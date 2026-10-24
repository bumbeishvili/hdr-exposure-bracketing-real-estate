// Camera colour to output colour, following the DNG specification and the DNG
// SDK's reference code: the white point is solved from the camera neutral
// through ColorMatrix1/2, the forward matrix and hue/sat maps are interpolated
// by its colour temperature, and the profile's tables run in linear ProPhoto
// RGB (D50). Temperature and tint use Robertson's method like the SDK, so the
// numbers match Lightroom's Temp/Tint scale.

import type { CameraProfile, HueSatTable, Matrix3 } from './dcp.ts';

export type Vec3 = [number, number, number];

export function mul3(m: Matrix3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

export function mulMM(a: Matrix3, b: Matrix3): Matrix3 {
  const out = new Array<number>(9) as Matrix3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return out;
}

export function inv3(m: Matrix3): Matrix3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('Singular colour matrix');
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

function lerpMatrix(a: Matrix3, b: Matrix3 | null, weightA: number): Matrix3 {
  if (!b) return a;
  return a.map((v, k) => v * weightA + b[k] * (1 - weightA)) as Matrix3;
}

/** Linear ProPhoto RGB (ROMM, D50) ↔ XYZ D50. */
export const PROPHOTO_TO_XYZ: Matrix3 = [0.7976749, 0.1351917, 0.0313534, 0.2880402, 0.7118741, 0.0000857, 0, 0, 0.82521];
export const XYZ_TO_PROPHOTO: Matrix3 = [1.3459433, -0.2556075, -0.0511118, -0.5445989, 1.5081673, 0.0205351, 0, 0, 1.2118128];
/** XYZ D50 → linear sRGB (D65), Bradford adaptation included. */
export const XYZ_D50_TO_SRGB: Matrix3 = [3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415, 0.033454, 0.0719453, -0.2289914, 1.4052427];
export const PROPHOTO_TO_SRGB: Matrix3 = mulMM(XYZ_D50_TO_SRGB, PROPHOTO_TO_XYZ);

const D50_XY: [number, number] = [0.3457, 0.3585];

function xyToXYZ([x, y]: [number, number]): Vec3 {
  return [x / y, 1, (1 - x - y) / y];
}

function XYZToXy([X, Y, Z]: Vec3): [number, number] {
  const s = X + Y + Z;
  return s > 0 ? [X / s, Y / s] : D50_XY;
}

// Robertson's isotemperature lines: mired, u, v, slope.
const ROBERTSON: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0.18006, 0.26352, -0.24341],
  [10, 0.18066, 0.26589, -0.25479],
  [20, 0.18133, 0.26846, -0.26876],
  [30, 0.18208, 0.27119, -0.28539],
  [40, 0.18293, 0.27407, -0.3047],
  [50, 0.18388, 0.27709, -0.32675],
  [60, 0.18494, 0.28021, -0.35156],
  [70, 0.18611, 0.28342, -0.37915],
  [80, 0.1874, 0.28668, -0.40955],
  [90, 0.1888, 0.28997, -0.44278],
  [100, 0.19032, 0.29326, -0.47888],
  [125, 0.19462, 0.30141, -0.58204],
  [150, 0.19962, 0.30921, -0.70471],
  [175, 0.20525, 0.31647, -0.84901],
  [200, 0.21142, 0.32312, -1.0182],
  [225, 0.21807, 0.32909, -1.2168],
  [250, 0.22511, 0.33439, -1.4512],
  [275, 0.23247, 0.33904, -1.7298],
  [300, 0.2401, 0.34308, -2.0637],
  [325, 0.24702, 0.34655, -2.4681],
  [350, 0.25591, 0.34951, -2.9641],
  [375, 0.264, 0.352, -3.5814],
  [400, 0.27218, 0.35407, -4.3633],
  [425, 0.28039, 0.35577, -5.3762],
  [450, 0.28863, 0.35714, -6.7262],
  [475, 0.29685, 0.35823, -8.5955],
  [500, 0.30505, 0.35907, -11.324],
  [525, 0.3132, 0.35968, -15.628],
  [550, 0.32129, 0.36011, -23.325],
  [575, 0.32931, 0.36038, -40.77],
  [600, 0.33724, 0.36051, -116.45],
];
const TINT_SCALE = -3000;

/** Correlated colour temperature (K) and tint of a chromaticity, as in the DNG SDK. */
export function xyToTemperature([x, y]: [number, number]): { temperature: number; tint: number } {
  const u = (2 * x) / (1.5 - x + 6 * y);
  const v = (3 * y) / (1.5 - x + 6 * y);
  let lastDt = 0;
  let lastDu = 0;
  let lastDv = 0;
  for (let i = 1; i <= 30; i++) {
    let du = 1;
    let dv = ROBERTSON[i][3];
    const len = Math.hypot(du, dv);
    du /= len;
    dv /= len;
    let uu = u - ROBERTSON[i][1];
    let vv = v - ROBERTSON[i][2];
    let dt = -uu * dv + vv * du;
    if (dt <= 0 || i === 30) {
      if (dt > 0) dt = 0;
      dt = -dt;
      const f = i === 1 ? 0 : dt / (lastDt + dt);
      const temperature = 1e6 / (ROBERTSON[i - 1][0] * f + ROBERTSON[i][0] * (1 - f));
      uu = u - (ROBERTSON[i - 1][1] * f + ROBERTSON[i][1] * (1 - f));
      vv = v - (ROBERTSON[i - 1][2] * f + ROBERTSON[i][2] * (1 - f));
      du = du * (1 - f) + lastDu * f;
      dv = dv * (1 - f) + lastDv * f;
      const l2 = Math.hypot(du, dv);
      return { temperature, tint: ((uu * du + vv * dv) / l2) * TINT_SCALE };
    }
    lastDt = dt;
    lastDu = du;
    lastDv = dv;
  }
  return { temperature: 6500, tint: 0 };
}

/** Chromaticity for a temperature (K) and tint, as in the DNG SDK. */
export function temperatureToXy(temperature: number, tint: number): [number, number] {
  const r = 1e6 / temperature;
  const offset = tint / TINT_SCALE;
  for (let i = 0; i <= 29; i++) {
    if (r < ROBERTSON[i + 1][0] || i === 29) {
      const f = (ROBERTSON[i + 1][0] - r) / (ROBERTSON[i + 1][0] - ROBERTSON[i][0]);
      let u = ROBERTSON[i][1] * f + ROBERTSON[i + 1][1] * (1 - f);
      let v = ROBERTSON[i][2] * f + ROBERTSON[i + 1][2] * (1 - f);
      const l1 = Math.hypot(1, ROBERTSON[i][3]);
      const l2 = Math.hypot(1, ROBERTSON[i + 1][3]);
      let uu = (1 / l1) * f + (1 / l2) * (1 - f);
      let vv = (ROBERTSON[i][3] / l1) * f + (ROBERTSON[i + 1][3] / l2) * (1 - f);
      const l3 = Math.hypot(uu, vv);
      uu /= l3;
      vv /= l3;
      u += uu * offset;
      v += vv * offset;
      return [(1.5 * u) / (u - 4 * v + 2), v / (u - 4 * v + 2)];
    }
  }
  return D50_XY;
}

/** Temperature the DNG SDK assigns to an Exif LightSource code. */
export function illuminantTemperature(code: number): number {
  switch (code) {
    case 17:
    case 3:
      return 2850;
    case 24:
      return 3200;
    case 23:
      return 5000;
    case 20:
    case 1:
    case 9:
    case 4:
    case 18:
      return 5500;
    case 21:
    case 19:
    case 10:
      return 6500;
    case 22:
    case 11:
      return 7500;
    case 12:
      return 6400;
    case 13:
      return 5000;
    case 14:
    case 2:
      return 4200;
    case 15:
      return 3450;
    default:
      return 5000;
  }
}

/** Weight of the first calibration illuminant for a white of this temperature. */
function illuminantWeight(profile: CameraProfile, temperature: number): number {
  if (!profile.colorMatrix2) return 1;
  let t1 = illuminantTemperature(profile.illuminant1);
  let t2 = illuminantTemperature(profile.illuminant2);
  let swap = false;
  if (t1 > t2) {
    [t1, t2] = [t2, t1];
    swap = true;
  }
  let g: number;
  if (temperature <= t1) g = 1;
  else if (temperature >= t2) g = 0;
  else g = (1 / temperature - 1 / t2) / (1 / t1 - 1 / t2);
  return swap ? 1 - g : g;
}

function colorMatrixFor(profile: CameraProfile, xy: [number, number]): Matrix3 {
  return lerpMatrix(profile.colorMatrix1, profile.colorMatrix2, illuminantWeight(profile, xyToTemperature(xy).temperature));
}

/** White point chromaticity of a camera neutral (camera RGB of a white object). */
export function neutralToXy(profile: CameraProfile, neutral: Vec3): [number, number] {
  let last = D50_XY;
  for (let pass = 0; pass < 30; pass++) {
    const next = XYZToXy(mul3(inv3(colorMatrixFor(profile, last)), neutral));
    if (Math.abs(next[0] - last[0]) + Math.abs(next[1] - last[1]) < 1e-7) return next;
    last = pass === 29 ? [(last[0] + next[0]) / 2, (last[1] + next[1]) / 2] : next;
  }
  return last;
}

/** Camera neutral (normalised to max 1) for a white of the given temperature and tint. */
export function neutralForTemperature(profile: CameraProfile, temperature: number, tint: number): Vec3 {
  const xy = temperatureToXy(temperature, tint);
  return normalizeMax(mul3(colorMatrixFor(profile, xy), xyToXYZ(xy)));
}

export function normalizeMax(v: Vec3): Vec3 {
  const m = Math.max(v[0], v[1], v[2]);
  return [v[0] / m, v[1] / m, v[2] / m];
}

export interface ColorTransform {
  /** Camera neutral, normalised to max 1. */
  neutral: Vec3;
  whiteXy: [number, number];
  temperature: number;
  tint: number;
  /** Camera RGB (not white-balanced) → linear ProPhoto RGB. A neutral at the white level maps to (1, 1, 1). */
  cameraToProPhoto: Matrix3;
  hueSatMap: HueSatTable | null;
  lookTable: HueSatTable | null;
}

/** Everything needed to render camera RGB under the white balance `neutral`. */
export function colorTransform(profile: CameraProfile, neutral: Vec3): ColorTransform {
  const n = normalizeMax(neutral);
  const whiteXy = neutralToXy(profile, n);
  const { temperature, tint } = xyToTemperature(whiteXy);
  const g = illuminantWeight(profile, temperature);
  let cameraToXyz: Matrix3;
  if (profile.forwardMatrix1) {
    const fm = lerpMatrix(profile.forwardMatrix1, profile.forwardMatrix2, g);
    cameraToXyz = mulMM(fm, [1 / n[0], 0, 0, 0, 1 / n[1], 0, 0, 0, 1 / n[2]]);
  } else {
    // No forward matrix: invert the colour matrix and adapt the white to D50 (DNG spec, chapter 6).
    const cm = lerpMatrix(profile.colorMatrix1, profile.colorMatrix2, g);
    const toXyz = inv3(cm);
    const white = mul3(toXyz, n);
    const d50 = xyToXYZ(D50_XY);
    cameraToXyz = mulMM([d50[0] / white[0], 0, 0, 0, d50[1] / white[1], 0, 0, 0, d50[2] / white[2]], toXyz);
  }
  return {
    neutral: n,
    whiteXy,
    temperature,
    tint,
    cameraToProPhoto: mulMM(XYZ_TO_PROPHOTO, cameraToXyz),
    hueSatMap: blendTables(profile.hueSatMap1, profile.hueSatMap2, g),
    lookTable: profile.lookTable,
  };
}

function blendTables(a: HueSatTable | null, b: HueSatTable | null, weightA: number): HueSatTable | null {
  if (!a) return b;
  if (!b || weightA >= 1) return a;
  const data = new Float32Array(a.data.length);
  for (let i = 0; i < data.length; i++) data[i] = a.data[i] * weightA + b.data[i] * (1 - weightA);
  return { ...a, data };
}

const srgbEncode = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const srgbDecode = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/**
 * Applies a hue/saturation/value table to interleaved linear RGB in place
 * (DNG SDK RefBaselineHueSatMap). Values above 1 keep their value scaling
 * instead of being pinned, so HDR highlights survive.
 */
export function applyHueSatTable(table: HueSatTable, rgb: Float32Array, count = rgb.length / 3): void {
  const { hueDivisions: hd, satDivisions: sd, valDivisions: vd, data } = table;
  const hScale = hd < 2 ? 0 : hd / 6;
  const sScale = sd - 1;
  const vScale = vd - 1;
  const maxH = hd - 1;
  const maxS = sd - 2;
  const maxV = vd - 2;
  const hueStep = sd * 3;
  const valStep = hd * sd * 3;
  const encoded = table.encoding === 1;
  for (let j = 0; j < count; j++) {
    const o = 3 * j;
    const r = Math.max(rgb[o], 0);
    const g = Math.max(rgb[o + 1], 0);
    const b = Math.max(rgb[o + 2], 0);
    const v = Math.max(r, g, b);
    if (v <= 0) continue;
    const gap = v - Math.min(r, g, b);
    let h = 0;
    if (gap > 0) {
      if (r === v) {
        h = (g - b) / gap;
        if (h < 0) h += 6;
      } else if (g === v) h = 2 + (b - r) / gap;
      else h = 4 + (r - g) / gap;
    }
    let s = gap / v;

    const hs = h * hScale;
    const ss = s * sScale;
    let h0 = Math.floor(hs);
    const s0 = Math.min(Math.floor(ss), maxS);
    let h1 = h0 + 1;
    if (h0 >= maxH) {
      h0 = maxH;
      h1 = 0;
    }
    const hf1 = hs - h0;
    const sf1 = ss - s0;
    const hf0 = 1 - hf1;
    const sf0 = 1 - sf1;
    let vf1 = 0;
    let base = 0;
    if (vd >= 2) {
      const ve = encoded ? srgbEncode(Math.min(v, 1)) : Math.min(v, 1);
      const vs = ve * vScale;
      const v0 = Math.min(Math.floor(vs), maxV);
      vf1 = vs - v0;
      base = v0 * valStep;
    }
    // Bilinear over hue × saturation, then linear over value when the table has a value axis.
    const w00 = hf0 * sf0;
    const w01 = hf0 * sf1;
    const w10 = hf1 * sf0;
    const w11 = hf1 * sf1;
    const e0 = base + h0 * hueStep + s0 * 3;
    const e1 = base + h1 * hueStep + s0 * 3;
    let hueShift = w00 * data[e0] + w01 * data[e0 + 3] + w10 * data[e1] + w11 * data[e1 + 3];
    let satScale = w00 * data[e0 + 1] + w01 * data[e0 + 4] + w10 * data[e1 + 1] + w11 * data[e1 + 4];
    let valScale = w00 * data[e0 + 2] + w01 * data[e0 + 5] + w10 * data[e1 + 2] + w11 * data[e1 + 5];
    if (vd >= 2) {
      const f0 = e0 + valStep;
      const f1 = e1 + valStep;
      const vf0 = 1 - vf1;
      hueShift = vf0 * hueShift + vf1 * (w00 * data[f0] + w01 * data[f0 + 3] + w10 * data[f1] + w11 * data[f1 + 3]);
      satScale = vf0 * satScale + vf1 * (w00 * data[f0 + 1] + w01 * data[f0 + 4] + w10 * data[f1 + 1] + w11 * data[f1 + 4]);
      valScale = vf0 * valScale + vf1 * (w00 * data[f0 + 2] + w01 * data[f0 + 5] + w10 * data[f1 + 2] + w11 * data[f1 + 5]);
    }
    h += hueShift * (6 / 360);
    s = Math.min(s * satScale, 1);
    let vOut: number;
    if (vd >= 2 && encoded) {
      const ve = srgbEncode(Math.min(v, 1)) * valScale;
      vOut = v > 1 ? v * valScale : srgbDecode(Math.min(Math.max(ve, 0), 1));
    } else {
      vOut = v * valScale;
    }
    hsvToRgbInto(h, s, vOut, rgb, o);
  }
}

function hsvToRgbInto(h: number, s: number, v: number, out: Float32Array, o: number): void {
  if (h < 0) h += 6;
  if (h >= 6) h -= 6;
  const i = Math.floor(h);
  const f = h - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  let r = v;
  let g = t;
  let b = p;
  switch (i) {
    case 1:
      r = q;
      g = v;
      b = p;
      break;
    case 2:
      r = p;
      g = v;
      b = t;
      break;
    case 3:
      r = p;
      g = q;
      b = v;
      break;
    case 4:
      r = t;
      g = p;
      b = v;
      break;
    case 5:
      r = v;
      g = p;
      b = q;
      break;
  }
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
}

/** Camera RGB (interleaved) → linear ProPhoto with the profile's hue/sat map, in place. */
export function cameraToProPhoto(transform: ColorTransform, rgb: Float32Array): void {
  const m = transform.cameraToProPhoto;
  for (let o = 0; o < rgb.length; o += 3) {
    const r = rgb[o];
    const g = rgb[o + 1];
    const b = rgb[o + 2];
    rgb[o] = m[0] * r + m[1] * g + m[2] * b;
    rgb[o + 1] = m[3] * r + m[4] * g + m[5] * b;
    rgb[o + 2] = m[6] * r + m[7] * g + m[8] * b;
  }
  if (transform.hueSatMap) applyHueSatTable(transform.hueSatMap, rgb);
}

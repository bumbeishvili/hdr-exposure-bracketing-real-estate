// The finished real-estate rendering: camera colour through the camera profile,
// synthetic exposures of the merged image fused into a bright interior with a
// readable window view, then finishing. Input and output are interleaved RGB.
//
// Interior and window are aimed at separately, as a real-estate editor would:
// fusion favours a high-key rendering in the room and a lower one inside the
// window (a smooth mask of what blows out at the base exposure), so white walls
// come out bright while the view keeps its detail. The pyramid blending of the
// fusion keeps the hand-off between the two halo-free.

import type { CameraProfile } from '../color/dcp.ts';
import { applyHueSatTable, cameraToProPhoto, colorTransform, PROPHOTO_TO_SRGB, type Vec3 } from '../color/color.ts';
import { fuseExposures } from '../tone/fusion.ts';
import { finish, type FinishParams } from './finish.ts';

export interface LookParams extends FinishParams {
  /** Camera neutral of the white balance. */
  neutral: Vec3;
  /** −1…1.5: how bright and airy the room is rendered. */
  brightness: number;
  /** 0…1: how much darker than the room the window view is kept, for detail. */
  windowPull: number;
}

export { REAL_ESTATE_LOOK } from './defaults.ts';

export interface RenderedLook {
  /** Display-referred linear sRGB, interleaved. */
  rgb: Float32Array;
  width: number;
  height: number;
  /** EV offsets of the synthetic exposures that were fused. */
  exposures: number[];
  /** Share of the frame treated as window or light source. */
  windowShare: number;
  temperature: number;
  tint: number;
  /** What a full-resolution render needs from this one (when asked for). */
  base: LookBase | null;
}

/** The coarse levels of a render, for adding full-resolution detail (see detail.ts). */
export interface LookBase {
  width: number;
  height: number;
  /** Fused display-encoded ProPhoto, before decoding and finishing; interleaved. */
  fused: Float32Array;
  /** Per-pixel ideal display level the fusion weights aimed at. */
  center: Float32Array;
  /** Scale from profile-linear ProPhoto to the 0 EV synthetic exposure. */
  gain: number;
  exposures: number[];
}

/** Fusion quality measures, shared with the full-resolution pass. */
export const FUSION_WEIGHTS = { exposedness: 1, contrast: 0.15, saturation: 0.2, sigma: 0.26 } as const;

/** Shoulder that keeps a synthetic exposure linear to 0.75 and rolls off smoothly to 1. */
function shoulder(x: number): number {
  const k = 0.75;
  return x <= k ? x : k + (1 - k) * (1 - Math.exp(-(x - k) / (1 - k)));
}

const encode = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const decode = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

// The per-pixel curves, tabulated: a full-resolution render evaluates them a few hundred million times.
const CURVE_MAX = 4;
const CURVE_SIZE = 16384;
const curveTable = Float32Array.from({ length: CURVE_SIZE + 1 }, (_, i) => encode(shoulder((i / CURVE_SIZE) * CURVE_MAX)));
const decodeTable = Float32Array.from({ length: 4097 }, (_, i) => decode(i / 4096));
const srgb8Table = Uint8Array.from({ length: 65536 }, (_, i) => Math.round(255 * encode(i / 65535)));

/** A synthetic exposure's display encoding of linear x ≥ 0: shoulder, then the sRGB transfer curve. */
export function exposureCurve(x: number): number {
  if (!(x > 0)) return 0;
  if (x >= CURVE_MAX) return curveTable[CURVE_SIZE];
  const t = x * (CURVE_SIZE / CURVE_MAX);
  const i = t | 0;
  return curveTable[i] + (curveTable[i + 1] - curveTable[i]) * (t - i);
}

/** Inverse sRGB transfer of a display value, clamped to [0, 1]. */
export function displayDecode(v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 1) return 1;
  const t = v * 4096;
  const i = t | 0;
  return decodeTable[i] + (decodeTable[i + 1] - decodeTable[i]) * (t - i);
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Renders camera RGB (linear, 1.0 = reference white, not white-balanced) to the finished look.
 * `keepBase` also returns the fused image before finishing, for a full-resolution render.
 */
export function renderLook(camera: Float32Array, width: number, height: number, profile: CameraProfile, look: LookParams, keepBase = false): RenderedLook {
  const n = width * height;
  const transform = colorTransform(profile, look.neutral);
  const linear = Float32Array.from(camera);
  cameraToProPhoto(transform, linear);

  // Base exposure from the median luminance; brighter for an airier look.
  const lum = new Float32Array(n);
  for (let p = 0; p < n; p++) lum[p] = Math.max(0, 0.2880402 * linear[3 * p] + 0.7118741 * linear[3 * p + 1] + 0.0000857 * linear[3 * p + 2]);
  const sorted = Float32Array.from(lum).sort();
  const median = Math.max(sorted[n >> 1], 1e-6);
  const gain = (0.18 * 2 ** (0.6 + look.brightness)) / median;
  const top = sorted[Math.min(n - 1, Math.floor(n * 0.997))] * gain;
  // Darker exposures until the brightest areas sit around mid-grey; one brighter to open backlit walls.
  const darkSteps = Math.max(0, Math.min(5, Math.ceil(Math.log2(Math.max(top, 1e-6) / 0.6) / 2)));
  const exposures = [2, 0];
  for (let s = 1; s <= darkSteps; s++) exposures.push(-2 * s);

  const images = exposures.map((ev) => {
    const k = gain * 2 ** ev;
    const img = new Float32Array(n * 3);
    for (let i = 0; i < img.length; i++) img[i] = linear[i] * k;
    if (transform.lookTable) applyHueSatTable(transform.lookTable, img);
    for (let i = 0; i < img.length; i++) img[i] = exposureCurve(img[i]);
    return img;
  });

  // Window mask: well above anything the room's own surfaces reach at the base exposure, softened.
  const mask = new Float32Array(n);
  for (let p = 0; p < n; p++) mask[p] = smoothstep(1.6, 4, lum[p] * gain);
  const radius = Math.max(2, Math.round(width * 0.004));
  boxBlur(mask, width, height, radius);
  boxBlur(mask, width, height, radius);
  let windowShare = 0;
  for (let p = 0; p < n; p++) windowShare += mask[p];

  // Target display level per pixel: high-key in the room, lower in the window.
  const interior = Math.min(0.78, Math.max(0.5, 0.62 + 0.08 * look.brightness));
  const window = interior - 0.3 * look.windowPull;
  const center = new Float32Array(n);
  for (let p = 0; p < n; p++) center[p] = interior + (window - interior) * mask[p];
  const fused = fuseExposures(images, width, height, { ...FUSION_WEIGHTS, centerMap: center });

  // Display ProPhoto (encoded) → linear sRGB, then finishing.
  const out = new Float32Array(n * 3);
  const m = PROPHOTO_TO_SRGB;
  for (let p = 0; p < n; p++) {
    const r = displayDecode(fused[3 * p]);
    const g = displayDecode(fused[3 * p + 1]);
    const b = displayDecode(fused[3 * p + 2]);
    out[3 * p] = m[0] * r + m[1] * g + m[2] * b;
    out[3 * p + 1] = m[3] * r + m[4] * g + m[5] * b;
    out[3 * p + 2] = m[6] * r + m[7] * g + m[8] * b;
  }
  finish(out, look);
  const base = keepBase ? { width, height, fused, center, gain, exposures } : null;
  return { rgb: out, width, height, exposures, windowShare: windowShare / n, temperature: transform.temperature, tint: transform.tint, base };
}

/** In-place separable box blur with mirrored edges. */
function boxBlur(a: Float32Array, w: number, h: number, r: number): void {
  const tmp = new Float32Array(Math.max(w, h));
  const norm = 1 / (2 * r + 1);
  const at = (i: number, n: number): number => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let k = -r; k <= r; k++) s += a[row + at(k, w)];
    for (let x = 0; x < w; x++) {
      tmp[x] = s * norm;
      s += a[row + at(x + r + 1, w)] - a[row + at(x - r, w)];
    }
    a.set(tmp.subarray(0, w), row);
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += a[at(k, h) * w + x];
    for (let y = 0; y < h; y++) {
      tmp[y] = s * norm;
      s += a[at(y + r + 1, h) * w + x] - a[at(y - r, h) * w + x];
    }
    for (let y = 0; y < h; y++) a[y * w + x] = tmp[y];
  }
}

/** Linear sRGB → 8-bit sRGB RGBA, written from pixel `offset` of `out` on. */
export function toRgba8(rgb: Float32Array, out: Uint8ClampedArray, offset = 0): void {
  const q = (v: number): number => srgb8Table[v > 0 ? (v < 1 ? (v * 65535 + 0.5) | 0 : 65535) : 0];
  for (let p = 0, o = 4 * offset; p < rgb.length; p += 3, o += 4) {
    out[o] = q(rgb[p]);
    out[o + 1] = q(rgb[p + 1]);
    out[o + 2] = q(rgb[p + 2]);
    out[o + 3] = 255;
  }
}

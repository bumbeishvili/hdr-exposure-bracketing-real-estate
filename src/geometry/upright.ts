// Upright: makes vertical lines vertical, as real-estate photos require.
// Near-vertical edges are traced row by row at sub-pixel precision and fitted
// with straight lines (wall corners, door and window frames, furniture). Their
// common vanishing point gives the camera's pitch and roll: a robust fit over
// the lines' interpretation planes, seeded by consensus over pairs and refined
// by reweighted least squares. A rotation homography H = K·R·K⁻¹ (K from the
// focal length) undoes the tilt, and the fit is checked by mapping every line
// it used through H: they must come out vertical. The result is cropped to the
// largest centred rectangle of the original aspect ratio inside the warp.

import { inv3, mul3, mulMM, type Vec3 } from '../color/color.ts';
import type { Matrix3 } from '../color/dcp.ts';
import { knotValue, radialScale, type LensModel } from './lens.ts';

export interface UprightLine {
  /** End points in pixel coordinates (pixel centres at +0.5), top first. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Rows covered times the square root of the edge's mean contrast. */
  weight: number;
}

export interface UprightEstimate {
  /** Rotation that makes the vanishing direction vertical; null when there is nothing to correct. */
  rotation: Matrix3 | null;
  /** The lines the fit used. */
  lines: UprightLine[];
  /** Tilt of the camera relative to level (degrees), and rotation about the lens axis. */
  pitch: number;
  roll: number;
  /** Angle from vertical of the fitted lines after correction (degrees): median and largest. */
  residual: { median: number; max: number };
}

/** Edges leaning more than this from vertical are not candidates. */
const MAX_LEAN = (25 * Math.PI) / 180;

/**
 * Near-vertical straight edges in a luminance image (any monotonic encoding):
 * gradient maxima along each row, linked down the image into chains and split
 * where they stop being straight.
 */
export function findVerticalLines(lum: Float32Array, w: number, h: number): UprightLine[] {
  const log = new Float32Array(w * h);
  for (let i = 0; i < log.length; i++) log[i] = Math.log(Math.max(lum[i], 1e-4));
  const mag = new Float32Array(w * h);
  const sign = new Int8Array(w * h);
  const tanMax = Math.tan(MAX_LEAN);
  const strong: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = log[i - w + 1] + 2 * log[i + 1] + log[i + w + 1] - log[i - w - 1] - 2 * log[i - 1] - log[i + w - 1];
      const gy = log[i + w - 1] + 2 * log[i + w] + log[i + w + 1] - log[i - w - 1] - 2 * log[i - w] - log[i - w + 1];
      if (Math.abs(gy) > tanMax * Math.abs(gx)) continue;
      mag[i] = Math.hypot(gx, gy);
      sign[i] = gx > 0 ? 1 : -1;
      if ((y & 3) === 0) strong.push(mag[i]);
    }
  }
  if (strong.length < 100) return [];
  strong.sort((a, b) => a - b);
  const threshold = Math.max(0.12, strong[Math.floor(strong.length * 0.85)]);

  interface Chain {
    xs: number[];
    ys: number[];
    m: number;
    sign: number;
    last: number;
    // Running sums for the line through the chain so far.
    n: number;
    sy: number;
    sx: number;
    syy: number;
    sxy: number;
  }
  const open: Chain[] = [];
  const done: Chain[] = [];
  const predict = (c: Chain, y: number): number => {
    if (c.n < 4) return c.xs[c.xs.length - 1];
    const d = c.n * c.syy - c.sy * c.sy;
    const b = d > 1e-9 ? (c.n * c.sxy - c.sy * c.sx) / d : 0;
    return (c.sx - b * c.sy) / c.n + b * y;
  };
  for (let y = 1; y < h - 1; y++) {
    // Edge points of this row: gradient-magnitude maxima along x, at sub-pixel position.
    const points: Array<{ x: number; sign: number; m: number }> = [];
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < threshold || !sign[i] || m < mag[i - 1] || m <= mag[i + 1]) continue;
      const a = mag[i - 1];
      const c = mag[i + 1];
      const den = a - 2 * m + c;
      const off = den < 0 ? Math.min(0.5, Math.max(-0.5, (0.5 * (a - c)) / den)) : 0;
      points.push({ x: x + 0.5 + off, sign: sign[i], m });
    }
    const taken = new Set<Chain>();
    for (const p of points) {
      let best: Chain | null = null;
      let bestD = 1.2;
      for (const c of open) {
        if (c.sign !== p.sign || taken.has(c)) continue;
        const d = Math.abs(predict(c, y + 0.5) - p.x);
        if (d < bestD) (bestD = d), (best = c);
      }
      if (!best) {
        best = { xs: [], ys: [], m: 0, sign: p.sign, last: y, n: 0, sy: 0, sx: 0, syy: 0, sxy: 0 };
        open.push(best);
      }
      taken.add(best);
      best.xs.push(p.x);
      best.ys.push(y + 0.5);
      best.m += p.m;
      best.last = y;
      best.n++;
      best.sy += y + 0.5;
      best.sx += p.x;
      best.syy += (y + 0.5) * (y + 0.5);
      best.sxy += (y + 0.5) * p.x;
    }
    // Chains not continued for three rows are finished.
    for (let k = open.length - 1; k >= 0; k--) {
      if (y - open[k].last > 3) done.push(...open.splice(k, 1));
    }
  }
  done.push(...open);

  // Straight pieces of each chain: fit, split at the worst point while the fit is poor.
  const minRows = Math.max(16, Math.round(0.05 * h));
  const lines: UprightLine[] = [];
  const fit = (xs: number[], ys: number[], from: number, to: number): { a: number; b: number; worst: number; dev: number; rms: number } => {
    let n = 0;
    let sy = 0;
    let sx = 0;
    let syy = 0;
    let sxy = 0;
    for (let k = from; k < to; k++) {
      n++;
      sy += ys[k];
      sx += xs[k];
      syy += ys[k] * ys[k];
      sxy += ys[k] * xs[k];
    }
    const d = n * syy - sy * sy;
    const b = d > 1e-9 ? (n * sxy - sy * sx) / d : 0;
    const a = (sx - b * sy) / n;
    let worst = from;
    let dev = 0;
    let ss = 0;
    for (let k = from; k < to; k++) {
      const r = Math.abs(xs[k] - (a + b * ys[k]));
      ss += r * r;
      if (r > dev) (dev = r), (worst = k);
    }
    return { a, b, worst, dev, rms: Math.sqrt(ss / n) };
  };
  const pieces = (c: Chain, from: number, to: number, depth: number): void => {
    if (to - from < minRows) return;
    const f = fit(c.xs, c.ys, from, to);
    if (f.dev > 1.0 && depth < 8) {
      pieces(c, from, f.worst, depth + 1);
      pieces(c, f.worst + 1, to, depth + 1);
      return;
    }
    if (f.rms > 0.5 || Math.abs(Math.atan(f.b)) > MAX_LEAN) return;
    const y0 = c.ys[from];
    const y1 = c.ys[to - 1];
    let m = 0;
    for (let k = from; k < to; k++) m += mag[Math.floor(c.ys[k]) * w + Math.min(w - 1, Math.floor(c.xs[k]))];
    lines.push({ x0: f.a + f.b * y0, y0, x1: f.a + f.b * y1, y1, weight: (to - from) * Math.sqrt(m / (to - from)) });
  };
  for (const c of done) pieces(c, 0, c.xs.length, 0);
  return lines;
}

/**
 * Finds near-vertical lines and the rotation that straightens them.
 * `lum` is a luminance image (any monotonic encoding), `focal` the focal length in pixels at this size.
 */
export function estimateUpright(lum: Float32Array, w: number, h: number, focal: number): UprightEstimate {
  const none = (lines: UprightLine[], pitch = 0, roll = 0): UprightEstimate => ({ rotation: null, lines, pitch, roll, residual: { median: 0, max: 0 } });
  const lines = findVerticalLines(lum, w, h);
  if (lines.length < 3) return none(lines);

  const K: Matrix3 = [focal, 0, w / 2, 0, focal, h / 2, 0, 0, 1];
  const Kinv = inv3(K);
  // Each line's interpretation plane (through the camera centre); the vertical direction lies in all of them.
  const normals = lines.map((l) => normalize(cross(mul3(Kinv, [l.x0, l.y0, 1]), mul3(Kinv, [l.x1, l.y1, 1]))));
  const weights = lines.map((l) => l.weight);
  const angles = (d: Vec3): { pitch: number; roll: number } => ({
    pitch: (Math.atan2(d[2], d[1]) * 180) / Math.PI,
    roll: (Math.atan2(d[0], d[1]) * 180) / Math.PI,
  });
  // Tied-back curtains and furniture make long straight edges that lean on purpose; on a tripod the
  // roll is small and the pitch moderate, so plausible geometry is preferred.
  const prior = (d: Vec3): number => {
    const { pitch, roll } = angles(d);
    return Math.exp(-((roll / 2) ** 2) - (pitch / 15) ** 2);
  };
  const inlierLimit = Math.sin((0.4 * Math.PI) / 180);

  // Consensus over line pairs (the longest lines first when there are many).
  const order = lines.map((_, i) => i).sort((a, b) => weights[b] - weights[a]).slice(0, 80);
  let best: Vec3 | null = null;
  let bestScore = 0;
  for (let ai = 0; ai < order.length; ai++) {
    for (let bi = ai + 1; bi < order.length; bi++) {
      let d = normalize(cross(normals[order[ai]], normals[order[bi]]));
      if (!Number.isFinite(d[0])) continue;
      if (d[1] < 0) d = [-d[0], -d[1], -d[2]];
      let support = 0;
      for (let i = 0; i < normals.length; i++) if (Math.abs(dot(normals[i], d)) < inlierLimit) support += weights[i];
      const score = support * prior(d);
      if (score > bestScore) (bestScore = score), (best = d);
    }
  }
  if (!best) return none(lines);

  // Reweighted least squares (Tukey) from the consensus direction.
  let d = best;
  const c = Math.sin((0.6 * Math.PI) / 180);
  for (let it = 0; it < 12; it++) {
    const ws = normals.map((n, i) => {
      const r = Math.abs(dot(n, d)) / c;
      return r < 1 ? weights[i] * (1 - r * r) ** 2 : 0;
    });
    const next = smallestEigenvector(normals, ws, d);
    d = next[1] < 0 ? ([-next[0], -next[1], -next[2]] as Vec3) : next;
  }
  const inliers = normals.flatMap((n, i) => (Math.abs(dot(n, d)) < inlierLimit ? [i] : []));
  if (inliers.length < 3) return none(lines);
  const { pitch, roll } = angles(d);
  const used = inliers.map((i) => lines[i]);
  if (Math.abs(pitch) < 0.15 && Math.abs(roll) < 0.15) return none(used, pitch, roll);
  const rotation = rotationTo(d, [0, 1, 0]);

  // Check: every line the fit used, mapped through the correction, should now be vertical.
  const H = mulMM(mulMM(K, rotation), Kinv);
  const lean = used
    .map((l) => {
      const [ax, ay] = project(H, l.x0, l.y0);
      const [bx, by] = project(H, l.x1, l.y1);
      return Math.abs((Math.atan2(bx - ax, by - ay) * 180) / Math.PI);
    })
    .sort((a, b) => a - b);
  return { rotation, lines: used, pitch, roll, residual: { median: lean[lean.length >> 1], max: lean[lean.length - 1] } };
}

export interface UprightWarp {
  /** Output pixel (centres at +0.5) → undistorted sensor-plane position: crop offset, then the inverse Upright homography. */
  inverse: Matrix3;
  /** Output size: the kept crop at the sensor image's own scale, never upsampled. */
  width: number;
  height: number;
  /** Sensor image size; the lens model is centred on it. */
  sourceWidth: number;
  sourceHeight: number;
  /** Linear size of the kept crop relative to the frame. */
  scale: number;
  /** Lens distortion from undistorted to sensor positions, or null. */
  lens: LensModel | null;
}

/**
 * One resampling for all geometry: output pixel → crop → inverse Upright rotation
 * (if any) → the lens's radial model (if any) → sensor position. The crop is the
 * largest centred rectangle of the frame's shape whose sensor positions stay
 * inside; the output covers it pixel for pixel (`size` may ask for a smaller one).
 */
export function geometryWarp(rotation: Matrix3 | null, lens: LensModel | null, w: number, h: number, focal: number, size?: { width: number; height: number }): UprightWarp {
  const cx = w / 2;
  const cy = h / 2;
  let H: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (rotation) {
    const K: Matrix3 = [focal, 0, cx, 0, focal, cy, 0, 0, 1];
    // The rotation also slides the picture; shift it back so the frame centre stays put (as Lightroom's Upright does).
    const R = mulMM(mulMM(K, rotation), inv3(K));
    const [mx, my] = project(R, cx, cy);
    H = mulMM([1, 0, cx - mx, 0, 1, cy - my, 0, 0, 1], R);
  }
  const Hinv = inv3(H);
  const probe: UprightWarp = { inverse: Hinv, width: w, height: h, sourceWidth: w, sourceHeight: h, scale: 1, lens };
  const fits = (s: number): boolean => {
    for (let k = 0; k < 64; k++) {
      // Points around the crop rectangle's boundary.
      const t = (k % 16) / 16;
      const side = Math.floor(k / 16);
      const u = side === 0 ? t : side === 1 ? 1 : side === 2 ? 1 - t : 0;
      const v = side === 0 ? 0 : side === 1 ? t : side === 2 ? 1 : 1 - t;
      const [x, y] = sensorPosition(probe, cx + (u - 0.5) * w * s, cy + (v - 0.5) * h * s, 1);
      if (x < 0 || y < 0 || x > w || y > h) return false;
    }
    return true;
  };
  let lo = 0.3;
  let hi = 1;
  if (fits(1)) lo = 1;
  else {
    for (let it = 0; it < 30; it++) {
      const s = (lo + hi) / 2;
      if (fits(s)) lo = s;
      else hi = s;
    }
  }
  const s = lo;
  const width = size?.width ?? Math.max(1, Math.floor(w * s + 1e-6));
  const height = size?.height ?? Math.max(1, Math.floor(h * s + 1e-6));
  const toPlane: Matrix3 = [1, 0, cx - width / 2, 0, 1, cy - height / 2, 0, 0, 1];
  return { inverse: mulMM(Hinv, toPlane), width, height, sourceWidth: w, sourceHeight: h, scale: s, lens };
}

/** Sensor position (continuous, pixel edges at integers) of plane point (px, py) under the warp's lens. */
function sensorPosition(warp: UprightWarp, px: number, py: number, channel: number): [number, number] {
  const z = mul3(warp.inverse, [px, py, 1]);
  const xu = z[0] / z[2];
  const yu = z[1] / z[2];
  if (!warp.lens) return [xu, yu];
  const cx = warp.sourceWidth / 2;
  const cy = warp.sourceHeight / 2;
  const dx = xu - cx;
  const dy = yu - cy;
  const k = radialScale(warp.lens, Math.hypot(dx, dy) / Math.hypot(cx, cy), channel);
  return [cx + dx * k, cy + dy * k];
}

/** Sensor sample position (pixel-centre coordinates) for output pixel (u, v) and a colour channel. */
export function warpPoint(warp: UprightWarp, u: number, v: number, channel = 1): [number, number] {
  const [x, y] = sensorPosition(warp, u + 0.5, v + 0.5, channel);
  return [x - 0.5, y - 0.5];
}

/** The vignetting correction's gain (as devignette applies it on the source) at each output pixel of `warp`. */
export function vignettingGain(warp: UprightWarp, vignetting: Float64Array): Float32Array {
  const out = new Float32Array(warp.width * warp.height);
  const cx = warp.sourceWidth / 2;
  const cy = warp.sourceHeight / 2;
  const norm = 1 / Math.hypot(cx, cy);
  for (let v = 0, i = 0; v < warp.height; v++) {
    for (let u = 0; u < warp.width; u++, i++) {
      const [x, y] = warpPoint(warp, u, v);
      out[i] = 1 / knotValue(vignetting, Math.hypot(x + 0.5 - cx, y + 0.5 - cy) * norm);
    }
  }
  return out;
}

/** Bilinear resampling of interleaved RGB (w × h) through `warp`; red and blue follow their own lateral-CA paths. */
export function applyWarp(rgb: Float32Array, w: number, h: number, warp: UprightWarp): Float32Array {
  const out = new Float32Array(warp.width * warp.height * 3);
  const ca = !!warp.lens && (!!warp.lens.caRed || !!warp.lens.caBlue);
  const sample = (sx: number, sy: number, c0: number, c1: number, o: number): void => {
    const x = Math.min(Math.max(sx, 0), w - 1.001);
    const y = Math.min(Math.max(sy, 0), h - 1.001);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const i00 = (y0 * w + x0) * 3;
    const i10 = i00 + 3;
    const i01 = i00 + w * 3;
    const i11 = i01 + 3;
    for (let c = c0; c < c1; c++) {
      out[o + c] = (rgb[i00 + c] * (1 - fx) + rgb[i10 + c] * fx) * (1 - fy) + (rgb[i01 + c] * (1 - fx) + rgb[i11 + c] * fx) * fy;
    }
  };
  for (let v = 0; v < warp.height; v++) {
    for (let u = 0; u < warp.width; u++) {
      const o = (v * warp.width + u) * 3;
      const [gx, gy] = warpPoint(warp, u, v, 1);
      if (ca) {
        sample(gx, gy, 1, 2, o);
        const [rx, ry] = warpPoint(warp, u, v, 0);
        sample(rx, ry, 0, 1, o);
        const [bx, by] = warpPoint(warp, u, v, 2);
        sample(bx, by, 2, 3, o);
      } else sample(gx, gy, 0, 3, o);
    }
  }
  return out;
}

function project(H: Matrix3, x: number, y: number): [number, number] {
  const p = mul3(H, [x, y, 1]);
  return [p[0] / p[2], p[1] / p[2]];
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** Rotation taking unit vector a onto unit vector b (Rodrigues). */
function rotationTo(a: Vec3, b: Vec3): Matrix3 {
  const v = cross(a, b);
  const c = dot(a, b);
  const k = 1 / (1 + c);
  return [
    v[0] * v[0] * k + c,
    v[0] * v[1] * k - v[2],
    v[0] * v[2] * k + v[1],
    v[1] * v[0] * k + v[2],
    v[1] * v[1] * k + c,
    v[1] * v[2] * k - v[0],
    v[2] * v[0] * k - v[1],
    v[2] * v[1] * k + v[0],
    v[2] * v[2] * k + c,
  ];
}

/** Unit vector minimising Σ w·(n·d)²: smallest eigenvector of Σ w·n·nᵀ, by inverse iteration from `start`. */
function smallestEigenvector(normals: Vec3[], weights: number[], start: Vec3): Vec3 {
  const m: Matrix3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  normals.forEach((n, i) => {
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r * 3 + c] += weights[i] * n[r] * n[c];
  });
  const trace = m[0] + m[4] + m[8];
  if (!(trace > 0)) return start;
  const shifted = m.map((v, i) => v + (i % 4 === 0 ? 1e-9 * trace : 0)) as Matrix3;
  const inv = inv3(shifted);
  let d: Vec3 = start;
  for (let it = 0; it < 50; it++) d = normalize(mul3(inv, d));
  return d;
}

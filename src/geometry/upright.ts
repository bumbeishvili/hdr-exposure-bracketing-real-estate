// Upright: makes vertical lines vertical, as real-estate photos require.
// Near-vertical architectural edges (wall corners, door and window frames) are
// found with a Hough transform on log-luminance gradients; their common
// vanishing point gives the camera's pitch and roll, and a rotation homography
// H = K·R·K⁻¹ (K from the focal length) undoes them. The result is cropped to
// the largest centred rectangle of the original aspect ratio inside the warp.

import { inv3, mul3, mulMM, type Vec3 } from '../color/color.ts';
import type { Matrix3 } from '../color/dcp.ts';
import { radialScale, type LensModel } from './lens.ts';

export interface UprightLine {
  /** Line through (x, y) points at the image's vertical centre, angle from vertical (radians). */
  x: number;
  angle: number;
  votes: number;
}

export interface UprightEstimate {
  /** Rotation that makes the vanishing direction vertical; null when there is nothing to correct. */
  rotation: Matrix3 | null;
  lines: UprightLine[];
  /** Tilt of the camera relative to level (degrees), and rotation about the lens axis. */
  pitch: number;
  roll: number;
}

const MAX_ANGLE = (20 * Math.PI) / 180;
const ANGLE_STEPS = 161;

/**
 * Finds near-vertical lines and the rotation that straightens them.
 * `lum` is a luminance image (any monotonic encoding), `focal` the focal length in pixels at this size.
 */
export function estimateUpright(lum: Float32Array, w: number, h: number, focal: number): UprightEstimate {
  const log = new Float32Array(w * h);
  for (let i = 0; i < log.length; i++) log[i] = Math.log(Math.max(lum[i], 1e-4));

  // Sobel gradients; keep strong edges whose orientation is near vertical.
  const mags: number[] = [];
  const gxs = new Float32Array(w * h);
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = log[i - w + 1] + 2 * log[i + 1] + log[i + w + 1] - log[i - w - 1] - 2 * log[i - 1] - log[i + w - 1];
      const gy = log[i + w - 1] + 2 * log[i + w] + log[i + w + 1] - log[i - w - 1] - 2 * log[i - w] - log[i - w + 1];
      if (Math.abs(gy) > Math.tan(MAX_ANGLE) * Math.abs(gx)) continue;
      const m = Math.hypot(gx, gy);
      gxs[i] = gy / (gx || 1e-9);
      mag[i] = m;
      mags.push(m);
    }
  }
  if (mags.length < 100) return { rotation: null, lines: [], pitch: 0, roll: 0 };
  mags.sort((a, b) => a - b);
  const threshold = mags[Math.floor(mags.length * 0.9)];

  // Hough over (x at the vertical centre, angle from vertical).
  const yc = h / 2;
  const angles = Array.from({ length: ANGLE_STEPS }, (_, k) => -MAX_ANGLE + (2 * MAX_ANGLE * k) / (ANGLE_STEPS - 1));
  const tans = angles.map(Math.tan);
  const acc = new Float32Array(ANGLE_STEPS * w);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mag[i] < threshold) continue;
      // Only angles close to the local edge direction (dx/dy = −gy/gx along the edge).
      const local = Math.atan(-gxs[i]);
      for (let k = 0; k < ANGLE_STEPS; k++) {
        if (Math.abs(angles[k] - local) > 0.05) continue;
        const xc = Math.round(x - (y - yc) * tans[k]);
        if (xc >= 0 && xc < w) acc[k * w + xc] += 1;
      }
    }
  }

  // Peaks with non-maximum suppression; a line must be supported over a good share of the height.
  const lines: UprightLine[] = [];
  const minVotes = h * 0.18;
  const taken = new Uint8Array(ANGLE_STEPS * w);
  for (let n = 0; n < 40; n++) {
    let best = -1;
    let bestVotes = minVotes;
    for (let j = 0; j < acc.length; j++) if (!taken[j] && acc[j] > bestVotes) (bestVotes = acc[j]), (best = j);
    if (best < 0) break;
    const k = Math.floor(best / w);
    const xc = best % w;
    lines.push({ x: xc, angle: angles[k], votes: bestVotes });
    for (let dk = -12; dk <= 12; dk++) {
      for (let dx = -6; dx <= 6; dx++) {
        const kk = k + dk;
        const xx = xc + dx;
        if (kk >= 0 && kk < ANGLE_STEPS && xx >= 0 && xx < w) taken[kk * w + xx] = 1;
      }
    }
  }
  if (lines.length < 3) return { rotation: null, lines, pitch: 0, roll: 0 };

  // Vanishing direction in camera coordinates, robust to stray lines.
  const K: Matrix3 = [focal, 0, w / 2, 0, focal, h / 2, 0, 0, 1];
  const Kinv = inv3(K);
  const toRay = (l: UprightLine, y: number): Vec3 => mul3(Kinv, [l.x + (y - yc) * Math.tan(l.angle), y, 1]);
  // Each line's interpretation plane normal (through the camera centre).
  const normals = lines.map((l) => normalize(cross(toRay(l, 0), toRay(l, h))));
  // Consensus over line pairs, scored by inlier votes times a prior on plausible camera geometry:
  // tied-back curtains and furniture make long straight edges that lean on purpose, and on a
  // tripod the roll is small and the pitch moderate.
  let bestDir: Vec3 | null = null;
  let bestInliers: number[] = [];
  let bestScore = 0;
  for (let a = 0; a < normals.length; a++) {
    for (let b = a + 1; b < normals.length; b++) {
      let d = normalize(cross(normals[a], normals[b]));
      if (!Number.isFinite(d[0])) continue;
      if (d[1] < 0) d = [-d[0], -d[1], -d[2]];
      const inliers = normals.flatMap((nv, i) => (Math.abs(dot(nv, d)) < Math.sin((0.5 * Math.PI) / 180) ? [i] : []));
      const pitch = (Math.atan2(d[2], d[1]) * 180) / Math.PI;
      const roll = (Math.atan2(d[0], d[1]) * 180) / Math.PI;
      const prior = Math.exp(-((roll / 2) ** 2) - (pitch / 15) ** 2);
      const score = inliers.reduce((s, i) => s + lines[i].votes, 0) * prior;
      if (score > bestScore) {
        bestScore = score;
        bestInliers = inliers;
        bestDir = d;
      }
    }
  }
  if (!bestDir || bestInliers.length < 3) return { rotation: null, lines, pitch: 0, roll: 0 };
  // Least squares over the inliers: the direction most orthogonal to all their normals.
  const dir = smallestEigenvector(bestInliers.map((i) => normals[i]), bestInliers.map((i) => lines[i].votes));
  const d = dir[1] < 0 ? ([-dir[0], -dir[1], -dir[2]] as Vec3) : dir;
  const pitch = (Math.atan2(d[2], d[1]) * 180) / Math.PI;
  const roll = (Math.atan2(d[0], d[1]) * 180) / Math.PI;
  if (Math.abs(pitch) < 0.2 && Math.abs(roll) < 0.2) return { rotation: null, lines: bestInliers.map((i) => lines[i]), pitch, roll };
  return { rotation: rotationTo(d, [0, 1, 0]), lines: bestInliers.map((i) => lines[i]), pitch, roll };
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

/** Unit vector minimising Σ w·(n·d)²: smallest eigenvector of Σ w·n·nᵀ, by inverse iteration. */
function smallestEigenvector(normals: Vec3[], weights: number[]): Vec3 {
  const m: Matrix3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  normals.forEach((n, i) => {
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r * 3 + c] += weights[i] * n[r] * n[c];
  });
  const trace = m[0] + m[4] + m[8];
  const shifted = m.map((v, i) => v + (i % 4 === 0 ? 1e-9 * trace : 0)) as Matrix3;
  const inv = inv3(shifted);
  let d: Vec3 = normalize(cross(normals[0], normals[normals.length - 1]));
  for (let it = 0; it < 50; it++) d = normalize(mul3(inv, d));
  return d;
}

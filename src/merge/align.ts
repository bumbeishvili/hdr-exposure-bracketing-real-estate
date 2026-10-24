// Global sub-pixel translation of every frame relative to the reference frame.
// Even on a tripod the A7C II brackets move by 0.1–0.3 px between frames, so
// alignment is measured, not assumed. Lucas–Kanade runs on exposure-normalised
// half-resolution green planes, coarse to fine, with residuals weighted by the
// noise model so moving regions (wind, people) barely pull the fit. Adjacent
// frames are aligned to each other and the shifts chained out from the reference.

import type { RawFrame } from '../raw/arw.ts';
import type { ExposureAnalysis } from '../analysis/exposure.ts';
import { noiseVariance, type NoiseModel } from '../analysis/noise.ts';

/** Raw-pixel translation: frame(x + dx, y + dy) shows what reference(x, y) shows. */
export interface Shift {
  dx: number;
  dy: number;
}

export interface FrameAlignment {
  shift: Shift;
  /** Per quadrant (TL, TR, BL, BR) estimates, to expose rotation or lens shift. */
  quadrants: Shift[];
  /** Robust RMS of noise-normalised residuals against the neighbour frame, before and after. */
  residualBefore: number;
  residualAfter: number;
  /** Too little unclipped texture to trust the estimate; the shift is left at the chain value. */
  unreliable: boolean;
}

export interface AlignmentResult {
  /** In input order; the reference frame has a zero shift. */
  frames: FrameAlignment[];
  reference: number;
}

interface Plane {
  data: Float32Array;
  /** 1 where the plane pixel is near clipping (excluded from fits). */
  bad: Uint8Array;
  w: number;
  h: number;
}

export function alignFrames(frames: RawFrame[], exposures: ExposureAnalysis, noise: NoiseModel): AlignmentResult {
  const n = frames.length;
  const result: FrameAlignment[] = frames.map(() => ({ shift: { dx: 0, dy: 0 }, quadrants: [], residualBefore: 0, residualAfter: 0, unreliable: false }));
  const ev = exposures.frames.map((f) => f.measuredEv);
  const order = exposures.order;
  const at = order.indexOf(exposures.reference);
  const greenPos = frames[0].cfaPattern.colors.findIndex((c) => c === 1);

  // Walk outwards from the reference: each frame is aligned to its already-aligned neighbour.
  const planes = new Map<number, Plane>();
  const plane = (i: number): Plane => {
    let p = planes.get(i);
    if (!p) planes.set(i, (p = greenPlane(frames[i])));
    return p;
  };
  const steps: Array<[number, number]> = [];
  for (let k = at + 1; k < order.length; k++) steps.push([order[k - 1], order[k]]);
  for (let k = at - 1; k >= 0; k--) steps.push([order[k + 1], order[k]]);

  for (const [fixed, moving] of steps) {
    const k = 2 ** (ev[fixed] - ev[moving]); // fixed ≈ k · moving
    const sigma2 = (s: number): number => {
      // Green plane = mean of two green samples: half the single-sample variance.
      const vf = noiseVariance(noise, greenPos, s, frames[fixed].exposure.exposureTime) / 2;
      const vm = noiseVariance(noise, greenPos, s / k, frames[moving].exposure.exposureTime) / 2;
      return vf + k * k * vm;
    };
    const fit = estimateShift(plane(fixed), plane(moving), k, sigma2);
    const base = result[fixed].shift;
    result[moving] = {
      shift: { dx: base.dx + fit.shift.dx, dy: base.dy + fit.shift.dy },
      quadrants: fit.quadrants.map((q) => ({ dx: base.dx + q.dx, dy: base.dy + q.dy })),
      residualBefore: fit.before,
      residualAfter: fit.after,
      unreliable: fit.unreliable,
    };
    // Planes far down the chain are no longer needed.
    for (const key of planes.keys()) if (key !== moving && key !== exposures.reference) planes.delete(key);
  }
  if (n) result[exposures.reference].quadrants = [0, 1, 2, 3].map(() => ({ dx: 0, dy: 0 }));
  return { frames: result, reference: exposures.reference };
}

/** Half-resolution green plane over the crop (mean of the two greens per Bayer quad), black-subtracted. */
function greenPlane(frame: RawFrame): Plane {
  const { cfa, width: W, crop } = frame;
  const colors = frame.cfaPattern.colors;
  const w = crop.width >> 1;
  const h = crop.height >> 1;
  const data = new Float32Array(w * h);
  const bad = new Uint8Array(w * h);
  const greens = [0, 1, 2, 3].filter((p) => colors[p] === 1);
  // Offsets of the two greens inside a quad that starts at an even raw row/column.
  const offs = greens.map((p) => ({ dy: p >> 1, dx: p & 1 }));
  const black = (greens.reduce((a, p) => a + frame.blackLevel[p], 0) / greens.length) || 0;
  const near = frame.blackLevel.map((b) => b + 0.9 * (frame.whiteLevel - b));
  const x0 = crop.left + (crop.left & 1);
  const y0 = crop.top + (crop.top & 1);
  for (let v = 0; v < h; v++) {
    const row0 = (y0 + 2 * v) * W;
    const row1 = row0 + W;
    for (let u = 0; u < w; u++) {
      const x = x0 + 2 * u;
      const a = cfa[(offs[0].dy ? row1 : row0) + x + offs[0].dx];
      const b = cfa[(offs[1].dy ? row1 : row0) + x + offs[1].dx];
      data[v * w + u] = (a + b) / 2 - black;
      // Near-clipping in any of the quad's four samples excludes the pixel.
      if (cfa[row0 + x] >= near[0] || cfa[row0 + x + 1] >= near[1] || cfa[row1 + x] >= near[2] || cfa[row1 + x + 1] >= near[3]) bad[v * w + u] = 1;
    }
  }
  return { data, bad, w, h };
}

/** 4× box downsample; a coarse pixel is bad if any source pixel is. */
function downsample(p: Plane): Plane {
  const f = 4;
  const w = Math.floor(p.w / f);
  const h = Math.floor(p.h / f);
  const data = new Float32Array(w * h);
  const bad = new Uint8Array(w * h);
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      let sum = 0;
      let flag = 0;
      for (let j = 0; j < f; j++) {
        const row = (v * f + j) * p.w + u * f;
        for (let i = 0; i < f; i++) {
          sum += p.data[row + i];
          flag |= p.bad[row + i];
        }
      }
      data[v * w + u] = sum / (f * f);
      bad[v * w + u] = flag;
    }
  }
  return { data, bad, w, h };
}

function bilinear(p: Plane, x: number, y: number): number {
  const xi = Math.min(Math.max(Math.floor(x), 0), p.w - 2);
  const yi = Math.min(Math.max(Math.floor(y), 0), p.h - 2);
  const fx = Math.min(Math.max(x - xi, 0), 1);
  const fy = Math.min(Math.max(y - yi, 0), 1);
  const i = yi * p.w + xi;
  const d = p.data;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + p.w] * (1 - fx) + d[i + p.w + 1] * fx) * fy;
}

interface Fit {
  shift: Shift;
  quadrants: Shift[];
  before: number;
  after: number;
  unreliable: boolean;
}

/** Shift (raw px) such that moving(x + shift) · k ≈ fixed(x). */
function estimateShift(fixed: Plane, moving: Plane, k: number, sigma2: (s: number) => number): Fit {
  // Coarse level first (plane px / 4), then the full half-resolution plane.
  const coarse = lk(downsample(fixed), downsample(moving), k, (s) => sigma2(s) / 16, { u: 0, v: 0 }, 1, null, 8);
  const start = { u: coarse.u * 4, v: coarse.v * 4 };
  const full = lk(fixed, moving, k, sigma2, start, 2, null, 6);
  const before = residualRms(fixed, moving, k, sigma2, { u: 0, v: 0 });
  const after = residualRms(fixed, moving, k, sigma2, full);
  const quadrants = [0, 1, 2, 3].map((q) => {
    const fq = lk(fixed, moving, k, sigma2, full, 2, q, 3);
    return { dx: 2 * fq.u, dy: 2 * fq.v };
  });
  // Plane pixels are 2 raw pixels.
  return { shift: { dx: 2 * full.u, dy: 2 * full.v }, quadrants, before, after, unreliable: full.unreliable || coarse.unreliable };
}

/** Iterative Lucas–Kanade for a translation (u, v) in plane pixels, with Huber-weighted residuals. */
function lk(
  fixed: Plane,
  moving: Plane,
  k: number,
  sigma2: (s: number) => number,
  init: { u: number; v: number },
  stride: number,
  quadrant: number | null,
  iterations: number,
): { u: number; v: number; unreliable: boolean } {
  let u = init.u;
  let v = init.v;
  let unreliable = false;
  const margin = 4;
  const x0 = quadrant === null ? margin : (quadrant & 1) * (fixed.w >> 1) + margin;
  const x1 = quadrant === null ? fixed.w - margin : x0 - margin + (fixed.w >> 1) - margin;
  const y0 = quadrant === null ? margin : (quadrant >> 1) * (fixed.h >> 1) + margin;
  const y1 = quadrant === null ? fixed.h - margin : y0 - margin + (fixed.h >> 1) - margin;
  for (let it = 0; it < iterations; it++) {
    let a11 = 0;
    let a12 = 0;
    let a22 = 0;
    let b1 = 0;
    let b2 = 0;
    let used = 0;
    for (let y = y0; y < y1; y += stride) {
      for (let x = x0; x < x1; x += stride) {
        const i = y * fixed.w + x;
        if (fixed.bad[i]) continue;
        const r = fixed.data[i];
        if (r < 16) continue;
        const mx = x + u;
        const my = y + v;
        const mi = Math.round(my) * moving.w + Math.round(mx);
        if (mi < 0 || mi >= moving.bad.length || moving.bad[mi]) continue;
        const m = bilinear(moving, mx, my);
        const gx = (bilinear(moving, mx + 1, my) - bilinear(moving, mx - 1, my)) * 0.5 * k;
        const gy = (bilinear(moving, mx, my + 1) - bilinear(moving, mx, my - 1)) * 0.5 * k;
        const e = r - k * m;
        const sd = Math.sqrt(sigma2(r));
        const z = Math.abs(e) / sd;
        if (z > 12) continue; // motion or occlusion
        const w = (z <= 3 ? 1 : 3 / z) / (sd * sd);
        a11 += w * gx * gx;
        a12 += w * gx * gy;
        a22 += w * gy * gy;
        b1 += w * gx * e;
        b2 += w * gy * e;
        used++;
      }
    }
    const det = a11 * a22 - a12 * a12;
    const trace = a11 + a22;
    // Ill-conditioned or starved: keep the current estimate.
    if (used < 200 || det <= 1e-12 * trace * trace) {
      unreliable = true;
      break;
    }
    const du = (a22 * b1 - a12 * b2) / det;
    const dv = (a11 * b2 - a12 * b1) / det;
    u += du;
    v += dv;
    if (Math.abs(du) < 1e-4 && Math.abs(dv) < 1e-4) break;
  }
  return { u, v, unreliable };
}

function residualRms(fixed: Plane, moving: Plane, k: number, sigma2: (s: number) => number, at: { u: number; v: number }): number {
  const z: number[] = [];
  for (let y = 8; y < fixed.h - 8; y += 4) {
    for (let x = 8; x < fixed.w - 8; x += 4) {
      const i = y * fixed.w + x;
      if (fixed.bad[i] || fixed.data[i] < 16) continue;
      const mi = Math.round(y + at.v) * moving.w + Math.round(x + at.u);
      if (moving.bad[mi]) continue;
      z.push(Math.abs(fixed.data[i] - k * bilinear(moving, x + at.u, y + at.v)) / Math.sqrt(sigma2(fixed.data[i])));
    }
  }
  if (!z.length) return NaN;
  z.sort((a, b) => a - b);
  // Robust RMS: 1.4826 × median absolute normalised residual (1 for pure noise).
  return 1.4826 * z[z.length >> 1];
}

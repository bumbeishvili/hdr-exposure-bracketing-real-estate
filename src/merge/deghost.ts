// Reference-frame deghosting. Each 16 × 16-pixel block has a local reference:
// the base frame where it is unclipped, otherwise the brightest darker frame
// that is. Every other frame is compared with that reference on exposure-
// normalised block means; where they disagree by more than the noise model
// allows and by more than a few percent, something moved (wind, people, clouds)
// and the frame's weight there is faded out. Masks are dilated and blurred so
// the merge falls back to the reference softly instead of block by block.

import type { RawFrame } from '../raw/arw.ts';
import type { ExposureAnalysis } from '../analysis/exposure.ts';
import { shotFactor, type NoiseModel } from '../analysis/noise.ts';
import type { AlignmentResult } from './align.ts';

export interface MotionMasks {
  /** Block size in raw pixels; blocks tile the active area from its top-left. */
  block: number;
  cols: number;
  rows: number;
  /** Per frame (input order): weight multiplier per block, 1 = keep. */
  weights: Float32Array[];
  /** Per frame: share of blocks where it disagreed with the local reference. */
  share: number[];
  /** Share of blocks where any frame was faded out. */
  coverage: number;
}

export interface DeghostOptions {
  block?: number;
  /** Normalised difference (in noise standard deviations) where fading starts and completes. */
  zLow?: number;
  zHigh?: number;
  /** Relative difference where fading starts and completes. */
  relLow?: number;
  relHigh?: number;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function detectMotion(frames: RawFrame[], exposures: ExposureAnalysis, noise: NoiseModel, alignment: AlignmentResult, opts: DeghostOptions = {}): MotionMasks {
  const block = opts.block ?? 16;
  const zLow = opts.zLow ?? 4;
  const zHigh = opts.zHigh ?? 8;
  const relLow = opts.relLow ?? 0.03;
  const relHigh = opts.relHigh ?? 0.08;
  const ref = frames[exposures.reference];
  const { crop } = ref;
  const cols = Math.floor(crop.width / block);
  const rows = Math.floor(crop.height / block);
  const nb = cols * rows;
  const n = frames.length;
  const perChannel = (block / 2) * (block / 2);

  // Per frame and block: black-subtracted sums per CFA position, and the block's largest raw value.
  const sums = frames.map(() => new Float64Array(nb * 4));
  const peaks = frames.map(() => new Uint16Array(nb));
  frames.forEach((f, i) => {
    // Whole-pixel shift keeping the CFA phase (sub-pixel shifts do not matter at block scale).
    const sx = 2 * Math.round(alignment.frames[i].shift.dx / 2);
    const sy = 2 * Math.round(alignment.frames[i].shift.dy / 2);
    const s = sums[i];
    const pk = peaks[i];
    for (let by = 0; by < rows; by++) {
      for (let yy = 0; yy < block; yy++) {
        const y = Math.min(f.height - 1, Math.max(0, crop.top + by * block + yy + sy));
        const row = y * f.width;
        const py = (y & 1) << 1;
        for (let bx = 0; bx < cols; bx++) {
          const k = by * cols + bx;
          for (let xx = 0; xx < block; xx++) {
            const x = Math.min(f.width - 1, Math.max(0, crop.left + bx * block + xx + sx));
            const v = f.cfa[row + x];
            const p = py | (x & 1);
            s[k * 4 + p] += v - f.blackLevel[p];
            if (v > pk[k]) pk[k] = v;
          }
        }
      }
    }
  });

  const exposure = frames.map((_, i) => 2 ** exposures.frames[i].measuredEv);
  const darkerFirst = [...exposures.order].reverse(); // brightest first
  const trusted = frames.map((f) => f.blackLevel[0] + 0.9 * (f.whiteLevel - f.blackLevel[0]));
  const motion = frames.map(() => new Float32Array(nb));
  const flagged = new Array<number>(n).fill(0);
  let anyFlagged = 0;
  for (let k = 0; k < nb; k++) {
    // Local reference: the base frame if trustworthy here, else the brightest darker frame that is.
    let r = exposures.reference;
    if (peaks[r][k] >= trusted[r]) {
      r = -1;
      for (const i of darkerFirst) {
        if (exposure[i] < exposure[exposures.reference] && peaks[i][k] < trusted[i]) {
          r = i;
          break;
        }
      }
      if (r < 0) r = exposures.order[0];
    }
    let blockFlagged = false;
    for (let i = 0; i < n; i++) {
      if (i === r || peaks[i][k] >= frames[i].whiteLevel) continue;
      let chi = 0;
      let diff = 0;
      let level = 0;
      for (let p = 0; p < 4; p++) {
        const ch = noise.channels[p];
        const si = sums[i][k * 4 + p] / perChannel;
        const sr = sums[r][k * 4 + p] / perChannel;
        const xi = si / exposure[i];
        const xr = sr / exposure[r];
        const vi = (ch.alpha * shotFactor(noise, frames[i].exposure.exposureTime) * Math.max(si, 0) + ch.beta) / perChannel / (exposure[i] * exposure[i]);
        const vr = (ch.alpha * shotFactor(noise, frames[r].exposure.exposureTime) * Math.max(sr, 0) + ch.beta) / perChannel / (exposure[r] * exposure[r]);
        chi += ((xi - xr) * (xi - xr)) / (vi + vr);
        diff += xi - xr;
        level += Math.max(xr, 0);
      }
      const z = Math.sqrt(chi / 4);
      const rel = level > 0 ? Math.abs(diff) / level : 0;
      const m = smoothstep(zLow, zHigh, z) * smoothstep(relLow, relHigh, rel);
      motion[i][k] = m;
      if (m > 0.5) {
        flagged[i]++;
        blockFlagged = true;
      }
    }
    if (blockFlagged) anyFlagged++;
  }

  // Dilate by one block, then blur, so faded regions have soft edges and cover the object's border.
  const weights = motion.map((m) => {
    const dilated = new Float32Array(nb);
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        let v = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const y = by + dy;
          const x = bx + dx;
          if (y >= 0 && y < rows && x >= 0 && x < cols) v = Math.max(v, m[y * cols + x]);
        }
        dilated[by * cols + bx] = v;
      }
    }
    const out = new Float32Array(nb);
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        let v = 0;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const y = by + dy;
          const x = bx + dx;
          if (y >= 0 && y < rows && x >= 0 && x < cols) {
            v += dilated[y * cols + x];
            c++;
          }
        }
        out[by * cols + bx] = 1 - v / c;
      }
    }
    return out;
  });
  return { block, cols, rows, weights, share: flagged.map((f) => f / nb), coverage: anyFlagged / nb };
}

/** Bilinear weight multiplier of frame `i` at active-area pixel (x, y). */
export function motionWeight(masks: MotionMasks, i: number, x: number, y: number): number {
  const w = masks.weights[i];
  const fx = Math.min(Math.max(x / masks.block - 0.5, 0), masks.cols - 1);
  const fy = Math.min(Math.max(y / masks.block - 0.5, 0), masks.rows - 1);
  const x0 = Math.min(Math.floor(fx), masks.cols - 2);
  const y0 = Math.min(Math.floor(fy), masks.rows - 2);
  const tx = fx - x0;
  const ty = fy - y0;
  const i0 = y0 * masks.cols + x0;
  return (w[i0] * (1 - tx) + w[i0 + 1] * tx) * (1 - ty) + (w[i0 + masks.cols] * (1 - tx) + w[i0 + masks.cols + 1] * tx) * ty;
}

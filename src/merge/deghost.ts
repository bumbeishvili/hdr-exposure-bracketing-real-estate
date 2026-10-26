// Reference-frame deghosting. Each 16 × 16-pixel block has a local reference:
// the base frame where it is unclipped, otherwise the brightest darker frame
// that is. Every other frame is compared with that reference on exposure-
// normalised block means over the samples neither has near clipping (a frame
// mostly clipped in a block still contributes its darker samples there);
// where they disagree by more than the noise model allows and by more than a
// few percent, something moved (wind, people, clouds) and the frame's weight
// there is faded out. Masks are dilated and blurred so the merge falls back to
// the reference softly instead of block by block.

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
  // Whole-pixel shifts keeping the CFA phase (sub-pixel shifts do not matter at block scale).
  const shifts = frames.map((_, i) => [2 * Math.round(alignment.frames[i].shift.dx / 2), 2 * Math.round(alignment.frames[i].shift.dy / 2)]);
  const raw = (i: number, x: number, y: number): number => {
    const f = frames[i];
    const xx = Math.min(f.width - 1, Math.max(0, crop.left + x + shifts[i][0]));
    const yy = Math.min(f.height - 1, Math.max(0, crop.top + y + shifts[i][1]));
    return f.cfa[yy * f.width + xx];
  };

  // Per frame and block: the largest raw value.
  const peaks = frames.map(() => new Uint16Array(nb));
  frames.forEach((_, i) => {
    const pk = peaks[i];
    for (let y = 0; y < rows * block; y++) {
      for (let x = 0; x < cols * block; x++) {
        const k = ((y / block) | 0) * cols + ((x / block) | 0);
        const v = raw(i, x, y);
        if (v > pk[k]) pk[k] = v;
      }
    }
  });

  const exposure = frames.map((_, i) => 2 ** exposures.frames[i].measuredEv);
  const darkerFirst = [...exposures.order].reverse(); // brightest first
  const trusted = frames.map((f) => f.blackLevel[0] + 0.9 * (f.whiteLevel - f.blackLevel[0]));
  // Local reference per block: the base frame if trustworthy here, else the brightest darker frame that is.
  const refOf = new Int8Array(nb);
  for (let k = 0; k < nb; k++) {
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
    refOf[k] = r;
  }

  // Per frame, block and CFA position: black-subtracted sums of the frame's and the reference's samples where
  // neither is near clipping, and their count. A frame clipped over most of a block still has its darker samples
  // there — a person against a bright lawn — and they must agree with the reference too.
  const sumOwn = frames.map(() => new Float64Array(nb * 4));
  const sumRef = frames.map(() => new Float64Array(nb * 4));
  const count = frames.map(() => new Uint16Array(nb * 4));
  for (let y = 0; y < rows * block; y++) {
    const py = ((crop.top + y) & 1) << 1;
    for (let x = 0; x < cols * block; x++) {
      const k = ((y / block) | 0) * cols + ((x / block) | 0);
      const r = refOf[k];
      const vr = raw(r, x, y);
      if (vr >= trusted[r]) continue;
      const p = py | ((crop.left + x) & 1);
      for (let i = 0; i < n; i++) {
        if (i === r) continue;
        const vi = raw(i, x, y);
        if (vi >= trusted[i]) continue;
        sumOwn[i][k * 4 + p] += vi - frames[i].blackLevel[p];
        sumRef[i][k * 4 + p] += vr - frames[r].blackLevel[p];
        count[i][k * 4 + p]++;
      }
    }
  }

  const motion = frames.map(() => new Float32Array(nb));
  const flagged = new Array<number>(n).fill(0);
  let anyFlagged = 0;
  for (let k = 0; k < nb; k++) {
    const r = refOf[k];
    let blockFlagged = false;
    for (let i = 0; i < n; i++) {
      if (i === r) continue;
      let chi = 0;
      let diff = 0;
      let level = 0;
      let channels = 0;
      for (let p = 0; p < 4; p++) {
        const c = count[i][k * 4 + p];
        if (c < 4) continue;
        const ch = noise.channels[p];
        const si = sumOwn[i][k * 4 + p] / c;
        const sr = sumRef[i][k * 4 + p] / c;
        const xi = si / exposure[i];
        const xr = sr / exposure[r];
        const vi = (ch.alpha * shotFactor(noise, frames[i].exposure.exposureTime) * Math.max(si, 0) + ch.beta) / c / (exposure[i] * exposure[i]);
        const vr = (ch.alpha * shotFactor(noise, frames[r].exposure.exposureTime) * Math.max(sr, 0) + ch.beta) / c / (exposure[r] * exposure[r]);
        chi += ((xi - xr) * (xi - xr)) / (vi + vr);
        diff += Math.abs(xi - xr);
        level += Math.max(xr, 0);
        channels++;
      }
      // Nothing to compare: the frame has no samples here that the merge would use.
      if (!channels) continue;
      const z = Math.sqrt(chi / channels);
      const rel = level > 0 ? diff / level : 0;
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

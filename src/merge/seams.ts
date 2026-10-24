// Seam check for the merge's transition zones. A seam is a brightness step
// where weight passes from a frame near clipping to the next darker frame, so
// for each adjacent pair this measures their mean disagreement in the brighter
// frame's roll-off band. Pixels are selected by a level predicted from their
// eight same-colour neighbours in the darker frame, which is independent of the
// tested pixel's noise: selecting on the brighter frame's own sample would bias
// the result towards "darker near clipping".

import type { RawFrame } from '../raw/arw.ts';
import type { ExposureAnalysis } from '../analysis/exposure.ts';
import type { AlignmentResult } from './align.ts';

export interface SeamCell {
  row: number;
  col: number;
  samples: number;
  /** Mean (bright − dark) radiance difference relative to the signal. */
  relativeBias: number;
}

export interface SeamReport {
  bright: number;
  dark: number;
  samples: number;
  relativeBias: number;
  /** Grid over the active area, row-major, `rows × cols`. */
  rows: number;
  cols: number;
  cells: SeamCell[];
}

export interface SeamOptions {
  rollOffStart?: number;
  rollOffEnd?: number;
  stride?: number;
  rows?: number;
  cols?: number;
}

const DY = [-2, -2, -2, 0, 0, 2, 2, 2];
const DX = [-2, 0, 2, -2, 2, -2, 0, 2];

export function checkSeams(frames: RawFrame[], exposures: ExposureAnalysis, alignment: AlignmentResult, opts: SeamOptions = {}): SeamReport[] {
  const rollStart = opts.rollOffStart ?? 0.9;
  const rollEnd = opts.rollOffEnd ?? 0.98;
  const stride = opts.stride ?? 2;
  const rows = opts.rows ?? 6;
  const cols = opts.cols ?? 8;
  const order = exposures.order;
  const reports: SeamReport[] = [];
  for (let k = order.length - 1; k > 0; k--) {
    const bi = order[k];
    const di = order[k - 1];
    const bright = frames[bi];
    const dark = frames[di];
    const ratio = 2 ** (exposures.frames[bi].measuredEv - exposures.frames[di].measuredEv);
    // Integer part of the relative shift between the two frames, in raw pixels (even, to keep the CFA phase).
    const sb = alignment.frames[bi].shift;
    const sd = alignment.frames[di].shift;
    const ox = 2 * Math.round((sd.dx - sb.dx) / 2);
    const oy = 2 * Math.round((sd.dy - sb.dy) / 2);
    const { crop, width: W } = bright;
    const cellN = new Float64Array(rows * cols);
    const cellD = new Float64Array(rows * cols);
    const cellX = new Float64Array(rows * cols);
    const step = 2 * stride;
    for (let y = crop.top + 4; y < crop.top + crop.height - 4; y += step) {
      for (let x = crop.left + 4; x < crop.left + crop.width - 4; x += step) {
        for (let q = 0; q < 4; q++) {
          const X = x + (q & 1);
          const Y = y + (q >> 1);
          const p = ((Y & 1) << 1) | (X & 1);
          const bb = bright.blackLevel[p];
          const bd = dark.blackLevel[p];
          const range = bright.whiteLevel - bb;
          const i = Y * W + X;
          const j = (Y + oy) * W + X + ox;
          // Predicted level in the brighter frame, from the darker frame's neighbours.
          let sum = 0;
          let lo = Infinity;
          let hi = -Infinity;
          for (let n = 0; n < 8; n++) {
            const v = dark.cfa[j + DY[n] * W + DX[n]] - bd;
            sum += v;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          const predicted = (sum / 8) * ratio;
          if (predicted < rollStart * range || predicted > rollEnd * range) continue;
          // Skip edges: there a 0.1 px residual misalignment matters more than the seam.
          if ((hi - lo) * ratio > 0.04 * predicted) continue;
          const vb = bright.cfa[i];
          if (vb >= bright.whiteLevel) continue;
          const xb = vb - bb;
          const xd = (dark.cfa[j] - bd) * ratio;
          const cell = Math.min(rows - 1, Math.floor(((Y - crop.top) / crop.height) * rows)) * cols + Math.min(cols - 1, Math.floor(((X - crop.left) / crop.width) * cols));
          cellN[cell]++;
          cellD[cell] += xb - xd;
          cellX[cell] += predicted;
        }
      }
    }
    let n = 0;
    let d = 0;
    let s = 0;
    const cells: SeamCell[] = [];
    for (let c = 0; c < rows * cols; c++) {
      n += cellN[c];
      d += cellD[c];
      s += cellX[c];
      cells.push({ row: Math.floor(c / cols), col: c % cols, samples: cellN[c], relativeBias: cellN[c] ? cellD[c] / cellX[c] : NaN });
    }
    reports.push({ bright: bi, dark: di, samples: n, relativeBias: n ? d / s : NaN, rows, cols, cells });
  }
  return reports;
}

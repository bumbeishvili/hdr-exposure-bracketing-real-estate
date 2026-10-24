// Exposure ratios measured from the pixels rather than EXIF: shutter speeds are
// nominal, and a few percent of error shows up as seams in the merge.

import type { RawFrame } from '../raw/arw.ts';
import { channelNames } from './stats.ts';

export interface RatioOptions {
  /** Same-colour samples per block side; a block spans 2 × blockSize raw pixels. */
  blockSize?: number;
  /** Minimum black-subtracted block mean in the darker frame (DN). */
  minSignal?: number;
  /** Every sample of the brighter frame's block must stay below this fraction of its linear range. */
  maxFraction?: number;
}

export interface ChannelRatio {
  name: string;
  ratio: number;
  ev: number;
  blocks: number;
}

export interface LinearityBin {
  /** Bin centre: brighter-frame block mean as a fraction of (linear limit − black). */
  level: number;
  /** Median block ratio in the bin divided by the overall ratio; 1 means linear. */
  relative: number;
  blocks: number;
}

export interface RatioEstimate {
  /** Brighter ÷ darker exposure. */
  ratio: number;
  ev: number;
  perChannel: ChannelRatio[];
  /** Block-channels that passed the clipping and noise-floor tests. */
  usable: number;
  inliers: number;
  /** Robust spread (1.4826 × MAD) of per-block log2 ratios, in EV. */
  spreadEv: number;
  /** Ratio against brightness, showing where the sensor leaves its linear range. */
  linearity: LinearityBin[];
}

export interface FrameExposure {
  /** EV relative to the reference frame from EXIF time, aperture and ISO. */
  exifEv: number;
  /** EV relative to the reference frame, chained from measured adjacent ratios. */
  measuredEv: number;
  /** Measured minus EXIF. */
  differenceEv: number;
}

export interface PairRatio {
  bright: number;
  dark: number;
  exifRatio: number;
  estimate: RatioEstimate;
}

export interface ExposureAnalysis {
  /** Frame indices from darkest to brightest by measured exposure. */
  order: number[];
  /** Index of the 0 EV frame: the bracket's base exposure. */
  reference: number;
  /** In input order. */
  frames: FrameExposure[];
  /** Adjacent pairs along `order`. */
  pairs: PairRatio[];
}

/** The level above which a sensor is treated as non-linear: Sony's SR2 white level when present. */
export function linearLimit(frame: RawFrame): number {
  return Math.min(frame.whiteLevel, ...(frame.sr2WhiteLevel ?? []));
}

/** Relative exposure H ∝ t · ISO / N² from EXIF. */
export function exifExposure(frame: RawFrame): number {
  const { exposureTime, fNumber, iso } = frame.exposure;
  const n = fNumber > 0 ? fNumber : 1;
  return (exposureTime * (iso > 0 ? iso : 100)) / (n * n);
}

/**
 * Estimates bright ÷ dark from blocks that are unclipped in the brighter frame
 * and above the noise floor in the darker one. Each block-channel gives a ratio
 * of means; outliers (motion, misalignment) are rejected around the median and
 * the inliers' summed signals give the estimate.
 */
export function estimateExposureRatio(bright: RawFrame, dark: RawFrame, opts: RatioOptions = {}): RatioEstimate {
  if (bright.width !== dark.width || bright.height !== dark.height) {
    throw new Error(`Frames differ in size (${bright.width}×${bright.height} vs ${dark.width}×${dark.height})`);
  }
  const bs = opts.blockSize ?? 8;
  const minSignal = opts.minSignal ?? 64;
  const maxFraction = opts.maxFraction ?? 0.9;
  const span = 2 * bs;
  const { left, top } = bright.crop;
  const nbx = Math.floor(bright.crop.width / span);
  const nby = Math.floor(bright.crop.height / span);
  const nb = nbx * nby * 4;

  const sumA = new Float64Array(nb);
  const sumB = new Float64Array(nb);
  const maxA = new Uint16Array(nb);
  const A = bright.cfa;
  const B = dark.cfa;
  const W = bright.width;
  for (let by = 0; by < nby; by++) {
    for (let yy = 0; yy < span; yy++) {
      const y = top + by * span + yy;
      const row = y * W;
      const py = (y & 1) << 1;
      let k0 = by * nbx * 4;
      for (let bx = 0; bx < nbx; bx++, k0 += 4) {
        const x0 = left + bx * span;
        for (let xx = 0; xx < span; xx++) {
          const x = x0 + xx;
          const k = k0 + (py | (x & 1));
          const a = A[row + x];
          sumA[k] += a;
          sumB[k] += B[row + x];
          if (a > maxA[k]) maxA[k] = a;
        }
      }
    }
  }

  const n = bs * bs;
  const limit = linearLimit(bright);
  const usableLog: number[] = [];
  const usableA: number[] = [];
  const usableB: number[] = [];
  const usablePos: number[] = [];
  const linLevel: number[] = [];
  const linLog: number[] = [];
  for (let k = 0; k < nb; k++) {
    const p = k & 3;
    const blackA = bright.blackLevel[p];
    const a = sumA[k] / n - blackA;
    const b = sumB[k] / n - dark.blackLevel[p];
    if (b < minSignal || a <= 0) continue;
    const l = Math.log2(a / b);
    if (maxA[k] < bright.whiteLevel) {
      linLevel.push(a / (limit - blackA));
      linLog.push(l);
    }
    if (maxA[k] >= blackA + maxFraction * (limit - blackA)) continue;
    usableLog.push(l);
    usableA.push(a);
    usableB.push(b);
    usablePos.push(p);
  }
  if (usableLog.length < 16) {
    throw new Error(`Too few unclipped, well-exposed blocks (${usableLog.length}) to compare these frames`);
  }

  const all = robustRatio(usableLog, usableA, usableB, () => true);
  const names = channelNames(bright.cfaPattern.colors);
  const perChannel = names.map((name, p): ChannelRatio => {
    const r = robustRatio(usableLog, usableA, usableB, (i) => usablePos[i] === p);
    return { name, ratio: r.ratio, ev: Math.log2(r.ratio), blocks: r.inliers };
  });

  const binWidth = 0.05;
  const binLogs = new Map<number, number[]>();
  for (let i = 0; i < linLevel.length; i++) {
    const bin = Math.floor(linLevel[i] / binWidth);
    let list = binLogs.get(bin);
    if (!list) binLogs.set(bin, (list = []));
    list.push(linLog[i]);
  }
  const logRatio = Math.log2(all.ratio);
  const linearity = [...binLogs.entries()]
    .filter(([, logs]) => logs.length >= 20)
    .sort(([a], [b]) => a - b)
    .map(([bin, logs]) => ({ level: (bin + 0.5) * binWidth, relative: 2 ** (median(logs) - logRatio), blocks: logs.length }));

  return {
    ratio: all.ratio,
    ev: logRatio,
    perChannel,
    usable: usableLog.length,
    inliers: all.inliers,
    spreadEv: all.spread,
    linearity,
  };
}

/** Sorts frames by measured exposure and chains adjacent ratios into EV offsets. */
export function analyzeExposures(frames: RawFrame[], meanSignal: number[], opts?: RatioOptions): ExposureAnalysis {
  const order = frames.map((_, i) => i).sort((a, b) => meanSignal[a] - meanSignal[b]);
  const pairs: PairRatio[] = [];
  for (let i = 1; i < order.length; i++) {
    const dark = order[i - 1];
    const bright = order[i];
    pairs.push({
      bright,
      dark,
      exifRatio: exifExposure(frames[bright]) / exifExposure(frames[dark]),
      estimate: estimateExposureRatio(frames[bright], frames[dark], opts),
    });
  }

  const ev = new Array<number>(frames.length).fill(0);
  for (let i = 1; i < order.length; i++) ev[order[i]] = ev[order[i - 1]] + pairs[i - 1].estimate.ev;
  const reference = pickReference(frames, order);
  const exifRef = Math.log2(exifExposure(frames[reference]));
  return {
    order,
    reference,
    frames: frames.map((frame, i) => {
      const exifEv = Math.log2(exifExposure(frame)) - exifRef;
      const measuredEv = ev[i] - ev[reference];
      return { exifEv, measuredEv, differenceEv: measuredEv - exifEv };
    }),
    pairs,
  };
}

/** The base exposure: the one frame with 0 EV bracket offset, else the first shot, else the middle one. */
function pickReference(frames: RawFrame[], order: number[]): number {
  const zero = frames.flatMap((f, i) => (f.exposure.exposureCompensation === 0 ? [i] : []));
  if (zero.length === 1) return zero[0];
  const first = frames.findIndex((f) => f.sequenceNumber === 1);
  return first >= 0 ? first : order[order.length >> 1];
}

function robustRatio(logs: number[], a: number[], b: number[], include: (i: number) => boolean): { ratio: number; inliers: number; spread: number } {
  const idx: number[] = [];
  for (let i = 0; i < logs.length; i++) if (include(i)) idx.push(i);
  if (!idx.length) return { ratio: NaN, inliers: 0, spread: NaN };
  const values = idx.map((i) => logs[i]);
  const med = median(values);
  const spread = 1.4826 * median(values.map((v) => Math.abs(v - med)));
  const tolerance = Math.max(3.5 * spread, 0.005);
  let sa = 0;
  let sb = 0;
  let inliers = 0;
  for (const i of idx) {
    if (Math.abs(logs[i] - med) > tolerance) continue;
    sa += a[i];
    sb += b[i];
    inliers++;
  }
  return { ratio: sa / sb, inliers, spread };
}

function median(values: number[]): number {
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Per-frame raw statistics over the active area: histograms and clipping.

import type { RawFrame } from '../raw/arw.ts';

export interface ChannelStats {
  /** "R", "G1", "G2" or "B". */
  name: string;
  /** 0 = R, 1 = G, 2 = B. */
  color: number;
  /** CFA pattern position (row-major over the 2×2 repeat). */
  position: number;
  /** Sample count per code value; codes above 2^bits − 1 land in the last bin. */
  histogram: Uint32Array;
  count: number;
  min: number;
  max: number;
  mean: number;
  p01: number;
  median: number;
  p99: number;
  /** Samples at or above the white level (hard clip). */
  clipped: number;
  clippedFraction: number;
}

export interface FrameStats {
  /** In CFA position order. */
  channels: ChannelStats[];
  /** Mean black-subtracted signal over all samples; rises monotonically with exposure. */
  meanSignal: number;
}

/** Display names for each CFA position: R, G1, G2, B for an RGGB-family pattern. */
export function channelNames(colors: number[]): string[] {
  let greens = 0;
  return colors.map((c) => (c === 1 ? `G${++greens}` : 'RGB'[c]));
}

export function computeFrameStats(frame: RawFrame): FrameStats {
  const { cfa, width, crop, whiteLevel, blackLevel } = frame;
  const bins = 1 << frame.bitsPerSample;
  const last = bins - 1;
  const hist = [0, 1, 2, 3].map(() => new Uint32Array(bins));

  const x0 = crop.left;
  const x1 = crop.left + crop.width;
  for (let y = crop.top; y < crop.top + crop.height; y++) {
    const row = y * width;
    const hEven = hist[((y & 1) << 1) | (x0 & 1)];
    const hOdd = hist[((y & 1) << 1) | ((x0 + 1) & 1)];
    let i = row + x0;
    const end = row + x1;
    for (; i + 1 < end; i += 2) {
      const a = cfa[i];
      const b = cfa[i + 1];
      hEven[a < last ? a : last]++;
      hOdd[b < last ? b : last]++;
    }
    if (i < end) {
      const a = cfa[i];
      hEven[a < last ? a : last]++;
    }
  }

  const names = channelNames(frame.cfaPattern.colors);
  let signal = 0;
  let samples = 0;
  const channels = hist.map((h, p): ChannelStats => {
    let count = 0;
    let sum = 0;
    let clipped = 0;
    let min = -1;
    let max = 0;
    for (let v = 0; v < bins; v++) {
      const n = h[v];
      if (!n) continue;
      if (min < 0) min = v;
      max = v;
      count += n;
      sum += n * v;
      if (v >= whiteLevel) clipped += n;
    }
    const mean = count ? sum / count : 0;
    signal += sum - count * blackLevel[p];
    samples += count;
    return {
      name: names[p],
      color: frame.cfaPattern.colors[p],
      position: p,
      histogram: h,
      count,
      min: Math.max(min, 0),
      max,
      mean,
      p01: percentile(h, count, 0.01),
      median: percentile(h, count, 0.5),
      p99: percentile(h, count, 0.99),
      clipped,
      clippedFraction: count ? clipped / count : 0,
    };
  });

  return { channels, meanSignal: samples ? signal / samples : 0 };
}

function percentile(h: Uint32Array, count: number, q: number): number {
  const target = q * count;
  let seen = 0;
  for (let v = 0; v < h.length; v++) {
    seen += h[v];
    if (seen >= target && seen > 0) return v;
  }
  return h.length - 1;
}

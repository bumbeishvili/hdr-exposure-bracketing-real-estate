// Noise model, fitted from exposure-normalised differences of adjacent frames.
// On a tripod the scene and the pixel-response pattern cancel in d = a − r·b,
// leaving temporal noise. Single-frame model, per CFA position:
//   Var(v) = α(t)·s + β,  α(t) = α · (1 + γ · log2(t / t_ref))
// for black-subtracted signal s at exposure time t. The γ term is empirical: on
// the A7C II the shot-noise slope grows with shutter time. For a pair with
// ratio r, Var(d) = (α(tA) + r·α(tB))·s + β(1 + r²), s at the brighter exposure.
// Only flat pixels are used, so sub-pixel misregistration and motion stay out.

import type { RawFrame } from '../raw/arw.ts';
import type { ExposureAnalysis } from './exposure.ts';
import { channelNames } from './stats.ts';

export interface NoiseChannel {
  name: string;
  /** Shot-noise slope at the reference exposure time: DN² per DN (1 / conversion gain). */
  alpha: number;
  /** Read-noise variance, DN². */
  beta: number;
}

export interface NoiseBin {
  /** Bin centre: signal at the brighter exposure, DN above black. */
  signal: number;
  samples: number;
  /** Variance of the pair difference, outliers beyond ±4σ dropped. */
  measured: number;
  /** Variance the fitted model predicts. */
  predicted: number;
}

export interface PairNoise {
  bright: number;
  dark: number;
  ratio: number;
  /** Per CFA position. */
  bins: NoiseBin[][];
  /** Black-level error implied by the mean difference at low signal, DN, per CFA position. */
  blackOffset: number[];
  /** This pair's own constant-α fit per CFA position, for comparison with the joint model. */
  own: Array<{ alpha: number; beta: number }>;
  /** Fraction of sampled pixels that passed the flatness test. */
  flatFraction: number;
}

export interface NoiseModel {
  /** Per CFA position. */
  channels: NoiseChannel[];
  /** γ: relative change of the shot-noise slope per doubling of exposure time. */
  timeSlope: number;
  /** t_ref, seconds: the reference frame's exposure time. */
  referenceTime: number;
  pairs: PairNoise[];
}

export interface NoiseOptions {
  /** Sample every n-th plane pixel in each direction. */
  stride?: number;
  /** Samples kept per signal bin, per pair and CFA position. */
  perBin?: number;
}

const BIN_LO = 4;
const BIN_HI = 16384;
const BINS_PER_OCTAVE = 3;
const N_BINS = Math.ceil(Math.log2(BIN_HI / BIN_LO) * BINS_PER_OCTAVE);
const binOf = (s: number): number => Math.floor(Math.log2(s / BIN_LO) * BINS_PER_OCTAVE);
const binCentre = (k: number): number => BIN_LO * 2 ** ((k + 0.5) / BINS_PER_OCTAVE);
const MIN_SAMPLES = 400;

/** α(t) / α: the shot-noise slope's exposure-time factor. */
export function shotFactor(model: Pick<NoiseModel, 'timeSlope' | 'referenceTime'>, exposureTime: number): number {
  return Math.max(0.2, 1 + model.timeSlope * Math.log2(exposureTime / model.referenceTime));
}

/** Single-frame variance of a raw sample with black-subtracted signal `s`. */
export function noiseVariance(model: NoiseModel, position: number, s: number, exposureTime = model.referenceTime): number {
  const c = model.channels[position];
  return c.alpha * shotFactor(model, exposureTime) * Math.max(s, 0) + c.beta;
}

interface Reservoir {
  s: Float32Array;
  g: Float32Array;
  d: Float32Array;
  n: number;
  seen: number;
}

interface Row {
  x1: number;
  x2: number;
  y: number;
  w: number;
}

export function fitNoiseModel(frames: RawFrame[], exposures: ExposureAnalysis, opts: NoiseOptions = {}): NoiseModel {
  const stride = opts.stride ?? 2;
  const perBin = opts.perBin ?? 4000;
  const names = channelNames(frames[0].cfaPattern.colors);
  const referenceTime = frames[exposures.reference].exposure.exposureTime;
  const logTime = (i: number): number => Math.log2(frames[i].exposure.exposureTime / referenceTime);

  // 1. Sample (signal, gradient, difference) triples for every pair and CFA position.
  const sampled = exposures.pairs.map((p) => {
    const reservoirs = [0, 1, 2, 3].map(() => Array.from({ length: N_BINS }, (): Reservoir => ({ s: new Float32Array(perBin), g: new Float32Array(perBin), d: new Float32Array(perBin), n: 0, seen: 0 })));
    samplePair(frames[p.bright], frames[p.dark], p.estimate.ratio, stride, reservoirs);
    return { pair: p, reservoirs };
  });

  // 2. Per pair and position: constant-α fit on all samples, then on the flat ones.
  const own = sampled.map(({ pair, reservoirs }) =>
    reservoirs.map((bins) => {
      let m = fitPair(robustBins(bins, () => true), pair.estimate.ratio);
      for (let it = 0; it < 2; it++) m = fitPair(robustBins(bins, flatUnder(m.alpha, m.beta)), pair.estimate.ratio);
      return m;
    }),
  );

  // 3. Joint fit across pairs: (α, β) per position, γ shared, found by a 1-D search.
  const flatBins = sampled.map(({ reservoirs }, k) => reservoirs.map((bins, pos) => robustBins(bins, flatUnder(own[k][pos].alpha, own[k][pos].beta))));
  const rowsFor = (gamma: number, pos: number): Row[] =>
    sampled.flatMap(({ pair }, k) => {
      const r = pair.estimate.ratio;
      const fA = Math.max(0.2, 1 + gamma * logTime(pair.bright));
      const fB = Math.max(0.2, 1 + gamma * logTime(pair.dark));
      return flatBins[k][pos].map((b) => ({ x1: (fA + r * fB) * b.signal, x2: 1 + r * r, y: b.variance, w: b.samples }));
    });
  let best = { cost: Infinity, gamma: 0, fits: [] as Array<{ a: number; b: number }> };
  for (let gamma = -0.1; gamma <= 0.3 + 1e-9; gamma += 0.005) {
    let cost = 0;
    const fits = names.map((_, pos) => {
      const rows = rowsFor(gamma, pos);
      const fit = weightedFit(rows);
      cost += relativeCost(rows, fit.a, fit.b);
      return fit;
    });
    if (cost < best.cost) best = { cost, gamma, fits };
  }
  const channels = names.map((name, pos): NoiseChannel => ({ name, alpha: best.fits[pos].a, beta: Math.max(best.fits[pos].b, 0) }));
  const model: NoiseModel = { channels, timeSlope: best.gamma, referenceTime, pairs: [] };

  // 4. Diagnostics under the joint model: measured vs predicted per bin, black-level check.
  model.pairs = sampled.map(({ pair, reservoirs }, k): PairNoise => {
    const r = pair.estimate.ratio;
    const fA = shotFactor(model, frames[pair.bright].exposure.exposureTime);
    const fB = shotFactor(model, frames[pair.dark].exposure.exposureTime);
    let flat = 0;
    let kept = 0;
    const blackOffset: number[] = [];
    const bins = reservoirs.map((res, pos) => {
      const { alpha, beta } = channels[pos];
      const isFlat = flatUnder(alpha * fA, beta);
      // Mean difference over flat, low-signal samples: E[d] = −δ(r − 1) for a black error δ.
      let sum = 0;
      let n = 0;
      for (const bin of res) {
        for (let i = 0; i < bin.n; i++) {
          kept++;
          if (!isFlat(bin.s[i], bin.g[i])) continue;
          flat++;
          if (bin.s[i] <= 400) {
            sum += bin.d[i];
            n++;
          }
        }
      }
      blackOffset.push(n ? -sum / n / (r - 1) : NaN);
      return robustBins(res, isFlat).map(
        (b): NoiseBin => ({ signal: b.signal, samples: b.samples, measured: b.variance, predicted: alpha * (fA + r * fB) * b.signal + beta * (1 + r * r) }),
      );
    });
    return { bright: pair.bright, dark: pair.dark, ratio: r, bins, blackOffset, own: own[k], flatFraction: kept ? flat / kept : 0 };
  });
  return model;
}

/**
 * Flatness test: the local gradient of the combined estimate stays within twice
 * the single-frame noise, so a 0.1–0.3 px misregistration adds little residual.
 */
function flatUnder(alpha: number, beta: number): (s: number, g: number) => boolean {
  return (s, g) => g < 2 * Math.sqrt(alpha * s + beta);
}

// Neighbour order: up-left, up, up-right, left, right, down-left, down, down-right (±2 raw px).
const NEIGHBOUR_DY = [-2, -2, -2, 0, 0, 2, 2, 2];
const NEIGHBOUR_DX = [-2, 0, 2, -2, 2, -2, 0, 2];

/** Streams one pair, filling per-position, per-bin reservoirs of (signal, gradient, difference). */
function samplePair(bright: RawFrame, dark: RawFrame, r: number, stride: number, reservoirs: Reservoir[][]): void {
  const { width: W, crop } = bright;
  const A = bright.cfa;
  const B = dark.cfa;
  const clip = bright.blackLevel.map((b) => b + 0.97 * (bright.whiteLevel - b));
  let seed = 0x9e3779b9;
  const rand = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  // Plane neighbours are ±2 raw pixels; start 2 inside the crop on each side.
  const y0 = crop.top + 2;
  const y1 = crop.top + crop.height - 2;
  const x0 = crop.left + 2;
  const x1 = crop.left + crop.width - 2;
  const step = 2 * stride;
  for (let py = 0; py < 2; py++) {
    for (let px = 0; px < 2; px++) {
      const pos = (((y0 + py) & 1) << 1) | ((x0 + px) & 1);
      const bA = bright.blackLevel[pos];
      const bB = dark.blackLevel[pos];
      const cl = clip[pos];
      const res = reservoirs[pos];
      for (let y = y0 + py; y < y1; y += step) {
        for (let x = x0 + px; x < x1; x += step) {
          const i = y * W + x;
          const aC = A[i];
          if (aC >= cl) continue;
          // 8 same-colour neighbours of the combined estimate (a + r·b) / 2.
          let sum = 0;
          let clipped = false;
          let left = 0;
          let right = 0;
          let up = 0;
          let down = 0;
          for (let k = 0; k < 8; k++) {
            const j = i + NEIGHBOUR_DY[k] * W + NEIGHBOUR_DX[k];
            const a = A[j];
            if (a >= cl) clipped = true;
            const c = (a - bA + r * (B[j] - bB)) * 0.5;
            sum += c;
            if (k === 1) up = c;
            else if (k === 3) left = c;
            else if (k === 4) right = c;
            else if (k === 6) down = c;
          }
          if (clipped) continue;
          const s = sum / 8;
          if (s < BIN_LO) continue;
          const bin = binOf(s);
          if (bin >= N_BINS) continue;
          const g = Math.max(Math.abs(right - left), Math.abs(down - up)) * 0.5;
          const d = aC - bA - r * (B[i] - bB);
          const rv = res[bin];
          rv.seen++;
          let slot = rv.n;
          if (rv.n < rv.s.length) rv.n++;
          else slot = Math.floor(rand() * rv.seen);
          if (slot < rv.s.length) {
            rv.s[slot] = s;
            rv.g[slot] = g;
            rv.d[slot] = d;
          }
        }
      }
    }
  }
}

function robustBins(bins: Reservoir[], keep: (s: number, g: number) => boolean): Array<{ signal: number; variance: number; samples: number }> {
  const out: Array<{ signal: number; variance: number; samples: number }> = [];
  bins.forEach((bin, k) => {
    const d: number[] = [];
    for (let i = 0; i < bin.n; i++) if (keep(bin.s[i], bin.g[i])) d.push(bin.d[i]);
    if (d.length < MIN_SAMPLES) return;
    out.push({ signal: binCentre(k), variance: clippedVariance(d), samples: d.length });
  });
  return out;
}

/**
 * Variance with samples beyond ±4σ dropped (motion, hot pixels). The MAD alone
 * is not used: pair differences are nearly integer-valued, which quantises the
 * MAD and swings (1.4826·MAD)² by ±10% from bin to bin.
 */
export function clippedVariance(values: number[]): number {
  const med = median(values);
  let sigma = 1.4826 * median(values.map((v) => Math.abs(v - med))) || 1;
  let centre = med;
  let variance = sigma * sigma;
  for (let it = 0; it < 3; it++) {
    const limit = 4 * sigma;
    let n = 0;
    let sum = 0;
    for (const v of values) {
      if (Math.abs(v - centre) <= limit) {
        sum += v;
        n++;
      }
    }
    const mean = sum / n;
    let ss = 0;
    for (const v of values) if (Math.abs(v - centre) <= limit) ss += (v - mean) ** 2;
    // A normal truncated at ±4σ keeps 99.89% of its variance.
    variance = ss / Math.max(n - 1, 1) / 0.99893;
    centre = mean;
    sigma = Math.sqrt(variance);
  }
  return variance;
}

/** Var(d) = α(1 + r)s + β(1 + r²) for one pair, as a single-frame (α, β). */
function fitPair(bins: Array<{ signal: number; variance: number; samples: number }>, r: number): { alpha: number; beta: number } {
  const { a, b } = weightedFit(bins.map((bin) => ({ x1: (1 + r) * bin.signal, x2: 1 + r * r, y: bin.variance, w: bin.samples })));
  return { alpha: Math.max(a, 1e-6), beta: Math.max(b, 0) };
}

/** Least squares for y = a·x1 + b·x2 with relative-error weights, reweighted by the fit. */
function weightedFit(rows: Row[]): { a: number; b: number } {
  let a = 0;
  let b = 0;
  for (let it = 0; it < 4; it++) {
    let s11 = 0;
    let s12 = 0;
    let s22 = 0;
    let t1 = 0;
    let t2 = 0;
    for (const r of rows) {
      const pred = it === 0 ? r.y : Math.max(a * r.x1 + b * r.x2, 1e-9);
      const w = Math.sqrt(r.w) / (pred * pred);
      s11 += w * r.x1 * r.x1;
      s12 += w * r.x1 * r.x2;
      s22 += w * r.x2 * r.x2;
      t1 += w * r.x1 * r.y;
      t2 += w * r.x2 * r.y;
    }
    const det = s11 * s22 - s12 * s12;
    if (!det) break;
    a = (t1 * s22 - t2 * s12) / det;
    b = (s11 * t2 - s12 * t1) / det;
  }
  return { a, b };
}

function relativeCost(rows: Row[], a: number, b: number): number {
  let cost = 0;
  for (const r of rows) {
    const pred = Math.max(a * r.x1 + b * r.x2, 1e-9);
    cost += Math.sqrt(r.w) * ((r.y - pred) / pred) ** 2;
  }
  return cost;
}

function median(values: number[]): number {
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

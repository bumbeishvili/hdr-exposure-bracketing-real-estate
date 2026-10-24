// Noise-weighted linear merge on the raw Bayer data, before demosaicing.
// Each frame's sample becomes a radiance estimate x_i = (v_i − black) / e_i in
// reference-frame DN (e_i: measured exposure relative to the reference). The
// estimates are averaged with inverse-variance weights from the noise model,
// w_i = e_i² / Var(v_i), where Var uses the signal predicted from the best frame
// rather than the frame's own noisy sample (that would bias bright noise low).
// Weights roll off smoothly towards clipping so no frame switches off abruptly,
// which is what leaves seams. Shifted frames are resampled per colour plane
// with a Catmull-Rom kernel.

import { cfaIndex, type RawFrame } from '../raw/arw.ts';
import type { ExposureAnalysis } from '../analysis/exposure.ts';
import { shotFactor, type NoiseModel } from '../analysis/noise.ts';
import type { PreviewData } from '../analysis/preview.ts';
import type { AlignmentResult } from './align.ts';
import type { MotionMasks } from './deghost.ts';

export interface MergeOptions {
  /** Fraction of a frame's range where its weight starts rolling off… */
  rollOffStart?: number;
  /** …and where it reaches zero. */
  rollOffEnd?: number;
  /** Frames exposed less than this fraction of the best frame at a pixel are skipped. */
  minRelativeExposure?: number;
  /** Shifts smaller than this (raw px) are not resampled. */
  minShift?: number;
  previewMaxWidth?: number;
  /** Deghosting: per-frame weight multipliers from `detectMotion`. */
  motion?: MotionMasks | null;
}

export interface MergedImage {
  /** Active-area size. */
  width: number;
  height: number;
  /** Black-subtracted signal in reference-frame DN; highlights exceed the reference white level. */
  data: Float32Array;
  /** Variance of each merged sample (reference DN²). */
  variance: Float32Array;
  /** CFA colour of each 2×2 pattern position, relative to the active area's top-left. */
  cfaColors: number[];
  /** The reference frame's white − black: 1.0 on the preview scale. */
  referenceRange: number;
}

export interface MergeResult {
  image: MergedImage;
  /** Linear camera RGB, 1.0 = the reference frame's white level. */
  preview: PreviewData;
  /** Per preview pixel: index (input order) of the frame that carried the most weight. */
  sourceMap: Uint8Array;
  /** Share of all weight each frame contributed (input order). */
  weightShare: number[];
  /** Fraction of samples where every frame was clipped. */
  clippedFraction: number;
  /** log2(brightest merged signal / read-noise floor of the brightest frame). */
  dynamicRangeStops: number;
  /** Per preview pixel, 0–255: how much weight deghosting took away from the frames there. */
  ghostMap: Uint8Array | null;
}

interface Source {
  index: number;
  cfa: Uint16Array;
  width: number;
  height: number;
  black: number[];
  clipCode: number;
  rollLo: number[];
  rollHi: number[];
  exposure: number;
  shot: number;
  resample: boolean;
  /** Integer plane offset of the first tap and the four Catmull-Rom weights, per axis. */
  ix: number;
  iy: number;
  wx: number[];
  wy: number[];
  /** Noise variance factor of the resampling kernel (Σwx² · Σwy²). */
  varFactor: number;
}

function catmullRom(t: number): number[] {
  const t2 = t * t;
  const t3 = t2 * t;
  return [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2];
}

export function mergeFrames(frames: RawFrame[], exposures: ExposureAnalysis, noise: NoiseModel, alignment: AlignmentResult, opts: MergeOptions = {}): MergeResult {
  const rollStart = opts.rollOffStart ?? 0.9;
  const rollEnd = opts.rollOffEnd ?? 0.98;
  const minRel = opts.minRelativeExposure ?? 1 / 32;
  const minShift = opts.minShift ?? 0.05;
  const ref = frames[exposures.reference];
  const { crop } = ref;
  const W = crop.width;
  const H = crop.height;

  // Brightest first: the first trustworthy frame at a pixel is the best one.
  const sources: Source[] = exposures.order
    .slice()
    .reverse()
    .map((i): Source => {
      const f = frames[i];
      const { dx, dy } = alignment.frames[i].shift;
      const resample = Math.hypot(dx, dy) >= minShift;
      const sx = dx / 2;
      const sy = dy / 2;
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      const wx = catmullRom(sx - ix);
      const wy = catmullRom(sy - iy);
      const sq = (w: number[]): number => w.reduce((a, b) => a + b * b, 0);
      return {
        index: i,
        cfa: f.cfa,
        width: f.width,
        height: f.height,
        black: f.blackLevel,
        clipCode: f.whiteLevel,
        rollLo: f.blackLevel.map((b) => b + rollStart * (f.whiteLevel - b)),
        rollHi: f.blackLevel.map((b) => b + rollEnd * (f.whiteLevel - b)),
        exposure: 2 ** exposures.frames[i].measuredEv,
        shot: shotFactor(noise, f.exposure.exposureTime),
        resample,
        ix,
        iy,
        wx,
        wy,
        varFactor: resample ? sq(wx) * sq(wy) : 1,
      };
    });
  const nS = sources.length;

  const data = new Float32Array(W * H);
  const variance = new Float32Array(W * H);
  const cfaColors = [0, 1, 2, 3].map((p) => ref.cfaPattern.colors[cfaIndex(crop.left + (p & 1), crop.top + (p >> 1))]);
  const referenceRange = ref.whiteLevel - ref.blackLevel[0];

  // Preview accumulators (quarter-resolution bins of Bayer quads), as in makePreview.
  const quadsX = W >> 1;
  const quadsY = H >> 1;
  const pf = Math.max(1, Math.ceil(quadsX / (opts.previewMaxWidth ?? 960)));
  const pw = Math.floor(quadsX / pf);
  const ph = Math.floor(quadsY / pf);
  const pSum = new Float64Array(pw * ph * 3);
  const pClip = new Uint8Array(pw * ph);
  const pWeight = new Float64Array(pw * ph * nS);
  const perColor = [0, 0, 0];
  for (const c of cfaColors) perColor[c] += pf * pf;

  const shareSum = new Float64Array(nS);
  let clippedSamples = 0;
  let maxSignal = 0;

  const raws = new Float64Array(nS);
  const xs = new Float64Array(nS);
  const ws = new Float64Array(nS);
  const tapClip = new Uint8Array(nS);

  const motion = opts.motion ?? null;
  const rowWeights = motion ? sources.map(() => new Float32Array(motion.cols)) : null;

  for (let y = 0; y < H; y++) {
    if (motion && rowWeights) {
      const fy = Math.min(Math.max(y / motion.block - 0.5, 0), motion.rows - 1);
      const y0 = Math.min(Math.floor(fy), motion.rows - 2);
      const ty = fy - y0;
      sources.forEach((src, k) => {
        const w = motion.weights[src.index];
        const out = rowWeights[k];
        for (let bx = 0; bx < motion.cols; bx++) out[bx] = w[y0 * motion.cols + bx] * (1 - ty) + w[(y0 + 1) * motion.cols + bx] * ty;
      });
    }
    const Y = crop.top + y;
    const py = Y & 1;
    const V = Y >> 1;
    const prow = Math.floor((y >> 1) / pf);
    const inPreviewY = prow < ph;
    for (let x = 0; x < W; x++) {
      const X = crop.left + x;
      const px = X & 1;
      const p = (py << 1) | px;
      const U = X >> 1;

      // Samples, brightest frame first, until the best frame is found and the rest are too dark to matter.
      let best = -1;
      let used = 0;
      for (let k = 0; k < nS; k++) {
        const s = sources[k];
        if (best >= 0 && s.exposure < sources[best].exposure * minRel) break;
        let v: number;
        let clipped = false;
        if (!s.resample) {
          v = s.cfa[Y * s.width + X];
          clipped = v >= s.clipCode;
        } else {
          v = 0;
          const pwMax = (s.width >> 1) - 1;
          const phMax = (s.height >> 1) - 1;
          for (let j = 0; j < 4; j++) {
            let vv = V + s.iy - 1 + j;
            vv = vv < 0 ? 0 : vv > phMax ? phMax : vv;
            const row = (2 * vv + py) * s.width + px;
            let acc = 0;
            for (let i = 0; i < 4; i++) {
              let uu = U + s.ix - 1 + i;
              uu = uu < 0 ? 0 : uu > pwMax ? pwMax : uu;
              const t = s.cfa[row + 2 * uu];
              if (t >= s.clipCode) clipped = true;
              acc += s.wx[i] * t;
            }
            v += s.wy[j] * acc;
          }
        }
        raws[k] = v;
        xs[k] = (v - s.black[p]) / s.exposure;
        tapClip[k] = clipped ? 1 : 0;
        used = k + 1;
        if (best < 0 && !clipped && v < s.rollLo[p]) best = k;
      }

      // Predicted signal for the variances: from the best frame, else the darkest sample.
      const xHat = Math.max(xs[best >= 0 ? best : used - 1], 0);
      const ch = noise.channels[p];
      let sw = 0;
      let swx = 0;
      for (let k = 0; k < used; k++) {
        const s = sources[k];
        const v = raws[k];
        ws[k] = 0;
        if (tapClip[k] || v >= s.rollHi[p]) continue;
        const e = s.exposure;
        let w = (e * e) / ((ch.alpha * s.shot * xHat * e + ch.beta) * s.varFactor);
        const lo = s.rollLo[p];
        if (v > lo) {
          const t = (v - lo) / (s.rollHi[p] - lo);
          w *= 1 - t * t * (3 - 2 * t);
        }
        if (rowWeights && motion) {
          const fx = Math.min(Math.max(x / motion.block - 0.5, 0), motion.cols - 1);
          const x0 = Math.min(fx | 0, motion.cols - 2);
          const tx = fx - x0;
          const rw = rowWeights[k];
          w *= rw[x0] * (1 - tx) + rw[x0 + 1] * tx;
        }
        ws[k] = w;
        sw += w;
        swx += w * xs[k];
        if (inPreviewY) {
          const pcol = Math.floor((x >> 1) / pf);
          if (pcol < pw) pWeight[(prow * pw + pcol) * nS + k] += w;
        }
      }

      let value: number;
      const idx = y * W + x;
      if (sw > 0) {
        value = swx / sw;
        variance[idx] = 1 / sw;
      } else {
        // Every frame clipped: keep the darkest frame's value as a lower bound.
        value = xs[used - 1];
        variance[idx] = Infinity;
        clippedSamples++;
      }
      data[idx] = value;
      if (value > maxSignal) maxSignal = value;

      if (inPreviewY) {
        const pcol = Math.floor((x >> 1) / pf);
        if (pcol < pw) {
          const o = prow * pw + pcol;
          pSum[o * 3 + cfaColors[p]] += value / referenceRange;
          if (sw <= 0) pClip[o] |= 1 << cfaColors[p];
        }
      }
    }
  }

  // Normalised weight shares and the per-bin dominant frame.
  const sourceMap = new Uint8Array(pw * ph);
  for (let o = 0; o < pw * ph; o++) {
    let total = 0;
    let bestK = 0;
    for (let k = 0; k < nS; k++) {
      const w = pWeight[o * nS + k];
      total += w;
      if (w > pWeight[o * nS + bestK]) bestK = k;
    }
    sourceMap[o] = sources[bestK].index;
    if (total > 0) for (let k = 0; k < nS; k++) shareSum[k] += pWeight[o * nS + k] / total;
  }
  const shareTotal = shareSum.reduce((a, b) => a + b, 0) || 1;
  const weightShare = new Array<number>(frames.length).fill(0);
  sources.forEach((s, k) => (weightShare[s.index] = shareSum[k] / shareTotal));

  const rgb = new Float32Array(pw * ph * 3);
  for (let o = 0; o < pw * ph; o++) for (let c = 0; c < 3; c++) rgb[o * 3 + c] = pSum[o * 3 + c] / perColor[c];

  // How much weight deghosting removed, per preview pixel.
  let ghostMap: Uint8Array | null = null;
  if (motion) {
    ghostMap = new Uint8Array(pw * ph);
    for (let oy = 0; oy < ph; oy++) {
      for (let ox = 0; ox < pw; ox++) {
        const x = (ox + 0.5) * 2 * pf;
        const y = (oy + 0.5) * 2 * pf;
        const fx = Math.min(Math.max(x / motion.block - 0.5, 0), motion.cols - 1);
        const fy = Math.min(Math.max(y / motion.block - 0.5, 0), motion.rows - 1);
        let removed = 0;
        for (const w of motion.weights) removed = Math.max(removed, 1 - w[Math.round(fy) * motion.cols + Math.round(fx)]);
        ghostMap[oy * pw + ox] = Math.round(255 * removed);
      }
    }
  }

  const brightest = sources[0];
  const floor = Math.sqrt(Math.min(...noise.channels.map((c) => c.beta))) / brightest.exposure;
  return {
    image: { width: W, height: H, data, variance, cfaColors, referenceRange },
    preview: { width: pw, height: ph, rgb, clip: pClip },
    sourceMap,
    weightShare,

    clippedFraction: clippedSamples / (W * H),
    dynamicRangeStops: Math.log2(maxSignal / floor),
    ghostMap,
  };
}

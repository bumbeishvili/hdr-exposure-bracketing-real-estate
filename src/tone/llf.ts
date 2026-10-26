// Local Laplacian filtering (Paris, Hasinoff & Kautz 2011, in the fast form of
// Aubry et al. 2014) on log luminance. Every pyramid coefficient takes the value
// it would have if the image were remapped around that coefficient's own local
// brightness: differences smaller than σ (texture, detail) are kept or enhanced,
// larger steps (a window against a wall, a lamp against a ceiling) are
// compressed by β. It compresses dynamic range without halos — the operator
// behind Lightroom's Highlights, Shadows and Clarity. Two conditions keep it
// halo-free: the pyramid goes down to a single pixel (so every scale is
// compressed by the same rule), and the remapping is symmetric (betaDark and
// the knee exist for experiments; uneven slopes overshoot at large steps).

import { collapse, gaussianPyramid, upsample, type Plane } from './pyramid.ts';

export interface LlfParams {
  /** Detail/edge threshold, in the input's units (stops, for log2 luminance). */
  sigma: number;
  /** Detail exponent: below 1 enhances differences smaller than sigma, 1 keeps them. */
  alpha: number;
  /** Edge slope: below 1 compresses differences larger than sigma. */
  beta: number;
  /** Slope for darker-than-local differences beyond sigma (default: beta); higher keeps blacks deep. */
  betaDark?: number;
  /** Brighter-than-local differences beyond this many units use `betaKnee` (windows, lamps). */
  knee?: number;
  betaKnee?: number;
  /** Reference levels across the input's range; default keeps them 0.6 σ apart. */
  levels?: number;
}

/** Remapping of a difference d from the local level: detail curve inside ±σ, compressed slopes outside. */
export function remapper(p: LlfParams): (d: number) => number {
  const { sigma, alpha, beta } = p;
  const betaDark = p.betaDark ?? beta;
  const knee = Math.max(p.knee ?? Infinity, sigma);
  const betaKnee = p.betaKnee ?? beta;
  const atKnee = sigma + beta * (knee - sigma);
  // t^α tabulated on [0, 1]; below t0 the gain is held at 2 so noise is not amplified without bound.
  const t0 = alpha < 1 ? 2 ** (1 / (alpha - 1)) : 0;
  const N = 1024;
  const table = Float32Array.from({ length: N + 1 }, (_, i) => {
    const t = i / N;
    return alpha === 1 ? t : t < t0 ? 2 * t : t ** alpha;
  });
  return (d: number): number => {
    const a = d < 0 ? -d : d;
    if (a >= sigma) {
      if (d < 0) return -(sigma + betaDark * (a - sigma));
      return a > knee ? atKnee + betaKnee * (a - knee) : sigma + beta * (a - sigma);
    }
    const x = (a / sigma) * N;
    const i = x | 0;
    const r = sigma * (table[i] + (table[i + 1] - table[i]) * (x - i));
    return d < 0 ? -r : r;
  };
}

/** Pyramid depth for an image: down to a single-pixel residual. */
export function pyramidDepth(w: number, h: number): number {
  return Math.max(1, Math.ceil(Math.log2(Math.max(w, h))) + 1);
}

/** Filters a single-channel plane; returns the result (same size). */
export function localLaplacian(input: Float32Array, w: number, h: number, p: LlfParams): Float32Array {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of input) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!(hi > lo)) return Float32Array.from(input);
  const K = p.levels ?? Math.min(32, Math.max(6, Math.ceil((hi - lo) / (0.6 * p.sigma)) + 1));
  const step = (hi - lo) / (K - 1);
  const depth = pyramidDepth(w, h);
  const gauss = gaussianPyramid({ data: input, w, h }, depth);
  const out: Plane[] = gauss.slice(0, depth - 1).map((g) => ({ data: new Float32Array(g.data.length), w: g.w, h: g.h }));
  const remap = remapper(p);
  const remapped = new Float32Array(input.length);
  for (let k = 0; k < K; k++) {
    const g0 = lo + k * step;
    for (let i = 0; i < input.length; i++) remapped[i] = g0 + remap(input[i] - g0);
    const pyr = gaussianPyramid({ data: remapped, w, h }, depth);
    for (let l = 0; l < depth - 1; l++) {
      const up = upsample(pyr[l + 1], pyr[l].w, pyr[l].h);
      const local = gauss[l].data;
      const src = pyr[l].data;
      const dst = out[l].data;
      for (let i = 0; i < dst.length; i++) {
        // Hat weight of this reference level at the input's local value.
        const t = (local[i] - g0) / step;
        const wgt = 1 - (t < 0 ? -t : t);
        if (wgt > 0) dst[i] += wgt * (src[i] - up[i]);
      }
    }
  }
  return collapse([...out, gauss[depth - 1]]);
}

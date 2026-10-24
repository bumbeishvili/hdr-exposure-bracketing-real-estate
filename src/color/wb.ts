// White balance for interiors. Real-estate edits want walls and ceilings
// neutral, so the estimate looks for the white point that makes the most
// interior surface area neutral: interior pixels are histogrammed in log-chroma
// (ln r/g, ln b/g), where a white-balance change is a pure translation; the
// daylight–tungsten locus is searched for the point with the most mass nearby,
// and a mean shift settles on the centre of that neutral cluster. Windows and
// lamps are excluded: their light is not the light the room is lit by.

import type { CameraProfile } from './dcp.ts';
import { colorTransform, neutralForTemperature, normalizeMax, type Vec3 } from './color.ts';

export interface WhiteBalanceEstimate {
  /** Camera neutral, normalised to max 1. */
  neutral: Vec3;
  temperature: number;
  tint: number;
  /** Share of the considered interior pixels that are near-neutral under this white balance. */
  coverage: number;
}

export interface WbOptions {
  /** Chroma radius (in ln units, ≈ fraction) counted as neutral. */
  radius?: number;
  /** Interior band relative to the median luminance. */
  minRelative?: number;
  maxRelative?: number;
}

const U0 = -3;
const V0 = -3;
const SPAN = 4;
const BINS = 400;
const STEP = SPAN / BINS;

/** Estimates an interior white balance from linear camera RGB (interleaved, not white-balanced). */
export function estimateInteriorWhiteBalance(profile: CameraProfile, rgb: Float32Array, opts: WbOptions = {}): WhiteBalanceEstimate {
  const radius = opts.radius ?? 0.04;
  const count = rgb.length / 3;
  const lum = new Float32Array(count);
  for (let i = 0; i < count; i++) lum[i] = 0.25 * rgb[3 * i] + 0.5 * rgb[3 * i + 1] + 0.25 * rgb[3 * i + 2];
  const sorted = Float32Array.from(lum).sort();
  const median = sorted[sorted.length >> 1] || 1e-3;
  const lo = median * (opts.minRelative ?? 0.3);
  const hi = median * (opts.maxRelative ?? 6);

  // Luminance-weighted histogram of interior pixels in log-chroma.
  const hist = new Float32Array(BINS * BINS);
  const us: number[] = [];
  const vs: number[] = [];
  const ws: number[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const y = lum[i];
    const r = rgb[3 * i];
    const g = rgb[3 * i + 1];
    const b = rgb[3 * i + 2];
    if (y < lo || y > hi || r <= 0 || g <= 0 || b <= 0) continue;
    const u = Math.log(r / g);
    const v = Math.log(b / g);
    const bu = Math.floor((u - U0) / STEP);
    const bv = Math.floor((v - V0) / STEP);
    if (bu < 0 || bv < 0 || bu >= BINS || bv >= BINS) continue;
    const w = Math.sqrt(y);
    hist[bv * BINS + bu] += w;
    us.push(u);
    vs.push(v);
    ws.push(w);
    total += w;
  }
  if (!total) return withTemperature(profile, neutralForTemperature(profile, 5500, 10), 0);

  const massNear = (u: number, v: number): number => {
    const r = Math.ceil(radius / STEP);
    const cu = Math.floor((u - U0) / STEP);
    const cv = Math.floor((v - V0) / STEP);
    let m = 0;
    for (let dv = -r; dv <= r; dv++) {
      for (let du = -r; du <= r; du++) {
        const bu = cu + du;
        const bv = cv + dv;
        if (bu < 0 || bv < 0 || bu >= BINS || bv >= BINS) continue;
        const d2 = (du * du + dv * dv) * STEP * STEP;
        if (d2 > radius * radius) continue;
        m += hist[bv * BINS + bu] * (1 - d2 / (radius * radius));
      }
    }
    return m;
  };

  // Search the locus: temperature 2400–10000 K, tint −20…+50.
  let best = { score: -1, u: 0, v: 0 };
  for (let k = 0; k <= 80; k++) {
    const t = 2400 * (10000 / 2400) ** (k / 80);
    for (let tint = -20; tint <= 50; tint += 5) {
      const n = neutralForTemperature(profile, t, tint);
      const u = Math.log(n[0] / n[1]);
      const v = Math.log(n[2] / n[1]);
      const score = massNear(u, v);
      if (score > best.score) best = { score, u, v };
    }
  }

  // Mean shift towards the centre of the neutral cluster.
  let { u, v } = best;
  for (let it = 0; it < 10; it++) {
    let su = 0;
    let sv = 0;
    let sw = 0;
    for (let i = 0; i < us.length; i++) {
      const d2 = (us[i] - u) ** 2 + (vs[i] - v) ** 2;
      if (d2 > radius * radius) continue;
      const w = ws[i] * (1 - d2 / (radius * radius));
      su += w * us[i];
      sv += w * vs[i];
      sw += w;
    }
    if (!sw) break;
    const nu = su / sw;
    const nv = sv / sw;
    const moved = Math.hypot(nu - u, nv - v);
    u = nu;
    v = nv;
    if (moved < 1e-4) break;
  }
  return withTemperature(profile, normalizeMax([Math.exp(u), 1, Math.exp(v)]), massNear(u, v) / total);
}

/** White balance from a patch the user marks as neutral (mean camera RGB of the patch). */
export function whiteBalanceFromPatch(profile: CameraProfile, rgb: Vec3): WhiteBalanceEstimate {
  return withTemperature(profile, normalizeMax(rgb), 1);
}

export function withTemperature(profile: CameraProfile, neutral: Vec3, coverage: number): WhiteBalanceEstimate {
  const t = colorTransform(profile, neutral);
  return { neutral: t.neutral, temperature: t.temperature, tint: t.tint, coverage };
}

// Sony's embedded lens corrections, decoded as darktable decodes them: knots
// spread evenly over the radius from the centre (0) to the corner (1 = half the
// diagonal), linearly interpolated.
//   distortion:  input radius = output radius × (1 + d · 2⁻¹⁴)
//   lateral CA:  red / blue additionally × (1 + c · 2⁻²¹)
//   vignetting:  relative illumination 2^(0.5 − 2^(v · 2⁻¹³ − 1)); dividing by it evens the field

import type { LensCorrectionParams } from '../raw/arw.ts';

export interface LensModel {
  /** Radial scale per knot, output → input. */
  distortion: Float64Array | null;
  /** Extra radial scale for red and blue per knot (lateral chromatic aberration). */
  caRed: Float64Array | null;
  caBlue: Float64Array | null;
  /** Relative illumination per knot (1 at the centre). */
  vignetting: Float64Array | null;
}

export function sonyLensModel(p: LensCorrectionParams | null): LensModel | null {
  if (!p) return null;
  const map = (v: number[] | null, f: (x: number) => number): Float64Array | null => (v && v.length >= 2 ? Float64Array.from(v, f) : null);
  return {
    distortion: map(p.distortion, (d) => 1 + d * 2 ** -14),
    caRed: map(p.caRed, (c) => 1 + c * 2 ** -21),
    caBlue: map(p.caBlue, (c) => 1 + c * 2 ** -21),
    vignetting: map(p.vignetting, (v) => 2 ** (0.5 - 2 ** (v * 2 ** -13 - 1))),
  };
}

/** Linear interpolation over knots evenly spaced on [0, 1]; flat beyond the ends. */
export function knotValue(values: Float64Array, r: number): number {
  const t = Math.min(Math.max(r, 0), 1) * (values.length - 1);
  const i = Math.min(Math.floor(t), values.length - 2);
  const f = t - i;
  return values[i] * (1 - f) + values[i + 1] * f;
}

/** Output → input radial scale for a channel (0 R, 1 G, 2 B) at normalised radius r. */
export function radialScale(model: LensModel, r: number, channel = 1): number {
  let s = model.distortion ? knotValue(model.distortion, r) : 1;
  if (channel === 0 && model.caRed) s *= knotValue(model.caRed, r);
  if (channel === 2 && model.caBlue) s *= knotValue(model.caBlue, r);
  return s;
}

/** Divides interleaved linear RGB by the lens's relative illumination, in place. */
export function devignette(rgb: Float32Array, w: number, h: number, model: LensModel): void {
  const vig = model.vignetting;
  if (!vig) return;
  const cx = w / 2;
  const cy = h / 2;
  const norm = 1 / Math.hypot(cx, cy);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const g = 1 / knotValue(vig, Math.hypot(x + 0.5 - cx, y + 0.5 - cy) * norm);
      const o = (y * w + x) * 3;
      rgb[o] *= g;
      rgb[o + 1] *= g;
      rgb[o + 2] *= g;
    }
  }
}

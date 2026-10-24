// Turns a linear camera-RGB preview into display pixels: white balance, gain,
// sRGB transfer, and an optional clipping overlay. Inspection only; colour is
// camera RGB until phase 9 brings a calibrated camera matrix.

import type { PreviewData } from '../analysis/preview.ts';

export interface RenderOptions {
  /** Linear gain applied after white balance. */
  gain: number;
  /** R, G, B multipliers, green = 1. */
  wb: readonly [number, number, number];
  showClipping: boolean;
}

/** Overlay colours: status "serious" for some channels clipped, "critical" for all. */
const PARTIAL = [0xec, 0x83, 0x5a];
const FULL = [0xd0, 0x3b, 0x3b];

const LUT_SIZE = 16384;
const SRGB = (() => {
  const lut = new Uint8ClampedArray(LUT_SIZE + 1);
  for (let i = 0; i <= LUT_SIZE; i++) {
    const v = i / LUT_SIZE;
    lut[i] = Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  }
  return lut;
})();

export function renderPreview(p: PreviewData, opt: RenderOptions, out: ImageData): void {
  const { rgb, clip } = p;
  const data = out.data;
  const kr = opt.gain * opt.wb[0] * LUT_SIZE;
  const kg = opt.gain * opt.wb[1] * LUT_SIZE;
  const kb = opt.gain * opt.wb[2] * LUT_SIZE;
  const n = p.width * p.height;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let r = SRGB[lutIndex(rgb[3 * i] * kr)];
    let g = SRGB[lutIndex(rgb[3 * i + 1] * kg)];
    let b = SRGB[lutIndex(rgb[3 * i + 2] * kb)];
    if (opt.showClipping && clip[i]) {
      const c = clip[i] === 7 ? FULL : PARTIAL;
      r = (r * 0.25 + c[0] * 0.75) | 0;
      g = (g * 0.25 + c[1] * 0.75) | 0;
      b = (b * 0.25 + c[2] * 0.75) | 0;
    }
    data[j] = r;
    data[j + 1] = g;
    data[j + 2] = b;
    data[j + 3] = 255;
  }
}

function lutIndex(v: number): number {
  return v <= 0 ? 0 : v >= LUT_SIZE ? LUT_SIZE : v | 0;
}

/** Gain that maps the log-average luminance of unclipped pixels to middle grey. */
export function autoGain(p: PreviewData, wb: readonly [number, number, number]): number {
  let sum = 0;
  let count = 0;
  const step = Math.max(1, Math.floor((p.width * p.height) / 50000));
  for (let i = 0; i < p.width * p.height; i += step) {
    if (p.clip[i]) continue;
    const y = 0.2126 * p.rgb[3 * i] * wb[0] + 0.7152 * p.rgb[3 * i + 1] * wb[1] + 0.0722 * p.rgb[3 * i + 2] * wb[2];
    if (y <= 1e-5) continue;
    sum += Math.log(y);
    count++;
  }
  return count ? 0.18 / Math.exp(sum / count) : 1;
}

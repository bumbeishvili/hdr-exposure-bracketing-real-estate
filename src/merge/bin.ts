// Downsampled RGB straight from the merged CFA: each output pixel averages the
// R, G and B samples of n × n Bayer quads. No interpolation, so no demosaic
// artifacts, at 1/(2n) of the linear resolution.

import type { MergedImage } from './merge.ts';

export interface RgbImage {
  width: number;
  height: number;
  /** Interleaved linear camera RGB, 1.0 = the reference frame's white level. */
  rgb: Float32Array;
}

export function binMerged(img: MergedImage, quads: number): RgbImage {
  const width = Math.floor(img.width / (2 * quads));
  const height = Math.floor(img.height / (2 * quads));
  const rgb = new Float32Array(width * height * 3);
  const perColor = [0, 0, 0];
  for (const c of img.cfaColors) perColor[c] += quads * quads;
  const scale = perColor.map((n) => 1 / (n * img.referenceRange));
  const span = 2 * quads;
  const acc = new Float64Array(width * 3);
  for (let oy = 0; oy < height; oy++) {
    acc.fill(0);
    for (let yy = 0; yy < span; yy++) {
      const y = oy * span + yy;
      const row = y * img.width;
      const py = (y & 1) << 1;
      for (let x = 0; x < width * span; x++) acc[Math.floor(x / span) * 3 + img.cfaColors[py | (x & 1)]] += img.data[row + x];
    }
    for (let ox = 0; ox < width; ox++) {
      const o = (oy * width + ox) * 3;
      rgb[o] = acc[ox * 3] * scale[0];
      rgb[o + 1] = acc[ox * 3 + 1] * scale[1];
      rgb[o + 2] = acc[ox * 3 + 2] * scale[2];
    }
  }
  return { width, height, rgb };
}

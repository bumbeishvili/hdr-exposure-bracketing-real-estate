// Downsampled linear preview built straight from the CFA, without demosaicing:
// each output pixel averages the R, G and B samples of factor × factor Bayer quads.

import { cfaIndex, type RawFrame } from '../raw/arw.ts';

export interface PreviewData {
  width: number;
  height: number;
  /** Interleaved linear camera RGB, black-subtracted; 1.0 is the white level. */
  rgb: Float32Array;
  /** Per pixel: bit 0, 1, 2 set when any R, G, B sample in the bin is clipped. */
  clip: Uint8Array;
}

export function makePreview(frame: RawFrame, maxWidth = 960): PreviewData {
  const { crop, cfa, width: W, whiteLevel, blackLevel } = frame;
  const colors = frame.cfaPattern.colors;
  const quadsX = crop.width >> 1;
  const quadsY = crop.height >> 1;
  const f = Math.max(1, Math.ceil(quadsX / maxWidth));
  const ow = Math.floor(quadsX / f);
  const oh = Math.floor(quadsY / f);
  const span = 2 * f;

  const scale = blackLevel.map((b) => 1 / (whiteLevel - b));
  const perColor = [0, 0, 0];
  for (const c of colors) perColor[c] += f * f;

  const rgb = new Float32Array(ow * oh * 3);
  const clip = new Uint8Array(ow * oh);
  const acc = new Float64Array(ow * 3);
  const flags = new Uint8Array(ow);
  for (let oy = 0; oy < oh; oy++) {
    acc.fill(0);
    flags.fill(0);
    for (let yy = 0; yy < span; yy++) {
      const y = crop.top + oy * span + yy;
      const row = y * W;
      for (let ox = 0; ox < ow; ox++) {
        const x0 = crop.left + ox * span;
        let fl = 0;
        for (let xx = 0; xx < span; xx++) {
          const x = x0 + xx;
          const p = cfaIndex(x, y);
          const v = cfa[row + x];
          const c = colors[p];
          acc[ox * 3 + c] += (v - blackLevel[p]) * scale[p];
          if (v >= whiteLevel) fl |= 1 << c;
        }
        flags[ox] |= fl;
      }
    }
    for (let ox = 0; ox < ow; ox++) {
      const o = oy * ow + ox;
      rgb[o * 3] = acc[ox * 3] / perColor[0];
      rgb[o * 3 + 1] = acc[ox * 3 + 1] / perColor[1];
      rgb[o * 3 + 2] = acc[ox * 3 + 2] / perColor[2];
      clip[o] = flags[ox];
    }
  }
  return { width: ow, height: oh, rgb, clip };
}

// Demosaics rectangles of the merged CFA. Rectangles are padded by the
// algorithm's border with mirrored samples (keeping the CFA phase), white
// balanced so the colour planes are comparable, demosaiced, and the white
// balance divided back out: output is camera RGB with 1.0 = the reference
// frame's white level, like every other preview in the app.

import type { MergedImage } from '../merge/merge.ts';
import { bilinear, rcd, rcdScratch, RCD_BORDER, type RcdScratch } from './rcd.ts';

export type DemosaicAlgorithm = 'rcd' | 'bilinear';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What demosaicing reads of a merged image (a slice of rows works too). */
export type CfaImage = Pick<MergedImage, 'width' | 'height' | 'data' | 'cfaColors' | 'referenceRange'>;

export interface RgbTile {
  rect: Rect;
  /** Interleaved camera RGB. */
  rgb: Float32Array;
}

/** Mirror an index into [0, n) around the edge sample, which keeps the CFA phase. */
function reflect(i: number, n: number): number {
  if (i < 0) return -i;
  if (i >= n) return 2 * (n - 1) - i;
  return i;
}

/**
 * Demosaics `rect` (clamped to the image; x and y rounded down to even, so the
 * CFA phase is the image's) of a merged image.
 */
export function demosaicRect(img: CfaImage, rect: Rect, wb: readonly [number, number, number], algorithm: DemosaicAlgorithm = 'rcd', scratch?: RcdScratch): RgbTile {
  const x = Math.max(0, Math.min(img.width - 2, rect.x & ~1));
  const y = Math.max(0, Math.min(img.height - 2, rect.y & ~1));
  const width = Math.min(rect.width, img.width - x);
  const height = Math.min(rect.height, img.height - y);
  const B = RCD_BORDER;
  const pw = width + 2 * B;
  const ph = height + 2 * B;
  const n = pw * ph;
  const cfa = new Float32Array(n);
  const colors = img.cfaColors;
  const scale = colors.map((c) => wb[c] / img.referenceRange);
  for (let yy = 0; yy < ph; yy++) {
    const sy = reflect(y - B + yy, img.height);
    const row = sy * img.width;
    const py = (yy & 1) << 1;
    for (let xx = 0; xx < pw; xx++) {
      const sx = reflect(x - B + xx, img.width);
      const v = img.data[row + sx] * scale[py | (xx & 1)];
      cfa[yy * pw + xx] = v > 0 ? v : 0;
    }
  }
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  if (algorithm === 'rcd') rcd(cfa, pw, ph, colors, r, g, b, scratch);
  else bilinear(cfa, pw, ph, colors, r, g, b);

  const rgb = new Float32Array(width * height * 3);
  const inv = [1 / wb[0], 1 / wb[1], 1 / wb[2]];
  for (let yy = 0; yy < height; yy++) {
    let i = (yy + B) * pw + B;
    let o = yy * width * 3;
    for (let xx = 0; xx < width; xx++, i++, o += 3) {
      rgb[o] = r[i] * inv[0];
      rgb[o + 1] = g[i] * inv[1];
      rgb[o + 2] = b[i] * inv[2];
    }
  }
  return { rect: { x, y, width, height }, rgb };
}

/** Reusable scratch buffers for a given tile size, so a full-image pass allocates once. */
export function scratchFor(tile: number): RcdScratch {
  return rcdScratch((tile + 2 * RCD_BORDER) ** 2);
}

// Phase 5 check on synthetic scenes with a known answer: mosaic a full-colour
// image, demosaic it, and compare. RCD must beat bilinear clearly on fine
// detail and must not invent zipper patterns along edges.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demosaicRect, type DemosaicAlgorithm } from '../src/demosaic/demosaic.ts';
import type { MergedImage } from '../src/merge/merge.ts';

const W = 384;
const H = 256;
const COLORS = [0, 1, 1, 2]; // RGGB

type Scene = (x: number, y: number) => [number, number, number];

/**
 * Natural-image-like detail: high-frequency luminance (a zone plate up to ~0.3
 * cycles/px, an oblique fine grating, hard edges) over slowly varying chroma.
 */
const detailScene: Scene = (x, y) => {
  const cx = x - W / 2;
  const cy = y - H / 2;
  const zone = 0.5 + 0.5 * Math.cos((cx * cx + cy * cy) / 260);
  const grating = x < 120 ? 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.22 * (x * 0.8 + y * 0.6)) : 0.5;
  const edges = (Math.hypot(cx - 120, cy + 40) < 40 ? 0.35 : 0) + (x + 0.4 * y > 330 ? 0.25 : 0);
  const lum = 0.15 + 0.45 * (x < 120 ? grating : zone) + edges;
  const t = x / W;
  return [lum * (0.8 + 0.3 * t), lum * 0.9, lum * (1.1 - 0.3 * t)];
};

function mosaic(scene: Scene): { img: MergedImage; truth: Float32Array } {
  const data = new Float32Array(W * H);
  const truth = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const rgb = scene(x, y);
      truth.set(rgb, (y * W + x) * 3);
      data[y * W + x] = rgb[COLORS[((y & 1) << 1) | (x & 1)]];
    }
  }
  return { img: { width: W, height: H, data, variance: new Float32Array(0), cfaColors: COLORS, referenceRange: 1, clip: Infinity }, truth };
}

function psnr(img: MergedImage, truth: Float32Array, algorithm: DemosaicAlgorithm, margin = 4): number {
  const out = demosaicRect(img, { x: 0, y: 0, width: W, height: H }, [1, 1, 1], algorithm).rgb;
  let se = 0;
  let n = 0;
  for (let y = margin; y < H - margin; y++) {
    for (let x = margin; x < W - margin; x++) {
      for (let c = 0; c < 3; c++) {
        const d = out[(y * W + x) * 3 + c] - truth[(y * W + x) * 3 + c];
        se += d * d;
        n++;
      }
    }
  }
  return 10 * Math.log10(1 / (se / n));
}

test('a flat colour field is reproduced exactly', () => {
  const { img, truth } = mosaic(() => [0.3, 0.5, 0.2]);
  assert.ok(psnr(img, truth, 'rcd', 0) > 80, 'RCD on a flat field');
});

test('RCD beats bilinear on detail by a wide margin', () => {
  const { img, truth } = mosaic(detailScene);
  const p = psnr(img, truth, 'rcd');
  const q = psnr(img, truth, 'bilinear');
  assert.ok(p > 32, `RCD PSNR ${p.toFixed(1)} dB`);
  assert.ok(p > q + 3, `RCD ${p.toFixed(1)} dB vs bilinear ${q.toFixed(1)} dB`);
});

test('no zipper along a sharp neutral edge', () => {
  // Vertical step edge: every row is the same, so any row-to-row alternation is an artifact.
  const { img } = mosaic((x) => (x < W / 2 + 0.5 ? [0.1, 0.1, 0.1] : [0.8, 0.8, 0.8]));
  const zipper = (algorithm: DemosaicAlgorithm): number => {
    const out = demosaicRect(img, { x: 0, y: 0, width: W, height: H }, [1, 1, 1], algorithm).rgb;
    let worst = 0;
    for (let y = 10; y < H - 11; y++) {
      for (let x = W / 2 - 3; x < W / 2 + 3; x++) {
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(out[(y * W + x) * 3 + c] - out[((y + 1) * W + x) * 3 + c]));
      }
    }
    return worst;
  };
  const z = zipper('rcd');
  assert.ok(z < 0.02, `RCD row-to-row alternation ${z.toFixed(4)} on a 0.7 step`);
});

test('the tile path matches a single pass', () => {
  const { img } = mosaic(detailScene);
  const whole = demosaicRect(img, { x: 0, y: 0, width: W, height: H }, [1, 1, 1], 'rcd').rgb;
  const part = demosaicRect(img, { x: 100, y: 60, width: 128, height: 96 }, [1, 1, 1], 'rcd');
  let worst = 0;
  for (let y = 0; y < part.rect.height; y++) {
    for (let x = 0; x < part.rect.width; x++) {
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(part.rgb[(y * part.rect.width + x) * 3 + c] - whole[((y + 60) * W + x + 100) * 3 + c]));
    }
  }
  assert.ok(worst < 1e-5, `tile vs whole max difference ${worst}`);
});

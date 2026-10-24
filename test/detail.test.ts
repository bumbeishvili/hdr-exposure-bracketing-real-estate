// Full-resolution export on a synthetic room with a bright window: the render
// must match the quarter-size look it is built on when scaled down, carry the
// fine detail that look lacks, and come out the same whether rendered in one
// pass or in chunks from row slices (as the render-worker pool does).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readDcp } from '../src/color/dcp.ts';
import { colorTransform, type Vec3 } from '../src/color/color.ts';
import { binMerged } from '../src/merge/bin.ts';
import type { MergedImage } from '../src/merge/merge.ts';
import { REAL_ESTATE_LOOK, renderLook, toRgba8, type LookBase } from '../src/look/render.ts';
import { chunkInputs, demosaicSource, renderRows, type DetailJob } from '../src/look/detail.ts';
import { applyWarp, geometryWarp, type UprightWarp } from '../src/geometry/upright.ts';
import { devignette, sonyLensModel } from '../src/geometry/lens.ts';
import type { Matrix3 } from '../src/color/dcp.ts';

const profile = readDcp(new Uint8Array(readFileSync(new URL('../src/color/profiles/Sony ILCE-7M4 Adobe Standard.dcp', import.meta.url))));
const W = 512;
const H = 384;
const COLORS = [0, 1, 1, 2];
const RANGE = 15871;
const NEUTRAL: Vec3 = [0.45, 1, 0.7];

/** Camera RGB (1 = white) of a room: textured walls and floor, fine stripes, a window up to 5× white. */
function scene(x: number, y: number): [number, number, number] {
  const window = x > 300 && x < 460 && y > 60 && y < 240;
  if (window) {
    const sky = 3 + 2 * Math.sin(x / 9) * Math.cos(y / 13);
    const bar = Math.abs(x - 380) < 3 ? 0.08 : 1; // a mullion
    return [sky * 0.42 * bar, sky * bar, sky * 0.75 * bar];
  }
  const wall = 0.12 + 0.02 * Math.sin(x / 31) + (y > 280 ? 0.04 * Math.sin(x * 1.3) * Math.sin(y * 0.9) : 0);
  const stripes = x > 60 && x < 160 && y > 100 && y < 220 ? 0.06 * Math.sign(Math.sin(x * 1.1)) : 0;
  return [(wall + stripes) * 0.5, wall + stripes, (wall + stripes) * 0.72];
}

function merged(): MergedImage {
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = scene(x + 0.5, y + 0.5)[COLORS[((y & 1) << 1) | (x & 1)]] * RANGE;
  return { width: W, height: H, data, variance: new Float32Array(0), cfaColors: COLORS, referenceRange: RANGE };
}

const look = { ...REAL_ESTATE_LOOK, neutral: NEUTRAL };
const wb: [number, number, number] = [NEUTRAL[1] / NEUTRAL[0], 1, NEUTRAL[1] / NEUTRAL[2]];

/** The quarter-size look and the full-resolution job built on it, as the pipeline worker builds them. */
function setup(rotation: Matrix3 | null, lensOn: boolean): { img: MergedImage; small: Uint8ClampedArray; base: LookBase; job: DetailJob } {
  const img = merged();
  const bin = binMerged(img, 2);
  const lens = lensOn ? sonyLensModel({ distortion: [1, -1, -4, -10, -18, -28, -40, -51, -62, -70, -75, -72, -61, -39, -4, 48], vignetting: [0, 0, 192, 560, 1088, 1792, 2592, 3424, 4304, 5216, 6128, 7056, 7968, 8864, 9728, 10560], caRed: [640, 640, 640, 512, 512, 512, 384, 384, 384, 384, 384, 384, 256, 256, 256, 128], caBlue: [-256, -256, -256, -256, -256, -256, -256, -256, -128, -128, -128, -128, 0, 0, 0, 128] }) : null;
  let work = bin;
  if (rotation || lens) {
    if (lens) devignette(bin.rgb, bin.width, bin.height, lens);
    const warp = geometryWarp(rotation, lens, bin.width, bin.height, bin.width);
    work = { width: warp.width, height: warp.height, rgb: applyWarp(bin.rgb, bin.width, bin.height, warp) };
  }
  const out = renderLook(work.rgb, work.width, work.height, profile, look, true);
  const small = new Uint8ClampedArray(work.width * work.height * 4);
  toRgba8(out.rgb, small);
  const base = out.base!;
  const width = 4 * base.width;
  const height = 4 * base.height;
  const warp: UprightWarp =
    rotation || lens
      ? geometryWarp(rotation, lens, W, H, W, { width, height })
      : { inverse: [1, 0, 0, 0, 1, 0, 0, 0, 1], width, height, sourceWidth: W, sourceHeight: H, scale: 1, lens: null };
  const job: DetailJob = {
    width,
    height,
    factor: 4,
    base: { width: base.width, height: base.height, y0: 0, rows: base.height, fused: base.fused, center: base.center },
    warp,
    vignetting: lens?.vignetting ?? null,
    transform: colorTransform(profile, NEUTRAL),
    gain: base.gain,
    exposures: base.exposures,
    finish: look,
  };
  return { img, small, base, job };
}

/** Renders in chunks from CFA and base row slices, like the worker pool. */
function chunked(img: MergedImage, base: LookBase, job: DetailJob, step: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(job.width * job.height * 4);
  for (let v0 = 0; v0 < job.height; v0 += step) {
    const v1 = Math.min(job.height, v0 + step);
    const need = chunkInputs(job, 'rcd', img.height, v0, v1);
    const [b0, b1] = need.base;
    const part = renderRows(
      { ...job, base: { width: base.width, height: base.height, y0: b0, rows: b1 - b0, fused: base.fused.slice(b0 * base.width * 3, b1 * base.width * 3), center: base.center.slice(b0 * base.width, b1 * base.width) } },
      demosaicSource({ width: W, height: need.cfa[1] - need.cfa[0], data: img.data.slice(need.cfa[0] * W, need.cfa[1] * W), cfaColors: COLORS, referenceRange: RANGE, offset: need.cfa[0] }, wb),
      v0,
      v1,
    );
    out.set(part, v0 * job.width * 4);
  }
  return out;
}

/** Mean absolute difference (levels) between the 4×-downscaled render and the small look. */
function coarseDifference(full: Uint8ClampedArray, small: Uint8ClampedArray, job: DetailJob): number {
  const bw = job.width / 4;
  const bh = job.height / 4;
  let sum = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let yy = 0; yy < 4; yy++) for (let xx = 0; xx < 4; xx++) acc += full[((4 * y + yy) * job.width + 4 * x + xx) * 4 + c];
        sum += Math.abs(acc / 16 - small[(y * bw + x) * 4 + c]);
      }
    }
  }
  return sum / (bw * bh * 3);
}

/** Mean |Laplacian| of green over a region: fine detail. */
function fineDetail(rgba: Uint8ClampedArray, w: number, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const g = (xx: number, yy: number): number => rgba[(yy * w + xx) * 4 + 1];
      sum += Math.abs(4 * g(x, y) - g(x - 1, y) - g(x + 1, y) - g(x, y - 1) - g(x, y + 1));
      n++;
    }
  }
  return sum / n;
}

test('the full-resolution render matches the look it is built on and adds the fine detail', () => {
  const { img, small, base, job } = setup(null, false);
  assert.equal(job.width, W);
  assert.equal(job.height, H);
  const full = renderRows(job, demosaicSource({ ...img, offset: 0 }, wb), 0, job.height);
  const diff = coarseDifference(full, small, job);
  assert.ok(diff < 2, `scaled down, it matches the small look: mean |Δ| ${diff.toFixed(2)} levels`);

  // The stripes and floor texture: the full render keeps them, the small look upsampled cannot.
  const up = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) up.set(small.subarray((((y >> 2) * (W >> 2)) + (x >> 2)) * 4, (((y >> 2) * (W >> 2)) + (x >> 2)) * 4 + 4), (y * W + x) * 4);
  const stripesFull = fineDetail(full, W, 70, 110, 150, 210);
  const stripesUp = fineDetail(up, W, 70, 110, 150, 210);
  assert.ok(stripesFull > 3 * stripesUp, `fine detail ${stripesFull.toFixed(1)} vs upsampled ${stripesUp.toFixed(1)}`);

  // The mullion in the window stays dark and narrow: no halo from the coarse fusion.
  const row = 150 * W;
  const mullion = full[(row + 380) * 4 + 1];
  const sky = Math.min(full[(row + 365) * 4 + 1], full[(row + 395) * 4 + 1]);
  assert.ok(sky - mullion > 60, `mullion ${mullion} against sky ${sky}`);
});

test('chunked rendering from row slices is identical to one pass', () => {
  for (const [rotation, lens] of [
    [null, false],
    [[1, 0, 0, 0, Math.cos(0.07), -Math.sin(0.07), 0, Math.sin(0.07), Math.cos(0.07)] as Matrix3, true],
  ] as const) {
    const { img, small, base, job } = setup(rotation, lens);
    const one = renderRows(job, demosaicSource({ ...img, offset: 0 }, wb), 0, job.height);
    const parts = chunked(img, base, job, 64);
    let differ = 0;
    for (let i = 0; i < one.length; i++) if (one[i] !== parts[i]) differ++;
    assert.equal(differ, 0, `${differ} bytes differ (${rotation ? 'upright + lens' : 'identity'})`);
    if (rotation) {
      assert.ok(job.width < W && job.height < H, 'the corrected crop is smaller, never upsampled');
      const diff = coarseDifference(one, small, job);
      assert.ok(diff < 2.5, `upright + lens: mean |Δ| ${diff.toFixed(2)} levels`);
    }
  }
});

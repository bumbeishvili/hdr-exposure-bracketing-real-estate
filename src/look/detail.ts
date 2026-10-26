// Full-resolution rendering. The look is computed at a quarter of the sensor's
// linear size (render.ts): the window pull, the local tone mapping and the
// per-image numbers (wall level, exposure, black point, dehaze). This renders
// the same look on the full-size image, band by band. The window pull is redone
// per pixel at full resolution, from the glass edge the small render measured
// (its distance, upsampled and scaled, and its blur at this scale). The
// tone mapping comes across as a gain: the small render's log gain, upsampled by
// a guided filter guided by the full-size luminance, so the gain's edges snap
// to the sharp image edges (no halos) while fine detail passes through in linear
// light (so the export averages back to exactly the small render). Colour and
// finishing are then applied per pixel exactly as in the small render.
// Geometry (lens distortion and lateral chromatic aberration, Upright) is a
// single bicubic resampling from the sensor image; vignetting is divided out at
// the sensor position.

import { cameraToProPhoto, type ColorTransform } from '../color/color.ts';
import type { CfaImage } from '../demosaic/demosaic.ts';
import { demosaicRect } from '../demosaic/demosaic.ts';
import { RCD_BORDER } from '../demosaic/rcd.ts';
import { knotValue } from '../geometry/lens.ts';
import type { UprightWarp } from '../geometry/upright.ts';
import type { FinishParams } from './finish.ts';
import { guidedFilter } from '../tone/guided.ts';
import { FAR, luminance, pullWindow, RADIUS, recoverPixel, toDisplay, toRgba8, viewShares, type LookScene } from './render.ts';

/** Camera RGB rows of the sensor image at output scale. */
export interface RowSource {
  width: number;
  height: number;
  /** Rows [y0, y1), clamped to what the source holds; interleaved camera RGB, full width. */
  rows(y0: number, y1: number): { y0: number; rows: number; rgb: Float32Array };
}

export interface DetailJob {
  /** Output size: `factor` times the base render's. */
  width: number;
  height: number;
  /** Output pixels per base pixel: 2 or 4. */
  factor: number;
  /** Rows [y0, y0 + rows) of the base render's maps (its full size is width × height; see LookBase). */
  base: { width: number; height: number; y0: number; rows: number; gain: Float32Array; distance: Float32Array; blur: Float32Array; frame: Float32Array };
  scene: LookScene;
  warp: UprightWarp;
  /** Relative illumination per knot, divided out; null leaves vignetting alone. */
  vignetting: Float64Array | null;
  /** Camera level where the merge clipped (Infinity: nowhere); see recoverPixel. */
  clip: number;
  transform: ColorTransform;
  finish: FinishParams;
}

/** Output rows per band; a multiple of every factor. */
export const DETAIL_BAND = 128;

/** Extra rows a band reads: the reach of the gain's guided upsampling (the window pull is per pixel). */
export function bandMargin(job: Pick<DetailJob, 'factor'>): number {
  return job.factor * Math.ceil((2 * job.factor + 2) / job.factor);
}

/** Renders output rows [v0, v1) (v0 a multiple of the factor) to 8-bit sRGB RGBA. */
export function renderRows(job: DetailJob, source: RowSource, v0: number, v1: number, onBand?: (rows: number) => void): Uint8ClampedArray {
  const out = new Uint8ClampedArray((v1 - v0) * job.width * 4);
  for (let b0 = v0; b0 < v1; b0 += DETAIL_BAND) {
    const b1 = Math.min(v1, b0 + DETAIL_BAND);
    toRgba8(renderBand(job, source, b0, b1), out, (b0 - v0) * job.width);
    onBand?.(b1 - b0);
  }
  return out;
}

/** Whether the base rows covering output rows [e0, e1) come within the bloom radius of glass. */
function glassNear(job: DetailJob, e0: number, e1: number): boolean {
  const { base, factor: F } = job;
  if (!base.distance.length) return false;
  const r0 = Math.max(base.y0, Math.floor(e0 / F) - 1);
  const r1 = Math.min(base.y0 + base.rows, Math.ceil(e1 / F) + 1);
  const reach = -(RADIUS.bloom * base.width + 2);
  for (let i = (r0 - base.y0) * base.width; i < (r1 - base.y0) * base.width; i++) if (base.distance[i] > reach && base.distance[i] > -FAR) return true;
  return false;
}

/** Display-referred linear sRGB for output rows [b0, b1). */
function renderBand(job: DetailJob, source: RowSource, b0: number, b1: number): Float32Array {
  const { width: W, height: H, factor: F, scene } = job;
  // Rows around the band for the gain's guided filter.
  const margin = bandMargin(job);
  const e0 = Math.max(0, b0 - margin);
  const e1 = Math.min(H, b1 + margin);
  const rows = e1 - e0;

  const { rgb: lin, clipped } = sampleCamera(job, source, e0, e1);
  cameraToProPhoto(job.transform, lin);
  const Y = luminance(lin);
  // The window pull, in place on the pixels, from the base render's glass edge.
  let pulled: Float32Array;
  if (scene.pull > 0 && glassNear(job, e0, e1)) {
    const at = (map: Float32Array, ch: number): Float32Array => upsampleBase(job, map, ch, e0, e1);
    pullWindow(lin, at(job.base.distance, 1), at(job.base.blur, 1), at(job.base.frame, 3), scene.pull, clipped, F, W);
    pulled = Float32Array.from(luminance(lin), Math.log2);
  } else pulled = Float32Array.from(Y, Math.log2);

  // The tone mapping's gain, upsampled along the full-size image's own edges.
  const gain = guidedFilter(pulled, upsampleBase(job, job.base.gain, 1, e0, e1), W, rows, F, 0.01);
  const at = (b0 - e0) * W;
  const m = (b1 - b0) * W;
  const tone = new Float32Array(m);
  const l = new Float32Array(m);
  for (let p = 0; p < m; p++) {
    tone[p] = pulled[at + p] + gain[at + p];
    l[p] = Math.log2(Y[at + p]);
  }
  const share = viewShares(l, pulled.subarray(at, at + m), scene.pull);
  const out = new Float32Array(m * 3);
  toDisplay(lin.subarray(at * 3, (at + m) * 3), pulled.subarray(at, at + m), tone, share, scene, job.transform, job.finish, out);
  return out;
}

/**
 * Bilinear interpolation of a coarse grid (gw × gh samples starting at global
 * coarse row cy0; rows [r0, r1) of it held in `grid`) at scale s, for output
 * rows [b0, b1) of width W.
 */
function interpolate(grid: Float32Array, gw: number, gh: number, cy0: number, ch: number, W: number, s: number, b0: number, b1: number, r0: number, r1: number): Float32Array {
  const { i0, frac } = axis(W, s, gw);
  const line = new Float32Array(gw * ch);
  const out = new Float32Array((b1 - b0) * W * ch);
  for (let v = b0; v < b1; v++) {
    const cy = Math.min(Math.max((v + 0.5) / s - 0.5 - cy0, 0), gh - 1);
    const ya = Math.min(cy | 0, Math.max(gh - 2, 0));
    const ty = cy - ya;
    const ra = (Math.min(Math.max(ya, r0), r1 - 1) - r0) * gw * ch;
    const rb = (Math.min(Math.max(ya + 1, r0), r1 - 1) - r0) * gw * ch;
    for (let g = 0; g < gw * ch; g++) line[g] = grid[ra + g] + (grid[rb + g] - grid[ra + g]) * ty;
    let o = (v - b0) * W * ch;
    if (ch === 3) {
      for (let u = 0; u < W; u++, o += 3) {
        const xa = i0[u] * 3;
        const xb = Math.min(i0[u] + 1, gw - 1) * 3;
        const tx = frac[u];
        out[o] = line[xa] + (line[xb] - line[xa]) * tx;
        out[o + 1] = line[xa + 1] + (line[xb + 1] - line[xa + 1]) * tx;
        out[o + 2] = line[xa + 2] + (line[xb + 2] - line[xa + 2]) * tx;
      }
    } else {
      for (let u = 0; u < W; u++, o++) {
        const xa = i0[u];
        const xb = Math.min(xa + 1, gw - 1);
        out[o] = line[xa] + (line[xb] - line[xa]) * frac[u];
      }
    }
  }
  return out;
}

/** Per output column: the left coarse sample and the interpolation fraction at scale s. */
function axis(W: number, s: number, n: number): { i0: Int32Array; frac: Float32Array } {
  const i0 = new Int32Array(W);
  const frac = new Float32Array(W);
  for (let u = 0; u < W; u++) {
    const c = Math.min(Math.max((u + 0.5) / s - 0.5, 0), n - 1);
    i0[u] = Math.min(c | 0, Math.max(n - 2, 0));
    frac[u] = c - i0[u];
  }
  return { i0, frac };
}

/** Bilinear upsampling of base-render rows to output rows [r0, r1). */
function upsampleBase(job: DetailJob, plane: Float32Array, ch: number, r0: number, r1: number): Float32Array {
  const { base } = job;
  return interpolate(plane, base.width, base.height, 0, ch, job.width, job.factor, r0, r1, base.y0, base.y0 + base.rows);
}

/** Catmull-Rom weights for fractional offset t. */
function cubic(t: number, w: Float64Array): void {
  const t2 = t * t;
  const t3 = t2 * t;
  w[0] = -0.5 * t3 + t2 - 0.5 * t;
  w[1] = 1.5 * t3 - 2.5 * t2 + 1;
  w[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
  w[3] = 0.5 * t3 - 0.5 * t2;
}

/** Sensor rows [y0, y1) a band of output rows reads, from the warp along the band's outline. */
function sourceRowsFor(warp: UprightWarp, e0: number, e1: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  const probe = (u: number, v: number): void => {
    for (let c = 0; c < 3; c++) {
      const y = sensorPoint(warp, u, v, c)[1];
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
  };
  for (let u = 0; u < warp.width + 32; u += 32) {
    probe(Math.min(u, warp.width - 1), e0);
    probe(Math.min(u, warp.width - 1), e1 - 1);
  }
  for (let v = e0; v < e1 + 8; v += 8) {
    probe(0, Math.min(v, e1 - 1));
    probe(warp.width - 1, Math.min(v, e1 - 1));
  }
  return [Math.floor(lo) - 2, Math.ceil(hi) + 3];
}

/** Sensor sample position (pixel-centre coordinates) of output pixel (u, v) for a channel. */
function sensorPoint(warp: UprightWarp, u: number, v: number, c: number): [number, number] {
  const m = warp.inverse;
  const zz = m[6] * (u + 0.5) + m[7] * (v + 0.5) + m[8];
  let x = (m[0] * (u + 0.5) + m[1] * (v + 0.5) + m[2]) / zz;
  let y = (m[3] * (u + 0.5) + m[4] * (v + 0.5) + m[5]) / zz;
  const lens = warp.lens;
  if (lens) {
    const cx = warp.sourceWidth / 2;
    const cy = warp.sourceHeight / 2;
    const r = Math.hypot(x - cx, y - cy) / Math.hypot(cx, cy);
    let k = lens.distortion ? knotValue(lens.distortion, r) : 1;
    if (c === 0 && lens.caRed) k *= knotValue(lens.caRed, r);
    if (c === 2 && lens.caBlue) k *= knotValue(lens.caBlue, r);
    x = cx + (x - cx) * k;
    y = cy + (y - cy) * k;
  }
  return [x - 0.5, y - 0.5];
}

/** Camera RGB at output rows [e0, e1): bicubic samples of the sensor image through the warp, devignetted. */
function sampleCamera(job: DetailJob, source: RowSource, e0: number, e1: number): { rgb: Float32Array; clipped: Float32Array | null } {
  const { warp, width: W } = job;
  const [s0, s1] = sourceRowsFor(warp, e0, e1);
  const src = source.rows(s0, s1);
  const S = source.width;
  const rgb = src.rgb;
  const yMax = src.rows - 1;
  const lens = warp.lens;
  const ca = !!lens && (!!lens.caRed || !!lens.caBlue);
  const vig = job.vignetting;
  const clip = job.clip;
  const neutral = job.transform.neutral;
  const cx = warp.sourceWidth / 2;
  const cy = warp.sourceHeight / 2;
  const invDiag = 1 / Math.hypot(cx, cy);
  const m = warp.inverse;
  const wx = new Float64Array(4);
  const wy = new Float64Array(4);
  const rowAt = new Int32Array(4);
  const colAt = new Int32Array(4);
  const out = new Float32Array((e1 - e0) * W * 3);
  const clipped = clip < Infinity ? new Float32Array((e1 - e0) * W) : null;
  const sample = (x: number, y: number, c0: number, c1: number, o: number): void => {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    cubic(x - xf, wx);
    cubic(y - yf, wy);
    for (let j = 0; j < 4; j++) {
      rowAt[j] = Math.min(Math.max(yf - 1 + j - src.y0, 0), yMax) * S * 3;
      colAt[j] = Math.min(Math.max(xf - 1 + j, 0), S - 1) * 3;
    }
    for (let c = c0; c < c1; c++) {
      let acc = 0;
      for (let j = 0; j < 4; j++) {
        const r = rowAt[j] + c;
        acc += wy[j] * (wx[0] * rgb[r + colAt[0]] + wx[1] * rgb[r + colAt[1]] + wx[2] * rgb[r + colAt[2]] + wx[3] * rgb[r + colAt[3]]);
      }
      out[o + c] = acc > 0 ? acc : 0;
    }
  };
  for (let v = e0; v < e1; v++) {
    for (let u = 0; u < W; u++) {
      const o = ((v - e0) * W + u) * 3;
      const zz = m[6] * (u + 0.5) + m[7] * (v + 0.5) + m[8];
      const xu = (m[0] * (u + 0.5) + m[1] * (v + 0.5) + m[2]) / zz - cx;
      const yu = (m[3] * (u + 0.5) + m[4] * (v + 0.5) + m[5]) / zz - cy;
      let kg = 1;
      let r = 0;
      if (lens) {
        r = Math.hypot(xu, yu) * invDiag;
        kg = lens.distortion ? knotValue(lens.distortion, r) : 1;
      }
      const xg = cx + xu * kg - 0.5;
      const yg = cy + yu * kg - 0.5;
      if (ca) {
        const kr = kg * (lens!.caRed ? knotValue(lens!.caRed, r) : 1);
        const kb = kg * (lens!.caBlue ? knotValue(lens!.caBlue, r) : 1);
        sample(cx + xu * kr - 0.5, cy + yu * kr - 0.5, 0, 1, o);
        sample(xg, yg, 1, 2, o);
        sample(cx + xu * kb - 0.5, cy + yu * kb - 0.5, 2, 3, o);
      } else sample(xg, yg, 0, 3, o);
      if (clipped) clipped[o / 3] = recoverPixel(out, o, neutral, clip);
      if (vig) {
        const g = 1 / knotValue(vig, Math.hypot(xg + 0.5 - cx, yg + 0.5 - cy) * invDiag);
        out[o] *= g;
        out[o + 1] *= g;
        out[o + 2] *= g;
      }
    }
  }
  return { rgb: out, clipped };
}

/**
 * What rendering output rows [v0, v1) reads: CFA rows (with room for the
 * demosaic's border, starting on an even row) and base-render rows.
 */
export function chunkInputs(job: Pick<DetailJob, 'warp' | 'factor' | 'width' | 'height' | 'base'>, source: 'rcd' | 'bin', cfaHeight: number, v0: number, v1: number): { cfa: [number, number]; base: [number, number] } {
  const F = job.factor;
  const margin = Math.max(F, bandMargin(job));
  const [s0, s1] = sourceRowsFor(job.warp, Math.max(0, v0 - margin), Math.min(job.height, v1 + margin));
  const cfa: [number, number] =
    source === 'rcd'
      ? [Math.max(0, (s0 - RCD_BORDER - 2) & ~1), Math.min(cfaHeight, s1 + RCD_BORDER + 2)]
      : [Math.max(0, 2 * s0 - 2) & ~1, Math.min(cfaHeight, 2 * s1 + 2)];
  const base: [number, number] = [Math.max(0, Math.floor((v0 - margin) / F) - 2), Math.min(job.base.height, Math.ceil((v1 + margin) / F) + 2)];
  return { cfa, base };
}

/** Rows of a merged CFA (or a slice of one starting at global row `offset`, an even row). */
export interface CfaRows extends CfaImage {
  offset: number;
}

/**
 * Full-resolution sensor rows, demosaiced with RCD on demand. The rows held
 * slide with the requests (bands ask for overlapping, mostly increasing
 * ranges), so each row is demosaiced about once.
 */
export function demosaicSource(img: CfaRows, wb: readonly [number, number, number]): RowSource {
  const W = img.width;
  let held = { y0: img.offset, rows: 0, rgb: new Float32Array(0) };
  const demosaic = (y0: number, y1: number, into: Float32Array, at: number): void => {
    // demosaicRect starts on an even row; keep the CFA phase and copy only [y0, y1).
    const start = (y0 - img.offset) & ~1;
    const tile = demosaicRect(img, { x: 0, y: start, width: W, height: y1 - img.offset - start }, wb, 'rcd');
    const skip = y0 - img.offset - tile.rect.y;
    into.set(tile.rgb.subarray(skip * W * 3, (skip + y1 - y0) * W * 3), (y0 - at) * W * 3);
  };
  return {
    width: W,
    height: img.height,
    rows(a: number, b: number) {
      const y0 = Math.max(a, img.offset);
      const y1 = Math.min(b, img.offset + img.height);
      const h0 = held.y0;
      const h1 = held.y0 + held.rows;
      if (y0 >= h0 && y1 <= h1) return held;
      const rgb = new Float32Array((y1 - y0) * W * 3);
      const k0 = Math.max(y0, h0);
      const k1 = Math.min(y1, h1);
      if (k1 > k0) {
        rgb.set(held.rgb.subarray((k0 - h0) * W * 3, (k1 - h0) * W * 3), (k0 - y0) * W * 3);
        if (y0 < k0) demosaic(y0, k0, rgb, y0);
        if (k1 < y1) demosaic(k1, y1, rgb, y0);
      } else demosaic(y0, y1, rgb, y0);
      held = { y0, rows: y1 - y0, rgb };
      return held;
    },
  };
}

/** Half-resolution sensor rows: each Bayer quad of the CFA becomes one RGB pixel (no demosaicing). */
export function binSource(img: CfaRows): RowSource {
  const W = img.width >> 1;
  const first = img.offset >> 1;
  const last = (img.offset + img.height) >> 1;
  const perColor = [0, 0, 0];
  for (const c of img.cfaColors) perColor[c]++;
  const scale = perColor.map((k) => 1 / (k * img.referenceRange));
  return {
    width: W,
    height: last - first,
    rows(a: number, b: number) {
      const y0 = Math.max(a, first);
      const y1 = Math.min(b, last);
      const rgb = new Float32Array((y1 - y0) * W * 3);
      for (let y = y0; y < y1; y++) {
        for (let q = 0; q < 4; q++) {
          const row = (2 * y + (q >> 1) - img.offset) * img.width;
          const c = img.cfaColors[q];
          const s = scale[c];
          for (let x = 0; x < W; x++) rgb[((y - y0) * W + x) * 3 + c] += img.data[row + 2 * x + (q & 1)] * s;
        }
      }
      return { y0, rows: y1 - y0, rgb };
    },
  };
}

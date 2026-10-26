// The tone tools behind the real-estate look, on synthetic images with a known
// answer: the local Laplacian remap and filter (range compression without
// halos), the box, morphology and guided filters, the nearest-seed distance
// transform, and the window pull: the glass edge measured on a blurred pane
// (past a strip of darker view along a bed, along a frame with dark view
// against it; the panes themselves are in panes.test.ts), the
// frame's colour beside it, the pull itself (the darker scene exactly: no glow,
// dark ring or colour fringe where the frame meets the view), and the window's
// light on the room near the glass evened out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localLaplacian, pyramidDepth, remapper, type LlfParams } from '../src/tone/llf.ts';
import { collapse, gaussianPyramid, laplacianPyramid, type Plane } from '../src/tone/pyramid.ts';
import { boxMean, guidedFilter, morph, nearestSeeds } from '../src/tone/guided.ts';
import { evenWindowLight, FAR, fillGlassHoles, frameColour, lampGlass, luminance, measureEdge, pullWindow, RADIUS, TONE, viewShares } from '../src/look/render.ts';

/** Deterministic uniform noise in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

test('remapper: continuous, monotonic, with the intended slopes', () => {
  const p: LlfParams = { sigma: 1.2, alpha: 0.8, beta: 0.6, betaDark: 0.85, knee: 2.5, betaKnee: 0.3 };
  const r = remapper(p);
  const eps = 1e-6;
  // Continuity at ±σ and at the knee.
  for (const x of [p.sigma, -p.sigma, p.knee!]) assert.ok(Math.abs(r(x + eps) - r(x - eps)) < 1e-4, `jump at ${x}: ${r(x - eps)} → ${r(x + eps)}`);
  // Monotonic over a wide range.
  let prev = -Infinity;
  for (let x = -8; x <= 8; x += 0.01) {
    const v = r(x);
    assert.ok(v >= prev - 1e-9, `not monotonic at ${x.toFixed(2)}`);
    prev = v;
  }
  // Slopes beyond σ, below −σ and beyond the knee; odd inside ±σ.
  const slope = (a: number, b: number): number => (r(b) - r(a)) / (b - a);
  assert.ok(Math.abs(slope(1.5, 2.2) - p.beta) < 1e-9, `beta slope ${slope(1.5, 2.2)}`);
  assert.ok(Math.abs(slope(-4, -2) - p.betaDark!) < 1e-9, `dark slope ${slope(-4, -2)}`);
  assert.ok(Math.abs(slope(3, 6) - p.betaKnee!) < 1e-9, `knee slope ${slope(3, 6)}`);
  for (const x of [0.05, 0.3, 0.9]) assert.ok(Math.abs(r(-x) + r(x)) < 1e-9);
  // Detail inside ±σ is enhanced when α < 1 (|r(d)| > |d|), never beyond a gain of 2.
  for (const x of [0.02, 0.2, 0.6]) {
    assert.ok(r(x) > x, `enhanced at ${x}`);
    assert.ok(r(x) <= 2 * x + 1e-6, `gain capped at ${x}: ${r(x) / x}`);
  }
  // α = β = 1 is the identity (the defaults for betaDark and betaKnee follow beta).
  const id = remapper({ sigma: 1, alpha: 1, beta: 1 });
  for (let x = -5; x <= 5; x += 0.37) assert.ok(Math.abs(id(x) - x) < 1e-6, `identity at ${x}: ${id(x)}`);
});

test('localLaplacian with α = β = 1 returns its input', () => {
  const w = 96;
  const h = 64;
  const rand = rng(7);
  const input = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) input[y * w + x] = 3 * Math.sin(x / 9) * Math.cos(y / 7) + (x > 50 ? 4 : 0) + 0.3 * rand();
  const out = localLaplacian(input, w, h, { sigma: 1, alpha: 1, beta: 1 });
  let worst = 0;
  for (let i = 0; i < input.length; i++) worst = Math.max(worst, Math.abs(out[i] - input[i]));
  assert.ok(worst < 1e-4, `largest difference ${worst}`);
});

/** A 5-stop step at x = w/2 with horizontal-stripe texture (cancels in column means). */
function stepImage(w: number, h: number, step: number, texture: number): Float32Array {
  const img = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img[y * w + x] = (x >= w / 2 ? step : 0) + texture * Math.sin((2 * Math.PI * y) / 6);
  return img;
}

/** Column means: the profile across the edge with the texture averaged out. */
function profile(img: Float32Array, w: number, h: number): number[] {
  const out = new Array<number>(w).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x] += img[y * w + x] / h;
  return out;
}

/** Texture amplitude in a column: RMS of the deviation from the column mean. */
function textureRms(img: Float32Array, w: number, h: number, x: number): number {
  let mean = 0;
  for (let y = 0; y < h; y++) mean += img[y * w + x] / h;
  let ss = 0;
  for (let y = 0; y < h; y++) ss += (img[y * w + x] - mean) ** 2;
  return Math.sqrt(ss / h);
}

/**
 * Reference local Laplacian filter (Paris et al.): every coefficient from the input remapped around
 * that coefficient's own Gaussian value. Brute force; only for images with few distinct values per level.
 */
function exactLocalLaplacian(input: Float32Array, w: number, h: number, p: LlfParams): Float32Array {
  const depth = pyramidDepth(w, h);
  const gauss = gaussianPyramid({ data: input, w, h }, depth);
  const remap = remapper(p);
  const cache = new Map<string, Plane[]>();
  const out: Plane[] = gauss.slice(0, depth - 1).map((g) => ({ data: new Float32Array(g.data.length), w: g.w, h: g.h }));
  for (let l = 0; l < depth - 1; l++) {
    const G = gauss[l].data;
    for (let i = 0; i < G.length; i++) {
      const key = G[i].toFixed(6);
      let lap = cache.get(key);
      if (!lap) {
        const g = G[i];
        lap = laplacianPyramid({ data: input.map((v) => g + remap(v - g)), w, h }, depth);
        cache.set(key, lap);
      }
      out[l].data[i] = lap[l].data[i];
    }
  }
  return collapse([...out, gauss[depth - 1]]);
}

/** Plateau levels (means away from the edge and the borders) of a column profile. */
function plateaus(prof: number[]): { left: number; right: number } {
  const w = prof.length;
  const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
  return { left: mean(prof.slice(4, 40)), right: mean(prof.slice(w - 40, w - 4)) };
}

test('localLaplacian matches the exact filter and compresses a large step without a halo', () => {
  const w = 256;
  const h = 32;
  const p: LlfParams = { sigma: 1, alpha: 1, beta: 0.4 };
  const input = stepImage(w, h, 5, 0);
  const fast = localLaplacian(input, w, h, p);
  const exact = exactLocalLaplacian(input, w, h, p);
  let worst = 0;
  for (let i = 0; i < fast.length; i++) worst = Math.max(worst, Math.abs(fast[i] - exact[i]));
  assert.ok(worst < 0.05, `fast vs exact: largest difference ${worst.toFixed(4)}`);
  // The step shrinks to about σ + β(5 − σ) = 2.6 (the pyramid's coarsest levels compress a little less).
  const prof = profile(fast, w, h);
  const { left, right } = plateaus(prof);
  assert.ok(Math.abs(right - left - (p.sigma + p.beta * (5 - p.sigma))) < 0.2, `step ${(right - left).toFixed(3)}`);
  // Halo-free: neither side over- or undershoots its plateau.
  assert.ok(left - Math.min(...prof) < 0.05, `undershoot ${(left - Math.min(...prof)).toFixed(4)}`);
  assert.ok(Math.max(...prof) - right < 0.1, `overshoot ${(Math.max(...prof) - right).toFixed(4)}`);
});

test('localLaplacian at the app’s tone parameters is halo-free at bright and dark steps', () => {
  const w = 256;
  const h = 32;
  for (const step of [2.5, 5, -4]) {
    const out = localLaplacian(stepImage(w, h, step, 0), w, h, { ...TONE, alpha: 0.82 });
    const prof = profile(out, w, h);
    const { left, right } = plateaus(prof);
    const hi = Math.max(left, right);
    const lo = Math.min(left, right);
    const over = Math.max(...prof) - hi;
    const under = lo - Math.min(...prof);
    assert.ok(over < 0.1 && under < 0.1, `${step} stops: overshoot ${over.toFixed(3)}, undershoot ${under.toFixed(3)}`);
    assert.ok(Math.abs(right - left) < Math.abs(step), `${step} stops compressed to ${(right - left).toFixed(2)}`);
  }
});

test('localLaplacian keeps texture at α = 1 and enhances it below 1', () => {
  const w = 256;
  const h = 48;
  const input = stepImage(w, h, 5, 0.2);
  const tin = textureRms(input, w, h, 30);
  for (const [alpha, check] of [
    [1, (r: number) => Math.abs(r - 1) < 0.1],
    [0.6, (r: number) => r > 1.15],
  ] as const) {
    const out = localLaplacian(input, w, h, { sigma: 1, alpha, beta: 0.4 });
    for (const x of [30, w - 30]) {
      const ratio = textureRms(out, w, h, x) / tin;
      assert.ok(check(ratio), `α = ${alpha}, texture at x = ${x}: ×${ratio.toFixed(3)}`);
    }
  }
});

test('boxMean and morph match brute force (clamped edges)', () => {
  const w = 23;
  const h = 17;
  const rand = rng(42);
  const img = Float32Array.from({ length: w * h }, () => rand());
  const at = (x: number, y: number): number => img[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (const r of [1, 2, 5]) {
    const box = boxMean(img, w, h, r);
    const dil = morph(img, w, h, r, true);
    const ero = morph(img, w, h, r, false);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let hi = -Infinity;
        let lo = Infinity;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            sum += at(x + dx, y + dy);
            // Morphology only looks inside the image.
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && xx < w && yy >= 0 && yy < h) {
              hi = Math.max(hi, img[yy * w + xx]);
              lo = Math.min(lo, img[yy * w + xx]);
            }
          }
        }
        const i = y * w + x;
        assert.ok(Math.abs(box[i] - sum / (2 * r + 1) ** 2) < 1e-5, `box r=${r} at (${x}, ${y}): ${box[i]} vs ${sum / (2 * r + 1) ** 2}`);
        assert.equal(dil[i], hi, `dilate r=${r} at (${x}, ${y})`);
        assert.equal(ero[i], lo, `erode r=${r} at (${x}, ${y})`);
      }
    }
  }
});

test('guidedFilter moves a rough mask edge onto the guide edge', () => {
  const w = 120;
  const h = 30;
  const edge = 60; // the guide steps between x = 59 and x = 60
  const rand = rng(3);
  const guide = new Float32Array(w * h);
  const rough = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      guide[y * w + x] = x >= edge ? 1 : 0.2;
      // The mask's own edge is 1.5 px off and blurred over ±4 px (it straddles the guide edge), with noise.
      const t = Math.min(1, Math.max(0, (x - (edge + 1.5) + 4) / 8));
      rough[y * w + x] = Math.min(1, Math.max(0, t + 0.15 * (rand() - 0.5)));
    }
  }
  const q = guidedFilter(guide, rough, w, h, 6, 1e-3);
  const prof = profile(q, w, h);
  // Where the profile crosses 0.5, interpolated between pixel centres.
  let crossing = NaN;
  for (let x = 1; x < w; x++) {
    if (prof[x - 1] < 0.5 && prof[x] >= 0.5) {
      crossing = x - 1 + (0.5 - prof[x - 1]) / (prof[x] - prof[x - 1]);
      break;
    }
  }
  assert.ok(Math.abs(crossing - (edge - 0.5)) <= 1, `crossing at ${crossing.toFixed(2)}, guide edge at ${edge - 0.5}`);
  for (let x = 0; x < edge - 15; x++) assert.ok(prof[x] < 0.05, `left side at x = ${x}: ${prof[x].toFixed(3)}`);
  for (let x = edge + 15; x < w; x++) assert.ok(prof[x] > 0.95, `right side at x = ${x}: ${prof[x].toFixed(3)}`);
});

/** Φ, the standard normal distribution function (Abramowitz & Stegun 7.1.26). */
function phi(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 + 0.5 * erf : 0.5 - 0.5 * erf;
}

/** Separable Gaussian blur (σ px, edges clamped): an out-of-focus lens. */
function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.ceil(4 * sigma);
  const k = Float32Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const sum = k.reduce((a, b) => a + b, 0);
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
      tmp[y * w + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      out[y * w + x] = s;
    }
  }
  return out;
}

test('pullWindow darkens the view, keeps the frame and its colour, and leaves no ring at the edge', () => {
  // A neutral frame meets a bright, red-tinged, textured view through an edge blurred by σ = 3 px, with the view's
  // bloom spilling onto the frame. The edge (distance, blur) is known exactly.
  const w = 1600;
  const h = 12;
  const edge = 400;
  const sigma = 3;
  const pull = 4;
  const k = 2 ** -pull;
  const F = 0.15;
  const n = w * h;
  const view = (x: number, y: number, c: number): number => [4.5, 2.4, 2.2][c] * (1 + 0.05 * Math.sin(x / 3.1) * Math.cos(y / 2.3));
  const lin = new Float32Array(3 * n);
  const ideal = new Float32Array(3 * n);
  const distance = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = phi((x + 0.5 - edge) / sigma);
      const bloom = x < edge ? 0.02 * Math.exp(-(edge - x) / 6) : 0;
      distance[i] = x + 0.5 - edge;
      for (let c = 0; c < 3; c++) {
        lin[3 * i + c] = (1 - a) * F + (a + bloom) * view(x, y, c);
        // The scene photographed with the view `pull` stops darker, bloom and all.
        ideal[3 * i + c] = (1 - a) * F + k * (a + bloom) * view(x, y, c);
      }
    }
  }
  const out = Float32Array.from(lin);
  pullWindow(out, distance, new Float32Array(n).fill(sigma), new Float32Array(3 * n).fill(F), pull, null, 1, w);
  // From three blur widths outside the edge inwards, exactly the darker scene: no ring, no glow, the frame's own colour.
  let worst = 0;
  for (let y = 0; y < h; y++) {
    for (let x = edge - 3 * sigma; x < w; x++) {
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(out[3 * (y * w + x) + c] / ideal[3 * (y * w + x) + c] - 1));
    }
  }
  assert.ok(worst < 0.005, `off the darker scene by ${(100 * worst).toFixed(2)}%`);
  // The frame beside the red view: reddish in the input (the blur mixes in view light), neutral after.
  const o = 3 * (5 * w + edge - 4);
  assert.ok(lin[o] / lin[o + 1] > 1.4 && out[o] / out[o + 1] < 1.15, `frame r/g ${(lin[o] / lin[o + 1]).toFixed(2)} → ${(out[o] / out[o + 1]).toFixed(2)}`);
  // The frame beyond the bloom radius: unchanged.
  for (let x = 0; x < edge - Math.ceil(RADIUS.bloom * w) - 1; x += 7) assert.equal(out[3 * (5 * w + x)], lin[3 * (5 * w + x)]);
  // Bloom fades back in smoothly towards the bloom radius (never brighter than the input).
  for (let x = edge - Math.ceil(RADIUS.bloom * w); x < edge; x++) assert.ok(out[3 * (5 * w + x) + 1] <= lin[3 * (5 * w + x) + 1] + 1e-7);
  // The view shares: 1 inside the glass, 0 on the frame.
  const lum = luminance(lin);
  const share = viewShares(Float32Array.from(lum, Math.log2), Float32Array.from(luminance(out), Math.log2), pull);
  assert.ok(share[5 * w + edge + 30] > 0.99 && share[5 * w + 30] < 1e-6);
});

test('measureEdge finds the half-light edge and the blur of a blurred pane, and keeps it straight past view detail', () => {
  // A pane of bright, textured view in a frame, blurred by σ = 2 px. The soft mask sits where the light is the
  // geometric mean of frame and view (it is refined on log luminance), about a blur width outside the edge,
  // and a shaded balcony (twice the frame's light) against the top of the pane dents it.
  const w = 1600;
  const h = 400;
  const sigma = 2;
  const F = 0.15;
  const V = 3;
  const sharp = new Float32Array(w * h).fill(F);
  for (let y = 100; y < 300; y++) for (let x = 600; x < 1000; x++) sharp[y * w + x] = V * (1 + 0.04 * Math.sin(x / 2.7) * Math.sin(y / 3.3));
  for (let y = 100; y < 110; y++) for (let x = 760; x < 776; x++) sharp[y * w + x] = 2 * F;
  const Y = gaussianBlur(sharp, w, h, sigma);
  const soft = Float32Array.from(Y, (v) => (v >= Math.sqrt(F * V) ? 1 : 0));
  const { distance, blur } = measureEdge(Y, soft, w, h);
  // Where the signed distance crosses zero along a row (or column), between pixel centres.
  const crossing = (at: (t: number) => number, from: number, to: number): number => {
    for (let t = from; t < to; t++) {
      const a = at(t);
      const b = at(t + 1);
      if ((a < 0) !== (b < 0)) return t + 0.5 + a / (a - b);
    }
    return NaN;
  };
  for (const y of [140, 200, 260]) {
    const left = crossing((x) => distance[y * w + x], 580, 620);
    const right = crossing((x) => distance[y * w + x], 980, 1020);
    assert.ok(Math.abs(left - 600) < 0.35 && Math.abs(right - 1000) < 0.35, `row ${y}: edges at ${left.toFixed(2)}, ${right.toFixed(2)}`);
    assert.ok(Math.abs(blur[y * w + 600] / sigma - 1) < 0.15, `row ${y}: blur ${blur[y * w + 600].toFixed(2)}`);
  }
  for (const x of [650, 700, 840, 900]) {
    const top = crossing((y) => distance[y * w + x], 80, 120);
    const bottom = crossing((y) => distance[y * w + x], 280, 320);
    assert.ok(Math.abs(top - 100) < 0.35 && Math.abs(bottom - 300) < 0.35, `column ${x}: edges at ${top.toFixed(2)}, ${bottom.toFixed(2)}`);
  }
  // Across the balcony the edge stays on the frame's line: the balcony is view, pulled with it.
  for (const x of [762, 768, 774]) {
    const top = crossing((y) => distance[y * w + x], 80, 120);
    assert.ok(Math.abs(top - 100) < 0.6, `balcony column ${x}: edge at ${top.toFixed(2)}`);
  }
  // Nowhere near the pane: far outside.
  assert.equal(distance[20 * w + 20], -FAR);
});

test('frameColour measures the frame against the frame and a curtain against the curtain', () => {
  // Glass from x = 800 on; outside it a neutral frame (x 760–799) with the view's bloom on it, then a dark teal curtain.
  const w = 1200;
  const h = 60;
  const n = w * h;
  const lin = new Float32Array(3 * n);
  const frameRgb = [0.2, 0.2, 0.2];
  const curtain = [0.02, 0.06, 0.065];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = x >= 800 ? [3, 3, 3] : x >= 760 ? frameRgb.map((v) => v * (1 + 0.6 * Math.exp(-(800 - x) / 4))) : curtain;
      lin.set(c, 3 * i);
    }
  }
  const Y = luminance(lin);
  const edge = { distance: Float32Array.from({ length: n }, (_, i) => (i % w) + 0.5 - 800), blur: new Float32Array(n).fill(1) };
  const F = frameColour(lin, Y, edge, new Float32Array(n).fill(0.2), w, h, 8);
  const at = (x: number): number[] => Array.from(F.subarray(3 * (30 * w + x), 3 * (30 * w + x) + 3));
  for (const x of [785, 795, 798]) at(x).forEach((v, c) => assert.ok(Math.abs(v / frameRgb[c] - 1) < 0.12, `frame at x = ${x}: ${at(x).map((u) => u.toFixed(3))}`));
  for (const x of [745, 755]) at(x).forEach((v, c) => assert.ok(Math.abs(v / curtain[c] - 1) < 0.15, `curtain at x = ${x}: ${at(x).map((u) => u.toFixed(3))}`));
  // Inside the glass, the frame's colour nearby.
  at(805).forEach((v, c) => assert.ok(Math.abs(v / frameRgb[c] - 1) < 0.3, `glass at x = 805: ${at(805).map((u) => u.toFixed(3))}`));
});

test('nearestSeeds gives exact Euclidean distances to the nearest seed', () => {
  const w = 64;
  const h = 48;
  const seed = new Uint8Array(w * h);
  const seeds = [
    [5, 7],
    [40, 30],
    [60, 2],
    [20, 44],
  ];
  for (const [x, y] of seeds) seed[y * w + x] = 1;
  const { index, dist2 } = nearestSeeds(seed, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const best = Math.min(...seeds.map(([sx, sy]) => (x - sx) ** 2 + (y - sy) ** 2));
      assert.equal(dist2[y * w + x], best, `(${x}, ${y})`);
      const s = index[y * w + x];
      assert.equal((x - (s % w)) ** 2 + (y - Math.floor(s / w)) ** 2, best);
    }
  }
});

test('fillGlassHoles fills dark view detail enclosed by glass, not room objects or open regions', () => {
  const w = 200;
  const h = 100;
  const soft = new Float32Array(w * h);
  const Y = new Float32Array(w * h).fill(0.1);
  // A pane (x 40–160, y 10–90) with: a tiny dark hole (as dark as the walls; up to 0.02% of the image), a larger hole a
  // stop above the walls (view), a larger hole at the walls' level (a lamp in front of the glass), and a notch open to the frame.
  for (let y = 10; y < 90; y++) for (let x = 40; x < 160; x++) soft[y * w + x] = 1;
  const box = (x0: number, y0: number, x1: number, y1: number, value: number): void => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) (soft[y * w + x] = 0.2), (Y[y * w + x] = value);
  };
  box(50, 20, 52, 22, 0.1);
  box(70, 20, 76, 26, 0.3);
  box(100, 40, 106, 46, 0.1);
  box(150, 60, 162, 64, 0.5);
  fillGlassHoles(soft, Y, 0.1, w, h);
  assert.equal(soft[21 * w + 51], 1, 'tiny hole filled');
  assert.equal(soft[23 * w + 73], 1, 'bright hole filled');
  assert.equal(soft[43 * w + 103], Math.fround(0.2), 'hole at the walls’ level kept');
  assert.equal(soft[62 * w + 155], Math.fround(0.2), 'notch open to the frame kept');
});

test('measureEdge follows a darker strip of view along a bed out to the bed', () => {
  // A pane over a bed: bright view, then a strip of shaded view 8 px tall (bright enough to be view, darker than
  // the rest), then the bed, its top lit by the window to 1.6 times the walls. The mask ends at the strip's top.
  const w = 1600;
  const h = 400;
  const wall = 0.1;
  const sharp = new Float32Array(w * h).fill(wall);
  for (let y = 100; y < 258; y++) for (let x = 600; x < 1000; x++) sharp[y * w + x] = y < 250 ? 16 * wall : 3.5 * wall;
  for (let y = 258; y < h; y++) for (let x = 0; x < w; x++) sharp[y * w + x] = 1.6 * wall;
  const Y = gaussianBlur(sharp, w, h, 2);
  const soft = Float32Array.from(Y, (v) => (v >= Math.sqrt(16 * 3.5) * wall ? 1 : 0));
  const bottom = (distance: Float32Array, x: number): number => {
    for (let y = 240; y < 270; y++) {
      const a = distance[y * w + x];
      const b = distance[(y + 1) * w + x];
      if (a > 0 && b <= 0) return y + 0.5 + a / (a - b);
    }
    return NaN;
  };
  const strip = measureEdge(Y, soft, w, h, wall * 2 ** 1.25).distance;
  const face = measureEdge(Y, soft, w, h).distance;
  for (const x of [700, 800, 900]) {
    assert.ok(Math.abs(bottom(strip, x) - 258) < 1, `column ${x}: edge at ${bottom(strip, x).toFixed(2)} with the view's level`);
    assert.ok(bottom(face, x) < 253, `column ${x}: edge at ${bottom(face, x).toFixed(2)} without it`);
  }
});

test('measureEdge keeps a frame straight along a long stretch of dark view against it', () => {
  // A pane in a frame with a groove 4 px out from the glass; for 120 px a shaded building (2.3 times the frame's
  // light) stands against the pane's left side. The mask covers the pane.
  const w = 1600;
  const h = 600;
  const F = 0.15;
  const sharp = new Float32Array(w * h).fill(F);
  for (let y = 0; y < h; y++) for (let x = 592; x < 596; x++) sharp[y * w + x] = 0.08;
  for (let y = 100; y < 500; y++) for (let x = 600; x < 1000; x++) sharp[y * w + x] = y >= 300 && y < 420 && x < 700 ? 2.3 * F : 3;
  const Y = gaussianBlur(sharp, w, h, 2);
  const soft = new Float32Array(w * h);
  for (let y = 100; y < 500; y++) for (let x = 600; x < 1000; x++) soft[y * w + x] = 1;
  const { distance } = measureEdge(Y, soft, w, h);
  for (const y of [330, 360, 390]) {
    let left = NaN;
    for (let x = 585; x < 615; x++) {
      const a = distance[y * w + x];
      const b = distance[y * w + x + 1];
      if (a <= 0 && b > 0) left = x + 0.5 + a / (a - b);
    }
    assert.ok(Math.abs(left - 600) < 0.6, `row ${y}: edge at ${left.toFixed(2)}`);
  }
});

test('evenWindowLight brings a window-lit bed top towards the bed, a bright frame towards the walls, and leaves the walls', () => {
  // Glass above y = 100. Below it, a teal bed whose top 30 px the window lights 0.7 stop above the walls' anchor
  // (the rest at −0.8); to its right a white frame strip lit to +1, then the wall (−0.1); beside a lamp, the same bed.
  const w = 1600;
  const h = 300;
  const n = w * h;
  const tone = new Float32Array(n);
  const lin = new Float32Array(3 * n);
  const distance = new Float32Array(n);
  const blur = new Float32Array(n).fill(1);
  const share = new Float32Array(n);
  const lamps = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      distance[i] = 100 - y;
      const teal = x < 1100 || x >= 1400;
      const rgb = y < 100 ? [1, 1, 1.1] : teal ? [0.6, 1, 1.2] : [1, 1, 1];
      for (let c = 0; c < 3; c++) lin[3 * i + c] = rgb[c];
      if (y < 100) {
        tone[i] = 3;
        share[i] = 1;
        lamps[i] = x >= 1400 ? 1 : 0;
      } else if (teal) tone[i] = y < 130 ? 0.7 : -0.8;
      else tone[i] = x < 1200 && y < 110 ? 1 : -0.1;
    }
  }
  evenWindowLight(tone, 0, lin, { distance, blur }, share, lamps, w, h);
  const keep = 0.3;
  assert.ok(Math.abs(tone[105 * w + 500] - (-0.8 + keep * 1.5)) < 0.1, `bed top ${tone[105 * w + 500].toFixed(2)}`);
  assert.equal(tone[200 * w + 500], Math.fround(-0.8), 'bed beyond the window’s reach');
  assert.ok(Math.abs(tone[105 * w + 1150] - (-0.1 + keep * 1.1)) < 0.1, `frame ${tone[105 * w + 1150].toFixed(2)}`);
  assert.equal(tone[105 * w + 1300], Math.fround(-0.1), 'wall below the anchor');
  assert.equal(tone[105 * w + 1500], Math.fround(0.7), 'beside a lamp');
});

test('lampGlass marks a warm shade, not a daylight view with a yellow facade in it', () => {
  const w = 300;
  const h = 100;
  const soft = new Float32Array(w * h);
  const lin = new Float32Array(3 * w * h).fill(0.1);
  const paint = (x0: number, x1: number, rgb: [number, number, number]): void => {
    for (let y = 20; y < 80; y++) {
      for (let x = x0; x < x1; x++) {
        soft[y * w + x] = 1;
        for (let c = 0; c < 3; c++) lin[3 * (y * w + x) + c] = rgb[c];
      }
    }
  };
  paint(10, 90, [1.5, 1, 0.6]);
  paint(150, 250, [1, 1, 1.1]);
  paint(150, 180, [1.2, 1, 0.4]);
  const lamp = lampGlass(soft, lin, w, h);
  assert.equal(lamp[50 * w + 50], 1, 'shade');
  assert.equal(lamp[50 * w + 160], 0, 'yellow facade in a view');
  assert.equal(lamp[50 * w + 220], 0, 'view');
});

test('luminance is ProPhoto Y, floored for logs', () => {
  const Y = luminance(Float32Array.from([1, 1, 1, 0, 0, 0, 0.5, 0.2, 0.1]));
  assert.ok(Math.abs(Y[0] - 1) < 1e-6);
  assert.ok(Math.abs(Y[1] - 1e-7) < 1e-12, `floor ${Y[1]}`);
  assert.ok(Math.abs(Y[2] - (0.2880402 * 0.5 + 0.7118741 * 0.2 + 0.0000857 * 0.1)) < 1e-7);
});

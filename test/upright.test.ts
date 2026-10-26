// Upright on synthetic rooms with a known camera tilt: every vertical edge of
// the scene is drawn through the vanishing point a tilted pinhole camera gives
// vertical lines, then blurred and noised. The estimator must recover the
// pitch and roll, ignore leaning curtains and short clutter, and its
// correction must leave the architecture vertical.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyWarp, estimateUpright, findVerticalLines, geometryWarp, warpPoint } from '../src/geometry/upright.ts';

const W = 800;
const H = 540;
const FOCAL = (35 / 36) * W; // a 35 mm lens on full frame, as the worker assumes

/** A line a·x + b·y + c = 0 with a² + b² = 1 and a > 0: positive to its right. */
interface Line {
  a: number;
  b: number;
  c: number;
}

/** A surface adding `step` (log luminance) right of `left` and left of `right` (open when null), between rows y0 and y1. */
interface Patch {
  left: Line;
  right: Line | null;
  y0: number;
  y1: number;
  step: number;
}

/** Deterministic noise (mulberry32 + Box–Muller). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Vertical vanishing direction (camera coordinates, y down) for a pitch and roll in the estimator's convention. */
function verticalDirection(pitch: number, roll: number): [number, number, number] {
  const d: [number, number, number] = [Math.tan((roll * Math.PI) / 180), 1, Math.tan((pitch * Math.PI) / 180)];
  const n = Math.hypot(...d);
  return [d[0] / n, d[1] / n, d[2] / n];
}

/** The image of a world-vertical line crossing the middle row at x: the line through (x, H/2) and the vanishing point. */
function vertical(pitch: number, roll: number, x: number): Line {
  const d = verticalDirection(pitch, roll);
  // Vanishing point K·d (homogeneous; may be near infinity).
  const v = [FOCAL * d[0] + (W / 2) * d[2], FOCAL * d[1] + (H / 2) * d[2], d[2]];
  const p = [x, H / 2, 1];
  const a = p[1] * v[2] - p[2] * v[1];
  const b = p[2] * v[0] - p[0] * v[2];
  const c = p[0] * v[1] - p[1] * v[0];
  const n = Math.hypot(a, b) * (a < 0 ? -1 : 1);
  return { a: a / n, b: b / n, c: c / n };
}

/** A straight line through (x, y) leaning `lean` degrees from vertical (lower end to the right when positive). */
function leaning(x: number, lean: number, y = H / 2): Line {
  const t = (lean * Math.PI) / 180;
  const a = Math.cos(t);
  const b = -Math.sin(t);
  return { a, b, c: -(a * x + b * y) };
}

/** Renders patches over a softly lit wall as linear luminance, blurred by `blur` px, with multiplicative noise. */
function render(patches: Patch[], seed = 1, blur = 1.3, noise = 0.015): Float32Array {
  const rand = rng(seed);
  const gauss = (): number => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const lum = new Float32Array(W * H);
  const smooth = (d: number): number => (d > 6 * blur ? 1 : d < -6 * blur ? 0 : 1 / (1 + Math.exp((-1.7 * d) / blur)));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let L = Math.log(0.25) + 0.15 * (px / W - 0.5) + 0.1 * (py / H - 0.5);
      for (const p of patches) {
        let cover = smooth(p.left.a * px + p.left.b * py + p.left.c);
        if (cover && p.right) cover *= smooth(-(p.right.a * px + p.right.b * py + p.right.c));
        if (cover) L += p.step * cover * smooth(py - p.y0) * smooth(p.y1 - py);
      }
      lum[y * W + x] = Math.exp(L + noise * gauss());
    }
  }
  return lum;
}

/** A room: wall corners, a door frame, a window and its frame, a wardrobe and a radiator, all vertical in the world. */
function room(pitch: number, roll: number): Patch[] {
  const v = (x: number): Line => vertical(pitch, roll, x);
  const span = (left: number, right: number | null, y0: number, y1: number, step: number): Patch => ({ left: v(left), right: right === null ? null : v(right), y0: y0 * H, y1: y1 * H, step });
  return [
    span(140, null, -1, 2, -0.6), // wall corner: the side wall is darker
    span(660, null, -1, 2, 0.4), // wall corner
    span(200, 222, 0.1, 0.95, 0.8), // door frame
    span(330, 470, 0.08, 0.75, 1.2), // window frame
    span(348, 452, 0.1, 0.72, 0.3), // glass, brighter still
    span(560, 610, 0.3, 0.95, -0.5), // wardrobe
    span(700, 720, 0.2, 0.9, 0.3), // radiator
  ];
}

/** Tied-back curtains (long, dark, leaning on purpose) and short clutter. */
function distractors(seed: number): Patch[] {
  const rand = rng(seed);
  const out: Patch[] = [
    { left: leaning(270, 11), right: leaning(300, 11), y0: 0.05 * H, y1: 0.9 * H, step: -1.5 },
    { left: leaning(500, -12), right: leaning(530, -12), y0: 0.05 * H, y1: 0.9 * H, step: -1.5 },
  ];
  for (let k = 0; k < 8; k++) {
    const x = 60 + rand() * (W - 140);
    const y = 60 + rand() * (H - 160);
    const lean = (rand() - 0.5) * 40;
    const width = 8 + rand() * 8;
    out.push({ left: leaning(x, lean, y), right: leaning(x + width, lean, y), y0: y, y1: y + 40 + rand() * 30, step: (rand() < 0.5 ? -1 : 1) * (0.4 + rand() * 0.4) });
  }
  return out;
}

/** Angle from vertical (degrees) of a detected line. */
const angleOf = (l: { x0: number; y0: number; x1: number; y1: number }): number => (Math.atan2(l.x1 - l.x0, l.y1 - l.y0) * 180) / Math.PI;

/** Straightens the image with the estimate and returns the angles of its long near-vertical lines. */
function straightened(lum: Float32Array, rotation: NonNullable<ReturnType<typeof estimateUpright>['rotation']>): { angles: number[]; width: number; height: number; centre: [number, number] } {
  const warp = geometryWarp(rotation, null, W, H, FOCAL);
  const rgb = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) rgb[3 * i] = rgb[3 * i + 1] = rgb[3 * i + 2] = lum[i];
  const out = applyWarp(rgb, W, H, warp);
  const outLum = new Float32Array(warp.width * warp.height);
  for (let i = 0; i < outLum.length; i++) outLum[i] = out[3 * i + 1];
  const angles = findVerticalLines(outLum, warp.width, warp.height)
    .filter((l) => l.y1 - l.y0 > 0.3 * warp.height && Math.abs(angleOf(l)) < 4)
    .map(angleOf);
  return { angles, width: warp.width, height: warp.height, centre: warpPoint(warp, (warp.width - 1) / 2, (warp.height - 1) / 2) };
}

for (const [pitch, roll] of [
  [-4, 0.3],
  [6, -0.3],
] as const) {
  test(`recovers a ${pitch}° pitch and ${roll}° roll from the room's vertical edges`, () => {
    const lum = render(room(pitch, roll), 7);
    const est = estimateUpright(lum, W, H, FOCAL);
    assert.ok(est.rotation, 'a tilt this large is corrected');
    assert.ok(Math.abs(est.pitch - pitch) < 0.15, `pitch ${est.pitch.toFixed(3)} vs ${pitch}`);
    assert.ok(Math.abs(est.roll - roll) < 0.15, `roll ${est.roll.toFixed(3)} vs ${roll}`);
    assert.ok(est.lines.length >= 10, `${est.lines.length} of the room's 12 vertical edges used`);
    assert.ok(est.residual.median < 0.1 && est.residual.max < 0.3, `residual ${est.residual.median.toFixed(3)} / ${est.residual.max.toFixed(3)}°`);
  });
}

test('ignores tied-back curtains and short clutter', () => {
  for (const [pitch, roll] of [
    [-4, 0.3],
    [6, -0.3],
  ] as const) {
    const lum = render([...room(pitch, roll), ...distractors(pitch < 0 ? 3 : 5)], 11);
    const est = estimateUpright(lum, W, H, FOCAL);
    assert.ok(est.rotation, 'corrected');
    assert.ok(Math.abs(est.pitch - pitch) < 0.2, `pitch ${est.pitch.toFixed(3)} vs ${pitch}`);
    assert.ok(Math.abs(est.roll - roll) < 0.2, `roll ${est.roll.toFixed(3)} vs ${roll}`);
    // The curtain edges lean 11–12°: none of them may be among the lines the fit used.
    for (const l of est.lines) assert.ok(Math.abs(angleOf(l)) < 6, `a ${angleOf(l).toFixed(1)}° line was used`);
  }
});

test('the correction leaves the architecture vertical, cropped at native scale', () => {
  for (const [pitch, roll] of [
    [-4, 0.3],
    [6, -0.3],
  ] as const) {
    const lum = render([...room(pitch, roll), ...distractors(9)], 13);
    const est = estimateUpright(lum, W, H, FOCAL);
    assert.ok(est.rotation);
    const out = straightened(lum, est.rotation);
    assert.ok(out.angles.length >= 6, `${out.angles.length} long vertical lines found after correction`);
    for (const a of out.angles) assert.ok(Math.abs(a) < 0.15, `a line leans ${a.toFixed(3)}° after correction`);
    // Never upsampled: the crop is at most the frame, with its shape.
    assert.ok(out.width <= W && out.height <= H, `${out.width} × ${out.height}`);
    assert.ok(Math.abs(out.width / out.height / (W / H) - 1) < 0.01, `aspect ${(out.width / out.height).toFixed(4)}`);
    // The frame centre stays where it was.
    assert.ok(Math.abs(out.centre[0] - (W - 1) / 2) < 0.5 && Math.abs(out.centre[1] - (H - 1) / 2) < 0.5, `centre ${out.centre.map((c) => c.toFixed(2))}`);
  }
});

test('a level camera needs no correction', () => {
  const est = estimateUpright(render([...room(0, 0), ...distractors(4)], 17), W, H, FOCAL);
  assert.equal(est.rotation, null);
  assert.ok(Math.abs(est.pitch) < 0.15 && Math.abs(est.roll) < 0.15, `pitch ${est.pitch.toFixed(3)}, roll ${est.roll.toFixed(3)}`);
  assert.ok(est.lines.length >= 8, 'the vertical lines are still found and reported');
});

test('too few lines: no correction, no error', () => {
  const flat = estimateUpright(render([], 19), W, H, FOCAL);
  assert.equal(flat.rotation, null);
  assert.equal(flat.lines.length, 0);
  const one = estimateUpright(render([{ left: vertical(5, 0, 400), right: null, y0: -1, y1: 2 * H, step: 0.8 }], 23), W, H, FOCAL);
  assert.equal(one.rotation, null);
  assert.ok(one.lines.length <= 2);
  assert.doesNotThrow(() => estimateUpright(new Float32Array(16 * 12).fill(0.5), 16, 12, 16));
});

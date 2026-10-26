// Window panes from their frames, on synthetic windows with a known answer: a
// pane is bounded by its frame's straight edges past dark view in its corner,
// not by a frame's lit bevel or a strip of view along the frame; a curtain that
// hides a side and a bed with a straight-looking edge stay out of the glass;
// and the measured glass edge runs straight along the frame to the corner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPanes, frameLines, paneMask, type Pane } from '../src/look/panes.ts';
import { measureEdge } from '../src/look/render.ts';

const W = 1600;
const H = 1000;
const WALL = 0.1;
const FRAME = 0.15;
/** The pane: view between these, framed by a 40 px frame with a lit 2 px lip next to the glass. */
const PANE = { x0: 600, y0: 200, x1: 1000, y1: 700 };

interface Scene {
  Y: Float32Array;
  rgb: Float32Array;
}

/** Deterministic uniform noise in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

function scene(): Scene & { paint: (x0: number, y0: number, x1: number, y1: number, Y: number, rgb?: [number, number, number]) => void } {
  const Y = new Float32Array(W * H).fill(WALL);
  const rgb = new Float32Array(3 * W * H).fill(1);
  const paint = (x0: number, y0: number, x1: number, y1: number, v: number, c: [number, number, number] = [1, 1, 1]): void => {
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
        Y[y * W + x] = v;
        rgb.set(c, 3 * (y * W + x));
      }
    }
  };
  // The frame and its lip, then the view: sky with buildings of all shades in it (none touching the frame).
  paint(PANE.x0 - 40, PANE.y0 - 40, PANE.x1 + 40, PANE.y1 + 40, FRAME);
  paint(PANE.x0 - 2, PANE.y0 - 2, PANE.x1 + 2, PANE.y1 + 2, 2 * FRAME);
  paint(PANE.x0, PANE.y0, PANE.x1, PANE.y1, 1.6, [1, 1, 1.1]);
  const rand = rng(7);
  for (let k = 0; k < 40; k++) {
    const x = PANE.x0 + 20 + Math.floor(rand() * 340);
    const y = PANE.y0 + 20 + Math.floor(rand() * 440);
    paint(x, y, x + 10 + Math.floor(rand() * 30), y + 10 + Math.floor(rand() * 30), 0.4 + 2.6 * rand(), [0.9 + 0.3 * rand(), 1, 0.9 + 0.3 * rand()]);
  }
  return { Y, rgb, paint };
}

function gaussianBlur(src: Float32Array, sigma: number): Float32Array {
  const r = Math.ceil(4 * sigma);
  const k = Float32Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const sum = k.reduce((a, b) => a + b, 0);
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += k[i + r] * src[y * W + Math.min(W - 1, Math.max(0, x + i))];
    tmp[y * W + x] = s / sum;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(H - 1, Math.max(0, y + i)) * W + x];
    out[y * W + x] = s / sum;
  }
  return out;
}

/** The scene through a lens (blur σ 1.2 px): log luminance, linear RGB, and the brightness mask (1.5 stops above the walls). */
function shoot(s: Scene): { Y: Float32Array; l: Float32Array; lin: Float32Array; soft: Float32Array } {
  const Y = gaussianBlur(s.Y, 1.2);
  const l = Float32Array.from(Y, Math.log2);
  const lin = new Float32Array(3 * W * H);
  for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) lin[3 * i + c] = Y[i] * s.rgb[3 * i + c];
  const lw = Math.log2(WALL);
  const soft = Float32Array.from(l, (v) => Math.min(1, Math.max(0, v - lw - 1)));
  return { Y, l, lin, soft };
}

function panesOf(shot: ReturnType<typeof shoot>): { panes: Pane[]; mask: Float32Array } {
  const { panes, label } = findPanes(shot.l, Math.log2(WALL) + 3, shot.soft, new Uint8Array(W * H), W, H);
  return { panes, mask: paneMask(panes, label, shot.soft, shot.l, shot.lin, W, H) };
}

/** Where a side's line crosses the given row (left, right) or column (top, bottom). */
function cross(pane: Pane, side: number, at: number): number {
  const s = pane.sides[side];
  if (!s) return NaN;
  return side < 2 ? (s.c - s.ny * at) / s.nx : (s.c - s.nx * at) / s.ny;
}

test('findPanes bounds a pane by its frame, past dark view in its corner', () => {
  const s = scene();
  // A shaded facade in the top left corner, as dark as the frame.
  s.paint(PANE.x0, PANE.y0, PANE.x0 + 60, PANE.y0 + 100, FRAME, [1.1, 1, 0.9]);
  const shot = shoot(s);
  const { panes, mask } = panesOf(shot);
  assert.equal(panes.length, 1);
  const [pane] = panes;
  for (const [side, at, want] of [
    [0, 450, PANE.x0],
    [1, 450, PANE.x1],
    [2, 800, PANE.y0],
    [3, 800, PANE.y1],
  ] as const) assert.ok(Math.abs(cross(pane, side, at) - want) < 1, `side ${side}: ${cross(pane, side, at).toFixed(2)}, want ${want}`);
  assert.equal(mask[(PANE.y0 + 3) * W + PANE.x0 + 3], 1, 'the dark corner is view');
  assert.equal(mask[(PANE.y0 + 50) * W + PANE.x0 + 30], 1, 'the shaded facade is view');
  assert.equal(mask[(PANE.y0 + 50) * W + PANE.x0 - 10], 0, 'the frame is not');
  assert.equal(mask[(PANE.y0 - 1) * W + PANE.x0 + 30], 0, 'the lip is not');
});

test('findPanes takes the glass edge for the pane’s side, not the outer edge of a lit bevel', () => {
  const s = scene();
  // Along the left side a bevel lit by the window rises from the frame's level to 2.3 stops above the walls.
  for (let x = PANE.x0 - 15; x < PANE.x0; x++) s.paint(x, PANE.y0, x + 1, PANE.y1, FRAME * (0.5 / FRAME) ** ((x - PANE.x0 + 15) / 15));
  const shot = shoot(s);
  const { panes, mask } = panesOf(shot);
  assert.equal(panes.length, 1);
  assert.ok(Math.abs(cross(panes[0], 0, 450) - PANE.x0) < 1, `left side at ${cross(panes[0], 0, 450).toFixed(2)}`);
  assert.equal(mask[450 * W + PANE.x0 - 4], 0, 'the bevel is frame');
  assert.equal(mask[450 * W + PANE.x0 + 2], 1, 'the view is glass');
});

test('findPanes takes the frame for the pane’s side, not a strip of view along it', () => {
  const s = scene();
  // A shaded strip 6 px tall along the bottom of the view, alike all along it (a kerb across the view): its edge is
  // a straight line along the whole side too, but a smaller step than the frame's.
  s.paint(PANE.x0, PANE.y1 - 6, PANE.x1, PANE.y1, 1);
  const shot = shoot(s);
  const { panes, mask } = panesOf(shot);
  assert.equal(panes.length, 1);
  assert.ok(Math.abs(cross(panes[0], 3, 800) - PANE.y1) < 1, `bottom side at ${cross(panes[0], 3, 800).toFixed(2)}`);
  assert.equal(mask[(PANE.y1 - 3) * W + 800], 1, 'the strip is view');
});

test('paneMask keeps a curtain that hides a side out of the glass, and the view beside it in', () => {
  const s = scene();
  // A teal curtain from above the window to the floor, its edge slanting across the pane's right part; and a
  // shaded facade in the view against it.
  for (let y = 0; y < H; y++) {
    const edge = Math.round(900 + 0.05 * (y - PANE.y0));
    s.paint(edge, y, PANE.x1 + 200, y + 1, 0.02, [0.7, 1, 1.2]);
  }
  s.paint(840, 400, 900 + 10, 460, FRAME, [1.1, 1, 0.9]);
  for (let y = 400; y < 460; y++) s.paint(Math.round(900 + 0.05 * (y - PANE.y0)), y, PANE.x1 + 200, y + 1, 0.02, [0.7, 1, 1.2]);
  const shot = shoot(s);
  const { panes, mask } = panesOf(shot);
  assert.equal(panes.length, 1);
  assert.equal(panes[0].sides[1], null, 'no frame shows on the right');
  assert.equal(mask[300 * W + 960], 0, 'the curtain is not glass');
  assert.equal(mask[650 * W + 940], 0, 'nor where it slants furthest into the pane');
  assert.equal(mask[300 * W + 890], 1, 'the view beside it is');
  assert.equal(mask[430 * W + 860], 1, 'the shaded facade against it is view');
});

test('paneMask keeps a bed with a straight-looking edge out of the glass', () => {
  const s = scene();
  // A bed in front of the bottom of the window, wider than it, its top wavy by a few pixels.
  for (let x = 0; x < W; x++) s.paint(x, Math.round(640 + 3 * Math.sin(x / 9)), x + 1, H, 0.12, [0.7, 1, 1.2]);
  const shot = shoot(s);
  const { panes, mask } = panesOf(shot);
  assert.equal(panes.length, 1);
  assert.equal(panes[0].sides[3], null, 'the bed’s edge is no frame');
  assert.equal(mask[670 * W + 800], 0, 'the bed is not glass');
  assert.equal(mask[600 * W + 800], 1, 'the view above it is');
});

test('measureEdge runs a pane’s edge along its frame’s line to the corner, past dark view', () => {
  const s = scene();
  s.paint(PANE.x0, PANE.y0, PANE.x0 + 60, PANE.y0 + 100, FRAME, [1.1, 1, 0.9]);
  const shot = shoot(s);
  const { panes, mask } = panesOf(shot);
  const { distance } = measureEdge(shot.Y, mask, W, H, 0, frameLines(panes, W, H));
  // Along the left side, through the dark facade and below it: the edge at the frame's line.
  for (const y of [PANE.y0 + 30, PANE.y0 + 80, 450]) {
    let left = NaN;
    for (let x = PANE.x0 - 10; x < PANE.x0 + 10; x++) {
      const a = distance[y * W + x];
      const b = distance[y * W + x + 1];
      if (a <= 0 && b > 0) left = x + 0.5 + a / (a - b);
    }
    assert.ok(Math.abs(left - PANE.x0) < 0.75, `row ${y}: edge at ${left.toFixed(2)}`);
  }
  // At the corner: inside right up to it, outside past it.
  assert.ok(distance[(PANE.y0 + 1) * W + PANE.x0 + 1] > 0, 'corner pixel inside');
  assert.ok(distance[(PANE.y0 - 2) * W + PANE.x0 + 1] < 0, 'above the corner outside');
  assert.ok(distance[(PANE.y0 + 1) * W + PANE.x0 - 2] < 0, 'left of the corner outside');
});

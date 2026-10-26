// What the look decides per image before rendering: interior or exterior (from
// the metered exposure, the walls and the sky), which white balance to start
// from, and what to do with highlights clipped in every frame (neutral white,
// not magenta, and left out of the window pull).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readDcp } from '../src/color/dcp.ts';
import type { Vec3 } from '../src/color/color.ts';
import { classifyScene, defaultWhiteBalance, pullWindow, recoverHighlights, recoverPixel, renderLook, REAL_ESTATE_LOOK, sceneEv } from '../src/look/render.ts';

const profile = readDcp(new Uint8Array(readFileSync(new URL('../src/color/profiles/Sony ILCE-7M4 Adobe Standard.dcp', import.meta.url))));
const NEUTRAL: Vec3 = [0.5, 1, 0.7];

/** A luminance image: `value` everywhere, the top `skyRows` rows `sky`. */
function plane(w: number, h: number, value: number, skyRows = 0, sky = value): Float32Array {
  const lum = new Float32Array(w * h).fill(value);
  lum.fill(sky, 0, skyRows * w);
  return lum;
}

test('sceneEv is EV at ISO 100', () => {
  assert.ok(Math.abs(sceneEv({ fNumber: 8, exposureTime: 1 / 15, iso: 100 }) - Math.log2(960)) < 1e-9);
  assert.ok(Math.abs(sceneEv({ fNumber: 8, exposureTime: 1 / 15, iso: 400 }) - (Math.log2(960) - 2)) < 1e-9);
});

test('classifyScene: rooms stay interiors, daylight, foliage and open sky are exteriors', () => {
  const flat = plane(100, 80, 0.1);
  // The bedroom bracket (EV 8.6, half the room near-neutral) and a sunlit room metering at EV 10.5.
  assert.equal(classifyScene(8.6, 0.48, flat, 100, 80), 'interior');
  assert.equal(classifyScene(10.5, 0.45, flat, 100, 80), 'interior');
  // Shade or overcast daylight with little near-neutral surface; full daylight whatever the walls;
  // a shaded street metering like a room (EV 8.6) but with walls in only 8% of the frame.
  assert.equal(classifyScene(10, 0.11, flat, 100, 80), 'exterior');
  assert.equal(classifyScene(12.6, 0.5, flat, 100, 80), 'exterior');
  assert.equal(classifyScene(8.6, 0.08, flat, 100, 80), 'exterior');
  // Dim, but the top rows are open sky.
  assert.equal(classifyScene(8, 0.4, plane(100, 80, 0.1, 6, 1), 100, 80), 'exterior');
  // A window touching the top edge in a few columns is not a sky.
  const lum = plane(100, 80, 0.1);
  for (let y = 0; y < 6; y++) lum.fill(1, y * 100, y * 100 + 20);
  assert.equal(classifyScene(8, 0.4, lum, 100, 80), 'interior');
});

test('defaultWhiteBalance trusts the walls only in rooms where the camera agrees', () => {
  const camera = { temperature: 6044, tint: 35 };
  assert.equal(defaultWhiteBalance('interior', { temperature: 5989, tint: 37, coverage: 0.48 }, camera), 'auto');
  // Too little near-neutral surface, or an estimate far from the camera's (foliage, coloured backdrops).
  assert.equal(defaultWhiteBalance('interior', { temperature: 5233, tint: 21, coverage: 0.08 }, camera), 'camera');
  assert.equal(defaultWhiteBalance('interior', { temperature: 10979, tint: 31, coverage: 0.5 }, camera), 'camera');
  assert.equal(defaultWhiteBalance('interior', { temperature: 6000, tint: 60, coverage: 0.5 }, camera), 'camera');
  // Outdoors: the camera's measurement; without one, as shot. Rooms without one rely on coverage alone.
  assert.equal(defaultWhiteBalance('exterior', { temperature: 6044, tint: 35, coverage: 0.9 }, camera), 'camera');
  assert.equal(defaultWhiteBalance('exterior', { temperature: 6044, tint: 35, coverage: 0.9 }, null), 'asShot');
  assert.equal(defaultWhiteBalance('interior', { temperature: 3000, tint: 0, coverage: 0.6 }, null), 'auto');
});

test('recoverPixel turns clipped white neutral and leaves unclipped colour alone', () => {
  const wbOf = (px: Float32Array): number[] => [px[0] / NEUTRAL[0], px[1] / NEUTRAL[1], px[2] / NEUTRAL[2]];
  // Clipped in every channel: white balance alone would give (2, 1, 1.43), magenta.
  const white = Float32Array.of(1, 1, 1);
  assert.equal(recoverPixel(white, 0, NEUTRAL, 1), 1);
  const [r, g, b] = wbOf(white);
  assert.ok(Math.abs(r - g) < 1e-6 && Math.abs(b - g) < 1e-6 && g >= 1, `neutral: ${[r, g, b]}`);
  // Green clipped, red already above it after white balance: green is raised, red and blue kept.
  const sky = Float32Array.of(0.6, 1, 0.65);
  recoverPixel(sky, 0, NEUTRAL, 1);
  assert.deepEqual(Array.from(sky).map((v) => +v.toFixed(6)), [0.6, 1.2, 0.65]);
  // A bright saturated colour below 90% of the clip level is untouched.
  const flower = Float32Array.of(0.85, 0.3, 0.2);
  assert.equal(recoverPixel(flower, 0, NEUTRAL, 1), 0);
  assert.deepEqual(Array.from(flower).map((v) => +v.toFixed(6)), [0.85, 0.3, 0.2]);
});

test('recoverHighlights follows the vignetting correction: corners clip higher', () => {
  // A raw value of 0.6 in a corner raised 1.6× by devignetting is not clipped; a raw 1.0 there is.
  const rgb = Float32Array.of(0.96 * NEUTRAL[0], 0.96, 0.96 * NEUTRAL[2], 1.6, 1.6, 1.6);
  const clipped = recoverHighlights(rgb, NEUTRAL, { level: 1, gain: Float32Array.of(1.6, 1.6) })!;
  assert.deepEqual(Array.from(clipped), [0, 1]);
  assert.ok(Math.abs(rgb[1] - 0.96) < 1e-6, 'unclipped corner pixel unchanged');
  assert.ok(Math.abs(rgb[3] / NEUTRAL[0] - rgb[4]) < 1e-6 && Math.abs(rgb[5] / NEUTRAL[2] - rgb[4]) < 1e-6, 'clipped corner pixel neutral');
  // Nothing near the clip level: no map.
  assert.equal(recoverHighlights(Float32Array.of(0.2, 0.3, 0.1), NEUTRAL, { level: 1, gain: null }), null);
});

test('pullWindow leaves clipped light alone', () => {
  const w = 40;
  const h = 10;
  const n = w * h;
  const lin = new Float32Array(3 * n).fill(4);
  const clipped = new Float32Array(n);
  clipped.fill(1, 0, n / 2);
  // Deep inside the glass.
  pullWindow(lin, new Float32Array(n).fill(50), new Float32Array(n).fill(1), new Float32Array(3 * n).fill(0.25), 3, clipped, 1, w);
  assert.ok(Math.abs(lin[0] - 4) < 1e-6, `clipped half kept at 4: ${lin[0]}`);
  assert.ok(Math.abs(lin[3 * n - 1] - 0.5) < 1e-6, `unclipped half pulled 3 stops: ${lin[3 * n - 1]}`);
});

test('a room with a window clipped in every frame renders the window white, not magenta', () => {
  // Camera RGB: walls at 0.12 of white with a neutral cast; the window clipped in all three channels.
  const w = 160;
  const h = 120;
  const camera = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      const window = x > 60 && x < 120 && y > 20 && y < 80;
      const v = window ? 1 : 0.12 * (1 + 0.1 * Math.sin(x / 7));
      camera[o] = window ? 1 : v * NEUTRAL[0];
      camera[o + 1] = v;
      camera[o + 2] = window ? 1 : v * NEUTRAL[2];
    }
  }
  const look = { ...REAL_ESTATE_LOOK, neutral: NEUTRAL, scene: 'interior' as const };
  const centre = (90 + 50 * w) * 3;
  const plain = renderLook(camera, w, h, profile, look);
  const recovered = renderLook(camera, w, h, profile, look, false, { level: 1, gain: null });
  const cast = (rgb: Float32Array): number => Math.max(rgb[centre], rgb[centre + 2]) / rgb[centre + 1];
  assert.ok(cast(plain.rgb) > 1.15, `without the clip level the window is magenta (${cast(plain.rgb).toFixed(2)})`);
  assert.ok(cast(recovered.rgb) < 1.03, `with it, neutral (${cast(recovered.rgb).toFixed(2)})`);
  assert.ok(recovered.rgb[centre + 1] > 0.85, `and white, not pulled to grey (${recovered.rgb[centre + 1].toFixed(2)})`);
});

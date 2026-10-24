// Lens corrections and the geometry warp: Sony's embedded spline decoded as
// darktable decodes it, the crop kept at native scale, lateral CA moving red
// and blue apart from green, and vignetting divided out towards the corners.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devignette, knotValue, radialScale, sonyLensModel } from '../src/geometry/lens.ts';
import { applyWarp, geometryWarp, warpPoint } from '../src/geometry/upright.ts';

// The FE 35mm F1.4 GM at f/8, as recorded in the sample bracket.
const PARAMS = {
  distortion: [1, -1, -4, -10, -18, -28, -40, -51, -62, -70, -75, -72, -61, -39, -4, 48],
  vignetting: [0, 0, 192, 560, 1088, 1792, 2592, 3424, 4304, 5216, 6128, 7056, 7968, 8864, 9728, 10560],
  caRed: [640, 640, 640, 512, 512, 512, 384, 384, 384, 384, 384, 384, 256, 256, 256, 128],
  caBlue: [-256, -256, -256, -256, -256, -256, -256, -256, -128, -128, -128, -128, 0, 0, 0, 128],
};

test('decodes the Sony spline: distortion, CA and vignetting knots', () => {
  const lens = sonyLensModel(PARAMS)!;
  assert.equal(lens.distortion!.length, 16);
  assert.ok(Math.abs(lens.distortion![15] - (1 + 48 / 16384)) < 1e-12);
  assert.ok(Math.abs(lens.caRed![0] - (1 + 640 / 2 ** 21)) < 1e-12);
  // No falloff at the centre; about 0.72 EV at the corner.
  assert.ok(Math.abs(lens.vignetting![0] - 1) < 1e-12);
  assert.ok(Math.abs(-Math.log2(lens.vignetting![15]) - 0.722) < 0.002);
  assert.equal(sonyLensModel(null), null);
});

test('knots interpolate linearly over the radius and hold beyond the ends', () => {
  const v = Float64Array.from([1, 2, 4]);
  assert.equal(knotValue(v, 0), 1);
  assert.equal(knotValue(v, 0.25), 1.5);
  assert.equal(knotValue(v, 0.75), 3);
  assert.equal(knotValue(v, 1), 4);
  assert.equal(knotValue(v, 1.4), 4);
  assert.equal(knotValue(v, -1), 1);
});

test('the lens warp keeps the centre, crops at native scale and stays on the sensor', () => {
  const lens = sonyLensModel(PARAMS)!;
  const w = 700;
  const h = 466;
  const warp = geometryWarp(null, lens, w, h, w);
  // The corner knot reads past the frame (scale > 1 there), so a little is cropped, never upsampled.
  assert.ok(warp.scale < 1 && warp.scale > 0.99, `scale ${warp.scale}`);
  assert.equal(warp.width, Math.floor(w * warp.scale + 1e-6));
  assert.equal(warp.height, Math.floor(h * warp.scale + 1e-6));
  assert.equal(warp.sourceWidth, w);
  // The output's centre samples the sensor's centre.
  const [cx, cy] = warpPoint(warp, (warp.width - 1) / 2, (warp.height - 1) / 2);
  assert.ok(Math.abs(cx - (w - 1) / 2) < 1e-9 && Math.abs(cy - (h - 1) / 2) < 1e-9);
  for (const [u, v] of [[0, 0], [warp.width - 1, 0], [0, warp.height - 1], [warp.width - 1, warp.height - 1]]) {
    for (let c = 0; c < 3; c++) {
      const [x, y] = warpPoint(warp, u, v, c);
      assert.ok(x >= -0.5 && y >= -0.5 && x <= w - 0.5 && y <= h - 0.5, `corner (${u}, ${v}) channel ${c} → (${x}, ${y})`);
    }
  }
});

test('lateral CA moves red outwards and blue inwards relative to green', () => {
  const lens = sonyLensModel(PARAMS)!;
  const w = 7008;
  const h = 4672;
  const warp = geometryWarp(null, lens, w, h, w);
  // A point at 40% of the half-diagonal, right of centre: red 1 + 384·2⁻²¹, blue 1 − 256·2⁻²¹ there.
  const r = 0.4;
  const u = Math.round(warp.width / 2 + r * Math.hypot(w / 2, h / 2));
  const v = warp.height / 2;
  const [xg] = warpPoint(warp, u, v, 1);
  const [xr] = warpPoint(warp, u, v, 0);
  const [xb] = warpPoint(warp, u, v, 2);
  const dx = xg + 0.5 - w / 2;
  const rr = dx / Math.hypot(w / 2, h / 2) / radialScale(lens, r, 1);
  const expected = (c: number): number => dx * (radialScale(lens, rr, c) / radialScale(lens, rr, 1) - 1);
  assert.ok(Math.abs(xr - xg - expected(0)) < 0.01, `red ${xr - xg} vs ${expected(0)}`);
  assert.ok(Math.abs(xb - xg - expected(2)) < 0.01, `blue ${xb - xg} vs ${expected(2)}`);
  assert.ok(xr - xg > 0.25 && xb - xg < -0.15, `red ${xr - xg}, blue ${xb - xg}`);

  // applyWarp follows the per-channel positions: a vertical white line splits into colour fringes.
  const small = 400;
  const rgb = new Float32Array(small * small * 3);
  for (let y = 0; y < small; y++) for (let c = 0; c < 3; c++) rgb[(y * small + 380) * 3 + c] = 1;
  const strong = { distortion: null, caRed: Float64Array.from([1.01, 1.01]), caBlue: Float64Array.from([0.99, 0.99]), vignetting: null };
  const out = applyWarp(rgb, small, small, geometryWarp(null, strong, small, small, small));
  const row = Math.floor(small / 2) * small;
  const peak = (c: number): number => {
    let best = 0;
    for (let x = 1; x < small; x++) if (out[(row + x) * 3 + c] > out[(row + best) * 3 + c]) best = x;
    return best;
  };
  assert.ok(peak(0) < peak(1) && peak(2) > peak(1), `red ${peak(0)}, green ${peak(1)}, blue ${peak(2)}`);
});

test('devignetting brightens the corners by the recorded falloff and leaves the centre', () => {
  const lens = sonyLensModel(PARAMS)!;
  const w = 64;
  const h = 48;
  const rgb = new Float32Array(w * h * 3).fill(0.5);
  devignette(rgb, w, h, lens);
  const centre = rgb[((h / 2) * w + w / 2) * 3];
  const corner = rgb[0];
  assert.ok(Math.abs(centre - 0.5) < 0.01, `centre ${centre}`);
  const r = Math.hypot(0.5 - w / 2, 0.5 - h / 2) / Math.hypot(w / 2, h / 2);
  assert.ok(Math.abs(corner - 0.5 / knotValue(lens.vignetting!, r)) < 1e-6, `corner ${corner}`);
  assert.ok(corner > 0.75, 'about +0.7 EV at the corner');
});

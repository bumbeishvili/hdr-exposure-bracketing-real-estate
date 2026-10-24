import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readDcp } from '../src/color/dcp.ts';
import {
  applyHueSatTable,
  colorTransform,
  mul3,
  neutralForTemperature,
  PROPHOTO_TO_SRGB,
  temperatureToXy,
  xyToTemperature,
  type Vec3,
} from '../src/color/color.ts';

const profile = readDcp(new Uint8Array(readFileSync(new URL('../src/color/profiles/Sony ILCE-7M4 Adobe Standard.dcp', import.meta.url))));

test('reads the bundled A7 IV Adobe Standard profile', () => {
  assert.equal(profile.cameraModel, 'Sony ILCE-7M4');
  assert.equal(profile.name, 'Adobe Standard');
  assert.equal(profile.illuminant1, 17);
  assert.equal(profile.illuminant2, 21);
  assert.equal(profile.embedPolicy, 0, 'Adobe Standard profiles allow copying');
  assert.ok(Math.abs(profile.colorMatrix2![0] - 0.746) < 1e-4);
  assert.equal(profile.hueSatMap1?.hueDivisions, 90);
  assert.equal(profile.lookTable?.valDivisions, 16);
});

test('Robertson temperature round trip and standard illuminants', () => {
  const d65 = xyToTemperature([0.3127, 0.329]);
  assert.ok(Math.abs(d65.temperature - 6504) < 15, `D65 → ${d65.temperature}`);
  // D65 sits above the Planckian locus (Duv ≈ +0.0032): about +10 on the Lightroom tint scale.
  assert.ok(Math.abs(d65.tint - 9.7) < 1, `D65 tint ${d65.tint}`);
  const a = xyToTemperature([0.44757, 0.40745]);
  assert.ok(Math.abs(a.temperature - 2856) < 10, `A → ${a.temperature}`);
  for (const [t, tint] of [
    [3200, 0],
    [5000, 10],
    [7500, -20],
  ]) {
    const back = xyToTemperature(temperatureToXy(t, tint));
    assert.ok(Math.abs(back.temperature - t) < 1, `${t} K → ${back.temperature}`);
    assert.ok(Math.abs(back.tint - tint) < 0.1, `tint ${tint} → ${back.tint}`);
  }
});

test('white balance neutral maps to ProPhoto and sRGB white', () => {
  for (const t of [2900, 5500, 7000]) {
    const neutral = neutralForTemperature(profile, t, 0);
    const tr = colorTransform(profile, neutral);
    assert.ok(Math.abs(tr.temperature - t) < 2, `neutral for ${t} K reads back as ${tr.temperature}`);
    const pp = mul3(tr.cameraToProPhoto, neutral);
    for (const c of pp) assert.ok(Math.abs(c - 1) < 0.002, `ProPhoto white ${pp}`);
    const srgb = mul3(PROPHOTO_TO_SRGB, [1, 1, 1]);
    for (const c of srgb) assert.ok(Math.abs(c - 1) < 0.001, `sRGB white ${srgb}`);
  }
});

test('the sample frames’ white balance reads as daylight', () => {
  // Camera set to Daylight: WB_RGGBLevels 2501/1024/1024/1650; camera auto WB 2796/1024/1024/1605.
  const daylight = colorTransform(profile, [1024 / 2501, 1, 1024 / 1650]);
  assert.ok(daylight.temperature > 4800 && daylight.temperature < 5800, `Daylight preset at ${daylight.temperature} K`);
  const auto = colorTransform(profile, [1024 / 2796, 1, 1024 / 1605]);
  assert.ok(auto.temperature > daylight.temperature, `camera auto WB (${auto.temperature} K) is cooler-looking than Daylight`);
});

test('an identity hue/sat table leaves colours unchanged', () => {
  const table = { hueDivisions: 6, satDivisions: 3, valDivisions: 1, encoding: 0, data: new Float32Array(6 * 3 * 3) };
  for (let i = 0; i < table.data.length; i += 3) table.data.set([0, 1, 1], i);
  const rgb = Float32Array.from([0.2, 0.5, 0.1, 1.5, 0.3, 0.3, 0.4, 0.4, 0.4]);
  const before = Array.from(rgb);
  applyHueSatTable(table, rgb);
  rgb.forEach((v, i) => assert.ok(Math.abs(v - before[i]) < 1e-6, `${v} vs ${before[i]}`));
});

test('the Adobe tables move saturated colours but keep neutrals neutral', () => {
  const tr = colorTransform(profile, neutralForTemperature(profile, 5500, 0));
  const rgb = Float32Array.from([0.5, 0.5, 0.5, 0.6, 0.2, 0.1] as number[]);
  applyHueSatTable(tr.hueSatMap!, rgb);
  const grey: Vec3 = [rgb[0], rgb[1], rgb[2]];
  assert.ok(Math.max(...grey) - Math.min(...grey) < 1e-6, `grey stays grey: ${grey}`);
  assert.ok(Math.abs(rgb[3] - 0.6) + Math.abs(rgb[4] - 0.2) + Math.abs(rgb[5] - 0.1) > 1e-3, 'saturated colour is adjusted');
});

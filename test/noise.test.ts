// Phase 3 check: the noise model is recovered on synthetic data with a known
// Poisson-Gaussian noise, and on the sample bracket it predicts pair residuals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readArw, type RawFrame } from '../src/raw/arw.ts';
import { computeFrameStats } from '../src/analysis/stats.ts';
import { analyzeExposures } from '../src/analysis/exposure.ts';
import { fitNoiseModel } from '../src/analysis/noise.ts';

const ALPHA = [0.24, 0.26, 0.26, 0.22];
const BETA = [1.9, 2.2, 2.2, 1.5];

/** Tripod bracket of a textured scene with Var(v) = α(1 + γ·log2(t/t0))·s + β per CFA position. */
function bracket(exposures: number[], gamma = 0): RawFrame[] {
  const width = 1200;
  const height = 800;
  const scene = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Smooth gradient regions plus a band of fine texture.
      const base = 0.2 + 30 * (x / width) ** 3 + 8 * (y / height);
      const texture = y > 300 && y < 420 ? 4 * (((x >> 3) + (y >> 3)) & 1) : 0;
      scene[y * width + x] = base + texture;
    }
  }
  let seed = 7;
  const rand = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const gauss = (): number => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  return exposures.map((e, k) => {
    const cfa = new Uint16Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = ((y & 1) << 1) | (x & 1);
        const s = scene[y * width + x] * e;
        const v = 512 + s + gauss() * Math.sqrt(ALPHA[p] * (1 + gamma * Math.log2(e / exposures[0])) * s + BETA[p]);
        cfa[y * width + x] = Math.min(16383, Math.max(0, Math.round(v)));
      }
    }
    return {
      fileName: `synthetic-${k}`,
      make: 'SONY',
      model: 'synthetic',
      software: '',
      orientation: 1,
      width,
      height,
      bitsPerSample: 14,
      compression: 1,
      rawFileType: 'synthetic',
      cfa,
      cfaPattern: { width: 2, height: 2, colors: [0, 1, 1, 2], name: 'RGGB' },
      blackLevel: [512, 512, 512, 512],
      whiteLevel: 16383,
      sr2WhiteLevel: null,
      crop: { left: 0, top: 0, width, height },
      asShotWb: null,
      sources: { blackLevel: 'default', whiteLevel: 'default', asShotWb: null },
      exposure: { exposureTime: e / 100, exposureTimeRational: [e, 100], fNumber: 8, iso: 100, exposureCompensation: NaN, dateTimeOriginal: '', subSecTimeOriginal: '', focalLength: 35, lensModel: '', exposureMode: 2 },
      sequenceNumber: k + 1,
      releaseMode: null,
      sr2: null,
    };
  });
}

for (const gamma of [0, 0.08]) {
  test(`recovers alpha, beta and time slope ${gamma} from a synthetic bracket`, () => {
    const frames = bracket([4, 16, 64, 256], gamma);
    const exposures = analyzeExposures(frames, frames.map((f) => computeFrameStats(f).meanSignal));
    const model = fitNoiseModel(frames, exposures, { stride: 1 });
    assert.ok(Math.abs(model.timeSlope - gamma) < 0.02, `time slope ${model.timeSlope}`);
    model.channels.forEach((c, p) => {
      assert.ok(Math.abs(c.alpha / ALPHA[p] - 1) < 0.06, `${c.name} alpha ${c.alpha} vs ${ALPHA[p]}`);
      assert.ok(Math.abs(c.beta / BETA[p] - 1) < 0.2, `${c.name} beta ${c.beta} vs ${BETA[p]}`);
    });
    for (const pair of model.pairs) {
      // A variance from n samples has relative standard error √(2/n); allow 4 of those plus 5%.
      for (const bins of pair.bins) {
        for (const b of bins) assert.ok(Math.abs(b.measured / b.predicted - 1) < 4 * Math.sqrt(2 / b.samples) + 0.05, `bin ${b.signal} (n=${b.samples}): ${b.measured / b.predicted}`);
      }
      for (const d of pair.blackOffset) assert.ok(Math.abs(d) < 0.3, `black offset ${d}`);
    }
  });
}

const SAMPLES = new URL('../app-samples/', import.meta.url);
const sampleFiles = existsSync(SAMPLES) ? readdirSync(SAMPLES).filter((f) => /\.arw$/i.test(f)).sort() : [];

test('sample bracket: the model predicts pair residuals on flat regions', { skip: sampleFiles.length < 2 ? 'needs a bracket set in app-samples/' : false }, () => {
  const frames = sampleFiles.map((f) => readArw(readFileSync(new URL(f, SAMPLES)), f));
  const exposures = analyzeExposures(frames, frames.map((f) => computeFrameStats(f).meanSignal));
  const model = fitNoiseModel(frames, exposures);
  for (const pair of model.pairs) {
    const ratios = pair.bins.flat().map((b) => b.measured / b.predicted);
    const sorted = [...ratios].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const within = ratios.filter((x) => Math.abs(x - 1) < 0.2).length / ratios.length;
    const name = `${frames[pair.bright].fileName}/${frames[pair.dark].fileName}`;
    assert.ok(Math.abs(med - 1) < 0.07, `${name}: median measured/predicted ${med}`);
    assert.ok(within > 0.9, `${name}: only ${(within * 100).toFixed(0)}% of bins within ±20%`);
    for (const d of pair.blackOffset) assert.ok(Math.abs(d) < 1, `${name}: black offset ${d} DN`);
  }
});

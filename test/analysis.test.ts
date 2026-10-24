// Phase 2 check: measured exposure ratios sort the frames and differ from EXIF
// by a measured amount. Synthetic tests pin the estimator down independently.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readArw, type RawFrame } from '../src/raw/arw.ts';
import { computeFrameStats } from '../src/analysis/stats.ts';
import { analyzeExposures, estimateExposureRatio } from '../src/analysis/exposure.ts';
import { makePreview } from '../src/analysis/preview.ts';

/** A synthetic RGGB frame: smooth scene × exposure, Gaussian shot + read noise, hard clip. */
function syntheticFrame(exposure: number, seed: number, overrides: Partial<RawFrame> = {}): RawFrame {
  const width = 512;
  const height = 384;
  const black = 512;
  const white = 16383;
  const cfa = new Uint16Array(width * height);
  let s = seed >>> 0;
  const rand = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const gauss = (): number => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const gain = [0.45, 1, 1, 0.7];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const scene = 40 + 3000 * (0.5 + 0.5 * Math.sin(x / 37) * Math.cos(y / 23)) * (x / width + 0.2);
      const signal = scene * gain[((y & 1) << 1) | (x & 1)] * exposure;
      const noisy = signal + gauss() * Math.sqrt(signal / 1.3 + 9);
      cfa[y * width + x] = Math.min(white, Math.max(0, Math.round(black + noisy)));
    }
  }
  return {
    fileName: `synthetic-${exposure}`,
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
    blackLevel: [black, black, black, black],
    whiteLevel: white,
    sr2WhiteLevel: null,
    crop: { left: 0, top: 0, width, height },
    asShotWb: null,
    sources: { blackLevel: 'default', whiteLevel: 'default', asShotWb: null },
    exposure: {
      exposureTime: exposure / 100,
      exposureTimeRational: [exposure, 100],
      fNumber: 8,
      iso: 100,
      exposureCompensation: NaN,
      dateTimeOriginal: '',
      subSecTimeOriginal: '',
      focalLength: 35,
      lensModel: '',
      exposureMode: 2,
    },
    sequenceNumber: null,
    releaseMode: null,
    sr2: null,
    ...overrides,
  };
}

test('estimator recovers a known ratio despite noise and clipping', () => {
  const dark = syntheticFrame(3, 1);
  const bright = syntheticFrame(3 * 3.3, 2); // brightest areas clip
  const stats = computeFrameStats(bright);
  assert.ok(stats.channels.some((c) => c.clippedFraction > 0.05), 'test scene should clip');
  const est = estimateExposureRatio(bright, dark, { blockSize: 4 });
  assert.ok(Math.abs(est.ratio / 3.3 - 1) < 0.005, `ratio ${est.ratio}`);
  for (const c of est.perChannel) assert.ok(Math.abs(c.ratio / 3.3 - 1) < 0.01, `${c.name} ${c.ratio}`);
});

test('estimator ignores a moving region', () => {
  const dark = syntheticFrame(2, 3);
  const bright = syntheticFrame(4, 4);
  // Paint a bright object into one frame only, over about 10% of the area.
  for (let y = 100; y < 220; y++) for (let x = 60; x < 220; x++) bright.cfa[y * bright.width + x] = 9000;
  const est = estimateExposureRatio(bright, dark, { blockSize: 4 });
  assert.ok(Math.abs(est.ratio / 2 - 1) < 0.005, `ratio ${est.ratio}`);
  assert.ok(est.inliers < est.usable, 'motion blocks rejected as outliers');
});

test('analysis sorts frames by measured exposure, not input order', () => {
  const frames = [syntheticFrame(4, 5), syntheticFrame(1, 6), syntheticFrame(16, 7), syntheticFrame(2, 8)];
  const stats = frames.map(computeFrameStats);
  const analysis = analyzeExposures(frames, stats.map((s) => s.meanSignal));
  assert.deepEqual(analysis.order, [1, 3, 0, 2]);
  const ev = analysis.frames.map((f) => f.measuredEv - analysis.frames[1].measuredEv);
  for (const [i, expected] of [2, 0, 4, 1].entries()) assert.ok(Math.abs(ev[i] - expected) < 0.01, `frame ${i}: ${ev[i]}`);
});

test('preview averages each colour and flags clipped bins', () => {
  const frame = syntheticFrame(30, 9);
  const preview = makePreview(frame, 64);
  assert.equal(preview.width, 64);
  assert.equal(preview.height, 48);
  assert.ok(preview.clip.some((c) => c !== 0), 'bright synthetic frame has clipped bins');
  assert.ok(preview.rgb.every((v) => v >= -0.01 && v <= 1.0001));
});

const SAMPLES = new URL('../app-samples/', import.meta.url);
const sampleFiles = existsSync(SAMPLES) ? readdirSync(SAMPLES).filter((f) => /\.arw$/i.test(f)).sort() : [];

test('sample bracket: measured ratios sort the frames and correct EXIF', { skip: sampleFiles.length < 2 ? 'needs a bracket set in app-samples/' : false }, () => {
  const frames = sampleFiles.map((f) => readArw(readFileSync(new URL(f, SAMPLES)), f));
  const analysis = analyzeExposures(frames, frames.map((f) => computeFrameStats(f).meanSignal));

  const byExif = frames.map((_, i) => i).sort((a, b) => frames[a].exposure.exposureTime - frames[b].exposure.exposureTime);
  assert.deepEqual(analysis.order, byExif, 'measured order matches shutter-time order');

  for (const pair of analysis.pairs) {
    const est = pair.estimate;
    // The camera's bracket offsets are exact; its EXIF shutter times are rounded nominal values.
    const offsetStep = frames[pair.bright].exposure.exposureCompensation - frames[pair.dark].exposure.exposureCompensation;
    assert.ok(Math.abs(est.ev - offsetStep) < 0.02, `${frames[pair.bright].fileName}: measured ${est.ev} EV vs offset step ${offsetStep}`);
    for (const c of est.perChannel) assert.ok(Math.abs(c.ev - est.ev) < 0.01, `${c.name} disagrees: ${c.ev}`);
    assert.ok(est.inliers / est.usable > 0.9);
  }
  const worst = Math.max(...analysis.frames.map((f) => Math.abs(f.differenceEv)));
  assert.ok(worst > 0.05, `EXIF is expected to be off by a measurable amount (worst ${worst} EV)`);
});

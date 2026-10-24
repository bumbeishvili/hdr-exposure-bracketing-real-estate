// Phase 7 check: a subject that moves between frames must come from the base
// frame only, with no faint copy where it stood in another frame.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RawFrame } from '../src/raw/arw.ts';
import { computeFrameStats } from '../src/analysis/stats.ts';
import { analyzeExposures } from '../src/analysis/exposure.ts';
import { fitNoiseModel } from '../src/analysis/noise.ts';
import { alignFrames } from '../src/merge/align.ts';
import { mergeFrames } from '../src/merge/merge.ts';
import { detectMotion } from '../src/merge/deghost.ts';

const W = 640;
const H = 448;

/** Textured background; a bright 60 × 90 px "person" with its left edge at `subjectX` (or none). */
function frame(exposure: number, seq: number, subjectX: number | null, seed: number): RawFrame {
  let s = seed;
  const rand = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const gauss = (): number => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const cfa = new Uint16Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let scene = 60 + 40 * Math.sin(x / 23) * Math.cos(y / 31) + 20 * ((x >> 4) & 1);
      if (subjectX !== null && x >= subjectX && x < subjectX + 60 && y >= 180 && y < 270) scene = 260;
      const sig = scene * exposure;
      cfa[y * W + x] = Math.min(16383, Math.max(0, Math.round(512 + sig + gauss() * Math.sqrt(0.25 * sig + 2))));
    }
  }
  return {
    fileName: `f${seq}`,
    make: 'SONY',
    model: 'synthetic',
    software: '',
    orientation: 1,
    width: W,
    height: H,
    bitsPerSample: 14,
    compression: 1,
    rawFileType: 'synthetic',
    cfa,
    cfaPattern: { width: 2, height: 2, colors: [0, 1, 1, 2], name: 'RGGB' },
    blackLevel: [512, 512, 512, 512],
    whiteLevel: 16383,
    sr2WhiteLevel: null,
    crop: { left: 0, top: 0, width: W, height: H },
    asShotWb: null,
    sources: { blackLevel: 'default', whiteLevel: 'default', asShotWb: null },
    exposure: { exposureTime: exposure / 50, exposureTimeRational: [exposure, 50], fNumber: 8, iso: 100, exposureCompensation: NaN, dateTimeOriginal: '', subSecTimeOriginal: '', focalLength: 35, focalLength35mm: 35, lensModel: '', exposureMode: 2 },
    sequenceNumber: seq,
    releaseMode: null,
    sr2: null,
    lensCorrection: null,
  };
}

/** Mean merged radiance over the subject-sized box at `x`. */
function boxMean(data: Float32Array, x: number): number {
  let sum = 0;
  let n = 0;
  for (let y = 190; y < 260; y++) for (let xx = x + 8; xx < x + 52; xx++) (sum += data[y * W + xx]), n++;
  return sum / n;
}

test('a moving subject comes from the base frame only', () => {
  // Base (shot 1) and the short frame see the subject at x = 100; the long frame saw it at x = 400.
  const frames = [frame(4, 1, 100, 11), frame(1, 2, 100, 12), frame(16, 3, 400, 13)];
  const exposures = analyzeExposures(frames, frames.map((f) => computeFrameStats(f).meanSignal));
  assert.equal(exposures.reference, 0);
  const noise = fitNoiseModel(frames, exposures, { stride: 1 });
  const alignment = alignFrames(frames, exposures, noise);
  const motion = detectMotion(frames, exposures, noise, alignment);
  assert.ok(motion.share[2] > 0.01, `the long frame is flagged (${motion.share[2]})`);
  assert.ok(motion.share[1] < 0.005, `the short frame agrees with the base (${motion.share[1]})`);

  const ghosted = mergeFrames(frames, exposures, noise, alignment).image.data;
  const clean = mergeFrames(frames, exposures, noise, alignment, { motion }).image.data;
  // The merge is in base-frame DN: the base frame has exposure 4.
  const background = (60 + 20 * 0.5) * 4; // the texture averages out over the box
  const subject = 260 * 4;
  // Without deghosting the long frame dominates and paints the subject at x = 400.
  assert.ok(boxMean(ghosted, 400) > 600, `ghost without deghosting: ${boxMean(ghosted, 400)}`);
  // With deghosting: background at x = 400, subject at x = 100 — both from the base frame.
  assert.ok(Math.abs(boxMean(clean, 400) - background) < 40, `no ghost: ${boxMean(clean, 400)}`);
  assert.ok(Math.abs(boxMean(clean, 100) - subject) < 20, `subject kept: ${boxMean(clean, 100)}`);
});

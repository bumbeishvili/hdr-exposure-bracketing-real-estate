// Runs alignment and the Bayer merge on a bracket and prints the checks.
// Usage: node scripts/merge.ts app-samples/*.ARW [--pfm out.pfm]
// --pfm writes the merged preview as a little-endian colour PFM (linear, 1.0 = reference white).

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readArw } from '../src/raw/arw.ts';
import { computeFrameStats } from '../src/analysis/stats.ts';
import { analyzeExposures } from '../src/analysis/exposure.ts';
import { fitNoiseModel } from '../src/analysis/noise.ts';
import { alignFrames } from '../src/merge/align.ts';
import { mergeFrames } from '../src/merge/merge.ts';

const args = process.argv.slice(2);
const pfmAt = args.indexOf('--pfm');
const pfm = pfmAt >= 0 ? args.splice(pfmAt, 2)[1] : null;
const frames = args.map((p) => readArw(readFileSync(p), basename(p)));
const t0 = performance.now();
const exposures = analyzeExposures(frames, frames.map((f) => computeFrameStats(f).meanSignal));
const noise = fitNoiseModel(frames, exposures);
const t1 = performance.now();
const alignment = alignFrames(frames, exposures, noise);
const t2 = performance.now();
const merged = mergeFrames(frames, exposures, noise, alignment);
const t3 = performance.now();

console.log('alignment (raw px, frame(x + shift) shows reference(x)):');
for (const i of exposures.order) {
  const a = alignment.frames[i];
  const q = a.quadrants.map((s) => `(${s.dx.toFixed(3)}, ${s.dy.toFixed(3)})`).join(' ');
  console.log(
    `  ${frames[i].fileName}${i === exposures.reference ? '*' : ' '} shift (${a.shift.dx.toFixed(3)}, ${a.shift.dy.toFixed(3)})  residual ${a.residualBefore.toFixed(2)} → ${a.residualAfter.toFixed(2)}${a.unreliable ? '  UNRELIABLE' : ''}  quadrants ${q}`,
  );
}
console.log('');
console.log('weight share: ' + exposures.order.map((i) => `${frames[i].fileName} ${(100 * merged.weightShare[i]).toFixed(1)}%`).join(' · '));
console.log('seam check (brighter frame in roll-off vs next darker):');
for (const s of merged.seams) {
  console.log(`  ${frames[s.bright].fileName} vs ${frames[s.dark].fileName}: ${s.samples} samples · bias ${(100 * s.relativeBias).toFixed(3)}% · z ${s.z.toFixed(2)}`);
}
console.log(`clipped after merge ${(100 * merged.clippedFraction).toFixed(4)}% · dynamic range ${merged.dynamicRangeStops.toFixed(1)} stops`);
console.log(`analysis ${(t1 - t0).toFixed(0)} ms · align ${(t2 - t1).toFixed(0)} ms · merge ${(t3 - t2).toFixed(0)} ms`);

if (pfm) {
  const { width, height, rgb } = merged.preview;
  const header = Buffer.from(`PF\n${width} ${height}\n-1.0\n`, 'ascii');
  const body = Buffer.alloc(width * height * 12);
  // PFM rows run bottom to top.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width * 3; x++) body.writeFloatLE(rgb[(height - 1 - y) * width * 3 + x], (y * width * 3 + x) * 4);
  }
  writeFileSync(pfm, Buffer.concat([header, body]));
  console.log(`wrote ${pfm}`);
}

// Prints the Phase 2 inspection numbers for a bracket set.
// Usage: node scripts/inspect.ts app-samples/*.ARW

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readArw } from '../src/raw/arw.ts';
import { computeFrameStats } from '../src/analysis/stats.ts';
import { analyzeExposures, linearLimit } from '../src/analysis/exposure.ts';
import { fitNoiseModel } from '../src/analysis/noise.ts';

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error('Usage: node scripts/inspect.ts <file.ARW> [...]');
  process.exit(1);
}

const t0 = performance.now();
const frames = paths.map((p) => readArw(readFileSync(p), basename(p)));
const t1 = performance.now();
const stats = frames.map(computeFrameStats);
const t2 = performance.now();
const analysis = analyzeExposures(frames, stats.map((s) => s.meanSignal));
const t3 = performance.now();

const pct = (x: number): string => `${(100 * x).toFixed(2)}%`;
const ev = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(3)}`;
const shutter = (t: number): string => (t >= 0.3 ? `${t}s` : `1/${Math.round(1 / t)}`);

const f0 = frames[0];
console.log(`${f0.model} · ${f0.rawFileType} · ${f0.width}×${f0.height} · CFA ${f0.cfaPattern.name} · ${f0.bitsPerSample}-bit`);
console.log(`black ${f0.blackLevel.join('/')} (${f0.sources.blackLevel}) · white ${f0.whiteLevel} (${f0.sources.whiteLevel}) · SR2 white ${f0.sr2WhiteLevel?.join('/') ?? '—'} · linear limit ${linearLimit(f0)}`);
console.log('');
console.log('frame            seq  shutter    EXIF EV   measured   diff     clip R / G1 / G2 / B');
for (const i of analysis.order) {
  const f = frames[i];
  const e = analysis.frames[i];
  const clips = stats[i].channels.map((c) => pct(c.clippedFraction)).join(' / ');
  const ref = i === analysis.reference ? '*' : ' ';
  console.log(
    `${(f.fileName + ref).padEnd(16)} ${String(f.sequenceNumber ?? '-').padStart(3)}  ${shutter(f.exposure.exposureTime).padEnd(9)} ${ev(e.exifEv).padStart(8)} ${ev(e.measuredEv).padStart(10)} ${ev(e.differenceEv).padStart(7)}   ${clips}`,
  );
}
console.log('');
console.log('pair (bright/dark)            EXIF ratio  measured  diff %   spread EV  inliers/usable   per-channel EV');
for (const p of analysis.pairs) {
  const est = p.estimate;
  const diff = (est.ratio / p.exifRatio - 1) * 100;
  const chans = est.perChannel.map((c) => `${c.name} ${c.ev.toFixed(3)}`).join('  ');
  console.log(
    `${(frames[p.bright].fileName + ' / ' + frames[p.dark].fileName).padEnd(30)} ${p.exifRatio.toFixed(4).padStart(9)} ${est.ratio.toFixed(4).padStart(9)} ${diff.toFixed(2).padStart(6)}   ${est.spreadEv.toFixed(4).padStart(8)}   ${String(est.inliers).padStart(6)}/${String(est.usable).padEnd(7)}  ${chans}`,
  );
}
console.log('');
console.log('linearity (brighter frame level → ratio relative to overall):');
for (const p of analysis.pairs) {
  const line = p.estimate.linearity.map((b) => `${b.level.toFixed(2)}:${b.relative.toFixed(3)}`).join(' ');
  console.log(`  ${frames[p.bright].fileName}: ${line}`);
}
const t4 = performance.now();
const noise = fitNoiseModel(frames, analysis);
const t5 = performance.now();
console.log('');
console.log(`noise model, Var(v) = alpha·(1 + ${noise.timeSlope.toFixed(3)}·log2(t / ${noise.referenceTime.toFixed(3)} s))·s + beta (flat pixels, all pairs jointly):`);
const range = f0.whiteLevel - f0.blackLevel[0];
for (const c of noise.channels) {
  const gain = 1 / c.alpha;
  const read = Math.sqrt(c.beta);
  console.log(
    `  ${c.name.padEnd(3)} alpha ${c.alpha.toFixed(4)} DN²/DN → gain ${gain.toFixed(2)} e-/DN · read noise ${read.toFixed(2)} DN (${(read * gain).toFixed(1)} e-) · full well ${Math.round(range * gain)} e- · DR ${Math.log2(range / read).toFixed(1)} stops`,
  );
}
console.log('');
console.log('pair residual check (measured ÷ predicted variance per signal bin, flat pixels):');
for (const p of noise.pairs) {
  const ratios = p.bins.flat().map((b) => b.measured / b.predicted);
  const sorted = [...ratios].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  console.log(
    `  ${frames[p.bright].fileName} / ${frames[p.dark].fileName}: median ${med.toFixed(3)} · range ${sorted[0].toFixed(3)}–${sorted[sorted.length - 1].toFixed(3)} · ${ratios.length} bins · flat ${(100 * p.flatFraction).toFixed(0)}% · black offset ${p.blackOffset.map((d) => d.toFixed(2)).join('/')} DN`,
  );
}
const g1 = noise.pairs[1].bins[1];
console.log(`  detail ${frames[noise.pairs[1].bright].fileName} G1: ` + g1.filter((_, i) => i % 3 === 0).map((b) => `${b.signal.toFixed(0)}:${(b.measured / b.predicted).toFixed(2)}`).join(' '));
console.log('');
console.log(`decode ${(t1 - t0).toFixed(0)} ms · stats ${(t2 - t1).toFixed(0)} ms · ratios ${(t3 - t2).toFixed(0)} ms · noise ${(t5 - t4).toFixed(0)} ms`);

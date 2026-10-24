// Renders the finished real-estate look for a bracket and writes PNGs.
// Usage: node scripts/look.ts <out-dir> app-samples/*.ARW
// The merged image is cached in <out-dir>/merged.bin so look tweaks re-render in seconds.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readArw } from '../src/raw/arw.ts';
import { computeFrameStats } from '../src/analysis/stats.ts';
import { analyzeExposures } from '../src/analysis/exposure.ts';
import { fitNoiseModel } from '../src/analysis/noise.ts';
import { alignFrames } from '../src/merge/align.ts';
import { mergeFrames } from '../src/merge/merge.ts';
import { binMerged, type RgbImage } from '../src/merge/bin.ts';
import { readDcp } from '../src/color/dcp.ts';
import { estimateInteriorWhiteBalance } from '../src/color/wb.ts';
import { REAL_ESTATE_LOOK, renderLook, toRgba8, type LookParams } from '../src/look/render.ts';
import type { Vec3 } from '../src/color/color.ts';
import { encodePng } from './lib/png.ts';

const [outDir, ...paths] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const cache = join(outDir, 'merged.bin');

let image: RgbImage;
let asShot: Vec3;
if (existsSync(cache)) {
  const buf = readFileSync(cache);
  const head = new Float64Array(buf.buffer, buf.byteOffset, 5);
  image = { width: head[0], height: head[1], rgb: new Float32Array(buf.buffer.slice(buf.byteOffset + 40)) };
  asShot = [head[2], head[3], head[4]];
} else {
  const frames = paths.map((p) => readArw(readFileSync(p), basename(p)));
  const exposures = analyzeExposures(frames, frames.map((f) => computeFrameStats(f).meanSignal));
  const noise = fitNoiseModel(frames, exposures);
  const merged = mergeFrames(frames, exposures, noise, alignFrames(frames, exposures, noise));
  image = binMerged(merged.image, 2);
  const wb = frames[exposures.reference].asShotWb!;
  asShot = [wb[1] / wb[0], 1, wb[2] / wb[3]];
  const head = Buffer.from(new Float64Array([image.width, image.height, ...asShot]).buffer);
  writeFileSync(cache, Buffer.concat([head, Buffer.from(image.rgb.buffer)]));
}

const profile = readDcp(new Uint8Array(readFileSync(new URL('../src/color/profiles/Sony ILCE-7M4 Adobe Standard.dcp', import.meta.url))));
const auto = estimateInteriorWhiteBalance(profile, image.rgb);
console.log(`auto white balance: ${Math.round(auto.temperature)} K, tint ${auto.tint.toFixed(1)}, ${(auto.coverage * 100).toFixed(0)}% of interior near-neutral`);

const variants: Array<[string, LookParams]> = [
  ['look-auto-wb', { ...REAL_ESTATE_LOOK, neutral: auto.neutral }],
  ['look-as-shot-wb', { ...REAL_ESTATE_LOOK, neutral: asShot }],
];
for (const [name, look] of variants) {
  const t0 = performance.now();
  const out = renderLook(image.rgb, image.width, image.height, profile, look);
  const rgba = new Uint8ClampedArray(out.width * out.height * 4);
  toRgba8(out.rgb, rgba);
  writeFileSync(join(outDir, `${name}.png`), encodePng(rgba, out.width, out.height));
  console.log(`${name}: ${Math.round(out.temperature)} K / ${out.tint.toFixed(1)} · exposures ${out.exposures.join(', ')} · ${Math.round(performance.now() - t0)} ms`);
}

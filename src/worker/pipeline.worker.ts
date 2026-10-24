// Decodes ARW files and runs the per-frame and cross-frame analysis off the UI thread.
// Decoded frames stay here; the UI receives metadata, statistics and previews.

import { readArw, type RawFrame } from '../raw/arw.ts';
import { computeFrameStats } from '../analysis/stats.ts';
import { analyzeExposures, linearLimit, type ExposureAnalysis } from '../analysis/exposure.ts';
import { fitNoiseModel, type NoiseModel } from '../analysis/noise.ts';
import { alignFrames, type AlignmentResult } from '../merge/align.ts';
import { mergeFrames, type MergedImage } from '../merge/merge.ts';
import { detectMotion, type MotionMasks } from '../merge/deghost.ts';
import { checkSeams } from '../merge/seams.ts';
import { demosaicRect, type DemosaicAlgorithm, type Rect } from '../demosaic/demosaic.ts';
import { binMerged, type RgbImage } from '../merge/bin.ts';
import { readDcp, type CameraProfile } from '../color/dcp.ts';
import { colorTransform, neutralForTemperature, type Vec3 } from '../color/color.ts';
import { estimateInteriorWhiteBalance, whiteBalanceFromPatch, withTemperature } from '../color/wb.ts';
import { renderLook, toRgba8, type LookBase } from '../look/render.ts';
import { chunkInputs, DETAIL_BAND, type DetailJob } from '../look/detail.ts';
import { applyWarp, estimateUpright, geometryWarp } from '../geometry/upright.ts';
import { devignette, knotValue, sonyLensModel, type LensModel } from '../geometry/lens.ts';
import { writeDng } from '../raw/dng.ts';
import { exifSegment, insertSegment, type ExifInfo } from '../raw/jpeg-exif.ts';
import { renderPool } from './render-pool.ts';
import type { Matrix3 } from '../color/dcp.ts';
import profileUrl from '../color/profiles/Sony ILCE-7M4 Adobe Standard.dcp?url';
import type { ExportSize, LensInfo, LookSettings, WbSetting } from './protocol.ts';
import { makePreview } from '../analysis/preview.ts';
import type { FrameInfo, WorkerEvent, WorkerRequest } from './protocol.ts';

const scope = self as unknown as Worker;
const post = (event: WorkerEvent, transfer: Transferable[] = []): void => scope.postMessage(event, transfer);

let frames: Array<{ index: number; frame: RawFrame; meanSignal: number }> = [];
/** What a re-merge needs: the decoded frames and their analysis. */
let session: { raw: RawFrame[]; analysis: ExposureAnalysis; noise: NoiseModel; alignment: AlignmentResult } | null = null;
let motion: MotionMasks | null = null;
/** The full-resolution merged CFA, kept for demosaicing and export. */
let merged: MergedImage | null = null;

/** Look working images: preview size for interaction, twice that as the base of exports. */
let lookPreview: RgbImage | null = null;
let lookExport: RgbImage | null = null;
let profilePromise: Promise<CameraProfile> | null = null;
let pendingLook: { id: number; settings: LookSettings } | null = null;
let lookScheduled = false;
/** Upright: the rotation that straightens verticals, and the 35 mm-equivalent focal length it assumes. */
let uprightRotation: Matrix3 | null = null;
let focal35 = 35;
/** The lens's own corrections, from the base frame's maker notes. */
let lensModel: LensModel | null = null;
const corrected = new WeakMap<RgbImage, Map<string, RgbImage>>();

/** The working image as rendered: devignetted and resampled through the lens model and Upright when on. */
function working(img: RgbImage, s: Pick<LookSettings, 'upright' | 'lens'>): RgbImage {
  const rotation = s.upright ? uprightRotation : null;
  const lens = s.lens ? lensModel : null;
  if (!rotation && !lens) return img;
  const key = `${rotation ? 'u' : ''}${lens ? 'l' : ''}`;
  let cache = corrected.get(img);
  if (!cache) corrected.set(img, (cache = new Map()));
  let out = cache.get(key);
  if (!out) {
    const rgb = lens ? Float32Array.from(img.rgb) : img.rgb;
    if (lens) devignette(rgb, img.width, img.height, lens);
    const warp = geometryWarp(rotation, lens, img.width, img.height, (focal35 / 36) * img.width);
    out = { width: warp.width, height: warp.height, rgb: applyWarp(rgb, img.width, img.height, warp) };
    cache.set(key, out);
  }
  return out;
}

const loadProfile = (): Promise<CameraProfile> =>
  (profilePromise ??= fetch(profileUrl)
    .then((r) => r.arrayBuffer())
    .then((b) => readDcp(new Uint8Array(b))));

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

scope.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'open') void open(msg.files);
  else if (msg.type === 'crop') crop(msg.id, msg.rect, msg.algorithm, msg.wb);
  else if (msg.type === 'look') {
    // Latest wins: slider drags send many requests, only the newest is worth rendering.
    pendingLook = msg;
    if (!lookScheduled) {
      lookScheduled = true;
      setTimeout(() => void renderPendingLook(), 0);
    }
  } else if (msg.type === 'export') void exportJpeg(msg.id, msg.settings, msg.size);
  else if (msg.type === 'export-dng') void exportDng(msg.id, msg.settings);
  else if (msg.type === 'pick-neutral') void pickNeutral(msg.x, msg.y, msg);
  else if (msg.type === 'remerge') void remerge(msg.deghost);
};

async function renderPendingLook(): Promise<void> {
  lookScheduled = false;
  const req = pendingLook;
  pendingLook = null;
  if (!req || !lookPreview) return;
  try {
    const t0 = performance.now();
    const profile = await loadProfile();
    const { width, height, rgb } = working(lookPreview, req.settings);
    const out = renderLook(rgb, width, height, profile, { ...req.settings, neutral: neutralForTemperature(profile, req.settings.wb.temperature, req.settings.wb.tint) });
    const rgba = new Uint8ClampedArray(width * height * 4);
    toRgba8(out.rgb, rgba);
    post({ type: 'look', id: req.id, width, height, rgba, exposures: out.exposures, windowShare: out.windowShare, sizes: exportSizes(req.settings), ms: performance.now() - t0 }, [rgba.buffer]);
  } catch (err) {
    post({ type: 'look-error', id: req.id, message: errorText(err) });
  }
}

/** Pixel sizes of the exports: the crop of the quarter-size base render, and twice and four times that. */
function exportSizes(settings: LookSettings): Record<ExportSize, [number, number]> {
  const m = merged!;
  const w = m.width >> 2;
  const h = m.height >> 2;
  const rotation = settings.upright ? uprightRotation : null;
  const lens = settings.lens ? lensModel : null;
  const base = rotation || lens ? geometryWarp(rotation, lens, w, h, (focal35 / 36) * w) : { width: w, height: h };
  return { small: [base.width, base.height], half: [2 * base.width, 2 * base.height], full: [4 * base.width, 4 * base.height] };
}

async function exportJpeg(id: number, settings: LookSettings, size: ExportSize): Promise<void> {
  if (!merged) {
    post({ type: 'look-error', id, message: 'Nothing merged yet' });
    return;
  }
  try {
    const t0 = performance.now();
    const profile = await loadProfile();
    const neutral = neutralForTemperature(profile, settings.wb.temperature, settings.wb.tint);
    lookExport ??= binMerged(merged, 2);
    const work = working(lookExport, settings);
    const look = renderLook(work.rgb, work.width, work.height, profile, { ...settings, neutral }, size !== 'small');
    let image: { width: number; height: number; rgba: Uint8ClampedArray };
    if (size === 'small' || !look.base) {
      image = { width: work.width, height: work.height, rgba: new Uint8ClampedArray(work.width * work.height * 4) };
      toRgba8(look.rgb, image.rgba);
    } else {
      image = await renderDetailed(merged, look.base, settings, profile, neutral, size, (fraction) => post({ type: 'export-progress', id, fraction }));
    }
    const canvas = new OffscreenCanvas(image.width, image.height);
    canvas.getContext('2d')!.putImageData(new ImageData(image.rgba as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), 0, 0);
    // Quality 1.0: the least loss browsers offer, and Chromium only skips chroma subsampling there.
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 1 });
    const reference = session?.raw[session.analysis.reference];
    const blob = reference ? await insertSegment(jpeg, exifSegment(exifInfo(reference, image.width, image.height))) : jpeg;
    post({ type: 'export', id, format: 'jpeg', blob, width: image.width, height: image.height, ms: performance.now() - t0 });
  } catch (err) {
    post({ type: 'look-error', id, message: errorText(err) });
  }
}

/**
 * The finished look at full or half sensor resolution: the coarse levels from
 * the quarter-size render (`base`), the finer octaves fused band by band on
 * the render-worker pool (see detail.ts).
 */
async function renderDetailed(m: MergedImage, base: LookBase, settings: LookSettings, profile: CameraProfile, neutral: Vec3, size: 'full' | 'half', onProgress: (fraction: number) => void): Promise<{ width: number; height: number; rgba: Uint8ClampedArray }> {
  const source = size === 'full' ? 'rcd' : 'bin';
  const factor = size === 'full' ? 4 : 2;
  // The sensor image at this scale, and the output: the base render's crop, `factor` times larger.
  const sensorWidth = size === 'full' ? m.width : m.width >> 1;
  const sensorHeight = size === 'full' ? m.height : m.height >> 1;
  const width = factor * base.width;
  const height = factor * base.height;
  const lens = settings.lens ? lensModel : null;
  const rotation = settings.upright ? uprightRotation : null;
  const job: DetailJob = {
    width,
    height,
    factor,
    base: { width: base.width, height: base.height, y0: 0, rows: base.height, fused: base.fused, center: base.center },
    warp:
      rotation || lens
        ? geometryWarp(rotation, lens, sensorWidth, sensorHeight, (focal35 / 36) * sensorWidth, { width, height })
        : { inverse: [1, 0, 0, 0, 1, 0, 0, 0, 1], width, height, sourceWidth: sensorWidth, sourceHeight: sensorHeight, scale: 1, lens: null },
    vignetting: lens?.vignetting ?? null,
    transform: colorTransform(profile, neutral),
    gain: base.gain,
    exposures: base.exposures,
    finish: { contrast: settings.contrast, vibrance: settings.vibrance, cleanWhites: settings.cleanWhites },
  };
  const wb: [number, number, number] = [neutral[1] / neutral[0], 1, neutral[1] / neutral[2]];
  const threads = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  // About three chunks per worker: an even finish without much re-demosaicing at chunk edges.
  const step = Math.max(DETAIL_BAND, Math.ceil(height / (3 * threads) / DETAIL_BAND) * DETAIL_BAND);
  const chunks: Array<[number, number]> = [];
  for (let v = 0; v < height; v += step) chunks.push([v, Math.min(height, v + step)]);
  const rgba = new Uint8ClampedArray(width * height * 4);
  let rows = 0;
  let reported = 0;
  await renderPool(
    chunks.length,
    threads,
    (i) => {
      const [v0, v1] = chunks[i];
      const need = chunkInputs(job, source, m.height, v0, v1);
      const data = m.data.slice(need.cfa[0] * m.width, need.cfa[1] * m.width);
      const [b0, b1] = need.base;
      const fused = base.fused.slice(b0 * base.width * 3, b1 * base.width * 3);
      const center = base.center.slice(b0 * base.width, b1 * base.width);
      return {
        chunk: {
          id: i,
          job: { ...job, base: { width: base.width, height: base.height, y0: b0, rows: b1 - b0, fused, center } },
          cfa: { width: m.width, height: need.cfa[1] - need.cfa[0], data, cfaColors: m.cfaColors, referenceRange: m.referenceRange, offset: need.cfa[0] },
          source,
          wb,
          v0,
          v1,
        },
        transfer: [data.buffer, fused.buffer, center.buffer],
      };
    },
    (i, part) => rgba.set(part, chunks[i][0] * width * 4),
    (n) => {
      rows += n;
      const now = performance.now();
      if (now - reported > 150) {
        reported = now;
        onProgress(rows / height);
      }
    },
  );
  return { width, height, rgba };
}

const SOFTWARE = 'HDR Bracket Merger';

function exifInfo(reference: RawFrame, width: number, height: number): ExifInfo {
  const e = reference.exposure;
  return {
    make: reference.make.trim(),
    model: reference.model,
    software: SOFTWARE,
    width,
    height,
    dateTimeOriginal: e.dateTimeOriginal,
    exposureTime: Number.isFinite(e.exposureTimeRational[0]) ? e.exposureTimeRational : null,
    fNumber: e.fNumber,
    iso: e.iso,
    focalLength: e.focalLength,
    lensModel: e.lensModel,
  };
}

async function exportDng(id: number, settings: LookSettings): Promise<void> {
  const reference = session?.raw[session.analysis.reference];
  if (!merged || !reference || !lookPreview) {
    post({ type: 'look-error', id, message: 'Nothing merged yet' });
    return;
  }
  try {
    const t0 = performance.now();
    const profile = await loadProfile();
    const neutral = neutralForTemperature(profile, settings.wb.temperature, settings.wb.tint);
    // The embedded preview shows the finished look in the raw data's own geometry.
    const work = working(lookPreview, { upright: false, lens: false });
    const look = renderLook(work.rgb, work.width, work.height, profile, { ...settings, neutral });
    const rgba = new Uint8ClampedArray(work.width * work.height * 4);
    toRgba8(look.rgb, rgba);
    const rgb = new Uint8Array(work.width * work.height * 3);
    for (let p = 0; p < work.width * work.height; p++) rgb.set(rgba.subarray(4 * p, 4 * p + 3), 3 * p);
    const make = reference.make.trim();
    const blob = writeDng({
      width: merged.width,
      height: merged.height,
      data: merged.data,
      white: merged.referenceRange,
      cfaColors: merged.cfaColors,
      make,
      model: reference.model,
      uniqueCameraModel: `${make.charAt(0)}${make.slice(1).toLowerCase()} ${reference.model}`,
      orientation: reference.orientation,
      profile,
      asShotNeutral: neutral,
      preview: { width: work.width, height: work.height, rgb },
      exif: exifInfo(reference, merged.width, merged.height),
      software: SOFTWARE,
      originalRawFileName: reference.fileName,
    });
    post({ type: 'export', id, format: 'dng', blob, width: merged.width, height: merged.height, ms: performance.now() - t0 });
  } catch (err) {
    post({ type: 'look-error', id, message: errorText(err) });
  }
}

async function pickNeutral(x: number, y: number, geometry: Pick<LookSettings, 'upright' | 'lens'>): Promise<void> {
  if (!lookPreview) return;
  const profile = await loadProfile();
  // The image as displayed, so (x, y) lands on what was clicked.
  const { width, height, rgb } = working(lookPreview, geometry);
  const cx = Math.round(x * (width - 1));
  const cy = Math.round(y * (height - 1));
  const sum: Vec3 = [0, 0, 0];
  let n = 0;
  for (let yy = Math.max(0, cy - 3); yy <= Math.min(height - 1, cy + 3); yy++) {
    for (let xx = Math.max(0, cx - 3); xx <= Math.min(width - 1, cx + 3); xx++) {
      const o = (yy * width + xx) * 3;
      sum[0] += rgb[o];
      sum[1] += rgb[o + 1];
      sum[2] += rgb[o + 2];
      n++;
    }
  }
  if (!n || sum[0] <= 0 || sum[1] <= 0 || sum[2] <= 0) return;
  const wb = whiteBalanceFromPatch(profile, [sum[0] / n, sum[1] / n, sum[2] / n]);
  post({ type: 'neutral-picked', wb: { temperature: wb.temperature, tint: wb.tint } });
}

/** Camera neutral from Sony WB levels (R, G, G, B; green = 1024). */
function neutralFromLevels(levels: readonly number[]): Vec3 {
  const g = (levels[1] + levels[2]) / 2;
  return [g / levels[0], 1, g / levels[3]];
}

/** What the lens corrections do, for the UI. */
function lensInfo(model: LensModel | null, lensName: string, width: number, height: number): LensInfo {
  if (!model) return { available: false, lensModel: lensName, vignetting: 0, distortion: 0, ca: 0 };
  let distortion = 0;
  let ca = 0;
  const halfDiagonal = Math.hypot(width, height) / 2;
  for (let k = 0; k <= 100; k++) {
    const r = k / 100;
    if (model.distortion) distortion = Math.max(distortion, Math.abs(knotValue(model.distortion, r) - 1));
    for (const t of [model.caRed, model.caBlue]) if (t) ca = Math.max(ca, Math.abs(knotValue(t, r) - 1) * r * halfDiagonal);
  }
  return {
    available: true,
    lensModel: lensName,
    vignetting: model.vignetting ? -Math.log2(knotValue(model.vignetting, 1)) : 0,
    distortion: 100 * distortion,
    ca,
  };
}

async function prepareLook(reference: RawFrame): Promise<void> {
  if (!merged) return;
  lookPreview = binMerged(merged, 4);
  lookExport = null;
  const profile = await loadProfile();
  const auto = estimateInteriorWhiteBalance(profile, lookPreview.rgb);
  const asShot = withTemperature(profile, reference.asShotWb ? neutralFromLevels(reference.asShotWb) : auto.neutral, 0);
  const cameraLevels = reference.sr2?.tags.get(0x7312);
  const camera = cameraLevels?.length === 4 ? withTemperature(profile, neutralFromLevels(cameraLevels), 0) : null;
  const setting = (w: { temperature: number; tint: number }): WbSetting => ({ temperature: w.temperature, tint: w.tint });

  // Upright, estimated once on the preview image's luminance, with lens distortion already undone.
  lensModel = sonyLensModel(reference.lensCorrection);
  focal35 = reference.exposure.focalLength35mm > 0 ? reference.exposure.focalLength35mm : reference.exposure.focalLength || 35;
  const { width, height } = lookPreview;
  const focal = (focal35 / 36) * width;
  const rgb = lensModel ? applyWarp(lookPreview.rgb, width, height, geometryWarp(null, lensModel, width, height, focal)) : lookPreview.rgb;
  const lum = new Float32Array(width * height);
  for (let i = 0; i < lum.length; i++) lum[i] = 0.25 * rgb[3 * i] + 0.5 * rgb[3 * i + 1] + 0.25 * rgb[3 * i + 2];
  const upright = estimateUpright(lum, width, height, focal);
  uprightRotation = upright.rotation;
  const keep = upright.rotation ? geometryWarp(upright.rotation, lensModel, width, height, focal).scale : 1;

  post({
    type: 'look-ready',
    profile: `${profile.name} (${profile.cameraModel.replace(/^Sony /, '')})`,
    wb: { auto: { ...setting(auto), coverage: auto.coverage }, asShot: setting(asShot), camera: camera ? setting(camera) : null },
    upright: { available: !!upright.rotation, pitch: upright.pitch, roll: upright.roll, lines: upright.lines.length, keep },
    lens: lensInfo(lensModel, reference.exposure.lensModel, merged.width, merged.height),
  });
}

function crop(id: number, rect: Rect, algorithm: DemosaicAlgorithm, wb: [number, number, number]): void {
  if (!merged) {
    post({ type: 'crop-error', id, message: 'Nothing merged yet' });
    return;
  }
  try {
    const t0 = performance.now();
    const tile = demosaicRect(merged, rect, wb, algorithm);
    post({ type: 'crop', id, rect: tile.rect, algorithm, rgb: tile.rgb, ms: performance.now() - t0 }, [tile.rgb.buffer]);
  } catch (err) {
    post({ type: 'crop-error', id, message: errorText(err) });
  }
}

/** Merges the session's frames (deghosted or not), reports the result and prepares the look. */
async function mergeSession(deghost: boolean): Promise<void> {
  if (!session) return;
  const { raw, analysis, noise, alignment } = session;
  const total = frames.length;
  try {
    let tm = 0;
    if (deghost && !motion) {
      post({ type: 'progress', index: total, total, fileName: '', stage: 'deghosting' });
      const t = performance.now();
      motion = detectMotion(raw, analysis, noise, alignment);
      tm = performance.now() - t;
    }
    post({ type: 'progress', index: total, total, fileName: '', stage: 'merging' });
    const t3 = performance.now();
    const result = mergeFrames(raw, analysis, noise, alignment, { motion: deghost ? motion : null });
    const t4 = performance.now();
    const seams = checkSeams(raw, analysis, alignment);
    const t5 = performance.now();
    merged = result.image;
    const transfer: Transferable[] = [result.preview.rgb.buffer, result.preview.clip.buffer, result.sourceMap.buffer];
    if (result.ghostMap) transfer.push(result.ghostMap.buffer);
    post(
      {
        type: 'merged',
        merge: {
          alignment,
          deghost: { enabled: deghost, coverage: deghost && motion ? motion.coverage : 0, share: deghost && motion ? motion.share : raw.map(() => 0), ms: tm },
          ghostMap: result.ghostMap,
          preview: result.preview,
          sourceMap: result.sourceMap,
          weightShare: result.weightShare,
          seams,
          clippedFraction: result.clippedFraction,
          dynamicRangeStops: result.dynamicRangeStops,
          width: result.image.width,
          height: result.image.height,
          ms: { align: alignmentMs, merge: t4 - t3, seams: t5 - t4 },
        },
      },
      transfer,
    );
  } catch (err) {
    post({ type: 'merge-error', message: errorText(err) });
    return;
  }
  try {
    await prepareLook(raw[analysis.reference]);
  } catch (err) {
    post({ type: 'look-error', id: null, message: errorText(err) });
  }
}

let alignmentMs = 0;

async function remerge(deghost: boolean): Promise<void> {
  const start = performance.now();
  await mergeSession(deghost);
  post({ type: 'done', ms: performance.now() - start });
}

async function open(files: File[]): Promise<void> {
  const start = performance.now();
  frames = [];
  merged = null;
  session = null;
  motion = null;
  for (const [index, file] of files.entries()) {
    const t0 = performance.now();
    try {
      post({ type: 'progress', index, total: files.length, fileName: file.name, stage: 'reading' });
      const buffer = await file.arrayBuffer();
      post({ type: 'progress', index, total: files.length, fileName: file.name, stage: 'decoding' });
      const frame = readArw(buffer, file.name);
      const stats = computeFrameStats(frame);
      const preview = makePreview(frame);
      frames.push({ index, frame, meanSignal: stats.meanSignal });
      const info = frameInfo(frame, file.size);
      post({ type: 'frame', index, info, stats, preview, ms: performance.now() - t0 }, [
        preview.rgb.buffer,
        preview.clip.buffer,
        ...stats.channels.map((c) => c.histogram.buffer),
      ]);
    } catch (err) {
      post({ type: 'frame-error', index, fileName: file.name, message: errorText(err) });
    }
  }

  if (frames.length >= 2) {
    const t0 = performance.now();
    post({ type: 'progress', index: files.length, total: files.length, fileName: '', stage: 'measuring' });
    const raw = frames.map((f) => f.frame);
    let analysis;
    try {
      analysis = analyzeExposures(
        raw,
        frames.map((f) => f.meanSignal),
      );
      post({ type: 'exposures', indices: frames.map((f) => f.index), analysis, ms: performance.now() - t0 });
    } catch (err) {
      post({ type: 'exposures-error', message: errorText(err) });
    }
    let noise: NoiseModel | undefined;
    if (analysis) {
      const t1 = performance.now();
      post({ type: 'progress', index: files.length, total: files.length, fileName: '', stage: 'noise' });
      try {
        noise = fitNoiseModel(raw, analysis);
        post({ type: 'noise', noise, ms: performance.now() - t1 });
      } catch (err) {
        post({ type: 'noise-error', message: errorText(err) });
      }
    }
    if (analysis && noise) {
      try {
        post({ type: 'progress', index: files.length, total: files.length, fileName: '', stage: 'aligning' });
        const t2 = performance.now();
        const alignment = alignFrames(raw, analysis, noise);
        alignmentMs = performance.now() - t2;
        session = { raw, analysis, noise, alignment };
      } catch (err) {
        post({ type: 'merge-error', message: errorText(err) });
      }
      await mergeSession(true);
    }
  }
  post({ type: 'done', ms: performance.now() - start });
}

function frameInfo(frame: RawFrame, fileSize: number): FrameInfo {
  const { cfa: _cfa, sr2, ...rest } = frame;
  return {
    ...rest,
    fileSize,
    sr2: sr2 ? { offset: sr2.offset, length: sr2.length, key: sr2.key, entryCount: sr2.entryCount } : null,
    linearLimit: linearLimit(frame),
  };
}

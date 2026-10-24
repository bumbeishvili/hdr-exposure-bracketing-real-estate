// Decodes ARW files and runs the per-frame and cross-frame analysis off the UI thread.
// Decoded frames stay here; the UI receives metadata, statistics and previews.

import { readArw, type RawFrame } from '../raw/arw.ts';
import { computeFrameStats } from '../analysis/stats.ts';
import { analyzeExposures, linearLimit } from '../analysis/exposure.ts';
import { fitNoiseModel } from '../analysis/noise.ts';
import { makePreview } from '../analysis/preview.ts';
import type { FrameInfo, WorkerEvent, WorkerRequest } from './protocol.ts';

const scope = self as unknown as Worker;
const post = (event: WorkerEvent, transfer: Transferable[] = []): void => scope.postMessage(event, transfer);

let frames: Array<{ index: number; frame: RawFrame; meanSignal: number }> = [];

scope.onmessage = (e: MessageEvent<WorkerRequest>) => {
  if (e.data.type === 'open') void open(e.data.files);
};

async function open(files: File[]): Promise<void> {
  const start = performance.now();
  frames = [];
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
      post({ type: 'frame-error', index, fileName: file.name, message: err instanceof Error ? err.message : String(err) });
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
      post({ type: 'exposures-error', message: err instanceof Error ? err.message : String(err) });
    }
    if (analysis) {
      const t1 = performance.now();
      post({ type: 'progress', index: files.length, total: files.length, fileName: '', stage: 'noise' });
      try {
        post({ type: 'noise', noise: fitNoiseModel(raw, analysis), ms: performance.now() - t1 });
      } catch (err) {
        post({ type: 'noise-error', message: err instanceof Error ? err.message : String(err) });
      }
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

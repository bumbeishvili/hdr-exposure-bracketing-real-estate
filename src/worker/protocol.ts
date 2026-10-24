// Messages between the UI thread and the pipeline worker.

import type { RawFrame } from '../raw/arw.ts';
import type { ExposureAnalysis } from '../analysis/exposure.ts';
import type { PreviewData } from '../analysis/preview.ts';
import type { FrameStats } from '../analysis/stats.ts';

/** A decoded frame without its pixel data (which stays in the worker). */
export type FrameInfo = Omit<RawFrame, 'cfa' | 'sr2'> & {
  fileSize: number;
  sr2: { offset: number; length: number; key: number; tagCount: number } | null;
  /** Linear limit used for ratio estimation (Sony SR2 white level when present). */
  linearLimit: number;
};

export type WorkerRequest = { type: 'open'; files: File[] };

export type WorkerEvent =
  | { type: 'progress'; index: number; total: number; fileName: string; stage: 'reading' | 'decoding' | 'measuring' }
  | { type: 'frame'; index: number; info: FrameInfo; stats: FrameStats; preview: PreviewData; ms: number }
  | { type: 'frame-error'; index: number; fileName: string; message: string }
  /** `analysis` indexes frames by position in `indices`, which maps back to file indices. */
  | { type: 'exposures'; indices: number[]; analysis: ExposureAnalysis; ms: number }
  | { type: 'exposures-error'; message: string }
  | { type: 'done'; ms: number };

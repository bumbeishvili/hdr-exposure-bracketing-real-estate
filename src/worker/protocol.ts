// Messages between the UI thread and the pipeline worker.

import type { RawFrame } from '../raw/arw.ts';
import type { ExposureAnalysis } from '../analysis/exposure.ts';
import type { NoiseModel } from '../analysis/noise.ts';
import type { AlignmentResult } from '../merge/align.ts';
import type { SeamReport } from '../merge/seams.ts';
import type { DemosaicAlgorithm, Rect } from '../demosaic/demosaic.ts';
import type { PreviewData } from '../analysis/preview.ts';
import type { FrameStats } from '../analysis/stats.ts';

/** A decoded frame without its pixel data (which stays in the worker). */
export type FrameInfo = Omit<RawFrame, 'cfa' | 'sr2'> & {
  fileSize: number;
  sr2: { offset: number; length: number; key: number; entryCount: number } | null;
  /** Linear limit used for ratio estimation (Sony SR2 white level when present). */
  linearLimit: number;
};

export interface MergeSummary {
  alignment: AlignmentResult;
  /** Moving-object handling: where frames disagreed with the base frame and were faded out. */
  deghost: { enabled: boolean; coverage: number; share: number[]; ms: number };
  /** Per preview pixel, 0–255: how much of some frame's weight deghosting removed (null when off). */
  ghostMap: Uint8Array | null;
  /** Linear camera RGB, 1.0 = the reference frame's white level. */
  preview: PreviewData;
  sourceMap: Uint8Array;
  weightShare: number[];
  seams: SeamReport[];
  clippedFraction: number;
  dynamicRangeStops: number;
  width: number;
  height: number;
  ms: { align: number; merge: number; seams: number };
}

/** White balance on Lightroom's Temp/Tint scale. */
export interface WbSetting {
  temperature: number;
  tint: number;
}

/** User-facing look settings; the worker turns `wb` into a camera neutral with the camera profile. */
export interface LookSettings {
  wb: WbSetting;
  brightness: number;
  windowPull: number;
  contrast: number;
  vibrance: number;
  cleanWhites: number;
  /** Straighten verticals (camera pitch and roll). */
  upright: boolean;
  /** Apply the lens's own corrections (vignetting, distortion, lateral CA). */
  lens: boolean;
}

/** The lens corrections the camera recorded, summarised for the UI. */
export interface LensInfo {
  available: boolean;
  lensModel: string;
  /** Light falloff at the corner (EV). */
  vignetting: number;
  /** Largest radial displacement (% of the radius). */
  distortion: number;
  /** Largest red/blue fringe width at full resolution (px). */
  ca: number;
}

/** JPEG export sizes: full sensor resolution, half, or the quarter-size render itself. */
export type ExportSize = 'full' | 'half' | 'small';

/** What Upright found: the camera's tilt, from how many vertical lines. */
export interface UprightInfo {
  available: boolean;
  pitch: number;
  roll: number;
  lines: number;
  /** Linear share of the frame kept after cropping the corrected image. */
  keep: number;
}

export type WorkerRequest =
  | { type: 'open'; files: File[] }
  /** Demosaic part of the merged image at full resolution. */
  | { type: 'crop'; id: number; rect: Rect; algorithm: DemosaicAlgorithm; wb: [number, number, number] }
  /** Render the finished look at preview size; only the newest pending request is rendered. */
  | { type: 'look'; id: number; settings: LookSettings }
  /** Render the finished look at export size and encode a JPEG. */
  | { type: 'export'; id: number; settings: LookSettings; size: ExportSize }
  /** Write the merged raw data as a floating-point DNG (white balance from `settings`). */
  | { type: 'export-dng'; id: number; settings: LookSettings }
  /** Merge again with deghosting on or off. */
  | { type: 'remerge'; deghost: boolean }
  /** White balance that makes the patch at (x, y) (fractions of the frame) neutral. */
  | { type: 'pick-neutral'; x: number; y: number; upright: boolean; lens: boolean };

export type WorkerEvent =
  | { type: 'progress'; index: number; total: number; fileName: string; stage: 'reading' | 'decoding' | 'measuring' | 'noise' | 'aligning' | 'deghosting' | 'merging' }
  | { type: 'frame'; index: number; info: FrameInfo; stats: FrameStats; preview: PreviewData; ms: number }
  | { type: 'frame-error'; index: number; fileName: string; message: string }
  /** `analysis` indexes frames by position in `indices`, which maps back to file indices. */
  | { type: 'exposures'; indices: number[]; analysis: ExposureAnalysis; ms: number }
  | { type: 'exposures-error'; message: string }
  /** Pair indices in `noise.pairs` refer to positions in the `exposures` event's `indices`. */
  | { type: 'noise'; noise: NoiseModel; ms: number }
  | { type: 'noise-error'; message: string }
  /** Frame indices in `alignment`, `weightShare`, `sourceMap` and `seams` are positions in the `exposures` event's `indices`. */
  | { type: 'merged'; merge: MergeSummary }
  | { type: 'merge-error'; message: string }
  /** `rgb` is interleaved camera RGB for `rect` (1.0 = the reference white level). */
  | { type: 'crop'; id: number; rect: Rect; algorithm: DemosaicAlgorithm; rgb: Float32Array; ms: number }
  | { type: 'crop-error'; id: number; message: string }
  /** The look stage is ready: white balance candidates, and the camera profile in use. */
  | { type: 'look-ready'; profile: string; wb: { auto: WbSetting & { coverage: number }; asShot: WbSetting; camera: WbSetting | null }; upright: UprightInfo; lens: LensInfo }
  /** `sizes`: pixel size of each export size under these settings. */
  | { type: 'look'; id: number; width: number; height: number; rgba: Uint8ClampedArray; exposures: number[]; windowShare: number; sizes: Record<ExportSize, [number, number]>; ms: number }
  | { type: 'export-progress'; id: number; fraction: number }
  | { type: 'export'; id: number; format: 'jpeg' | 'dng'; blob: Blob; width: number; height: number; ms: number }
  | { type: 'neutral-picked'; wb: WbSetting }
  | { type: 'look-error'; id: number | null; message: string }
  | { type: 'done'; ms: number };

// The app UI. By default it is just the finished photo: drop a bracket, watch
// it come together, download it. One button opens the workspace behind it —
// the frames, measured exposure ratios, noise model, merge checks and the look
// controls.

import type { ExposureAnalysis, FrameExposure, PairRatio } from '../analysis/exposure.ts';
import type { NoiseModel } from '../analysis/noise.ts';
import type { PreviewData } from '../analysis/preview.ts';
import type { FrameStats } from '../analysis/stats.ts';
import type { ExportSize, FrameInfo, LensInfo, LookDetail, LookSettings, LookWb, MergeSummary, UprightInfo, WbSetting, WorkerEvent, WorkerRequest } from '../worker/protocol.ts';
import type { SceneKind } from '../look/render.ts';
import type { DemosaicAlgorithm, Rect } from '../demosaic/demosaic.ts';
import { REAL_ESTATE_LOOK } from '../look/defaults.ts';
import { h, replace, s as svg } from './dom.ts';
import * as fmt from './format.ts';
import { evHistogram, histogramChart, type EvHistogram } from './histogram.ts';
import { lineChart } from './line-chart.ts';
import { autoGain, luminancePercentile, renderPreview } from './render-preview.ts';

interface Slot {
  index: number;
  fileName: string;
  info?: FrameInfo;
  stats?: FrameStats;
  preview?: PreviewData;
  hist?: EvHistogram;
  error?: string;
  ms?: number;
}

interface Exposures {
  byFile: Map<number, FrameExposure>;
  /** File indices, darkest to brightest. */
  order: number[];
  reference: number;
  pairs: Array<PairRatio & { brightFile: number; darkFile: number }>;
  /** Analysis position → file index (the worker's frame arrays skip failed files). */
  files: number[];
  ms: number;
}

/** Selection values for the merged result and the finished look. */
const MERGED = -2;
const FINAL = -3;

type WbMode = 'auto' | 'asShot' | 'camera' | 'custom';

/** Temperature slider: 0…1000 on a log scale from 2500 K to 10000 K. */
const tempToSlider = (t: number): number => Math.round((1000 * Math.log(t / 2500)) / Math.log(4));
const sliderToTemp = (v: number): number => 2500 * 4 ** (v / 1000);

/** Categorical slots (dark steps) for per-frame identity, darkest frame first. */
const FRAME_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [0x39, 0x87, 0xe5],
  [0xd9, 0x59, 0x26],
  [0x19, 0x9e, 0x70],
  [0xc9, 0x85, 0x00],
  [0xd5, 0x51, 0x81],
  [0x00, 0x83, 0x00],
  [0x90, 0x85, 0xe9],
  [0xe6, 0x67, 0x67],
];
/** Overlay for areas where deghosting kept moving content from one frame. */
const GHOST_COLORS: ReadonlyArray<readonly [number, number, number]> = [[0xe0, 0x3c, 0x9a]];
const css = (c: readonly [number, number, number]): string => `rgb(${c[0]} ${c[1]} ${c[2]})`;

/** A 24 × 24 stroked line icon. */
const icon = (...paths: string[]): SVGSVGElement =>
  svg(
    'svg',
    { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    ...paths.map((d) => svg('path', { d })),
  );
const ICON_DOWNLOAD = ['M12 4v11', 'M7.5 10.5 12 15l4.5-4.5', 'M5 19.5h14'];
const ICON_ADVANCED = ['M4 7h9', 'M17 7h3', 'M15 5v4', 'M4 17h3', 'M11 17h9', 'M9 15v4'];
const ICON_CLOSE = ['M6 6l12 12', 'M18 6 6 18'];
const ICON_DONE = ['M5 12.5 10 17 19 7'];

/** A circular progress indicator for the download button. */
function progressRing(fraction: number): SVGSVGElement {
  const r = 8;
  const c = 2 * Math.PI * r;
  return svg(
    'svg',
    { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': 'true', class: 'ring' },
    svg('circle', { cx: 12, cy: 12, r, fill: 'none', stroke: 'currentColor', 'stroke-opacity': 0.25, 'stroke-width': 2 }),
    svg('circle', {
      cx: 12,
      cy: 12,
      r,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-dasharray': c.toFixed(2),
      'stroke-dashoffset': (c * (1 - Math.max(0.04, fraction))).toFixed(2),
      transform: 'rotate(-90 12 12)',
    }),
  );
}

export function startApp(root: HTMLElement): void {
  new App(root);
}

const stem = (name: string): string => name.replace(/\.[^.]+$/, '');

function wbGains(info: FrameInfo): [number, number, number] {
  const wb = info.asShotWb;
  if (!wb) return [1, 1, 1];
  const g = (wb[1] + wb[2]) / 2;
  return [wb[0] / g, 1, wb[3] / g];
}

class App {
  private readonly root: HTMLElement;
  private worker: Worker | null = null;
  private slots: Slot[] = [];
  private exposures: Exposures | null = null;
  private exposureError = '';
  private noise: NoiseModel | null = null;
  private noiseError = '';
  private merge: MergeSummary | null = null;
  private mergeError = '';
  private selected = -1;
  private matched = false;
  private showClipping = true;
  private evOffset = 0;
  private mergedTone: 'linear' | 'global' = 'global';
  private showSources = false;
  private startedAt = 0;
  private totalMs = 0;
  private gainCache: { file: number; value: number } | null = null;
  private whiteCache: { gain: number; value: number } | null = null;
  /** Merged view: whole image, or a full-resolution crop demosaiced on demand. */
  private zoom: 'fit' | 'crop' = 'fit';
  private demosaic: DemosaicAlgorithm = 'rcd';
  private cropCenter: { x: number; y: number } | null = null;
  private crop: { id: number; rect: Rect; algorithm: DemosaicAlgorithm; data: PreviewData; ms: number } | null = null;
  private cropRequest = 0;
  /** The finished real-estate look. */
  private lookInfo: { profile: string; wb: LookWb; scene: SceneKind; upright: UprightInfo; lens: LensInfo } | null = null;
  private lookSettings: LookSettings | null = null;
  private wbMode: WbMode = 'auto';
  private lookImage: { id: number; detail: LookDetail; width: number; height: number; rgba: Uint8ClampedArray; pull: number; windowShare: number; sizes: Record<ExportSize, [number, number]>; ms: number } | null = null;
  private lookRequest = 0;
  private lookTimer = 0;
  private lookError = '';
  private showBefore = false;
  private picking = false;
  private exportRequest = 0;
  private exportStatus = '';
  private exportBusy = false;
  private exportSize: ExportSize = 'full';
  private exportDone = 0;
  private exportProgress = 0;
  private showGhosts = false;
  /** Simple (just the photo) or advanced (the whole workspace). */
  private advanced = false;
  private displayTimer = 0;

  private readonly input = h('input', { id: 'file-input', type: 'file', accept: '.arw,.ARW', multiple: true, hidden: true, 'data-testid': 'file-input' });
  private readonly status = h('div', { class: 'status', role: 'status', 'data-testid': 'status' });
  private readonly progressBar = h('div', { class: 'progress-bar' });
  private readonly empty = h('section', { class: 'empty', 'data-testid': 'dropzone' });
  private readonly workspace = h('section', { class: 'workspace' });
  private readonly summary = h('div', { class: 'summary', 'data-testid': 'summary' });
  private readonly canvas = h('canvas', { class: 'viewer-canvas', 'data-testid': 'viewer-canvas' });
  private readonly viewerCaption = h('div', { class: 'viewer-caption' });
  private readonly toolbar = h('div', { class: 'viewer-toolbar' });
  private readonly inspector = h('aside', { class: 'inspector', 'data-testid': 'inspector' });
  private readonly filmstrip = h('div', { class: 'filmstrip', role: 'listbox', 'aria-label': 'Merged result and frames by measured exposure', 'data-testid': 'filmstrip' });
  private readonly exposurePanel = h('section', { class: 'panel', 'data-testid': 'exposure-panel' });
  private readonly pairsPanel = h('section', { class: 'panel', 'data-testid': 'pairs-panel' });
  private readonly linearityPanel = h('section', { class: 'panel', 'data-testid': 'linearity-panel' });
  private readonly noisePanel = h('section', { class: 'panel', 'data-testid': 'noise-panel' });
  private readonly mergePanel = h('section', { class: 'panel', 'data-testid': 'merge-panel' });
  private readonly metadataPanel = h('section', { class: 'panel', 'data-testid': 'metadata-panel' });
  private readonly simple = h('section', { class: 'simple', 'data-testid': 'simple', hidden: true });
  private readonly simpleCanvas = h('canvas', { class: 'simple-canvas pending', 'data-testid': 'simple-canvas', role: 'img', 'aria-label': 'The finished photo' });
  private readonly simpleProgress = h('div', { class: 'simple-progress', hidden: true }, h('span'));
  private readonly simpleMessage = h('p', { class: 'simple-message', role: 'status' });
  private readonly simpleBrackets = h('p', { class: 'simple-brackets', 'data-testid': 'brackets' });
  /** The last selection's brackets when it held several (one is shown; the others are offered), and which is shown. */
  private brackets: File[][] = [];
  private bracketShown = 0;
  private selection: File[] = [];
  private readonly downloadButton = h('button', { type: 'button', class: 'icon-button download', 'aria-label': 'Download the full-resolution JPEG', title: 'Download (full resolution JPEG)', 'data-testid': 'download', hidden: true });
  private readonly advancedButton = h('button', { type: 'button', class: 'icon-button advanced-toggle', 'aria-label': 'Show the workspace', title: 'Details and controls', 'data-testid': 'advanced-toggle', hidden: true }, icon(...ICON_ADVANCED));

  constructor(root: HTMLElement) {
    this.root = root;
    this.buildShell();
    this.renderEmpty();
    this.renderStatus('');
    this.workspace.hidden = true;
    this.input.addEventListener('change', () => {
      if (this.input.files?.length) this.open([...this.input.files]);
      this.input.value = '';
    });
    this.bindDragAndDrop();
    this.bindKeys();
    this.bindCanvas();
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => this.renderCharts(), 120);
    });
  }

  // ---- loading -------------------------------------------------------------

  /** Opens a selection of files; `bracket`: the shown one of the brackets a selection held (see `brackets`). */
  private open(files: File[], bracket?: number): void {
    const arw = files.filter((f) => /\.arw$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
    if (!arw.length) {
      this.renderStatus('No .ARW files in that selection');
      return;
    }
    if (bracket === undefined) this.brackets = [];
    this.bracketShown = bracket ?? 0;
    this.selection = arw;
    this.worker?.terminate();
    this.worker = new Worker(new URL('../worker/pipeline.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerEvent>) => this.onWorkerEvent(e.data);
    this.worker.onerror = (e) => this.renderStatus(`Worker failed: ${e.message}`);
    this.slots = arw.map((f, index) => ({ index, fileName: f.name }));
    this.exposures = null;
    this.exposureError = '';
    this.noise = null;
    this.noiseError = '';
    this.merge = null;
    this.mergeError = '';
    this.zoom = 'fit';
    this.crop = null;
    this.cropCenter = null;
    this.lookInfo = null;
    this.lookSettings = null;
    this.lookImage = null;
    this.lookError = '';
    this.wbMode = 'auto';
    this.showBefore = false;
    this.picking = false;
    this.exportStatus = '';
    this.exportBusy = false;
    this.exportProgress = 0;
    this.exportDone = 0;
    this.showGhosts = false;
    this.selected = -1;
    this.matched = false;
    this.gainCache = null;
    this.whiteCache = null;
    this.startedAt = performance.now();
    this.empty.hidden = true;
    this.workspace.hidden = false;
    this.renderStatus(`Reading ${arw.length} file${arw.length > 1 ? 's' : ''}…`, 0);
    const request: WorkerRequest = { type: 'open', files: arw };
    this.worker.postMessage(request);
    this.renderAll();
    this.renderSimple();
  }

  private onWorkerEvent(ev: WorkerEvent): void {
    switch (ev.type) {
      case 'progress': {
        const verb = {
          reading: 'Reading',
          decoding: 'Decoding',
          measuring: 'Measuring exposure ratios',
          noise: 'Fitting the noise model',
          aligning: 'Aligning frames',
          deghosting: 'Finding moving objects',
          merging: 'Merging',
        }[ev.stage];
        const perFile = ev.stage === 'reading' || ev.stage === 'decoding';
        const label = perFile ? `${verb} ${ev.fileName} · ${ev.index + 1} of ${ev.total}` : `${verb}…`;
        const after = { measuring: 0.1, noise: 0.3, aligning: 0.5, deghosting: 0.6, merging: 0.7 } as Record<string, number>;
        const done = perFile ? ev.index + (ev.stage === 'decoding' ? 0.5 : 0) : ev.total + (after[ev.stage] ?? 0);
        this.renderStatus(label, done / (ev.total + 1));
        break;
      }
      case 'frame': {
        const slot = this.slots[ev.index];
        Object.assign(slot, { info: ev.info, stats: ev.stats, preview: ev.preview, ms: ev.ms, hist: evHistogram(ev.stats, ev.info) });
        if (this.selected === -1) this.selected = ev.index;
        this.renderAll();
        this.renderSimple();
        break;
      }
      case 'brackets': {
        // Start over with that bracket's files alone, so that all shown is of one scene.
        this.brackets = ev.groups.map((g) => g.map((i) => this.selection[i]));
        this.open(this.brackets[ev.chosen], ev.chosen);
        return;
      }
      case 'frame-error':
        this.slots[ev.index].error = ev.message;
        this.renderAll();
        break;
      case 'exposures':
        this.exposures = toExposures(ev.indices, ev.analysis, ev.ms);
        this.selected = this.exposures.reference;
        this.gainCache = null;
        this.renderAll();
        this.renderSimple();
        break;
      case 'exposures-error':
        this.exposureError = ev.message;
        this.renderAll();
        break;
      case 'noise':
        this.noise = ev.noise;
        this.renderNoise();
        break;
      case 'noise-error':
        this.noiseError = ev.message;
        this.renderNoise();
        break;
      case 'merged':
        if (!this.merge) this.selected = MERGED; // a re-merge keeps the current view
        this.merge = ev.merge;
        this.whiteCache = null;
        this.crop = null;
        if (this.zoom === 'crop') this.requestCrop();
        this.renderAll();
        break;
      case 'merge-error':
        this.mergeError = ev.message;
        this.renderAll();
        this.renderSimple();
        break;
      case 'crop':
        if (ev.id !== this.cropRequest) break; // superseded by a newer request
        this.crop = {
          id: ev.id,
          rect: ev.rect,
          algorithm: ev.algorithm,
          data: { width: ev.rect.width, height: ev.rect.height, rgb: ev.rgb, clip: new Uint8Array(ev.rect.width * ev.rect.height) },
          ms: ev.ms,
        };
        this.renderImages();
        break;
      case 'crop-error':
        if (ev.id === this.cropRequest) replace(this.viewerCaption, `Could not demosaic this crop: ${ev.message}`);
        break;
      case 'look-ready': {
        const remerged = !!this.lookSettings; // a re-merge keeps the look the user has set
        this.lookInfo = { profile: ev.profile, wb: ev.wb, scene: ev.scene, upright: ev.upright, lens: ev.lens };
        if (!remerged) {
          this.lookSettings = this.defaultLook();
          this.wbMode = ev.wb.default;
          this.selected = FINAL;
        }
        this.requestLook(0);
        this.renderAll();
        break;
      }
      case 'look':
        if (!this.lookImage || ev.id >= this.lookImage.id) {
          const first = !this.lookImage;
          this.lookImage = { id: ev.id, detail: ev.detail, width: ev.width, height: ev.height, rgba: ev.rgba, pull: ev.pull, windowShare: ev.windowShare, sizes: ev.sizes, ms: ev.ms };
          this.lookError = '';
          if (first) this.renderToolbar(); // enables Export
          else this.refreshExportSizes();
          this.renderImages();
          this.renderLookStatus();
          this.renderSimple();
          if (ev.detail === 'display' && ev.id === this.lookRequest) this.requestSharp();
        }
        break;
      case 'export-progress':
        if (ev.id === this.exportRequest && this.exportBusy) {
          this.exportProgress = ev.fraction;
          this.exportStatus = `Rendering full detail… ${Math.round(100 * ev.fraction)}%`;
          const note = this.toolbar.querySelector('[data-testid="export-status"]');
          if (note) note.textContent = this.exportStatus;
          if (!this.advanced) this.renderSimple();
        }
        break;
      case 'export': {
        if (ev.id !== this.exportRequest) break;
        const base = this.exposures ? stem(this.slots[this.exposures.reference].fileName) : 'merged';
        const url = URL.createObjectURL(ev.blob);
        const a = h('a', { href: url, download: `${base}-HDR.${ev.format === 'dng' ? 'dng' : 'jpg'}` });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        this.exportBusy = false;
        this.exportDone = performance.now();
        const what = ev.format === 'dng' ? 'float DNG' : 'JPEG';
        this.exportStatus = `Exported ${ev.width} × ${ev.height} ${what} (${fmt.megabytes(ev.blob.size)}) in ${(ev.ms / 1000).toFixed(1)} s`;
        this.downloadButton.dataset.exported = `${ev.width}x${ev.height}`;
        this.renderToolbar();
        this.renderSimple();
        setTimeout(() => this.renderSimple(), 1900); // the check mark gives way to the download icon
        break;
      }
      case 'neutral-picked':
        if (this.lookSettings) {
          this.lookSettings = { ...this.lookSettings, wb: ev.wb };
          this.wbMode = 'custom';
          this.requestLook(0);
          this.renderInspector();
        }
        break;
      case 'look-error':
        if (ev.id === this.exportRequest && this.exportBusy) {
          this.exportBusy = false;
          this.exportStatus = `Export failed: ${ev.message}`;
        } else this.lookError = ev.message;
        this.renderToolbar();
        this.renderLookStatus();
        this.renderSimple();
        break;
      case 'done': {
        this.totalMs = performance.now() - this.startedAt;
        const ok = this.slots.filter((s) => s.info).length;
        const failed = this.slots.length - ok;
        const what = this.merge ? (ok === 1 ? '1 frame decoded and rendered' : `${ok} frames decoded and merged`) : `${ok} frame${ok === 1 ? '' : 's'} decoded`;
        this.renderStatus(`${what} in ${(this.totalMs / 1000).toFixed(1)} s${failed ? ` · ${failed} failed` : ''}`);
        this.renderSummary();
        this.renderSimple();
        break;
      }
    }
  }

  // ---- shell ---------------------------------------------------------------

  private buildShell(): void {
    const logo = h('span', { class: 'logo', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'));
    const header = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, logo, h('div', {}, h('h1', {}, 'HDR Merger'), h('p', {}, 'Bracket merge · Sony A7C II ARW'))),
      h('div', { class: 'status-wrap' }, this.status, h('div', { class: 'progress' }, this.progressBar)),
      h('label', { class: 'button primary', for: 'file-input' }, 'Open ARW files'),
      h(
        'button',
        { type: 'button', class: 'icon-button flat', 'aria-label': 'Back to the photo', title: 'Back to the photo', 'data-testid': 'simple-toggle', onclick: () => this.setAdvanced(false) },
        icon(...ICON_CLOSE),
      ),
    );
    const viewer = h('div', { class: 'viewer-panel' }, this.toolbar, h('div', { class: 'viewer' }, this.canvas), this.viewerCaption);
    replace(
      this.workspace,
      this.summary,
      h('div', { class: 'stage' }, h('div', { class: 'stage-main' }, viewer, this.filmstrip), this.inspector),
      this.mergePanel,
      this.exposurePanel,
      this.pairsPanel,
      this.linearityPanel,
      this.noisePanel,
      this.metadataPanel,
    );
    this.downloadButton.addEventListener('click', () => {
      this.exportSize = 'full';
      this.exportLook('jpeg');
    });
    this.advancedButton.addEventListener('click', () => this.setAdvanced(true));
    replace(this.simple, this.simpleProgress, h('figure', { class: 'simple-figure' }, this.simpleCanvas, this.downloadButton), this.simpleBrackets, this.simpleMessage);
    replace(this.root, this.input, header, h('main', {}, this.empty, this.workspace), this.simple, this.advancedButton);
    this.root.dataset.mode = 'simple';
  }

  /** Switches between the photo alone and the full workspace. */
  private setAdvanced(on: boolean): void {
    this.advanced = on;
    this.root.dataset.mode = on ? 'advanced' : 'simple';
    window.scrollTo(0, 0);
    if (on) this.renderAll();
    else this.renderSimple();
  }

  private renderEmpty(): void {
    replace(
      this.empty,
      h(
        'label',
        { class: 'dropzone', for: 'file-input', 'data-testid': 'dropzone-label' },
        h('span', { class: 'drop-icon', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
        h('span', { class: 'drop-text' }, 'Drop your ARW bracket'),
      ),
    );
  }

  /**
   * The photo alone: while the bracket is processed, the base frame dimmed
   * under a thin progress line; then the finished look, with a download button
   * on hover.
   */
  private renderSimple(): void {
    const loaded = this.slots.length > 0;
    this.simple.hidden = !loaded;
    this.advancedButton.hidden = !loaded;
    if (!loaded) return;
    const failed = this.mergeError || this.exposureError || (this.slots.every((s) => s.error) ? this.slots[0].error : '');
    const img = this.lookImage;
    if (img) {
      this.drawLook(this.simpleCanvas);
      this.simpleCanvas.style.setProperty('--aspect', String(img.width / img.height));
      this.simpleCanvas.classList.remove('pending');
      this.simpleCanvas.dataset.state = 'final';
    } else {
      const slot = this.referenceSlot();
      if (slot?.preview && slot.info) {
        this.draw(this.simpleCanvas, slot.preview, { gain: this.gainFor(slot), wb: wbGains(slot.info), showClipping: false, tone: 'global' });
        this.simpleCanvas.style.setProperty('--aspect', String(slot.preview.width / slot.preview.height));
        this.simpleCanvas.dataset.state = 'pending';
      }
      this.simpleCanvas.classList.add('pending');
    }
    this.simpleCanvas.hidden = !img && !this.referenceSlot()?.preview;
    this.downloadButton.hidden = !img;
    this.downloadButton.disabled = this.exportBusy;
    this.downloadButton.classList.toggle('busy', this.exportBusy);
    const justDone = performance.now() - this.exportDone < 1800;
    replace(this.downloadButton, this.exportBusy ? progressRing(this.exportProgress) : icon(...(justDone ? ICON_DONE : ICON_DOWNLOAD)));
    this.simpleMessage.textContent = failed ? `Could not merge these files: ${failed}` : this.exportStatus.startsWith('Export failed') ? this.exportStatus : '';
    const range = (g: File[]): string => (g.length > 1 ? `${stem(g[0].name)}–${stem(g[g.length - 1].name)}` : stem(g[0].name));
    replace(
      this.simpleBrackets,
      ...(this.brackets.length > 1
        ? [
            `${this.brackets.length} brackets in these files; this is ${range(this.brackets[this.bracketShown])}.`,
            ...this.brackets.map((g, k) => (k === this.bracketShown ? null : h('button', { type: 'button', class: 'link-button', onclick: () => this.open(g, k) }, `Show ${range(g)}`))),
          ]
        : []),
    );
  }

  private renderStatus(text: string, progress?: number): void {
    this.status.textContent = text;
    const bar = this.progressBar.parentElement as HTMLElement;
    bar.hidden = progress === undefined;
    this.simpleProgress.hidden = progress === undefined;
    if (progress !== undefined) {
      this.progressBar.style.width = `${Math.round(progress * 100)}%`;
      (this.simpleProgress.firstElementChild as HTMLElement).style.width = `${Math.round(progress * 100)}%`;
    }
    this.simpleProgress.setAttribute('aria-label', text);
  }

  private bindDragAndDrop(): void {
    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth++;
      document.body.classList.add('dragging');
    });
    window.addEventListener('dragleave', () => {
      if (--depth <= 0) document.body.classList.remove('dragging');
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('dragging');
      if (e.dataTransfer?.files.length) this.open([...e.dataTransfer.files]);
    });
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape' && this.advanced) {
        this.setAdvanced(false);
        return;
      }
      if (!this.advanced) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const order = this.navigationOrder();
        const at = order.indexOf(this.selected);
        if (at < 0) return;
        const next = order[Math.max(0, Math.min(order.length - 1, at + (e.key === 'ArrowLeft' ? -1 : 1)))];
        if (next !== this.selected) {
          e.preventDefault();
          this.select(next);
        }
      } else if (e.key === 'm' && this.exposures) {
        this.matched = !this.matched;
        this.renderToolbar();
        this.renderImages();
      } else if (e.key === 'c') {
        this.showClipping = !this.showClipping;
        this.renderToolbar();
        this.renderImages();
      } else if (e.key === 's' && this.merge) {
        this.showSources = !this.showSources;
        this.renderToolbar();
        this.renderImages();
      } else if (e.key === 'g' && this.merge?.ghostMap) {
        this.showGhosts = !this.showGhosts;
        this.renderToolbar();
        this.renderImages();
      } else if (e.key === 'z' && this.merge && this.selected === MERGED) {
        this.setZoom(this.zoom === 'fit' ? 'crop' : 'fit');
      } else if (e.key === 'b' && this.selected === FINAL) {
        this.showBefore = !this.showBefore;
        this.renderToolbar();
        this.renderImages();
      } else if (e.key === 'w' && this.selected === FINAL) {
        this.picking = !this.picking;
        this.renderToolbar();
        this.renderImages();
      }
    });
  }

  /** Merged view: click to zoom to 100% there; in 100%, drag to pan and click to zoom out. */
  private bindCanvas(): void {
    let drag: { x: number; y: number; center: { x: number; y: number }; moved: boolean } | null = null;
    this.canvas.addEventListener('click', (e) => {
      if (this.selected !== FINAL || !this.picking || !this.worker) return;
      const box = this.canvas.getBoundingClientRect();
      const request: WorkerRequest = {
        type: 'pick-neutral',
        x: (e.clientX - box.left) / box.width,
        y: (e.clientY - box.top) / box.height,
        upright: this.lookSettings?.upright ?? false,
        lens: this.lookSettings?.lens ?? false,
      };
      this.worker.postMessage(request);
      this.picking = false;
      this.renderToolbar();
      this.renderImages();
    });
    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.selected !== MERGED || !this.merge) return;
      drag = { x: e.clientX, y: e.clientY, center: this.cropCenter ?? { x: this.merge.width / 2, y: this.merge.height / 2 }, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!drag || this.zoom !== 'crop') return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      if (drag.moved) this.canvas.style.transform = `translate(${dx}px, ${dy}px)`;
    });
    this.canvas.addEventListener('pointerup', (e) => {
      const d = drag;
      drag = null;
      if (!d || !this.merge) return;
      this.canvas.style.transform = '';
      if (this.zoom === 'fit') {
        const box = this.canvas.getBoundingClientRect();
        this.cropCenter = { x: ((e.clientX - box.left) / box.width) * this.merge.width, y: ((e.clientY - box.top) / box.height) * this.merge.height };
        this.setZoom('crop');
      } else if (d.moved) {
        // At 100% one CSS pixel is one image pixel.
        this.cropCenter = { x: d.center.x - (e.clientX - d.x), y: d.center.y - (e.clientY - d.y) };
        this.requestCrop();
      } else {
        this.setZoom('fit');
      }
    });
  }

  private setZoom(zoom: 'fit' | 'crop'): void {
    this.zoom = zoom;
    if (zoom === 'crop') {
      if (!this.cropCenter && this.merge) this.cropCenter = { x: this.merge.width / 2, y: this.merge.height / 2 };
      this.requestCrop();
    }
    this.renderToolbar();
    this.renderImages();
  }

  private requestCrop(): void {
    const merge = this.merge;
    const ref = this.referenceSlot();
    if (!merge || !this.worker || !this.cropCenter || !ref?.info) return;
    const viewer = this.canvas.parentElement as HTMLElement;
    const width = Math.min(merge.width, Math.max(320, Math.floor(viewer.clientWidth - 36)));
    const height = Math.min(merge.height, Math.round((width * 2) / 3));
    const clamp = (v: number, hi: number): number => Math.max(0, Math.min(hi, Math.round(v)));
    const rect = { x: clamp(this.cropCenter.x - width / 2, merge.width - width) & ~1, y: clamp(this.cropCenter.y - height / 2, merge.height - height) & ~1, width, height };
    this.cropCenter = { x: rect.x + width / 2, y: rect.y + height / 2 };
    const request: WorkerRequest = { type: 'crop', id: ++this.cropRequest, rect, algorithm: this.demosaic, wb: wbGains(ref.info) };
    this.worker.postMessage(request);
    replace(this.viewerCaption, h('strong', {}, 'Merged HDR'), ` · 100% · demosaicing with ${this.demosaic === 'rcd' ? 'RCD' : 'bilinear'}…`);
  }

  private select(index: number): void {
    this.selected = index;
    this.renderToolbar();
    this.renderInspector();
    this.renderFilmstrip();
    this.renderImages();
    this.filmstrip.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ---- rendering -----------------------------------------------------------

  private displayOrder(): number[] {
    const order = this.exposures ? [...this.exposures.order] : [];
    for (const s of this.slots) if (!order.includes(s.index)) order.push(s.index);
    return order;
  }

  private navigationOrder(): number[] {
    const frames = this.displayOrder().filter((i) => this.slots[i].preview);
    return [...(this.lookInfo ? [FINAL] : []), ...(this.merge ? [MERGED] : []), ...frames];
  }

  /** Asks the worker for the finished look with the current settings, debounced for slider drags. */
  /** On a screen with more pixels than the display render, follows it with a half-resolution render with full detail. */
  private requestSharp(): void {
    const img = this.lookImage;
    if (!img || !this.worker || !this.lookSettings) return;
    // The photo's on-screen width in device pixels, in the simple view (the workspace viewer is smaller).
    const cssWidth = Math.min(window.innerWidth - 64, (window.innerHeight - 64) * (img.width / img.height));
    if (cssWidth * window.devicePixelRatio < 1.15 * img.width) return;
    const request: WorkerRequest = { type: 'look', id: ++this.lookRequest, settings: this.lookSettings, detail: 'sharp' };
    this.worker.postMessage(request);
  }

  /** A quick preview render now, and a sharp one once the settings have stopped changing. */
  private requestLook(delay = 90): void {
    clearTimeout(this.lookTimer);
    clearTimeout(this.displayTimer);
    const send = (detail: LookDetail): void => {
      if (!this.worker || !this.lookSettings) return;
      const request: WorkerRequest = { type: 'look', id: ++this.lookRequest, settings: this.lookSettings, detail };
      this.worker.postMessage(request);
      this.renderLookStatus();
    };
    this.lookTimer = window.setTimeout(() => {
      send('preview');
      this.displayTimer = window.setTimeout(() => send('display'), 700);
    }, delay);
  }

  private exportLook(format: 'jpeg' | 'dng'): void {
    if (!this.worker || !this.lookSettings || this.exportBusy) return;
    const id = ++this.exportRequest;
    const request: WorkerRequest =
      format === 'dng' ? { type: 'export-dng', id, settings: this.lookSettings } : { type: 'export', id, settings: this.lookSettings, size: this.exportSize };
    this.worker.postMessage(request);
    this.exportBusy = true;
    this.exportProgress = 0;
    this.exportStatus = format === 'dng' ? 'Writing the DNG…' : this.exportSize === 'small' ? 'Rendering…' : 'Rendering full detail…';
    this.renderToolbar();
    this.renderSimple();
  }

  /** The real-estate default look for this image. */
  private defaultLook(): LookSettings {
    const info = this.lookInfo!;
    const wb = info.wb[info.wb.default] ?? info.wb.asShot;
    return { ...REAL_ESTATE_LOOK, wb: { temperature: wb.temperature, tint: wb.tint }, scene: info.scene, upright: info.upright.available, lens: info.lens.available };
  }

  /** Upright and lens corrections change the crop: keep the size menu's labels current without rebuilding it. */
  private refreshExportSizes(): void {
    for (const option of this.toolbar.querySelectorAll<HTMLOptionElement>('[data-testid="export-size"] option')) {
      option.textContent = `${option.textContent?.split(' · ')[0]} · ${this.exportDimensions(option.value as ExportSize)}`;
    }
  }

  /** Pixel size of an export under the current look. */
  private exportDimensions(size: ExportSize): string {
    const dims = this.lookImage?.sizes[size];
    return dims ? `${dims[0]} × ${dims[1]}` : '';
  }

  private remerge(deghost: boolean): void {
    if (!this.worker || !this.merge) return;
    const request: WorkerRequest = { type: 'remerge', deghost };
    this.worker.postMessage(request);
    this.startedAt = performance.now();
    this.renderStatus(deghost ? 'Merging with deghosting…' : 'Merging without deghosting…', 0.9);
  }

  private renderLookStatus(): void {
    const el = this.inspector.querySelector('[data-testid="look-status"]');
    if (!el) return;
    const pending = this.lookImage && this.lookImage.id < this.lookRequest;
    el.textContent = this.lookError
      ? `Render failed: ${this.lookError}`
      : !this.lookImage
        ? 'Rendering…'
        : pending
          ? 'Updating…'
          : `${this.lookImage.width} × ${this.lookImage.height} ${this.lookImage.detail} in ${Math.round(this.lookImage.ms)} ms${
              this.lookImage.pull > 0 ? ` · window view pulled ${this.lookImage.pull.toFixed(1)} stops` : ''
            }`;
  }

  private renderAll(): void {
    this.renderSummary();
    this.renderToolbar();
    this.renderInspector();
    this.renderFilmstrip();
    this.renderImages();
    this.renderMerge();
    this.renderExposurePanel();
    this.renderPairsPanel();
    this.renderLinearity();
    this.renderNoise();
    this.renderMetadata();
  }

  private renderCharts(): void {
    this.renderLinearity();
    this.renderNoise();
    this.renderInspector();
  }

  private renderSummary(): void {
    const loaded = this.slots.filter((s) => s.info);
    const first = loaded[0]?.info;
    if (!first) {
      replace(this.summary, h('span', { class: 'chip muted' }, `${this.slots.length} files queued`));
      return;
    }
    const uniq = (values: string[]): string => [...new Set(values)].join(' / ');
    const chips: Array<[string, string]> = [
      ['Camera', uniq(loaded.map((s) => s.info!.model))],
      ['Lens', uniq(loaded.map((s) => s.info!.exposure.lensModel || '—'))],
      ['Frames', `${loaded.length} of ${this.slots.length}`],
      ['Aperture', uniq(loaded.map((s) => `f/${s.info!.exposure.fNumber}`))],
      ['ISO', uniq(loaded.map((s) => String(s.info!.exposure.iso)))],
      ['Raw', `${first.rawFileType.replace(/^Sony /, '')} · ${first.width} × ${first.height}`],
    ];
    if (this.exposures) {
      const evs = this.exposures.order.map((i) => this.exposures!.byFile.get(i)!.measuredEv);
      const steps = this.exposures.pairs.map((p) => p.estimate.ev);
      const lo = fmt.signed(Math.min(...steps));
      const hi = fmt.signed(Math.max(...steps));
      chips.push(['Measured range', `${fmt.signed(evs[0])} to ${fmt.signed(evs[evs.length - 1])} EV`]);
      chips.push([steps.length > 1 ? 'Steps' : 'Step', lo === hi ? `${lo} EV` : `${lo} to ${hi} EV`]);
    }
    if (this.merge) chips.push(['Merged range', `${this.merge.dynamicRangeStops.toFixed(1)} stops`]);
    replace(this.summary, ...chips.map(([label, value]) => h('span', { class: 'chip' }, h('span', { class: 'chip-label' }, label), h('span', { class: 'chip-value' }, value))));
  }

  /** Size, JPEG and DNG export, and the export's progress. */
  private exportControls(): HTMLElement {
    const sizes: Array<[ExportSize, string]> = [
      ['full', 'Full resolution'],
      ['half', 'Half'],
      ['small', 'Small'],
    ];
    const select = h(
      'select',
      { class: 'select', 'aria-label': 'Export size', 'data-testid': 'export-size', disabled: !this.lookImage || this.exportBusy },
      ...sizes.map(([size, label]) => h('option', { value: size, selected: size === this.exportSize }, `${label} · ${this.exportDimensions(size)}`)),
    );
    select.addEventListener('change', () => (this.exportSize = select.value as ExportSize));
    return h(
      'div',
      { class: 'export-controls' },
      select,
      h('button', { type: 'button', class: 'button primary', 'data-testid': 'export-jpeg', disabled: !this.lookImage || this.exportBusy, onclick: () => this.exportLook('jpeg') }, 'Export JPEG'),
      h(
        'button',
        { type: 'button', class: 'button', 'data-testid': 'export-dng', title: 'The merged raw data as a 16-bit floating-point DNG, for Lightroom or Camera Raw', disabled: !this.lookImage || this.exportBusy, onclick: () => this.exportLook('dng') },
        'DNG',
      ),
      this.exportStatus ? h('span', { class: 'toolbar-note', 'data-testid': 'export-status', role: 'status' }, this.exportStatus) : null,
    );
  }

  private renderToolbar(): void {
    const segment = (label: string, active: boolean, disabled: boolean, onClick: () => void, testId: string): HTMLButtonElement =>
      h('button', { type: 'button', 'aria-pressed': String(active), disabled, onclick: onClick, 'data-testid': testId }, label);
    const rerender = (): void => {
      this.renderToolbar();
      this.renderImages();
    };
    const slider = h('input', { type: 'range', min: -4, max: 4, step: 0.25, value: this.evOffset, 'aria-label': 'Preview exposure', 'data-testid': 'ev-slider' });
    const sliderValue = h('output', { class: 'slider-value' }, fmt.ev(this.evOffset));
    slider.addEventListener('input', () => {
      this.evOffset = Number(slider.value);
      sliderValue.textContent = fmt.ev(this.evOffset);
      this.renderImages();
    });
    const exposure = h('label', { class: 'slider' }, h('span', {}, 'Exposure'), slider, sliderValue);

    if (this.selected === FINAL) {
      replace(
        this.toolbar,
        h(
          'div',
          { class: 'segmented', role: 'group', 'aria-label': 'Before and after' },
          segment('Before', this.showBefore, !this.merge, () => ((this.showBefore = true), rerender()), 'look-before'),
          segment('After', !this.showBefore, false, () => ((this.showBefore = false), rerender()), 'look-after'),
        ),
        h(
          'button',
          {
            type: 'button',
            class: `button${this.picking ? ' active' : ''}`,
            'aria-pressed': String(this.picking),
            'data-testid': 'pick-white',
            onclick: () => ((this.picking = !this.picking), rerender()),
          },
          this.picking ? 'Click a white wall…' : 'Pick white',
        ),
        this.exportControls(),
        h('span', { class: 'kbd-hint' }, h('kbd', {}, 'B'), ' before/after  ', h('kbd', {}, 'W'), ' pick white'),
      );
      return;
    }

    if (this.selected === MERGED) {
      const sourceToggle = h('input', { type: 'checkbox', checked: this.showSources, 'data-testid': 'source-toggle' });
      sourceToggle.addEventListener('change', () => {
        this.showSources = sourceToggle.checked;
        rerender();
      });
      const setDemosaic = (algorithm: DemosaicAlgorithm) => () => {
        this.demosaic = algorithm;
        this.requestCrop();
        this.renderToolbar();
      };
      replace(
        this.toolbar,
        h(
          'div',
          { class: 'segmented', role: 'group', 'aria-label': 'Zoom' },
          segment('Fit', this.zoom === 'fit', false, () => this.setZoom('fit'), 'zoom-fit'),
          segment('100%', this.zoom === 'crop', false, () => this.setZoom('crop'), 'zoom-100'),
        ),
        this.zoom === 'crop'
          ? h(
              'div',
              { class: 'segmented', role: 'group', 'aria-label': 'Demosaic' },
              segment('RCD', this.demosaic === 'rcd', false, setDemosaic('rcd'), 'demosaic-rcd'),
              segment('Bilinear', this.demosaic === 'bilinear', false, setDemosaic('bilinear'), 'demosaic-bilinear'),
            )
          : null,
        h(
          'div',
          { class: 'segmented', role: 'group', 'aria-label': 'Tone curve' },
          segment('Linear', this.mergedTone === 'linear', false, () => ((this.mergedTone = 'linear'), rerender()), 'tone-linear'),
          segment('Global tone', this.mergedTone === 'global', false, () => ((this.mergedTone = 'global'), rerender()), 'tone-global'),
        ),
        h('label', { class: 'toggle' }, sourceToggle, h('span', {}, 'Source frames')),
        this.merge?.ghostMap
          ? h(
              'label',
              { class: 'toggle' },
              (() => {
                const box = h('input', { type: 'checkbox', checked: this.showGhosts, 'data-testid': 'ghost-toggle' });
                box.addEventListener('change', () => {
                  this.showGhosts = box.checked;
                  rerender();
                });
                return box;
              })(),
              h('span', {}, 'Moving objects'),
            )
          : null,
        this.showSources && this.exposures
          ? h(
              'span',
              { class: 'clip-legend', 'data-testid': 'source-legend' },
              ...this.exposures.order.flatMap((file, rank) => [
                h('span', { class: 'swatch', style: `background:${css(FRAME_COLORS[rank % FRAME_COLORS.length])}` }),
                fmt.shutter(this.slots[file].info?.exposure.exposureTime ?? NaN),
              ]),
            )
          : null,
        exposure,
        h('span', { class: 'kbd-hint' }, h('kbd', {}, 'Z'), ' zoom  ', h('kbd', {}, 'S'), ' sources  ', h('kbd', {}, 'G'), ' moving'),
      );
      return;
    }

    const clipToggle = h('input', { type: 'checkbox', checked: this.showClipping, 'data-testid': 'clip-toggle' });
    clipToggle.addEventListener('change', () => {
      this.showClipping = clipToggle.checked;
      rerender();
    });
    replace(
      this.toolbar,
      h(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': 'Preview brightness' },
        segment('As shot', !this.matched, false, () => ((this.matched = false), rerender()), 'mode-as-shot'),
        segment('Matched', this.matched, !this.exposures, () => ((this.matched = true), rerender()), 'mode-matched'),
      ),
      h('label', { class: 'toggle' }, clipToggle, h('span', {}, 'Clipping')),
      this.showClipping
        ? h(
            'span',
            { class: 'clip-legend' },
            h('span', { class: 'swatch', style: 'background: var(--serious)' }),
            'some channels',
            h('span', { class: 'swatch', style: 'background: var(--critical)' }),
            'all channels',
          )
        : null,
      exposure,
      h('span', { class: 'kbd-hint' }, h('kbd', {}, '←'), h('kbd', {}, '→'), ' frames  ', h('kbd', {}, 'M'), ' match  ', h('kbd', {}, 'C'), ' clipping'),
    );
  }

  private referenceSlot(): Slot | undefined {
    if (this.exposures) return this.slots[this.exposures.reference];
    return this.slots.find((s) => s.info?.exposure.exposureCompensation === 0) ?? this.slots.find((s) => s.preview);
  }

  /** Gain that renders the base frame at a normal brightness, plus the exposure slider. */
  private baseGain(): number {
    const ref = this.referenceSlot();
    if (!ref?.preview || !ref.info) return 2 ** this.evOffset;
    if (this.gainCache?.file !== ref.index) this.gainCache = { file: ref.index, value: autoGain(ref.preview, wbGains(ref.info)) };
    return this.gainCache.value * 2 ** this.evOffset;
  }

  private gainFor(slot: Slot): number {
    let gain = this.baseGain();
    if (this.matched && this.exposures) {
      const ev = this.exposures.byFile.get(slot.index)?.measuredEv;
      if (ev !== undefined) gain *= 2 ** -ev;
    }
    return gain;
  }

  private paint(canvas: HTMLCanvasElement, slot: Slot): void {
    const p = slot.preview;
    if (!p || !slot.info) return;
    this.draw(canvas, p, { gain: this.gainFor(slot), wb: wbGains(slot.info), showClipping: this.showClipping });
  }

  private paintMerged(canvas: HTMLCanvasElement, thumbnail = false): void {
    const merge = this.merge;
    const ref = this.referenceSlot();
    if (!merge || !ref?.info) return;
    const wb = wbGains(ref.info);
    const gain = this.baseGain();
    const tone = thumbnail ? 'global' : this.mergedTone;
    if (this.whiteCache?.gain !== gain) this.whiteCache = { gain, value: luminancePercentile(merge.preview, wb, gain, 0.999) };
    if (!thumbnail && this.zoom === 'crop' && this.crop) {
      // Same gain and white point as the whole image, so zooming does not change brightness.
      this.draw(canvas, this.crop.data, { gain, wb, showClipping: false, tone, whitePoint: this.whiteCache.value });
      return;
    }
    let overlay = null;
    if (this.showGhosts && !thumbnail && merge.ghostMap) {
      const index = new Uint8Array(merge.ghostMap.length);
      for (let i = 0; i < index.length; i++) index[i] = merge.ghostMap[i] > 96 ? 0 : 255;
      overlay = { index, colors: GHOST_COLORS };
    } else if (this.showSources && !thumbnail && this.exposures) {
      const rankOf = new Map(this.exposures.order.map((file, rank) => [file, rank]));
      const index = new Uint8Array(merge.sourceMap.length);
      for (let i = 0; i < index.length; i++) index[i] = (rankOf.get(this.exposures.files[merge.sourceMap[i]]) ?? 0) % FRAME_COLORS.length;
      overlay = { index, colors: FRAME_COLORS };
    }
    this.draw(canvas, merge.preview, { gain, wb, showClipping: false, tone, whitePoint: this.whiteCache.value, overlay });
  }

  private drawLook(canvas: HTMLCanvasElement): void {
    const img = this.lookImage;
    if (!img) return;
    if (canvas.width !== img.width || canvas.height !== img.height) {
      canvas.width = img.width;
      canvas.height = img.height;
    }
    canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0);
  }

  private draw(canvas: HTMLCanvasElement, p: PreviewData, options: Parameters<typeof renderPreview>[1]): void {
    if (canvas.width !== p.width || canvas.height !== p.height) {
      canvas.width = p.width;
      canvas.height = p.height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const image = ctx.createImageData(p.width, p.height);
    renderPreview(p, options, image);
    ctx.putImageData(image, 0, 0);
  }

  private renderImages(): void {
    const finalThumb = this.filmstrip.querySelector<HTMLCanvasElement>('canvas[data-final]');
    if (finalThumb && this.lookImage) this.drawLook(finalThumb);
    if (this.selected === FINAL) {
      this.canvas.classList.remove('crop', 'zoomable');
      this.canvas.classList.toggle('picking', this.picking);
      this.canvas.style.width = '';
      this.canvas.style.height = '';
      this.canvas.dataset.view = 'fit';
      this.canvas.dataset.file = this.showBefore ? 'merged' : 'final';
      if (this.showBefore && this.merge) {
        const tone = this.mergedTone;
        this.mergedTone = 'global';
        this.paintMerged(this.canvas);
        this.mergedTone = tone;
        replace(this.viewerCaption, h('strong', {}, 'Before'), ' · the merge with a plain global tone curve and camera white balance');
      } else if (this.lookImage) {
        this.drawLook(this.canvas);
        const s = this.lookSettings;
        replace(
          this.viewerCaption,
          h('strong', {}, 'Final'),
          s ? ` · ${Math.round(s.wb.temperature)} K / ${fmt.signed(s.wb.tint, 0)} tint · ${this.lookInfo?.profile ?? ''} colour · real-estate tone and finishing` : '',
        );
      } else {
        replace(this.viewerCaption, h('strong', {}, 'Final'), ' · rendering…');
      }
      for (const thumb of this.filmstrip.querySelectorAll<HTMLCanvasElement>('canvas[data-index]')) {
        const s = this.slots[Number(thumb.dataset.index)];
        if (s) this.paint(thumb, s);
      }
      const mergedThumb = this.filmstrip.querySelector<HTMLCanvasElement>('canvas[data-merged]');
      if (mergedThumb) this.paintMerged(mergedThumb, true);
      return;
    }
    this.canvas.classList.remove('picking');
    const crop = this.selected === MERGED && this.zoom === 'crop' ? this.crop : null;
    this.canvas.classList.toggle('crop', !!crop);
    this.canvas.classList.toggle('zoomable', this.selected === MERGED && !crop);
    this.canvas.style.width = crop ? `${crop.rect.width}px` : '';
    this.canvas.style.height = crop ? `${crop.rect.height}px` : '';
    this.canvas.dataset.view = crop ? 'crop' : 'fit';
    if (crop) this.canvas.dataset.algorithm = crop.algorithm;
    else delete this.canvas.dataset.algorithm;
    if (this.selected === MERGED && this.merge) {
      this.paintMerged(this.canvas);
      this.canvas.setAttribute('aria-label', 'Preview of the merged HDR result');
      this.canvas.dataset.file = 'merged';
      const tone = this.mergedTone === 'global' ? 'global tone curve (extended Reinhard)' : 'linear, clipped at white';
      if (crop) {
        const name = crop.algorithm === 'rcd' ? 'RCD' : 'bilinear';
        replace(
          this.viewerCaption,
          h('strong', {}, 'Merged HDR'),
          ` · 100% at (${crop.rect.x}, ${crop.rect.y}) · ${name} demosaic in ${Math.round(crop.ms)} ms · ${tone} · drag to pan, click to fit`,
        );
      } else {
        replace(
          this.viewerCaption,
          h('strong', {}, 'Merged HDR'),
          ` · ${tone} · camera RGB with the base frame’s WB, quarter-resolution bin of the merged CFA · click to see 100%`,
        );
      }
    } else {
      const slot = this.slots[this.selected];
      if (slot?.preview) {
        this.paint(this.canvas, slot);
        this.canvas.setAttribute('aria-label', `Preview of ${slot.fileName}`);
        this.canvas.dataset.file = slot.fileName;
        const e = this.exposures?.byFile.get(slot.index);
        const mode = this.matched ? `matched to the base frame (${fmt.ev(-(e?.measuredEv ?? 0))} gain)` : 'as shot, relative to the base frame';
        replace(this.viewerCaption, h('strong', {}, slot.fileName), ` · ${mode} · camera RGB with as-shot WB, quarter-resolution bin of the CFA (no demosaic yet)`);
      }
    }
    for (const thumb of this.filmstrip.querySelectorAll<HTMLCanvasElement>('canvas[data-index]')) {
      const s = this.slots[Number(thumb.dataset.index)];
      if (s) this.paint(thumb, s);
    }
    const mergedThumb = this.filmstrip.querySelector<HTMLCanvasElement>('canvas[data-merged]');
    if (mergedThumb) this.paintMerged(mergedThumb, true);
  }

  private renderFilmstrip(): void {
    const cards: HTMLElement[] = [];
    if (this.lookInfo) {
      cards.push(
        h(
          'button',
          { type: 'button', class: 'thumb merged final', role: 'option', 'aria-selected': String(this.selected === FINAL), 'data-testid': 'thumb-final', onclick: () => this.select(FINAL) },
          h('canvas', { 'data-final': 'true', 'aria-hidden': 'true' }),
          h('div', { class: 'thumb-row' }, h('span', { class: 'thumb-name' }, 'Final'), h('span', { class: 'badge' }, 'Real estate')),
          h('div', { class: 'thumb-row secondary' }, h('span', {}, 'colour, tone, finishing'), h('span', {}, 'export-ready')),
        ),
      );
    }
    if (this.merge) {
      cards.push(
        h(
          'button',
          { type: 'button', class: 'thumb merged', role: 'option', 'aria-selected': String(this.selected === MERGED), 'data-testid': 'thumb-merged', onclick: () => this.select(MERGED) },
          h('canvas', { 'data-merged': 'true', 'aria-hidden': 'true' }),
          h('div', { class: 'thumb-row' }, h('span', { class: 'thumb-name' }, 'Merged HDR'), h('span', { class: 'badge' }, `${this.merge.dynamicRangeStops.toFixed(1)} stops`)),
          h('div', { class: 'thumb-row secondary' }, h('span', {}, `${this.slots.filter((s) => s.info).length} frames`), h('span', {}, 'aligned · noise-weighted')),
        ),
      );
    } else if (this.exposures && !this.mergeError) {
      cards.push(h('div', { class: 'thumb pending merged', role: 'option', 'aria-selected': 'false' }, h('div', { class: 'thumb-placeholder' }), h('div', { class: 'thumb-name' }, 'Merging…')));
    }
    for (const i of this.displayOrder()) {
      const slot = this.slots[i];
      const e = this.exposures?.byFile.get(i);
      const isRef = this.exposures?.reference === i;
      if (slot.error) {
        cards.push(
          h(
            'div',
            { class: 'thumb error', role: 'option', 'aria-selected': 'false', 'data-testid': 'thumb' },
            h('div', { class: 'thumb-error' }, h('strong', {}, 'Could not read this file'), h('span', {}, slot.error)),
            h('div', { class: 'thumb-name' }, slot.fileName),
          ),
        );
        continue;
      }
      if (!slot.info || !slot.hist) {
        cards.push(h('div', { class: 'thumb pending', role: 'option', 'aria-selected': 'false', 'data-testid': 'thumb' }, h('div', { class: 'thumb-placeholder' }), h('div', { class: 'thumb-name' }, slot.fileName)));
        continue;
      }
      cards.push(
        h(
          'button',
          { type: 'button', class: 'thumb', role: 'option', 'aria-selected': String(i === this.selected), 'data-testid': 'thumb', 'data-file': slot.fileName, onclick: () => this.select(i) },
          h('canvas', { 'data-index': i, 'aria-hidden': 'true' }),
          h('div', { class: 'thumb-row' }, h('span', { class: 'thumb-name' }, stem(slot.fileName)), isRef ? h('span', { class: 'badge' }, 'Base') : null),
          h(
            'div',
            { class: 'thumb-row secondary' },
            h('span', {}, fmt.shutter(slot.info.exposure.exposureTime)),
            h('span', { class: 'thumb-ev' }, e ? fmt.ev(e.measuredEv) : `${fmt.signed(slot.info.exposure.exposureCompensation, 1)} EV offset`),
          ),
          histogramChart(slot.hist, { width: 164, rowHeight: 11, compact: true }),
        ),
      );
    }
    replace(this.filmstrip, ...cards);
  }

  private kpi(label: string, value: string, testId: string, note?: string): HTMLElement {
    return h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, label), h('span', { class: 'kpi-value', 'data-testid': testId }, value), note ? h('span', { class: 'kpi-note' }, note) : null);
  }

  private renderInspector(): void {
    if (this.selected === FINAL && this.lookInfo && this.lookSettings) {
      this.renderLookInspector(this.lookInfo, this.lookSettings);
      return;
    }
    if (this.selected === MERGED && this.merge && this.exposures) {
      this.renderMergedInspector(this.merge, this.exposures);
      return;
    }
    const slot = this.slots[this.selected];
    if (!slot) {
      replace(this.inspector, h('p', { class: 'muted' }, 'Decoding…'));
      return;
    }
    if (slot.error) {
      replace(this.inspector, h('h2', {}, slot.fileName), h('p', { class: 'error-text' }, slot.error));
      return;
    }
    const info = slot.info;
    const stats = slot.stats;
    if (!info || !stats || !slot.hist) {
      replace(this.inspector, h('h2', {}, slot.fileName), h('p', { class: 'muted' }, 'Decoding…'));
      return;
    }
    const e = this.exposures?.byFile.get(slot.index);
    const ex = info.exposure;
    const width = Math.max(240, this.inspector.clientWidth - 32 || 340);
    const channelRows = stats.channels.map((c) =>
      h(
        'tr',
        {},
        h('th', { scope: 'row' }, h('span', { class: `key key-${'rgb'[c.color]}` }), c.name),
        h('td', { class: 'num' }, fmt.percent(c.clippedFraction)),
        h('td', { class: 'num' }, fmt.integer(c.median)),
        h('td', { class: 'num' }, fmt.integer(c.p99)),
        h('td', { class: 'num' }, fmt.integer(c.max)),
      ),
    );
    const wb = info.asShotWb ? wbGains(info) : null;
    replace(
      this.inspector,
      h('div', { class: 'inspector-head' }, h('h2', { 'data-testid': 'inspector-title' }, info.fileName), this.exposures?.reference === slot.index ? h('span', { class: 'badge' }, 'Base exposure') : null),
      h('p', { class: 'meta-line' }, `Shot ${info.sequenceNumber ?? '?'} of ${this.slots.length} · ${fmt.shutter(ex.exposureTime)} · f/${ex.fNumber} · ISO ${ex.iso} · ${ex.focalLength} mm`),
      h(
        'div',
        { class: 'kpis' },
        this.kpi('Measured', e ? fmt.ev(e.measuredEv) : '…', 'kpi-measured', 'from pixels'),
        this.kpi('EXIF shutter', e ? fmt.ev(e.exifEv) : '…', 'kpi-exif', 'from tags'),
        this.kpi('Difference', e ? fmt.ev(e.differenceEv) : '…', 'kpi-diff', 'measured − EXIF'),
      ),
      h('h3', {}, 'Histogram', h('span', { class: 'h3-note' }, 'stops below white level')),
      histogramChart(slot.hist, { width, rowHeight: 34, label: `Raw histogram of ${info.fileName}` }),
      h(
        'table',
        { class: 'data compact', 'data-testid': 'channel-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Channel'), h('th', { class: 'num' }, 'Clipped'), h('th', { class: 'num' }, 'Median'), h('th', { class: 'num' }, '99th pct'), h('th', { class: 'num' }, 'Max'))),
        h('tbody', {}, ...channelRows),
      ),
      h(
        'dl',
        { class: 'levels' },
        h('dt', {}, 'Black level'),
        h('dd', { 'data-testid': 'black-level' }, `${[...new Set(info.blackLevel)].join(' / ')}`, h('span', { class: 'src' }, info.sources.blackLevel)),
        h('dt', {}, 'White level'),
        h('dd', { 'data-testid': 'white-level' }, String(info.whiteLevel), h('span', { class: 'src' }, `${info.sources.whiteLevel} · clip`)),
        h('dt', {}, 'SR2 white'),
        h('dd', {}, info.sr2WhiteLevel ? [...new Set(info.sr2WhiteLevel)].join(' / ') : '—', h('span', { class: 'src' }, 'not a clip')),
        h('dt', {}, 'As-shot WB'),
        h('dd', {}, wb ? `R ${wb[0].toFixed(3)} · B ${wb[2].toFixed(3)}` : '—', h('span', { class: 'src' }, info.sources.asShotWb ?? '')),
      ),
    );
  }

  private renderLookInspector(info: NonNullable<App['lookInfo']>, initial: LookSettings): void {
    // Slider drags only update their label and the settings: rebuilding the panel would end the drag.
    const current = (): LookSettings => this.lookSettings ?? initial;
    const apply = (patch: Partial<LookSettings>): void => {
      this.lookSettings = { ...current(), ...patch };
      this.requestLook();
      this.renderImages();
    };
    const pct = (v: number): string => `${Math.round(v * 100)}%`;
    const wbNote = h('span', { class: 'h3-note' });
    const wbButtons = new Map<WbMode, HTMLButtonElement>();
    const setMode = (mode: WbMode): void => {
      this.wbMode = mode;
      for (const [m, b] of wbButtons) b.setAttribute('aria-pressed', String(m === mode));
      wbNote.textContent =
        mode === 'auto' ? `walls neutral · ${pct(info.wb.auto.coverage)} of the room` : mode === 'camera' ? "the camera's auto measurement" : mode === 'asShot' ? 'as shot' : 'custom';
    };
    const row = (label: string, testId: string, min: number, max: number, step: number, value: number, format: (v: number) => string, onInput: (v: number) => void): HTMLElement => {
      const out = h('output', { class: 'look-value', 'data-testid': `${testId}-value` }, format(value));
      const input = h('input', { type: 'range', min, max, step, value, 'data-testid': testId });
      input.addEventListener('input', () => {
        const v = Number(input.value);
        onInput(v);
        out.textContent = format(v);
      });
      return h('label', { class: 'look-row' }, h('span', { class: 'look-label' }, label), input, out);
    };
    const presets: Array<[WbMode, string, WbSetting | null]> = [
      ['auto', 'Auto', info.wb.auto],
      ['asShot', 'As shot', info.wb.asShot],
      ['camera', 'Camera', info.wb.camera],
    ];
    for (const [mode, label, wb] of presets) {
      wbButtons.set(
        mode,
        h(
          'button',
          {
            type: 'button',
            disabled: !wb,
            'data-testid': `wb-${mode}`,
            onclick: () => {
              if (!wb) return;
              this.lookSettings = { ...current(), wb: { temperature: wb.temperature, tint: wb.tint } };
              this.wbMode = mode;
              this.requestLook(0);
              this.renderInspector();
            },
          },
          label,
        ),
      );
    }
    const s = current();
    const signed2 = (v: number): string => fmt.signed(v, 2);
    const sceneButtons = (['interior', 'exterior'] as const).map((kind) =>
      h(
        'button',
        {
          type: 'button',
          'aria-pressed': String(s.scene === kind),
          'data-testid': `scene-${kind}`,
          onclick: () => {
            if (current().scene === kind) return;
            this.lookSettings = { ...current(), scene: kind };
            this.requestLook(0);
            this.renderInspector();
          },
        },
        kind === 'interior' ? 'Interior' : 'Exterior',
      ),
    );
    const toggle = (label: string, testId: string, checked: boolean, disabled: boolean, onChange: (on: boolean) => void, note?: string): HTMLElement => {
      const box = h('input', { type: 'checkbox', checked, disabled, 'data-testid': testId });
      box.addEventListener('change', () => onChange(box.checked));
      return h('label', { class: 'toggle look-toggle' }, box, h('span', {}, label), note ? h('span', { class: 'toggle-note' }, note) : null);
    };
    replace(
      this.inspector,
      h('div', { class: 'inspector-head' }, h('h2', { 'data-testid': 'inspector-title' }, 'Final'), h('span', { class: 'badge' }, 'Real estate')),
      h('p', { class: 'meta-line' }, `${info.profile} colour · ${s.scene === 'interior' ? 'bright & airy, windows pulled' : "the camera's exposure, sky and shadows balanced"}`),
      h('h3', {}, 'Scene', h('span', { class: 'h3-note' }, s.scene === info.scene ? 'detected' : 'set by you')),
      h('div', { class: 'segmented wide', role: 'group', 'aria-label': 'Scene' }, ...sceneButtons),
      h('h3', {}, 'White balance', wbNote),
      h('div', { class: 'segmented wide', role: 'group', 'aria-label': 'White balance' }, ...wbButtons.values()),
      row('Temp', 'look-temp', 0, 1000, 1, tempToSlider(s.wb.temperature), (v) => `${Math.round(sliderToTemp(v))} K`, (v) => {
        setMode('custom');
        apply({ wb: { ...current().wb, temperature: sliderToTemp(v) } });
      }),
      row('Tint', 'look-tint', -50, 80, 1, Math.round(s.wb.tint), (v) => fmt.signed(v, 0), (v) => {
        setMode('custom');
        apply({ wb: { ...current().wb, tint: v } });
      }),
      h('h3', {}, 'Tone'),
      row('Brightness', 'look-brightness', -1, 1.5, 0.05, s.brightness, signed2, (v) => apply({ brightness: v })),
      s.scene === 'interior' ? row('Window pull', 'look-window', 0, 1, 0.05, s.windowPull, pct, (v) => apply({ windowPull: v })) : null,
      row('Clarity', 'look-clarity', 0, 1, 0.05, s.clarity, pct, (v) => apply({ clarity: v })),
      row('Contrast', 'look-contrast', -0.5, 0.6, 0.05, s.contrast, signed2, (v) => apply({ contrast: v })),
      h('h3', {}, 'Colour'),
      row('Vibrance', 'look-vibrance', -0.5, 0.6, 0.05, s.vibrance, signed2, (v) => apply({ vibrance: v })),
      row('Clean whites', 'look-whites', 0, 1, 0.05, s.cleanWhites, pct, (v) => apply({ cleanWhites: v })),
      h('h3', {}, 'Geometry', h('span', { class: 'h3-note' }, uprightNote(info.upright))),
      toggle('Straighten verticals', 'look-upright', s.upright, !info.upright.available, (on) => apply({ upright: on })),
      toggle('Lens corrections', 'look-lens', s.lens, !info.lens.available, (on) => apply({ lens: on }), lensNote(info.lens)),
      h(
        'div',
        { class: 'look-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'button',
            'data-testid': 'look-reset',
            onclick: () => {
              this.lookSettings = this.defaultLook();
              this.wbMode = info.wb.default;
              this.requestLook(0);
              this.renderInspector();
            },
          },
          'Reset to real-estate default',
        ),
      ),
      h('p', { class: 'muted small', 'data-testid': 'look-status' }),
    );
    setMode(this.wbMode);
    this.renderLookStatus();
  }

  private renderMergedInspector(merge: MergeSummary, exposures: Exposures): void {
    const worstSeam = Math.max(...merge.seams.map((s) => Math.abs(s.relativeBias)).filter(Number.isFinite), 0);
    const maxShare = Math.max(...merge.weightShare);
    const bars = exposures.order.map((file, rank) => {
      const position = exposures.files.indexOf(file);
      const share = merge.weightShare[position] ?? 0;
      const info = this.slots[file].info;
      return h(
        'div',
        { class: 'bar-row', title: `${this.slots[file].fileName}: ${fmt.percent(share, 1)} of the weight` },
        h('span', { class: 'bar-label' }, info ? fmt.shutter(info.exposure.exposureTime) : stem(this.slots[file].fileName)),
        h('span', { class: 'bar-track' }, h('span', { class: 'bar', style: `width:${(100 * share) / maxShare}%;background:${css(FRAME_COLORS[rank % FRAME_COLORS.length])}` })),
        h('span', { class: 'bar-value' }, fmt.percent(share, 1)),
      );
    });
    replace(
      this.inspector,
      h('div', { class: 'inspector-head' }, h('h2', { 'data-testid': 'inspector-title' }, 'Merged HDR'), h('span', { class: 'badge' }, 'Phase 4')),
      h('p', { class: 'meta-line' }, `${exposures.order.length} frames · ${merge.width} × ${merge.height} · aligned to ${stem(this.slots[exposures.reference].fileName)}`),
      h(
        'div',
        { class: 'kpis' },
        this.kpi('Dynamic range', `${merge.dynamicRangeStops.toFixed(1)} stops`, 'kpi-range', 'brightest ÷ noise floor'),
        this.kpi('Still clipped', fmt.percent(merge.clippedFraction, 3), 'kpi-clipped', 'all frames clipped'),
        this.kpi('Worst seam', fmt.percent(worstSeam, 2), 'kpi-seam', 'mean step at a hand-off'),
      ),
      h('h3', {}, 'Weight share', h('span', { class: 'h3-note' }, 'how much each frame contributes')),
      h('div', { class: 'bars', 'data-testid': 'weight-bars' }, ...bars),
      h(
        'p',
        { class: 'muted small' },
        'Each pixel averages every usable frame, weighted by the noise model: longer exposures win wherever they are unclipped, and a frame fades out smoothly as it nears clipping.',
      ),
    );
  }

  /** Moving objects: the deghosting switch and how much of each frame it set aside. */
  private deghostSection(merge: MergeSummary, exposures: Exposures): HTMLElement {
    const d = merge.deghost;
    const box = h('input', { type: 'checkbox', checked: d.enabled, 'data-testid': 'deghost-toggle' });
    box.addEventListener('change', () => this.remerge(box.checked));
    const perFrame = exposures.order
      .filter((file) => file !== exposures.reference)
      .map((file) => `${stem(this.slots[file].fileName)} ${fmt.percent(d.share[exposures.files.indexOf(file)] ?? 0, 2)}`)
      .join(' · ');
    const summary = d.enabled
      ? d.coverage > 0
        ? `Frames disagreed with the base frame in ${fmt.percent(d.coverage, 2)} of the image (wind, people, passing cars, changing light); there the base frame is used alone. Per frame: ${perFrame}.`
        : 'No moving objects found: every frame agrees with the base frame within its noise.'
      : 'Off: every frame contributes everywhere, so anything that moved between shots can leave a faint copy.'
    return h(
      'div',
      { class: 'deghost', 'data-testid': 'deghost' },
      h('h3', { class: 'panel-h3' }, 'Moving objects', h('span', { class: 'h3-note' }, d.enabled ? `checked in ${Math.round(d.ms)} ms` : 'deghosting off')),
      h('label', { class: 'toggle' }, box, h('span', {}, 'Deghost: keep moving objects from the base frame only')),
      h('p', { class: 'muted small', 'data-testid': 'deghost-summary' }, summary),
    );
  }

  private renderMerge(): void {
    const head = [h('h2', {}, 'Merge')];
    const merge = this.merge;
    const exposures = this.exposures;
    if (!merge || !exposures) {
      head.push(h('p', { class: 'lead' }, this.mergeError ? `The merge failed: ${this.mergeError}` : 'Aligning and merging once the noise model is fitted…'));
      replace(this.mergePanel, ...head);
      return;
    }
    const fileAt = (position: number): number => exposures.files[position];
    head.push(
      h(
        'p',
        { class: 'lead' },
        `Frames are aligned to the base frame with sub-pixel shifts measured from the image, resampled per colour plane, and averaged with noise-model weights on the raw Bayer data. Align ${Math.round(merge.ms.align)} ms · merge ${Math.round(merge.ms.merge)} ms.`,
      ),
    );
    const alignRows = exposures.order.map((file) => {
      const a = merge.alignment.frames[exposures.files.indexOf(file)];
      const spread = Math.max(...a.quadrants.map((q) => Math.hypot(q.dx - a.shift.dx, q.dy - a.shift.dy)), 0);
      const isRef = file === exposures.reference;
      return h(
        'tr',
        { 'data-file': this.slots[file].fileName },
        h('th', { scope: 'row' }, stem(this.slots[file].fileName), isRef ? h('span', { class: 'badge' }, 'Base') : null),
        h('td', { class: 'num' }, fmt.shutter(this.slots[file].info?.exposure.exposureTime ?? NaN)),
        h('td', { class: 'num strong' }, isRef ? '—' : fmt.signed(a.shift.dx, 3)),
        h('td', { class: 'num strong' }, isRef ? '—' : fmt.signed(a.shift.dy, 3)),
        h('td', { class: 'num' }, isRef ? '—' : spread.toFixed(3)),
        h('td', { class: 'num' }, isRef ? '—' : `${a.residualBefore.toFixed(2)} → ${a.residualAfter.toFixed(2)}`),
        h('td', {}, a.unreliable ? 'low texture, check' : isRef ? 'reference' : 'ok'),
      );
    });
    const seamRows = merge.seams.map((s) => {
      const cells = s.cells.filter((c) => c.samples >= 500);
      const worst = cells.reduce((m, c) => (Math.abs(c.relativeBias) > Math.abs(m) ? c.relativeBias : m), 0);
      return h(
        'tr',
        {},
        h('th', { scope: 'row' }, `${stem(this.slots[fileAt(s.bright)].fileName)} → ${stem(this.slots[fileAt(s.dark)].fileName)}`),
        h('td', { class: 'num' }, fmt.integer(s.samples)),
        h('td', { class: 'num strong' }, fmt.signedPercent(s.relativeBias, 2)),
        h('td', { class: 'num' }, cells.length ? fmt.signedPercent(worst, 2) : '—'),
        h('td', { class: 'num' }, String(cells.length)),
      );
    });
    replace(
      this.mergePanel,
      ...head,
      this.deghostSection(merge, exposures),
      h('h3', { class: 'panel-h3' }, 'Alignment', h('span', { class: 'h3-note' }, 'shift in raw pixels; residual = robust RMS of noise-normalised differences (1 = noise only)')),
      h(
        'table',
        { class: 'data', 'data-testid': 'alignment-table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', {}, 'Frame'),
            h('th', { class: 'num' }, 'Shutter'),
            h('th', { class: 'num' }, 'Shift x (px)'),
            h('th', { class: 'num' }, 'Shift y (px)'),
            h('th', { class: 'num' }, 'Quadrant spread (px)'),
            h('th', { class: 'num' }, 'Residual'),
            h('th', {}, 'Status'),
          ),
        ),
        h('tbody', {}, ...alignRows),
      ),
      h('h3', { class: 'panel-h3' }, 'Seam check', h('span', { class: 'h3-note' }, 'mean step where weight hands off from a frame nearing clip to the next darker frame; flat areas only'), ),
      h(
        'table',
        { class: 'data', 'data-testid': 'seam-table' },
        h(
          'thead',
          {},
          h('tr', {}, h('th', {}, 'Hand-off'), h('th', { class: 'num' }, 'Samples'), h('th', { class: 'num' }, 'Mean step'), h('th', { class: 'num' }, 'Worst region'), h('th', { class: 'num' }, 'Regions')),
        ),
        h('tbody', {}, ...seamRows),
      ),
    );
  }

  private renderExposurePanel(): void {
    const head = [h('h2', {}, 'Exposure'), h('p', { class: 'lead' }, leadText(this.exposures, this.exposureError))];
    if (!this.exposures) {
      replace(this.exposurePanel, ...head);
      return;
    }
    const rows = this.exposures.order.map((i) => {
      const slot = this.slots[i];
      const info = slot.info!;
      const e = this.exposures!.byFile.get(i)!;
      const g = slot.stats!.channels.filter((c) => c.color === 1);
      const gClip = g.reduce((a, c) => a + c.clipped, 0) / g.reduce((a, c) => a + c.count, 0);
      return h(
        'tr',
        { 'data-file': slot.fileName, class: this.exposures!.reference === i ? 'is-ref' : '' },
        h('th', { scope: 'row' }, stem(slot.fileName), this.exposures!.reference === i ? h('span', { class: 'badge' }, 'Base') : null),
        h('td', { class: 'num' }, String(info.sequenceNumber ?? '—')),
        h('td', { class: 'num', 'data-col': 'shutter' }, fmt.shutter(info.exposure.exposureTime)),
        h('td', { class: 'num' }, fmt.ev(info.exposure.exposureCompensation, 1)),
        h('td', { class: 'num' }, fmt.ev(e.exifEv)),
        h('td', { class: 'num strong', 'data-col': 'measured' }, fmt.ev(e.measuredEv)),
        h('td', { class: 'num', 'data-col': 'difference' }, fmt.ev(e.differenceEv)),
        h('td', { class: 'num' }, fmt.percent(gClip)),
      );
    });
    replace(
      this.exposurePanel,
      ...head,
      h(
        'table',
        { class: 'data', 'data-testid': 'exposure-table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', {}, 'Frame'),
            h('th', { class: 'num' }, 'Shot'),
            h('th', { class: 'num' }, 'Shutter'),
            h('th', { class: 'num' }, 'Bracket offset'),
            h('th', { class: 'num' }, 'EXIF shutter'),
            h('th', { class: 'num' }, 'Measured'),
            h('th', { class: 'num' }, 'Measured − EXIF'),
            h('th', { class: 'num' }, 'Green clipped'),
          ),
        ),
        h('tbody', {}, ...rows),
      ),
    );
  }

  private renderPairsPanel(): void {
    const head = [
      h('h2', {}, 'Adjacent pairs'),
      h('p', { class: 'lead' }, 'Brighter ÷ darker frame, from 16 × 16-pixel blocks unclipped in the brighter frame and above the noise floor in the darker one.'),
    ];
    if (!this.exposures) {
      replace(this.pairsPanel, ...head);
      return;
    }
    const rows = this.exposures.pairs.map((p) => {
      const est = p.estimate;
      return h(
        'tr',
        {},
        h('th', { scope: 'row' }, this.pairLabel(p.brightFile, p.darkFile)),
        h('td', { class: 'num' }, `${p.exifRatio.toFixed(3)}×`),
        h('td', { class: 'num strong' }, `${est.ratio.toFixed(3)}×`),
        h('td', { class: 'num' }, fmt.signedPercent(est.ratio / p.exifRatio - 1, 1)),
        h('td', { class: 'num' }, est.perChannel.map((c) => c.ev.toFixed(3)).join(' · ')),
        h('td', { class: 'num' }, `${est.spreadEv.toFixed(4)} EV`),
        h('td', { class: 'num' }, `${fmt.percent(est.inliers / est.usable, 1)} of ${fmt.integer(est.usable)}`),
      );
    });
    const names = this.exposures.pairs[0]?.estimate.perChannel.map((c) => c.name).join(' · ') ?? '';
    replace(
      this.pairsPanel,
      ...head,
      h(
        'table',
        { class: 'data', 'data-testid': 'pairs-table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', {}, 'Pair'),
            h('th', { class: 'num' }, 'EXIF'),
            h('th', { class: 'num' }, 'Measured'),
            h('th', { class: 'num' }, 'EXIF error'),
            h('th', { class: 'num' }, `Per channel, EV (${names})`),
            h('th', { class: 'num' }, 'Spread'),
            h('th', { class: 'num' }, 'Blocks kept'),
          ),
        ),
        h('tbody', {}, ...rows),
      ),
    );
  }

  private renderLinearity(): void {
    const head = [
      h('h2', {}, 'Sensor linearity'),
      h(
        'p',
        { class: 'lead' },
        'Per-block ratio against the brighter frame’s level, relative to each pair’s overall ratio. A flat line means the sensor stays linear; a drop near the top would mean highlights compress before the clip.',
      ),
    ];
    if (!this.exposures) {
      replace(this.linearityPanel, ...head);
      return;
    }
    const ref = this.slots[this.exposures.reference].info!;
    const black = ref.blackLevel[0];
    const clipLevel = (ref.whiteLevel - black) / (ref.linearLimit - black);
    const series = this.exposures.pairs.map((p) => ({
      label: this.pairLabel(p.brightFile, p.darkFile),
      points: p.estimate.linearity.map((b) => ({ x: b.level, y: (b.relative - 1) * 100, note: `${fmt.integer(b.blocks)} blocks` })),
    }));
    const span = Math.max(0.5, ...series.flatMap((sr) => sr.points.map((p) => Math.abs(p.y)))) * 1.2;
    const step = span > 2 ? 1 : span > 1 ? 0.5 : 0.25;
    const yMax = Math.ceil(span / step) * step;
    const yTicks: number[] = [];
    for (let v = -yMax; v <= yMax + 1e-9; v += step) yTicks.push(Number(v.toFixed(4)));
    const xMax = Math.max(1.1, clipLevel + 0.02);
    replace(
      this.linearityPanel,
      ...head,
      lineChart(series, {
        width: Math.max(320, this.linearityPanel.clientWidth - 36),
        x: { min: 0, max: xMax, ticks: [0, 0.25, 0.5, 0.75, 1], format: (v) => `${Math.round(v * 100)}%` },
        y: { min: -yMax, max: yMax, ticks: yTicks, format: (v) => (v === 0 ? '0' : `${fmt.signed(v, 2)}%`), reference: 0 },
        markers: [
          { x: 1, label: `SR2 white ${ref.linearLimit}` },
          { x: clipLevel, label: `clip ${ref.whiteLevel}` },
        ],
        label: 'Exposure ratio deviation against brightness for each adjacent pair',
        readoutTitle: (x) => `Brighter frame at ${Math.round(x * 100)}% of the SR2 white level`,
        readoutValue: (y) => `${fmt.signed(y, 2)}%`,
      }),
    );
  }

  private pairLabel(brightFile: number, darkFile: number): string {
    return `${stem(this.slots[brightFile].fileName)} ÷ ${stem(this.slots[darkFile].fileName)}`;
  }

  private renderNoise(): void {
    const head = [h('h2', {}, 'Noise model')];
    const noise = this.noise;
    const exposures = this.exposures;
    if (!noise || !exposures) {
      head.push(h('p', { class: 'lead' }, this.noiseError ? `The noise model could not be fitted: ${this.noiseError}` : 'Fitting once the exposure ratios are known…'));
      replace(this.noisePanel, ...head);
      return;
    }
    const ref = this.slots[exposures.reference].info!;
    const range = ref.whiteLevel - ref.blackLevel[0];
    const offsets = noise.pairs.flatMap((p) => p.blackOffset);
    const worstOffset = Math.max(...offsets.map(Math.abs));
    head.push(
      h(
        'p',
        { class: 'lead' },
        `Fitted from adjacent-frame differences on flat pixels, where the scene and the pixel-response pattern cancel. Var(v) = α(t)·s + β per channel; the shot-noise slope α rises ${fmt.percent(noise.timeSlope, 1)} per doubling of shutter time. Black level checks out within ${worstOffset.toFixed(2)} DN of the file’s ${ref.blackLevel[0]}.`,
      ),
    );
    const rows = noise.channels.map((c, p) => {
      const gain = 1 / c.alpha;
      const read = Math.sqrt(c.beta);
      const colour = 'rgb'[ref.cfaPattern.colors[p]];
      return h(
        'tr',
        {},
        h('th', { scope: 'row' }, h('span', { class: `key key-${colour}` }), c.name),
        h('td', { class: 'num' }, gain.toFixed(2)),
        h('td', { class: 'num' }, read.toFixed(2)),
        h('td', { class: 'num' }, (read * gain).toFixed(1)),
        h('td', { class: 'num' }, fmt.integer(range * gain)),
        h('td', { class: 'num strong' }, Math.log2(range / read).toFixed(1)),
      );
    });
    const table = h(
      'table',
      { class: 'data', 'data-testid': 'noise-table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', {}, 'Channel'),
          h('th', { class: 'num' }, `Gain at ${fmt.shutter(noise.referenceTime)} (e⁻/DN)`),
          h('th', { class: 'num' }, 'Read noise (DN)'),
          h('th', { class: 'num' }, 'Read noise (e⁻)'),
          h('th', { class: 'num' }, 'Full well (e⁻)'),
          h('th', { class: 'num' }, 'Dynamic range (stops)'),
        ),
      ),
      h('tbody', {}, ...rows),
    );

    // Residual check: measured ÷ predicted variance per signal bin, averaged over the CFA positions.
    // noise.pairs follows exposures.pairs, which carries the file indices.
    const series = noise.pairs.map((p, k) => {
      const byBin = new Map<number, { sum: number; n: number; samples: number }>();
      for (const bins of p.bins) {
        for (const b of bins) {
          const key = Math.round(Math.log2(b.signal) * 3);
          const e = byBin.get(key) ?? { sum: 0, n: 0, samples: 0 };
          e.sum += b.measured / b.predicted;
          e.n++;
          e.samples += b.samples;
          byBin.set(key, e);
        }
      }
      return {
        label: this.pairLabel(exposures.pairs[k].brightFile, exposures.pairs[k].darkFile),
        points: [...byBin.entries()].sort(([a], [b]) => a - b).map(([key, e]) => ({ x: 2 ** (key / 3), y: e.sum / e.n, note: `${fmt.integer(e.samples)} px` })),
      };
    });
    const chart = lineChart(series, {
      width: Math.max(320, this.noisePanel.clientWidth - 36),
      height: 220,
      x: { min: 4, max: 16384, log: true, ticks: [4, 16, 64, 256, 1024, 4096, 16384], format: (v) => (v >= 1024 ? `${v / 1024}k` : String(v)) },
      y: { min: 0.6, max: 1.4, ticks: [0.6, 0.8, 1, 1.2, 1.4], format: (v) => `×${v.toFixed(1)}`, reference: 1 },
      label: 'Measured over predicted residual variance against signal, per adjacent pair',
      readoutTitle: (x) => `Signal ≈ ${fmt.integer(x)} DN above black`,
      readoutValue: (y) => `×${y.toFixed(2)}`,
    });
    replace(this.noisePanel, ...head, table, h('h3', { class: 'panel-h3' }, 'Residual check', h('span', { class: 'h3-note' }, 'measured ÷ predicted variance of each pair’s difference; 1 means the model is right')), chart);
  }

  private renderMetadata(): void {
    const loaded = this.displayOrder().map((i) => this.slots[i]).filter((s) => s.info);
    const head = [h('h2', {}, 'Raw metadata'), h('p', { class: 'lead' }, 'What the reader found in each file. Levels and white balance list where they were read from.')];
    if (!loaded.length) {
      replace(this.metadataPanel, ...head);
      return;
    }
    const rows: Array<[string, (i: FrameInfo, s: Slot) => string]> = [
      ['File size', (i) => fmt.megabytes(i.fileSize)],
      ['Camera', (i) => `${i.make} ${i.model}`],
      ['Firmware', (i) => i.software],
      ['Raw type', (i) => `${i.rawFileType} (compression ${i.compression})`],
      ['Stored size', (i) => `${i.width} × ${i.height}`],
      ['Active area', (i) => `${i.crop.width} × ${i.crop.height} at (${i.crop.left}, ${i.crop.top})`],
      ['CFA', (i) => i.cfaPattern.name],
      ['Bit depth', (i) => `${i.bitsPerSample}-bit`],
      ['Black level', (i) => `${i.blackLevel.join(' / ')} · ${i.sources.blackLevel}`],
      ['White level', (i) => `${i.whiteLevel} · ${i.sources.whiteLevel}`],
      ['SR2 white', (i) => i.sr2WhiteLevel?.join(' / ') ?? '—'],
      ['As-shot WB (RGGB)', (i) => (i.asShotWb ? `${i.asShotWb.join(' / ')} · ${i.sources.asShotWb}` : '—')],
      ['SR2 block', (i) => (i.sr2 ? `${fmt.integer(i.sr2.length)} B at ${fmt.integer(i.sr2.offset)} · key ${fmt.hex32(i.sr2.key)} · ${i.sr2.entryCount} entries` : 'not found')],
      ['Shutter (stored)', (i) => `${i.exposure.exposureTimeRational[0]}/${i.exposure.exposureTimeRational[1]} s`],
      ['Aperture', (i) => `f/${i.exposure.fNumber}`],
      ['ISO', (i) => String(i.exposure.iso)],
      ['Bracket offset', (i) => fmt.ev(i.exposure.exposureCompensation, 1)],
      ['Shot in sequence', (i) => String(i.sequenceNumber ?? '—')],
      ['Release mode', (i) => i.releaseMode ?? '—'],
      ['Captured', (i) => `${i.exposure.dateTimeOriginal}.${i.exposure.subSecTimeOriginal}`],
      ['Lens', (i) => `${i.exposure.lensModel} at ${i.exposure.focalLength} mm`],
      ['Decode + stats', (_i, s) => (s.ms ? `${Math.round(s.ms)} ms` : '—')],
    ];
    replace(
      this.metadataPanel,
      ...head,
      h(
        'div',
        { class: 'table-scroll' },
        h(
          'table',
          { class: 'data meta', 'data-testid': 'metadata-table' },
          h('thead', {}, h('tr', {}, h('th', {}, ''), ...loaded.map((s) => h('th', {}, stem(s.fileName))))),
          h('tbody', {}, ...rows.map(([label, get]) => h('tr', { 'data-row': label }, h('th', { scope: 'row' }, label), ...loaded.map((s) => h('td', {}, get(s.info!, s)))))),
        ),
      ),
    );
  }
}

function lensNote(l: LensInfo): string {
  if (!l.available) return 'no correction data in the file';
  return `vignetting ${l.vignetting.toFixed(1)} EV · distortion ${l.distortion.toFixed(1)}% · CA ${l.ca.toFixed(1)} px`;
}

function uprightNote(u: UprightInfo): string {
  if (!u.available) return u.lines ? `already level · ${u.lines} vertical lines` : 'not enough vertical lines';
  return `camera tilted ${fmt.signed(u.pitch, 1)}°, roll ${fmt.signed(u.roll, 1)}° · keeps ${Math.round(u.keep * 100)}%`;
}

function leadText(exposures: Exposures | null, error: string): string {
  if (error) return `Exposure ratios could not be measured: ${error}`;
  if (!exposures) return 'Measuring exposure ratios once every frame is decoded…';
  const worst = Math.max(...[...exposures.byFile.values()].map((e) => Math.abs(e.differenceEv)));
  return `Sorted by measured exposure, relative to the base frame. EXIF shutter times are off by up to ${worst.toFixed(2)} EV; the merge uses the measured values.`;
}

function toExposures(indices: number[], analysis: ExposureAnalysis, ms: number): Exposures {
  return {
    byFile: new Map(analysis.frames.map((f, k) => [indices[k], f])),
    order: analysis.order.map((k) => indices[k]),
    reference: indices[analysis.reference],
    pairs: analysis.pairs.map((p) => ({ ...p, brightFile: indices[p.bright], darkFile: indices[p.dark] })),
    files: indices,
    ms,
  };
}

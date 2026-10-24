// Bracket inspector UI: open a set of ARW files, decode them in a worker, and
// show per-frame statistics next to the measured exposure ratios.

import type { ExposureAnalysis, FrameExposure, PairRatio } from '../analysis/exposure.ts';
import type { PreviewData } from '../analysis/preview.ts';
import type { FrameStats } from '../analysis/stats.ts';
import type { FrameInfo, WorkerEvent, WorkerRequest } from '../worker/protocol.ts';
import { h, replace } from './dom.ts';
import * as fmt from './format.ts';
import { evHistogram, histogramChart, type EvHistogram } from './histogram.ts';
import { linearityChart } from './linearity.ts';
import { autoGain, renderPreview } from './render-preview.ts';

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
  ms: number;
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
  private selected = -1;
  private matched = false;
  private showClipping = true;
  private evOffset = 0;
  private startedAt = 0;
  private totalMs = 0;
  private gainCache: { file: number; value: number } | null = null;

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
  private readonly filmstrip = h('div', { class: 'filmstrip', role: 'listbox', 'aria-label': 'Frames by measured exposure', 'data-testid': 'filmstrip' });
  private readonly exposurePanel = h('section', { class: 'panel', 'data-testid': 'exposure-panel' });
  private readonly pairsPanel = h('section', { class: 'panel', 'data-testid': 'pairs-panel' });
  private readonly linearityPanel = h('section', { class: 'panel', 'data-testid': 'linearity-panel' });
  private readonly metadataPanel = h('section', { class: 'panel', 'data-testid': 'metadata-panel' });

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
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => this.renderCharts(), 120);
    });
  }

  // ---- loading -------------------------------------------------------------

  private open(files: File[]): void {
    const arw = files.filter((f) => /\.arw$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
    if (!arw.length) {
      this.renderStatus('No .ARW files in that selection');
      return;
    }
    this.worker?.terminate();
    this.worker = new Worker(new URL('../worker/pipeline.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerEvent>) => this.onWorkerEvent(e.data);
    this.worker.onerror = (e) => this.renderStatus(`Worker failed: ${e.message}`);
    this.slots = arw.map((f, index) => ({ index, fileName: f.name }));
    this.exposures = null;
    this.exposureError = '';
    this.selected = -1;
    this.matched = false;
    this.gainCache = null;
    this.startedAt = performance.now();
    this.empty.hidden = true;
    this.workspace.hidden = false;
    this.renderStatus(`Reading ${arw.length} file${arw.length > 1 ? 's' : ''}…`, 0);
    const request: WorkerRequest = { type: 'open', files: arw };
    this.worker.postMessage(request);
    this.renderAll();
  }

  private onWorkerEvent(ev: WorkerEvent): void {
    switch (ev.type) {
      case 'progress': {
        const verb = { reading: 'Reading', decoding: 'Decoding', measuring: 'Measuring exposure ratios' }[ev.stage];
        const label = ev.stage === 'measuring' ? `${verb}…` : `${verb} ${ev.fileName} · ${ev.index + 1} of ${ev.total}`;
        this.renderStatus(label, (ev.index + (ev.stage === 'decoding' ? 0.5 : 0)) / (ev.total + 1));
        break;
      }
      case 'frame': {
        const slot = this.slots[ev.index];
        Object.assign(slot, { info: ev.info, stats: ev.stats, preview: ev.preview, ms: ev.ms, hist: evHistogram(ev.stats, ev.info) });
        if (this.selected < 0) this.selected = ev.index;
        this.renderAll();
        break;
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
        break;
      case 'exposures-error':
        this.exposureError = ev.message;
        this.renderAll();
        break;
      case 'done': {
        this.totalMs = performance.now() - this.startedAt;
        const ok = this.slots.filter((s) => s.info).length;
        const failed = this.slots.length - ok;
        this.renderStatus(`${ok} frame${ok === 1 ? '' : 's'} decoded in ${(this.totalMs / 1000).toFixed(1)} s${failed ? ` · ${failed} failed` : ''}`);
        this.renderSummary();
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
      h('div', { class: 'brand' }, logo, h('div', {}, h('h1', {}, 'HDR Merger'), h('p', {}, 'Bracket inspector · Sony A7C II ARW'))),
      h('div', { class: 'status-wrap' }, this.status, h('div', { class: 'progress' }, this.progressBar)),
      h('label', { class: 'button primary', for: 'file-input' }, 'Open ARW files'),
      this.input,
    );
    const viewer = h('div', { class: 'viewer-panel' }, this.toolbar, h('div', { class: 'viewer' }, this.canvas), this.viewerCaption);
    replace(
      this.workspace,
      this.summary,
      h('div', { class: 'stage' }, h('div', { class: 'stage-main' }, viewer, this.filmstrip), this.inspector),
      this.exposurePanel,
      this.pairsPanel,
      this.linearityPanel,
      this.metadataPanel,
    );
    replace(this.root, header, h('main', {}, this.empty, this.workspace));
  }

  private renderEmpty(): void {
    replace(
      this.empty,
      h(
        'label',
        { class: 'dropzone', for: 'file-input' },
        h('span', { class: 'drop-icon', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
        h('strong', {}, 'Drop a bracket set here'),
        h('span', {}, 'or click to choose the ARW files of one bracket'),
        h('span', { class: 'hint' }, 'Sony A7C II · RAW file type Uncompressed · tripod · decoded locally in your browser'),
      ),
    );
  }

  private renderStatus(text: string, progress?: number): void {
    this.status.textContent = text;
    const bar = this.progressBar.parentElement as HTMLElement;
    bar.hidden = progress === undefined;
    if (progress !== undefined) this.progressBar.style.width = `${Math.round(progress * 100)}%`;
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
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const order = this.displayOrder().filter((i) => this.slots[i].preview);
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
      }
    });
  }

  private select(index: number): void {
    this.selected = index;
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

  private renderAll(): void {
    this.renderSummary();
    this.renderToolbar();
    this.renderInspector();
    this.renderFilmstrip();
    this.renderImages();
    this.renderExposurePanel();
    this.renderPairsPanel();
    this.renderLinearity();
    this.renderMetadata();
  }

  private renderCharts(): void {
    this.renderLinearity();
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
    replace(this.summary, ...chips.map(([label, value]) => h('span', { class: 'chip' }, h('span', { class: 'chip-label' }, label), h('span', { class: 'chip-value' }, value))));
  }

  private renderToolbar(): void {
    const segment = (label: string, active: boolean, disabled: boolean, onClick: () => void, testId: string): HTMLButtonElement =>
      h('button', { type: 'button', 'aria-pressed': String(active), disabled, onclick: onClick, 'data-testid': testId }, label);
    const setMatched = (value: boolean) => () => {
      this.matched = value;
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
    const clipToggle = h('input', { type: 'checkbox', checked: this.showClipping, 'data-testid': 'clip-toggle' });
    clipToggle.addEventListener('change', () => {
      this.showClipping = clipToggle.checked;
      this.renderToolbar();
      this.renderImages();
    });
    replace(
      this.toolbar,
      h(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': 'Preview brightness' },
        segment('As shot', !this.matched, false, setMatched(false), 'mode-as-shot'),
        segment('Matched', this.matched, !this.exposures, setMatched(true), 'mode-matched'),
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
      h('label', { class: 'slider' }, h('span', {}, 'Exposure'), slider, sliderValue),
      h('span', { class: 'kbd-hint' }, h('kbd', {}, '←'), h('kbd', {}, '→'), ' frames  ', h('kbd', {}, 'M'), ' match  ', h('kbd', {}, 'C'), ' clipping'),
    );
  }

  private referenceSlot(): Slot | undefined {
    if (this.exposures) return this.slots[this.exposures.reference];
    return this.slots.find((s) => s.info?.exposure.exposureCompensation === 0) ?? this.slots.find((s) => s.preview);
  }

  private gainFor(slot: Slot): number {
    const ref = this.referenceSlot();
    if (!ref?.preview || !ref.info) return 1;
    if (this.gainCache?.file !== ref.index) this.gainCache = { file: ref.index, value: autoGain(ref.preview, wbGains(ref.info)) };
    let gain = this.gainCache.value * 2 ** this.evOffset;
    if (this.matched && this.exposures) {
      const ev = this.exposures.byFile.get(slot.index)?.measuredEv;
      if (ev !== undefined) gain *= 2 ** -ev;
    }
    return gain;
  }

  private paint(canvas: HTMLCanvasElement, slot: Slot): void {
    const p = slot.preview;
    if (!p || !slot.info) return;
    if (canvas.width !== p.width || canvas.height !== p.height) {
      canvas.width = p.width;
      canvas.height = p.height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const image = ctx.createImageData(p.width, p.height);
    renderPreview(p, { gain: this.gainFor(slot), wb: wbGains(slot.info), showClipping: this.showClipping }, image);
    ctx.putImageData(image, 0, 0);
  }

  private renderImages(): void {
    const slot = this.slots[this.selected];
    if (slot?.preview) {
      this.paint(this.canvas, slot);
      this.canvas.setAttribute('aria-label', `Preview of ${slot.fileName}`);
      this.canvas.dataset.file = slot.fileName;
      const e = this.exposures?.byFile.get(slot.index);
      const mode = this.matched ? `matched to the base frame (×2^${fmt.signed(-(e?.measuredEv ?? 0))})` : 'as shot, relative to the base frame';
      replace(
        this.viewerCaption,
        h('strong', {}, slot.fileName),
        ` · ${mode} · camera RGB with as-shot WB, quarter-resolution bin of the CFA (no demosaic yet)`,
      );
    }
    for (const thumb of this.filmstrip.querySelectorAll<HTMLCanvasElement>('canvas[data-index]')) {
      const s = this.slots[Number(thumb.dataset.index)];
      if (s) this.paint(thumb, s);
    }
  }

  private renderFilmstrip(): void {
    const cards = this.displayOrder().map((i) => {
      const slot = this.slots[i];
      const e = this.exposures?.byFile.get(i);
      const isRef = this.exposures?.reference === i;
      if (slot.error) {
        return h(
          'div',
          { class: 'thumb error', role: 'option', 'aria-selected': 'false', 'data-testid': 'thumb' },
          h('div', { class: 'thumb-error' }, h('strong', {}, 'Could not read this file'), h('span', {}, slot.error)),
          h('div', { class: 'thumb-name' }, slot.fileName),
        );
      }
      if (!slot.info || !slot.hist) {
        return h('div', { class: 'thumb pending', role: 'option', 'aria-selected': 'false', 'data-testid': 'thumb' }, h('div', { class: 'thumb-placeholder' }), h('div', { class: 'thumb-name' }, slot.fileName));
      }
      const canvas = h('canvas', { 'data-index': i, 'aria-hidden': 'true' });
      const card = h(
        'button',
        {
          type: 'button',
          class: 'thumb',
          role: 'option',
          'aria-selected': String(i === this.selected),
          'data-testid': 'thumb',
          'data-file': slot.fileName,
          onclick: () => this.select(i),
        },
        canvas,
        h('div', { class: 'thumb-row' }, h('span', { class: 'thumb-name' }, stem(slot.fileName)), isRef ? h('span', { class: 'badge' }, 'Base') : null),
        h(
          'div',
          { class: 'thumb-row secondary' },
          h('span', {}, fmt.shutter(slot.info.exposure.exposureTime)),
          h('span', { class: 'thumb-ev' }, e ? fmt.ev(e.measuredEv) : `${fmt.signed(slot.info.exposure.exposureCompensation, 1)} EV offset`),
        ),
        histogramChart(slot.hist, { width: 164, rowHeight: 11, compact: true }),
      );
      return card;
    });
    replace(this.filmstrip, ...cards);
  }

  private renderInspector(): void {
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
    const total = this.slots.length;
    const kpi = (label: string, value: string, testId: string, note?: string): HTMLElement =>
      h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, label), h('span', { class: 'kpi-value', 'data-testid': testId }, value), note ? h('span', { class: 'kpi-note' }, note) : null);

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
      h(
        'div',
        { class: 'inspector-head' },
        h('h2', { 'data-testid': 'inspector-title' }, info.fileName),
        this.exposures?.reference === slot.index ? h('span', { class: 'badge' }, 'Base exposure') : null,
      ),
      h(
        'p',
        { class: 'meta-line' },
        `Shot ${info.sequenceNumber ?? '?'} of ${total} · ${fmt.shutter(ex.exposureTime)} · f/${ex.fNumber} · ISO ${ex.iso} · ${ex.focalLength} mm`,
      ),
      h(
        'div',
        { class: 'kpis' },
        kpi('Measured', e ? fmt.ev(e.measuredEv) : '…', 'kpi-measured', 'from pixels'),
        kpi('EXIF shutter', e ? fmt.ev(e.exifEv) : '…', 'kpi-exif', 'from tags'),
        kpi('Difference', e ? fmt.ev(e.differenceEv) : '…', 'kpi-diff', 'measured − EXIF'),
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
        h('th', { scope: 'row' }, `${stem(this.slots[p.brightFile].fileName)} ÷ ${stem(this.slots[p.darkFile].fileName)}`),
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
    const markers = [
      { level: 1, label: `SR2 white ${ref.linearLimit}` },
      { level: (ref.whiteLevel - black) / (ref.linearLimit - black), label: `clip ${ref.whiteLevel}` },
    ];
    const series = this.exposures.pairs.map((p) => ({ label: `${stem(this.slots[p.brightFile].fileName)} ÷ ${stem(this.slots[p.darkFile].fileName)}`, bins: p.estimate.linearity }));
    const width = Math.max(320, this.linearityPanel.clientWidth - 36);
    replace(this.linearityPanel, ...head, linearityChart(series, markers, width));
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
      ['SR2 block', (i) => (i.sr2 ? `${fmt.integer(i.sr2.length)} B at ${fmt.integer(i.sr2.offset)} · key ${fmt.hex32(i.sr2.key)} · ${i.sr2.tagCount} tags` : 'not found')],
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
    ms,
  };
}

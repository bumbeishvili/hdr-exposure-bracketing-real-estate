// Raw histograms on an EV axis (stops below the white level), one row per colour.
// Rows instead of overlaid curves: red and green are hard to tell apart under
// colour-vision deficiency, and overlaid channels hide each other.

import type { FrameStats } from '../analysis/stats.ts';
import type { FrameInfo } from '../worker/protocol.ts';
import { h, s } from './dom.ts';
import { percent, signed } from './format.ts';

export interface EvHistogramRow {
  name: 'R' | 'G' | 'B';
  /** Fraction of the row's samples in each bin. */
  fractions: Float64Array;
  /** Fraction of samples at or above the white level. */
  clipped: number;
  /** Fraction at or below black, or below the first bin. */
  floor: number;
}

export interface EvHistogram {
  /** Left edge of the first bin, in EV below the white level (negative). */
  minEv: number;
  binEv: number;
  bins: number;
  rows: EvHistogramRow[];
}

export function evHistogram(stats: FrameStats, info: FrameInfo, minEv = -14, binEv = 0.125): EvHistogram {
  const bins = Math.round(-minEv / binEv);
  const rows: EvHistogramRow[] = (['R', 'G', 'B'] as const).map((name) => ({ name, fractions: new Float64Array(bins), clipped: 0, floor: 0 }));
  const totals = [0, 0, 0];
  for (const ch of stats.channels) {
    const row = rows[ch.color];
    const black = info.blackLevel[ch.position];
    const range = info.whiteLevel - black;
    const hist = ch.histogram;
    for (let v = 0; v < hist.length; v++) {
      const n = hist[v];
      if (!n) continue;
      totals[ch.color] += n;
      if (v >= info.whiteLevel) {
        row.clipped += n;
        continue;
      }
      const bin = v > black ? Math.floor((Math.log2((v - black) / range) - minEv) / binEv) : -1;
      if (bin < 0) row.floor += n;
      else row.fractions[Math.min(bin, bins - 1)] += n;
    }
  }
  rows.forEach((row, c) => {
    const total = totals[c] || 1;
    for (let i = 0; i < bins; i++) row.fractions[i] /= total;
    row.clipped /= total;
    row.floor /= total;
  });
  return { minEv, binEv, bins, rows };
}

const ROW_COLOR = { R: 'var(--ch-r)', G: 'var(--ch-g)', B: 'var(--ch-b)' };

export interface HistogramOptions {
  width: number;
  rowHeight?: number;
  /** Thumbnail mode: no axis labels, clip column or hover. */
  compact?: boolean;
  label?: string;
}

export function histogramChart(hist: EvHistogram, opts: HistogramOptions): HTMLElement {
  const compact = opts.compact ?? false;
  const rowH = opts.rowHeight ?? 30;
  const gap = compact ? 3 : 8;
  const labelW = compact ? 0 : 18;
  const clipW = compact ? 0 : 64;
  const axisH = compact ? 0 : 20;
  const plotW = opts.width - labelW - clipW;
  const plotH = hist.rows.length * (rowH + gap) - gap;
  const height = plotH + axisH;
  const x = (e: number): number => labelW + ((e - hist.minEv) / -hist.minEv) * plotW;

  const svg = s('svg', {
    class: 'chart',
    width: opts.width,
    height,
    viewBox: `0 0 ${opts.width} ${height}`,
    role: 'img',
    'aria-label': opts.label ?? 'Raw histogram per channel, in EV below the white level',
  });

  for (let e = hist.minEv; e <= 0; e += 2) svg.append(s('line', { class: 'grid', x1: x(e), x2: x(e), y1: 0, y2: plotH }));

  hist.rows.forEach((row, r) => {
    const top = r * (rowH + gap);
    const base = top + rowH;
    let max = 0;
    for (const f of row.fractions) max = Math.max(max, f);
    const scale = max > 0 ? (rowH - 2) / max : 0;
    let line = '';
    for (let i = 0; i < hist.bins; i++) {
      const cx = x(hist.minEv + (i + 0.5) * hist.binEv);
      line += `${i ? 'L' : 'M'}${cx.toFixed(1)} ${(base - row.fractions[i] * scale).toFixed(1)}`;
    }
    const first = x(hist.minEv + 0.5 * hist.binEv).toFixed(1);
    const last = x(hist.minEv + (hist.bins - 0.5) * hist.binEv).toFixed(1);
    svg.append(
      s('path', { d: `${line}L${last} ${base}L${first} ${base}Z`, fill: ROW_COLOR[row.name], 'fill-opacity': 0.14 }),
      s('path', { d: line, class: 'series-line', stroke: ROW_COLOR[row.name] }),
      s('line', { class: 'axis', x1: labelW, x2: labelW + plotW, y1: base, y2: base }),
    );
    if (!compact) {
      svg.append(s('text', { class: 'tick-label', x: 0, y: top + rowH / 2 + 4 }, row.name));
      const clipText = row.clipped > 0 ? percent(row.clipped) : '0%';
      const tx = labelW + plotW + 10;
      if (row.clipped > 0) svg.append(s('circle', { cx: tx + 3, cy: top + rowH / 2, r: 3, fill: 'var(--critical)' }));
      svg.append(s('text', { class: 'value-label', x: tx + 10, y: top + rowH / 2 + 4 }, clipText));
    }
  });

  if (compact) return h('div', { class: 'histogram compact' }, svg);

  for (let e = 0; e >= hist.minEv; e -= 4) {
    svg.append(s('text', { class: 'tick-label', x: x(e), y: plotH + 15, 'text-anchor': e === 0 ? 'end' : 'middle' }, e === 0 ? '0 EV' : signed(e, 0)));
  }
  svg.append(s('text', { class: 'tick-label', x: labelW + plotW + 20, y: plotH + 15 }, 'clipped'));

  const root = h('div', { class: 'histogram' }, svg);
  attachCrosshair(root, svg, hist, { x, labelW, plotW, plotH });
  return root;
}

function attachCrosshair(root: HTMLElement, svg: SVGSVGElement, hist: EvHistogram, g: { x: (e: number) => number; labelW: number; plotW: number; plotH: number }): void {
  const hair = s('line', { class: 'crosshair', x1: 0, x2: 0, y1: 0, y2: g.plotH, visibility: 'hidden' });
  const hit = s('rect', { x: g.labelW, y: 0, width: g.plotW, height: g.plotH, fill: 'transparent' });
  svg.append(hair, hit);
  svg.setAttribute('tabindex', '0');
  const tip = h('div', { class: 'tooltip', role: 'status' });
  tip.hidden = true;
  root.append(tip);
  let bin = -1;

  const show = (b: number): void => {
    bin = Math.max(0, Math.min(hist.bins - 1, b));
    const lo = hist.minEv + bin * hist.binEv;
    const cx = g.x(lo + hist.binEv / 2);
    hair.setAttribute('x1', String(cx));
    hair.setAttribute('x2', String(cx));
    hair.setAttribute('visibility', 'visible');
    tip.replaceChildren(
      h('div', { class: 'tooltip-title' }, `${signed(lo, 2)} to ${signed(lo + hist.binEv, 2)} EV`),
      ...hist.rows.map((row) =>
        h('div', { class: 'tooltip-row' }, h('span', { class: `key key-${row.name.toLowerCase()}` }), h('strong', {}, percent(row.fractions[bin], 2)), h('span', {}, row.name)),
      ),
    );
    tip.hidden = false;
    const left = Math.min(Math.max(cx + 12, 0), g.labelW + g.plotW - 120);
    tip.style.left = `${cx + 132 > g.labelW + g.plotW ? cx - 132 : left}px`;
    tip.style.top = '0px';
  };
  const hide = (): void => {
    hair.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };

  hit.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * svg.viewBox.baseVal.width;
    show(Math.floor(((px - g.labelW) / g.plotW) * hist.bins));
  });
  hit.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(bin < 0 ? hist.bins - 8 : bin));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      show(bin + (e.key === 'ArrowLeft' ? -1 : 1));
    }
  });
}

// Small multi-series line chart with a snapping crosshair readout (hover and
// keyboard). Used for the linearity and noise-residual checks.

import { h, s } from './dom.ts';

export interface LinePoint {
  x: number;
  y: number;
  /** Extra text for the readout, e.g. a sample count. */
  note?: string;
}

export interface LineSeries {
  label: string;
  points: LinePoint[];
}

export interface Axis {
  min: number;
  max: number;
  ticks: number[];
  format: (v: number) => string;
  log?: boolean;
}

export interface LineChartOptions {
  width: number;
  height?: number;
  x: Axis;
  y: Axis & { reference?: number };
  markers?: Array<{ x: number; label: string }>;
  label: string;
  readoutTitle: (x: number) => string;
  readoutValue: (y: number) => string;
}

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];

export function lineChart(series: LineSeries[], o: LineChartOptions): HTMLElement {
  const width = o.width;
  const height = o.height ?? 240;
  const m = { left: 52, right: 16, top: 12, bottom: 30 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const tx = (v: number): number => (o.x.log ? Math.log(v) : v);
  const x = (v: number): number => m.left + ((tx(v) - tx(o.x.min)) / (tx(o.x.max) - tx(o.x.min))) * plotW;
  const yClamp = (v: number): number => Math.min(o.y.max, Math.max(o.y.min, v));
  const y = (v: number): number => m.top + plotH - ((yClamp(v) - o.y.min) / (o.y.max - o.y.min)) * plotH;
  const color = (i: number): string => SERIES[i % SERIES.length];

  const svg = s('svg', { class: 'chart', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', tabindex: 0, 'aria-label': o.label });
  for (const t of o.y.ticks) {
    const isRef = o.y.reference !== undefined && Math.abs(t - o.y.reference) < 1e-9;
    svg.append(
      s('line', { class: isRef ? 'axis' : 'grid', x1: m.left, x2: m.left + plotW, y1: y(t), y2: y(t) }),
      s('text', { class: 'tick-label', x: m.left - 8, y: y(t) + 4, 'text-anchor': 'end' }, o.y.format(t)),
    );
  }
  for (const t of o.x.ticks) svg.append(s('text', { class: 'tick-label', x: x(t), y: height - 10, 'text-anchor': 'middle' }, o.x.format(t)));
  for (const mk of o.markers ?? []) {
    svg.append(
      s('line', { class: 'marker', x1: x(mk.x), x2: x(mk.x), y1: m.top, y2: m.top + plotH }),
      s('text', { class: 'tick-label', x: x(mk.x) - 4, y: m.top + 10, 'text-anchor': 'end' }, mk.label),
    );
  }
  series.forEach((sr, i) => {
    const d = sr.points.map((p, j) => `${j ? 'L' : 'M'}${x(p.x).toFixed(1)} ${y(p.y).toFixed(1)}`).join('');
    svg.append(s('path', { d, class: 'series-line', stroke: color(i) }));
  });

  const legend = h(
    'div',
    { class: 'legend' },
    ...series.map((sr, i) => h('span', { class: 'legend-item' }, h('span', { class: 'line-key', style: `background:${color(i)}` }), sr.label)),
  );
  const wrap = h('div', { class: 'chart-wrap' }, svg);
  const root = h('div', { class: 'line-chart' }, legend, wrap);

  const xs = [...new Set(series.flatMap((sr) => sr.points.map((p) => p.x)))].sort((a, b) => a - b);
  const hair = s('line', { class: 'crosshair', x1: 0, x2: 0, y1: m.top, y2: m.top + plotH, visibility: 'hidden' });
  const hit = s('rect', { x: m.left, y: m.top, width: plotW, height: plotH, fill: 'transparent' });
  svg.append(hair, hit);
  const tip = h('div', { class: 'tooltip', role: 'status' });
  tip.hidden = true;
  wrap.append(tip);
  let current = -1;

  const show = (k: number): void => {
    if (!xs.length) return;
    current = Math.max(0, Math.min(xs.length - 1, k));
    const at = xs[current];
    const cx = x(at);
    hair.setAttribute('x1', String(cx));
    hair.setAttribute('x2', String(cx));
    hair.setAttribute('visibility', 'visible');
    tip.replaceChildren(
      h('div', { class: 'tooltip-title' }, o.readoutTitle(at)),
      ...series.map((sr, i) => {
        const p = nearestPoint(sr.points, at, tx);
        return h(
          'div',
          { class: 'tooltip-row' },
          h('span', { class: 'line-key', style: `background:${color(i)}` }),
          h('strong', {}, p ? o.readoutValue(p.y) : '—'),
          h('span', {}, p?.note ? `${sr.label} · ${p.note}` : sr.label),
        );
      }),
    );
    tip.hidden = false;
    tip.style.left = `${cx > width - 280 ? cx - 272 : cx + 12}px`;
    tip.style.top = `${m.top}px`;
  };
  const hide = (): void => {
    hair.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  hit.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const v = tx(o.x.min) + ((px - m.left) / plotW) * (tx(o.x.max) - tx(o.x.min));
    let best = 0;
    for (let k = 1; k < xs.length; k++) if (Math.abs(tx(xs[k]) - v) < Math.abs(tx(xs[best]) - v)) best = k;
    show(best);
  });
  hit.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(current < 0 ? xs.length - 1 : current));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      show(current + (e.key === 'ArrowLeft' ? -1 : 1));
    }
  });
  return root;
}

/** The series point at `at`, if the series has one within a small tolerance. */
function nearestPoint(points: LinePoint[], at: number, tx: (v: number) => number): LinePoint | undefined {
  let best: LinePoint | undefined;
  for (const p of points) if (!best || Math.abs(tx(p.x) - tx(at)) < Math.abs(tx(best.x) - tx(at))) best = p;
  return best && Math.abs(tx(best.x) - tx(at)) < 0.02 ? best : undefined;
}

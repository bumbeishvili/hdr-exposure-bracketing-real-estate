// Ratio-versus-brightness chart: for each adjacent pair, how far the per-block
// exposure ratio drifts from the overall ratio as the brighter frame nears clipping.

import type { LinearityBin } from '../analysis/exposure.ts';
import { h, s } from './dom.ts';
import { integer, signed } from './format.ts';

export interface LinearitySeries {
  label: string;
  bins: LinearityBin[];
}

export interface LevelMarker {
  /** Fraction of the linear range. */
  level: number;
  label: string;
}

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];

export function linearityChart(series: LinearitySeries[], markers: LevelMarker[], width: number, height = 240): HTMLElement {
  const m = { left: 52, right: 16, top: 12, bottom: 30 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const all = series.flatMap((sr) => sr.bins);
  const maxLevel = Math.max(1.1, ...all.map((b) => b.level), ...markers.map((mk) => mk.level));
  const dev = all.map((b) => (b.relative - 1) * 100);
  const span = Math.max(0.5, ...dev.map(Math.abs)) * 1.2;
  const step = span > 2 ? 1 : span > 1 ? 0.5 : span > 0.5 ? 0.25 : 0.1;
  const yMax = Math.ceil(span / step) * step;
  const x = (level: number): number => m.left + (level / maxLevel) * plotW;
  const y = (pct: number): number => m.top + plotH / 2 - (pct / yMax) * (plotH / 2);

  const svg = s('svg', {
    class: 'chart',
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    tabindex: 0,
    'aria-label': 'Exposure ratio deviation against brightness for each adjacent pair',
  });

  for (let v = -yMax; v <= yMax + 1e-9; v += step) {
    svg.append(
      s('line', { class: Math.abs(v) < 1e-9 ? 'axis' : 'grid', x1: m.left, x2: m.left + plotW, y1: y(v), y2: y(v) }),
      s('text', { class: 'tick-label', x: m.left - 8, y: y(v) + 4, 'text-anchor': 'end' }, Math.abs(v) < 1e-9 ? '0' : `${signed(v, step < 0.25 ? 1 : 2)}%`),
    );
  }
  for (let level = 0; level <= maxLevel + 1e-9; level += 0.25) {
    svg.append(s('text', { class: 'tick-label', x: x(level), y: height - 10, 'text-anchor': 'middle' }, `${Math.round(level * 100)}%`));
  }
  for (const mk of markers) {
    svg.append(
      s('line', { class: 'marker', x1: x(mk.level), x2: x(mk.level), y1: m.top, y2: m.top + plotH }),
      s('text', { class: 'tick-label', x: x(mk.level) - 4, y: m.top + 10, 'text-anchor': 'end' }, mk.label),
    );
  }

  series.forEach((sr, i) => {
    const d = sr.bins.map((b, j) => `${j ? 'L' : 'M'}${x(b.level).toFixed(1)} ${y((b.relative - 1) * 100).toFixed(1)}`).join('');
    svg.append(s('path', { d, class: 'series-line', stroke: SERIES[i % SERIES.length] }));
  });

  const legend = h(
    'div',
    { class: 'legend' },
    ...series.map((sr, i) => h('span', { class: 'legend-item' }, h('span', { class: 'line-key', style: `background:${SERIES[i % SERIES.length]}` }), sr.label)),
  );

  const root = h('div', { class: 'linearity' }, legend, h('div', { class: 'chart-wrap' }, svg));
  const levels = [...new Set(all.map((b) => b.level))].sort((a, b) => a - b);
  const hair = s('line', { class: 'crosshair', x1: 0, x2: 0, y1: m.top, y2: m.top + plotH, visibility: 'hidden' });
  const hit = s('rect', { x: m.left, y: m.top, width: plotW, height: plotH, fill: 'transparent' });
  svg.append(hair, hit);
  const tip = h('div', { class: 'tooltip', role: 'status' });
  tip.hidden = true;
  root.querySelector('.chart-wrap')?.append(tip);
  let current = -1;

  const show = (k: number): void => {
    current = Math.max(0, Math.min(levels.length - 1, k));
    const level = levels[current];
    const cx = x(level);
    hair.setAttribute('x1', String(cx));
    hair.setAttribute('x2', String(cx));
    hair.setAttribute('visibility', 'visible');
    tip.replaceChildren(
      h('div', { class: 'tooltip-title' }, `Brighter frame at ${Math.round(level * 100)}% of linear range`),
      ...series.map((sr, i) => {
        const bin = sr.bins.find((b) => Math.abs(b.level - level) < 1e-9);
        return h(
          'div',
          { class: 'tooltip-row' },
          h('span', { class: 'line-key', style: `background:${SERIES[i % SERIES.length]}` }),
          h('strong', {}, bin ? `${signed((bin.relative - 1) * 100, 2)}%` : '—'),
          h('span', {}, bin ? `${sr.label} · ${integer(bin.blocks)} blocks` : sr.label),
        );
      }),
    );
    tip.hidden = false;
    tip.style.left = `${cx > width - 260 ? cx - 252 : cx + 12}px`;
    tip.style.top = `${m.top}px`;
  };
  const hide = (): void => {
    hair.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  const nearest = (level: number): number => {
    let best = 0;
    for (let k = 1; k < levels.length; k++) if (Math.abs(levels[k] - level) < Math.abs(levels[best] - level)) best = k;
    return best;
  };
  hit.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    show(nearest(((px - m.left) / plotW) * maxLevel));
  });
  hit.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(current < 0 ? levels.length - 1 : current));
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

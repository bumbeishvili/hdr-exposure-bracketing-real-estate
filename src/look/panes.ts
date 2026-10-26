// Window panes from their frames. A pane is a quadrilateral: after Upright its
// sides are the frame's straight edges, and its corners are where those meet,
// whatever the view shows beside them. Everything the frame encloses is view —
// a shaded courtyard or a dark car as much as the sky — except room objects in
// front of the glass (a curtain, a bed), which hide a side of the pane or cover
// the frame where they cross it.

/** A pane side on the frame: the line nx·x + ny·y = c (pixel-centre coordinates), the glass where nx·x + ny·y < c. */
export interface FrameSide {
  nx: number;
  ny: number;
  c: number;
}

/** A frame side for measureEdge: its line, and its extent along the line (u = −ny·x + nx·y) between the pane's corners. */
export interface FrameLine extends FrameSide {
  lo: number;
  hi: number;
  /** Index of its pane: a pane's frame sides together bound it. */
  pane: number;
}

export interface Pane {
  /** Box of the pane's confident glass, inclusive pixel bounds. */
  box: [number, number, number, number];
  /** Left, right, top and bottom: the frame's edge, or null where none shows (a curtain or a bed hides it, or the image ends). */
  sides: (FrameSide | null)[];
  /** The pane's component in the glass mask's labels. */
  label: number;
}

// Outward unit vectors of the left, right, top and bottom sides.
const OUT = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

/**
 * Search reach as shares of the image width: outwards from the confident glass
 * (dark view along a side), inwards (the window lights a frame's bevel as
 * brightly as a shaded view: it passes the brightness threshold).
 */
const SEARCH = { out: 0.04, in: 0.01 } as const;
/** A frame edge is a step of at least FRAME_STEP stops (over two pixels) along half the side, and FRAME_STEP_LOW along 75% of it… */
const FRAME_STEP = 0.4;
const FRAME_STEP_LOW = 0.25;
/** …past it lies the frame, along half the side within this many stops of a line (light changes slowly along a frame)… */
const FRAME_FLAT = 0.2;
/** …the innermost such edge as strong as 70% of the strongest within this share of the image width past it… */
const NEAR = 0.007;
/** …and slopes: verticals are vertical after Upright, to this much; horizontals within `spread` of the window's own slope, found within `range`. */
const VERTICAL = 0.008;
const HORIZONTAL = { range: 0.12, spread: 0.02 } as const;
/** Margin, as a share of the image width, past a pane's confident glass where no frame shows: the blurred boundary of what hides it. */
const FREE_MARGIN = 0.003;
/** A covered stretch of a frame side runs at least this share of the image width. */
const COVER_RUN = 0.006;
/** What stands in front of the glass changes by less than `step` stops between neighbours and `range` from where it entered. */
const FRONT = { step: 0.8, range: 1.5 } as const;

function sampleAt(l: Float32Array, w: number, h: number, x: number, y: number): number {
  const fx = Math.min(w - 1.001, Math.max(0, x - 0.5));
  const fy = Math.min(h - 1.001, Math.max(0, y - 0.5));
  const xa = fx | 0;
  const ya = fy | 0;
  const tx = fx - xa;
  const ty = fy - ya;
  const j = ya * w + xa;
  return (1 - ty) * ((1 - tx) * l[j] + tx * l[j + 1]) + ty * ((1 - tx) * l[j + w] + tx * l[j + w + 1]);
}

/** Share of a side's values within FRAME_FLAT of a robust line through them. */
function flatness(band: Float32Array): number {
  const rows = band.length;
  const slopes: number[] = [];
  const stride = Math.max(1, Math.floor(rows / 48));
  for (let i = 0; i < rows; i += stride) for (let j = i + 4 * stride; j < rows; j += stride) slopes.push((band[j] - band[i]) / (j - i));
  slopes.sort((p, q) => p - q);
  const trend = slopes.length ? slopes[slopes.length >> 1] : 0;
  const mid = Array.from(band, (v, r) => v - trend * r).sort((p, q) => p - q)[rows >> 1];
  let flat = 0;
  for (let r = 0; r < rows; r++) if (Math.abs(band[r] - trend * r - mid) <= FRAME_FLAT) flat++;
  return flat / rows;
}

/**
 * A line t = a + b (u − uc) through edge points, if one holds most of them:
 * from slope `b` (the search's), the offset where the points crowd most within
 * a pixel either way, then least squares over the points within a pixel of
 * that line — half the side's rows at least, spanning half of it.
 */
function straightLine(us: number[], ts: number[], uc: number, rows: number, b: number): { a: number; b: number } | null {
  if (us.length < Math.max(8, 0.5 * rows)) return null;
  const offs = us.map((u, i) => ts[i] - b * (u - uc)).sort((p, q) => p - q);
  let most = 0;
  let a = 0;
  for (let i = 0, j = 0; i < offs.length; i++) {
    while (offs[j] < offs[i] - 2) j++;
    if (i - j + 1 > most) {
      most = i - j + 1;
      a = offs[(i + j) >> 1];
    }
  }
  let n = 0;
  let su = 0;
  let st = 0;
  let suu = 0;
  let sut = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < us.length; i++) {
    if (Math.abs(ts[i] - a - b * (us[i] - uc)) > 1) continue;
    const du = us[i] - uc;
    n++;
    su += du;
    st += ts[i];
    suu += du * du;
    sut += du * ts[i];
    lo = Math.min(lo, us[i]);
    hi = Math.max(hi, us[i]);
  }
  if (n < 0.5 * rows || hi - lo < 0.5 * rows) return null;
  const det = n * suu - su * su;
  if (det > 1e-6) {
    b = (n * sut - su * st) / det;
    a = (st - b * su) / n;
  }
  return { a, b };
}

/**
 * The frame edge along one side of a pane's confident glass, or null; and the
 * slope of the strongest line near the side. Every line near the side (offset,
 * and slope within `slopes`) is scored by the steps in log luminance across it
 * along the side: a frame's edge runs the side's whole length, view detail does
 * not. A line can be the edge where the view reaches it along part
 * of the side (`glass`: the pane's glass pixels; a curtain's folds past the
 * glass are lines too), and past it, beyond the blur, lies the frame: no sky or sunlit view
 * (`bright`, log luminance; a lit bevel or sill is not as bright as the sky),
 * and alike along the side (past a line in the view lies more view, past a
 * curtain's edge curtain in some rows and view in others). The edge is the
 * innermost such line about as strong as the strongest close by: frame against
 * view is the largest step there, the frame's lit bevel or lip beyond it and
 * lines in the view before it smaller ones. To a fraction of a pixel it is a
 * line through each row's steepest change of light near it, which must hold
 * most rows (a bed's edge that looks straight is fabric).
 */
function frameSide(l: Float32Array, bright: number, glass: (x: number, y: number) => boolean, w: number, h: number, box: [number, number, number, number], side: number, slopes: [number, number], slopeOnly = false): { line: FrameSide | null; slope: number } {
  const [x0, y0, x1, y1] = box;
  const [ox, oy] = OUT[side];
  const vertical = side < 2;
  const ref = side === 0 ? x0 : side === 1 ? x1 + 1 : side === 2 ? y0 : y1 + 1;
  const ua = vertical ? y0 : x0;
  const ub = vertical ? y1 + 1 : x1 + 1;
  const len = ub - ua;
  const room = side === 0 ? x0 : side === 1 ? w - 1 - x1 : side === 2 ? y0 : h - 1 - y1;
  const Tin = Math.max(3, Math.round(SEARCH.in * w));
  const tMax = Math.min(Math.max(8, Math.round(SEARCH.out * w)), room - 2);
  if (len < 16 || tMax < 2) return { line: null, slope: NaN };
  const k0 = Math.ceil(ua + 0.08 * len);
  const k1 = Math.floor(ub - 0.08 * len) - 1;
  const uc = (k0 + k1 + 1) / 2;
  const rows = k1 - k0 + 1;
  // Position of offset t (outwards) at u along the side.
  const at = (u: number, t: number): [number, number] => (vertical ? [ref + ox * t, u] : [u, ref + oy * t]);
  // Steps |Δ log L| over two pixels outwards, every half pixel, per row; and where the row's glass ends.
  const STEP = 0.5;
  const nt = Math.round((Tin + tMax) / STEP) + 1;
  const G = new Float32Array(rows * nt);
  const tGlass = new Float32Array(rows).fill(-Infinity);
  for (let r = 0; r < rows; r++) {
    const u = k0 + r + 0.5;
    for (let k = 0; k < nt; k++) {
      const t = -Tin + k * STEP;
      const [xa, ya] = at(u, t + 1);
      const [xb, yb] = at(u, t - 1);
      G[r * nt + k] = Math.abs(sampleAt(l, w, h, xa, ya) - sampleAt(l, w, h, xb, yb));
    }
    for (let t = Math.floor(tMax); t >= -len; t--) {
      const [xc, yc] = at(u, t - 0.5);
      if (xc >= 0 && yc >= 0 && xc < w && yc < h && glass(Math.floor(xc), Math.floor(yc))) {
        tGlass[r] = t;
        break;
      }
    }
  }
  // Each line t = a + b (u − uc) scored by the median and the 25th percentile of the steps along it (0.05-stop
  // bins); per offset the best slope, the middle one of equals.
  const db = Math.max(0.002, 0.5 / Math.max(1, rows / 2));
  const nb = Math.round((slopes[1] - slopes[0]) / db) + 1;
  const middle = (slopes[0] + slopes[1]) / 2;
  const best = new Float32Array(nt);
  const low = new Float32Array(nt);
  const slope = new Float32Array(nt);
  const hist = new Int32Array(129);
  const quantile = (count: number, q: number): number => {
    let acc = 0;
    for (let bin = 0; bin <= 128; bin++) {
      acc += hist[bin];
      if (acc >= q * count) return bin / 20;
    }
    return 6.4;
  };
  for (let ib = 0; ib < nb; ib++) {
    const b = slopes[0] + ib * db;
    for (let k = 0; k < nt; k++) {
      const a = -Tin + k * STEP;
      hist.fill(0);
      let count = 0;
      for (let r = 0; r < rows; r++) {
        const kk = Math.round((a + b * (k0 + r + 0.5 - uc) + Tin) / STEP);
        if (kk < 0 || kk >= nt) continue;
        hist[Math.min(128, Math.floor(G[r * nt + kk] * 20))]++;
        count++;
      }
      if (count < 0.8 * rows) continue;
      const med = quantile(count, 0.5);
      if (med > best[k] || (med === best[k] && Math.abs(b - middle) < Math.abs(slope[k] - middle))) {
        best[k] = med;
        low[k] = quantile(count, 0.25);
        slope[k] = b;
      }
    }
  }
  let strongest = 0;
  for (let k = 1; k < nt; k++) if (best[k] > best[strongest]) strongest = k;
  const found = best[strongest] >= FRAME_STEP ? slope[strongest] : NaN;
  if (slopeOnly) return { line: null, slope: found };
  const valid: number[] = [];
  const band = new Float32Array(rows);
  const vals: number[] = [];
  for (let k = 1; k < nt - 1; k++) {
    if (best[k] < FRAME_STEP || low[k] < FRAME_STEP_LOW || best[k] < best[k - 1] || best[k] < best[k + 1]) continue;
    const a = -Tin + k * STEP;
    const b = slope[k];
    let reach = 0;
    let lit = 0;
    for (let r = 0; r < rows; r++) {
      const u = k0 + r + 0.5;
      const t = a + b * (u - uc);
      if (t <= tGlass[r] + 2) reach++;
      // Past the line, 2–8 pixels out: the median level.
      vals.length = 0;
      for (let q = 2; q <= 8; q++) {
        const [xs, ys] = at(u, t + q);
        vals.push(sampleAt(l, w, h, xs, ys));
      }
      band[r] = vals.sort((p, q) => p - q)[vals.length >> 1];
      if (band[r] >= bright) lit++;
    }
    if (reach < 0.25 * rows || lit > 0.1 * rows || flatness(band) < 0.5) continue;
    valid.push(k);
  }
  if (!valid.length) return { line: null, slope: found };
  const near = valid.filter((k) => (k - valid[0]) * STEP <= Math.max(4, NEAR * w));
  const top = Math.max(...near.map((k) => best[k]));
  const k = near.find((kk) => best[kk] >= 0.7 * top)!;
  const a = -Tin + k * STEP;
  const b = slope[k];
  // Per row, the steepest change of light within a few pixels of the line — the nearest of those about as strong
  // as the strongest there — at the maximum of the change in linear light (the half-light point of a blurred step).
  const lin = (u: number, t: number): number => {
    const [x, y] = at(u, t);
    return 2 ** sampleAt(l, w, h, x, y);
  };
  const eu: number[] = [];
  const et: number[] = [];
  const g = new Float32Array(21);
  const rel = new Float32Array(21);
  for (let r = 0; r < rows; r++) {
    const u = k0 + r + 0.5;
    const tl = a + b * (u - uc);
    for (let q = 0; q < 21; q++) {
      const t = tl + (q - 10) * 0.25;
      g[q] = Math.abs(lin(u, t + 0.5) - lin(u, t - 0.5));
      rel[q] = g[q] / (lin(u, t + 1.5) + lin(u, t - 1.5));
    }
    let most = 0;
    for (let q = 1; q < 20; q++) most = Math.max(most, rel[q]);
    let qe = -1;
    for (let q = 1; q < 20; q++) {
      if (rel[q] < 0.5 * most || rel[q] < rel[q - 1] || rel[q] < rel[q + 1]) continue;
      if (qe < 0 || Math.abs(q - 10) < Math.abs(qe - 10)) qe = q;
    }
    if (qe < 0 || most < 0.05) continue;
    let qm = qe;
    for (let q = Math.max(1, qe - 2); q <= Math.min(19, qe + 2); q++) if (g[q] > g[qm]) qm = q;
    const den = g[qm - 1] - 2 * g[qm] + g[qm + 1];
    eu.push(u);
    et.push(tl + (qm - 10 + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (g[qm - 1] - g[qm + 1])) / den)) : 0)) * 0.25);
  }
  const fit = straightLine(eu, et, uc, rows, b);
  if (!fit) return { line: null, slope: found };
  // t = a + b (u − uc) in image coordinates, the glass where t is smaller; with p the coordinate across the side,
  // o (p − ref) − b u < a − b uc.
  const o = vertical ? ox : oy;
  const nx = vertical ? o : -fit.b;
  const ny = vertical ? -fit.b : o;
  const norm = Math.hypot(nx, ny);
  return { line: { nx: nx / norm, ny: ny / norm, c: (fit.a - fit.b * uc + o * ref) / norm }, slope: found };
}

/**
 * The panes of the window: components of the glass mask (`soft` ≥ 0.5) large
 * enough to be a pane and not a lamp (`lamp`), each with its confident glass's
 * box and the frame's edge along each side; and the components' labels
 * (`bright`: log luminance of sky or sunlit view). The
 * window's horizontals share a perspective: their slope is taken from the
 * strongest lines along the panes' tops and bottoms first, and each top or
 * bottom edge must lie within a little of it (a line slanting across the view
 * is not the frame).
 */
export function findPanes(l: Float32Array, bright: number, soft: Float32Array, lamp: Uint8Array, w: number, h: number): { panes: Pane[]; label: Int32Array } {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const comps: { box: [number, number, number, number]; label: number }[] = [];
  let id = 0;
  for (let start = 0; start < n; start++) {
    if (soft[start] < 0.5 || label[start] >= 0) continue;
    let head = 0;
    let tail = 0;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    const me = id++;
    label[start] = me;
    queue[tail++] = start;
    while (head < tail) {
      const j = queue[head++];
      const x = j % w;
      if (soft[j] >= 0.9) {
        const y = (j / w) | 0;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j >= w ? j - w : -1, j < n - w ? j + w : -1]) {
        if (k < 0 || soft[k] < 0.5 || label[k] >= 0) continue;
        label[k] = me;
        queue[tail++] = k;
      }
    }
    if (tail >= 0.001 * n && x1 >= x0 && !lamp[start]) comps.push({ box: [x0, y0, x1, y1], label: me });
  }
  const along: number[] = [];
  for (const c of comps) {
    const mine = (x: number, y: number): boolean => label[y * w + x] === c.label;
    for (const s of [2, 3]) {
      const { slope } = frameSide(l, bright, mine, w, h, c.box, s, [-HORIZONTAL.range, HORIZONTAL.range], true);
      if (slope === slope) along.push(slope);
    }
  }
  along.sort((p, q) => p - q);
  const b0 = along.length ? along[along.length >> 1] : 0;
  const panes: Pane[] = [];
  for (const c of comps) {
    const mine = (x: number, y: number): boolean => label[y * w + x] === c.label;
    const sides = [0, 1, 2, 3].map((s) => frameSide(l, bright, mine, w, h, c.box, s, s < 2 ? [-VERTICAL, VERTICAL] : [b0 - HORIZONTAL.spread, b0 + HORIZONTAL.spread]).line);
    // Two frame sides at least, so it is a pane in a frame (a lit lampshade or a mirror has none).
    if (sides.filter(Boolean).length >= 2) panes.push({ box: c.box, sides, label: c.label });
  }
  return { panes, label };
}

/** Where a pane ends on the sides no frame shows: FREE_MARGIN past its confident glass, or the image's edge if that is as close. */
function freeBounds(pane: Pane, w: number, h: number): number[] {
  const m = Math.max(2, Math.round(FREE_MARGIN * w));
  const [bx0, by0, bx1, by1] = pane.box;
  return [bx0 - m <= 0 ? -Infinity : bx0 - m, bx1 + 1 + m >= w ? Infinity : bx1 + 1 + m, by0 - m <= 0 ? -Infinity : by0 - m, by1 + 1 + m >= h ? Infinity : by1 + 1 + m];
}

/** Whether a point lies within a pane's quadrilateral: its frame sides, and its bounds where no frame shows. */
function insidePane(pane: Pane, lim: number[], X: number, Y: number): boolean {
  const [L, R, T, B] = pane.sides;
  if (L ? L.nx * X + L.ny * Y >= L.c : X < lim[0]) return false;
  if (R ? R.nx * X + R.ny * Y >= R.c : X > lim[1]) return false;
  if (T ? T.nx * X + T.ny * Y >= T.c : Y < lim[2]) return false;
  if (B ? B.nx * X + B.ny * Y >= B.c : Y > lim[3]) return false;
  return true;
}

/**
 * The panes' frame sides with their extents: each runs between the pane's
 * corners, where it meets the adjacent sides (their frame lines, or the bounds
 * where no frame shows), a couple of pixels either way.
 */
export function frameLines(panes: Pane[], w: number, h: number): FrameLine[] {
  const out: FrameLine[] = [];
  for (const [index, pane] of panes.entries()) {
    const lim = freeBounds(pane, w, h);
    const bound = (side: number): FrameSide => {
      const s = pane.sides[side];
      if (s) return s;
      // A free side as a line: x = bound (left, right) or y = bound (top, bottom), clamped to the image.
      const v = Math.min(side < 2 ? w : h, Math.max(0, lim[side]));
      const [ox, oy] = OUT[side];
      return { nx: ox, ny: oy, c: (side < 2 ? ox : oy) * v };
    };
    pane.sides.forEach((s, side) => {
      if (!s) return;
      // The adjacent sides: top and bottom for the left and right, and the other way round.
      const ends = (side < 2 ? [2, 3] : [0, 1]).map((o) => {
        const q = bound(o);
        const det = s.nx * q.ny - s.ny * q.nx;
        if (Math.abs(det) < 1e-6) return NaN;
        const x = (s.c * q.ny - s.ny * q.c) / det;
        const y = (s.nx * q.c - s.c * q.nx) / det;
        return -s.ny * x + s.nx * y;
      });
      if (ends.some((e) => e !== e)) return;
      out.push({ ...s, lo: Math.min(ends[0], ends[1]) - 2, hi: Math.max(ends[0], ends[1]) + 2, pane: index });
    });
  }
  return out;
}

/**
 * What the panes enclose, as a glass mask (1 in, 0 out; `soft` ≥ 0.5 for the
 * components that are not panes): each pane's quadrilateral less what stands in
 * front of the glass. That is what lies outside the brightness mask and joins
 * the quadrilateral's boundary where no frame shows, or a covered stretch of a
 * frame side — where, along a stretch, something unlike the frame lies just past
 * the line and the same thing just inside it (a handle on the frame is on the
 * frame only) — through pixels like it (no sharp step of light between
 * neighbours: folds in a curtain are gentler than its edge against the view),
 * and what that leaves enclosed without touching the glass. The pane's glass
 * outside its quadrilateral (the frame's lit bevel, glare) is not glass, nor
 * are bits too small to be panes on a pane's frame.
 */
export function paneMask(panes: Pane[], label: Int32Array, soft: Float32Array, l: Float32Array, lin: Float32Array, w: number, h: number): Float32Array {
  const n = w * h;
  const out = Float32Array.from(soft, (v) => (v >= 0.5 ? 1 : 0));
  const reach = Math.round(SEARCH.out * w) + Math.round(FREE_MARGIN * w) + 4;
  const bounds = panes.map((pane) => freeBounds(pane, w, h));
  const queue = new Int32Array(n);
  const look = (i: number): [number, number, number] => [l[i], Math.log2(Math.max(1e-7, lin[3 * i]) / Math.max(1e-7, lin[3 * i + 1])), Math.log2(Math.max(1e-7, lin[3 * i + 2]) / Math.max(1e-7, lin[3 * i + 1]))];
  const unlike = (a: [number, number, number], b: [number, number, number]): boolean => Math.abs(a[0] - b[0]) > 0.6 || Math.abs(a[1] - b[1]) > 0.15 || Math.abs(a[2] - b[2]) > 0.15;
  // The median look of the pixels t0…t1 past a point on a line.
  const bandLook = (px: number, py: number, nx: number, ny: number, t0: number, t1: number): [number, number, number] | null => {
    const v: [number, number, number][] = [];
    for (let t = t0; t <= t1; t++) {
      const sx = Math.floor(px + t * nx);
      const sy = Math.floor(py + t * ny);
      if (sx >= 0 && sy >= 0 && sx < w && sy < h) v.push(look(sy * w + sx));
    }
    if (v.length < 2) return null;
    const mid = (c: number): number => v.map((e) => e[c]).sort((p, q) => p - q)[v.length >> 1];
    return [mid(0), mid(1), mid(2)];
  };
  panes.forEach((pane, index) => {
    const [bx0, by0, bx1, by1] = pane.box;
    const lim = bounds[index];
    const [L, R, T, B] = pane.sides;
    const qx0 = Math.max(0, bx0 - reach);
    const qx1 = Math.min(w - 1, bx1 + reach);
    const qy0 = Math.max(0, by0 - reach);
    const qy1 = Math.min(h - 1, by1 + reach);
    const qw = qx1 - qx0 + 1;
    const qh = qy1 - qy0 + 1;
    const at = (j: number): number => (((j / qw) | 0) + qy0) * w + (j % qw) + qx0;
    const inQ = new Uint8Array(qw * qh);
    for (let y = qy0; y <= qy1; y++) for (let x = qx0; x <= qx1; x++) inQ[(y - qy0) * qw + x - qx0] = insidePane(pane, lim, x + 0.5, y + 0.5) ? 1 : 0;
    const covered = new Uint8Array(qw * qh);
    pane.sides.forEach((s, side) => {
      if (!s) return;
      const vertical = side < 2;
      const us: number[] = [];
      const points: [number, number][] = [];
      const outs: [number, number, number][] = [];
      const ins: [number, number, number][] = [];
      for (let u = vertical ? qy0 : qx0; u <= (vertical ? qy1 : qx1); u++) {
        const U = u + 0.5;
        const px = vertical ? (s.c - s.ny * U) / s.nx : U;
        const py = vertical ? U : (s.c - s.nx * U) / s.ny;
        // Only where the line bounds the quadrilateral.
        const ix = Math.floor(px - 1.5 * s.nx);
        const iy = Math.floor(py - 1.5 * s.ny);
        if (ix < qx0 || iy < qy0 || ix > qx1 || iy > qy1 || !inQ[(iy - qy0) * qw + ix - qx0]) continue;
        const o = bandLook(px, py, s.nx, s.ny, 2, 5);
        const i = bandLook(px, py, s.nx, s.ny, -5, -2);
        if (!o || !i) continue;
        us.push(u);
        points.push([px, py]);
        outs.push(o);
        ins.push(i);
      }
      if (us.length < 8) return;
      // The frame along the side: its level a robust line (light changes slowly along a frame), its colour the median.
      const slopes: number[] = [];
      const stride = Math.max(1, Math.floor(us.length / 40));
      for (let i = 0; i < us.length; i += stride) for (let j = i + stride; j < us.length; j += stride) slopes.push((outs[j][0] - outs[i][0]) / (us[j] - us[i]));
      slopes.sort((p, q) => p - q);
      const sl = slopes.length ? slopes[slopes.length >> 1] : 0;
      const level = us.map((u, i) => outs[i][0] - sl * u).sort((p, q) => p - q)[us.length >> 1];
      const red = outs.map((e) => e[1]).sort((p, q) => p - q)[us.length >> 1];
      const blue = outs.map((e) => e[2]).sort((p, q) => p - q)[us.length >> 1];
      const hit = us.map((u, i) => unlike(outs[i], [level + sl * u, red, blue]) && !unlike(outs[i], ins[i]));
      const run = Math.max(4, Math.round(COVER_RUN * w));
      for (let i = 0; i < us.length; ) {
        if (!hit[i]) {
          i++;
          continue;
        }
        let e = i;
        while (e + 1 < us.length && hit[e + 1] && us[e + 1] === us[e] + 1) e++;
        if (e - i + 1 >= run) {
          for (let q = i; q <= e; q++) {
            const [px, py] = points[q];
            for (let t = 0.5; t <= 2.5; t += 0.5) {
              const sx = Math.floor(px - t * s.nx);
              const sy = Math.floor(py - t * s.ny);
              if (sx >= qx0 && sy >= qy0 && sx <= qx1 && sy <= qy1) covered[(sy - qy0) * qw + sx - qx0] = 1;
            }
          }
        }
        i = e + 1;
      }
    });
    // In front of the glass: flooded from where no frame shows and from the covered stretches.
    const front = new Uint8Array(qw * qh);
    const entry = new Float32Array(qw * qh);
    let tail = 0;
    const join = (j: number, from: number): void => {
      if (!inQ[j] || front[j] || soft[at(j)] >= 0.5) return;
      const v = l[at(j)];
      if (from >= 0 && (Math.abs(v - l[at(from)]) >= FRONT.step || Math.abs(v - entry[from]) >= FRONT.range)) return;
      front[j] = 1;
      entry[j] = from >= 0 ? entry[from] : v;
      queue[tail++] = j;
    };
    for (let y = qy0; y <= qy1; y++) {
      for (let x = qx0; x <= qx1; x++) {
        const j = (y - qy0) * qw + x - qx0;
        const X = x + 0.5;
        const Y = y + 0.5;
        if (inQ[j] && (covered[j] || (!L && X - 1 < lim[0]) || (!R && X + 1 > lim[1]) || (!T && Y - 1 < lim[2]) || (!B && Y + 1 > lim[3]))) join(j, -1);
      }
    }
    for (let head = 0; head < tail; head++) {
      const j = queue[head];
      const x = j % qw;
      if (x > 0) join(j - 1, j);
      if (x < qw - 1) join(j + 1, j);
      if (j >= qw) join(j - qw, j);
      if (j < qw * qh - qw) join(j + qw, j);
    }
    // What the flood left out that touches no glass (a fold too dark to pass) is part of it too.
    const seen = new Uint8Array(qw * qh);
    for (let start = 0; start < qw * qh; start++) {
      if (!inQ[start] || front[start] || seen[start] || soft[at(start)] >= 0.5) continue;
      let head = 0;
      let count = 0;
      let open = false;
      seen[start] = 1;
      queue[count++] = start;
      while (head < count) {
        const j = queue[head++];
        const x = j % qw;
        for (const k of [x > 0 ? j - 1 : -1, x < qw - 1 ? j + 1 : -1, j >= qw ? j - qw : -1, j < qw * qh - qw ? j + qw : -1]) {
          if (k < 0 || !inQ[k] || front[k]) continue;
          if (soft[at(k)] >= 0.5) open = true;
          else if (!seen[k]) {
            seen[k] = 1;
            queue[count++] = k;
          }
        }
      }
      if (!open) for (let q = 0; q < count; q++) front[queue[q]] = 1;
    }
    for (let j = 0; j < qw * qh; j++) {
      const i = at(j);
      if (inQ[j]) out[i] = front[j] ? 0 : 1;
      else if (label[i] === pane.label) out[i] = 0;
    }
  });
  // Bits of glass too small to be panes on a pane's frame, outside every pane: lit frame (a lip catching the sky).
  const size = new Map<number, number>();
  for (let i = 0; i < n; i++) if (label[i] >= 0) size.set(label[i], (size.get(label[i]) ?? 0) + 1);
  for (const pane of panes) {
    const [bx0, by0, bx1, by1] = pane.box;
    for (let y = Math.max(0, by0 - reach); y <= Math.min(h - 1, by1 + reach); y++) {
      for (let x = Math.max(0, bx0 - reach); x <= Math.min(w - 1, bx1 + reach); x++) {
        const i = y * w + x;
        if (label[i] < 0 || (size.get(label[i]) ?? 0) >= 0.001 * n || panes.some((p, k) => insidePane(p, bounds[k], x + 0.5, y + 0.5))) continue;
        out[i] = 0;
      }
    }
  }
  return out;
}

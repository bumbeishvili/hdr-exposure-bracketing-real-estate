// The finished real-estate rendering, made the way a professional editor
// finishes a bracket merge: clean white walls, a bright room with depth, and
// the view through the windows pulled down to a natural daylight exposure.
//
// 1. Colour: light clipped in every frame raised to neutral white, then camera
//    RGB to linear ProPhoto through the camera profile.
// 2. Window pull (interiors): the view through the glass is several stops
//    brighter than the room, and is darkened. Its region is what the panes'
//    frames enclose (panes.ts): each pane is found from its bright part and
//    bounded by the frame's straight edges, so a shaded courtyard beside the
//    frame is in it and a curtain or a bed in front of the glass is not. At the
//    glass edge pixels mix frame and view (lens blur, bloom): the edge is the
//    frame's line, or measured across a curtain's or a bed's edge (where the
//    light is half-way between it and the view) and smoothed along it, and
//    only the view's share — the glass blurred like the image — is darkened,
//    in linear RGB against the frame's own colour, so the edge stays as clean
//    and as soft as the photo's other edges, with no glow, ring or colour
//    fringe.
// 3. Tone: local Laplacian filtering of log luminance compresses what range is
//    left (Highlights/Shadows) and adds midtone contrast (Clarity), halo-free.
// 4. Exposure: interiors from the walls, which land at a bright, clean white;
//    exteriors from the camera's metered exposure, nudged towards a bright midtone.
// 5. Finishing: dehaze in the view, black point, the profile's look table, a
//    highlight shoulder, then clean whites, vibrance and contrast in Oklab.
//
// Every step works in relative units, so a preview, the screen render and the
// full-resolution export (detail.ts) give the same picture.

import type { CameraProfile } from '../color/dcp.ts';
import { applyHueSatTable, cameraToProPhoto, colorTransform, PROPHOTO_TO_SRGB, type ColorTransform, type Vec3 } from '../color/color.ts';
import { localLaplacian } from '../tone/llf.ts';
import { boxMean, guidedFilter, morph, nearestSeeds } from '../tone/guided.ts';
import { finish, type FinishParams } from './finish.ts';
import { findPanes, frameLines, paneMask, type FrameLine } from './panes.ts';

export interface LookParams extends FinishParams {
  /** Camera neutral of the white balance. */
  neutral: Vec3;
  /** −1…1.5: how bright and airy the room is rendered. */
  brightness: number;
  /** 0…1: how far the view through the windows is pulled down. */
  windowPull: number;
  /** 0…1: midtone contrast from the local tone mapping. */
  clarity: number;
  /** Interior: windows pulled, exposure from the walls. Exterior: no window pull, the photographer's exposure. */
  scene: SceneKind;
}

export type SceneKind = 'interior' | 'exterior';

/** Scene brightness from the exposure the camera metered: EV at ISO 100. */
export function sceneEv(exposure: { fNumber: number; exposureTime: number; iso: number }): number {
  return Math.log2((exposure.fNumber * exposure.fNumber) / exposure.exposureTime) - Math.log2((exposure.iso > 0 ? exposure.iso : 100) / 100);
}

/**
 * Interior or exterior. A room exposed for its walls meters at EV100 ≈ 5–10
 * (a sunlit one up to about 11) and shows large near-neutral walls (beige
 * ones count: they are the dominant near-neutral); daylight outdoors meters
 * at 9.5–15 and is mostly foliage, sky and facades, and a shaded street can
 * meter like a room but has few walls. Open sky along the top edge (much
 * brighter than the median) also marks an exterior. `wallShare` is the white
 * balance estimate's coverage; `lum` a linear luminance image of the frame.
 * Twilight exteriors with walls in view read as interiors.
 */
export function classifyScene(ev100: number, wallShare: number, lum: Float32Array, w: number, h: number): SceneKind {
  if (ev100 >= 12.5 || (ev100 >= 9.5 && wallShare < 0.3) || wallShare < 0.15) return 'exterior';
  const median = Float32Array.from(lum).sort()[lum.length >> 1];
  let sky = 0;
  let count = 0;
  for (let y = 0; y < Math.max(2, Math.round(h * 0.04)); y++) {
    for (let x = 0; x < w; x++, count++) if (lum[y * w + x] > 4 * median) sky++;
  }
  return sky >= 0.4 * count ? 'exterior' : 'interior';
}

/**
 * The white balance a look starts from. Interiors: the walls' neutral, when
 * enough of the room is near-neutral and the camera's own auto measurement
 * agrees within 60 mired and 20 tint (foliage, coloured backdrops or a few
 * grey objects mislead the estimate). Otherwise, and outdoors, the camera's
 * measurement — or the as-shot setting when the file has none.
 */
export function defaultWhiteBalance(
  scene: SceneKind,
  auto: { temperature: number; tint: number; coverage: number },
  camera: { temperature: number; tint: number } | null,
): 'auto' | 'camera' | 'asShot' {
  const agrees = !camera || (Math.abs(1e6 / auto.temperature - 1e6 / camera.temperature) <= 60 && Math.abs(auto.tint - camera.tint) <= 20);
  if (scene === 'interior' && auto.coverage >= 0.3 && agrees) return 'auto';
  return camera ? 'camera' : 'asShot';
}

export { REAL_ESTATE_LOOK } from './defaults.ts';

/** Per-image numbers that every scale of a render shares. */
export interface LookScene {
  /** Scene luminance of the walls (the near-neutral interior surfaces). */
  wall: number;
  /** Stops the view through the windows is darkened by. */
  pull: number;
  /** Tone level (log2) of the walls: the exposure anchor, and where shadow depth starts. */
  anchor: number;
  /** Scene luminance → display-linear. */
  exposure: number;
  /** Display-linear veil removed from the view (dehaze). */
  veil: number;
  /** Display-linear black offset. */
  black: number;
}

/** What a full-resolution render takes from a smaller one (see detail.ts). */
export interface LookBase {
  width: number;
  height: number;
  /** The tone mapping (with the walls' light evened out) as a log2 gain on the pulled luminance (smooth except at strong edges). */
  gain: Float32Array;
  /** The glass edge (see measureEdge): signed distance and blur, in base pixels; empty where nothing was pulled. */
  distance: Float32Array;
  blur: Float32Array;
  /** F, interleaved linear RGB: the colour just outside the glass edge (see frameColour); empty where nothing was pulled. */
  frame: Float32Array;
  scene: LookScene;
}

export interface RenderedLook {
  /** Display-referred linear sRGB, interleaved. */
  rgb: Float32Array;
  width: number;
  height: number;
  /** Share of the frame seen through windows. */
  windowShare: number;
  /** Stops the view was pulled down by. */
  pull: number;
  temperature: number;
  tint: number;
  /** What a full-resolution render needs from this one (when asked for). */
  base: LookBase | null;
}

/**
 * Local tone mapping: details within ±1.2 stops kept (or enhanced), larger
 * steps compressed — symmetric, so halo-free. Interiors compress less (the
 * light on the walls is evened out separately, and dark accents should stay
 * dark); exteriors more, for sky against ground.
 */
export const TONE = { sigma: 1.2, beta: 0.75, betaExterior: 0.6 } as const;
/** The view through glass is at least this many stops above the walls… */
const GLASS_STOPS = 1.5;
/** …and every pane shows something (sky, sunlit facades) at least this bright; lit jambs and sills do not. */
const EXTERIOR_STOPS = 3;
/** Share of the view's darkest level removed as veil (a little haze keeps the view from looking pasted in). */
const DEHAZE = 0.25;
/** Light this many stops above the walls ends up white after tone mapping. */
const WHITE_STOPS = 1.3;
/**
 * The tone curve around the walls: exposure anchors on the walls' median
 * (after their light is evened out), tones below the walls are deepened up to
 * 10% of their distance (pointwise, so halo-free) for a little depth, and
 * highlights roll off from 0.55, so the walls lit by the windows stay below
 * L* 92. Professional interiors keep about 2% of the frame below L* 20 and
 * 2–4% above L* 92; deepening by 35% with the shoulder at 0.65 gave 3% and
 * 19%, and with the finishing contrast the room looked harsh.
 */
const CURVE = { anchor: 0.5, depth: 0.1, shoulder: 0.55 } as const;
/**
 * Evening out the light on the walls: the illumination is estimated from the
 * walls themselves (smoothly, `radius`) and only `keep` of its variation stays.
 */
const LEVEL = { keep: 0.3, radius: 0.025 } as const;
/** The window is exposed for its bright part: this quantile of the view (sky, sunlit facades). */
const VIEW_QUANTILE = 0.95;

/**
 * Radii as shares of the image width. `sides`: reach of the frame colour outside the glass edge; `reach`: of
 * the edge profiles either side of the glass contour; `contour`, `normal`: smoothing of the glass mask for its
 * contour and for the profiles' direction; `along`: the edge's smoothing along the contour; `spill`: reach of the
 * window's light on the room (evenWindowLight).
 */
export const RADIUS = { close: 0.003, glass: 0.01, sides: 0.006, frame: 0.01, bloom: 0.012, reach: 0.015, contour: 0.002, normal: 0.008, along: 0.012, spill: 0.025 } as const;

const radius = (share: number, w: number): number => Math.max(1, Math.round(share * w));
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Where the merge clipped, in camera units: `level` times a per-pixel gain (the vignetting correction applied since), or 1. */
export interface ClipLevel {
  level: number;
  gain: Float32Array | null;
}

/**
 * Clipped highlights to white. A channel that reached the clip level in every
 * frame is at least that bright, and green clips first, so white balance would
 * turn clipped whites magenta. From 90% of the clip level on, a channel is
 * raised towards the brightest white-balanced channel of its pixel: a fully
 * clipped pixel becomes neutral, unclipped channels are left alone. Returns
 * how clipped the pixel is, 0–1.
 */
export function recoverPixel(rgb: Float32Array, o: number, neutral: Vec3, level: number): number {
  const lo = 0.9 * level;
  const r = rgb[o];
  const g = rgb[o + 1];
  const b = rgb[o + 2];
  if (r <= lo && g <= lo && b <= lo) return 0;
  const top = Math.max(r / neutral[0], g / neutral[1], b / neutral[2]);
  const tr = smoothstep(lo, level, r);
  const tg = smoothstep(lo, level, g);
  const tb = smoothstep(lo, level, b);
  rgb[o] = r + tr * (top * neutral[0] - r);
  rgb[o + 1] = g + tg * (top * neutral[1] - g);
  rgb[o + 2] = b + tb * (top * neutral[2] - b);
  return Math.max(tr, tg, tb);
}

/** recoverPixel over an image; returns how clipped each pixel is (null: nowhere). */
export function recoverHighlights(camera: Float32Array, neutral: Vec3, clip: ClipLevel): Float32Array | null {
  if (!(clip.level < Infinity)) return null;
  const clipped = new Float32Array(camera.length / 3);
  let any = false;
  for (let p = 0, o = 0; o < camera.length; p++, o += 3) {
    clipped[p] = recoverPixel(camera, o, neutral, clip.gain ? clip.level * clip.gain[p] : clip.level);
    if (clipped[p] > 0) any = true;
  }
  return any ? clipped : null;
}

/** ProPhoto luminance of interleaved linear RGB, floored for logs. */
export function luminance(lin: Float32Array): Float32Array {
  const n = lin.length / 3;
  const Y = new Float32Array(n);
  for (let p = 0; p < n; p++) Y[p] = Math.max(1e-7, 0.2880402 * lin[3 * p] + 0.7118741 * lin[3 * p + 1] + 0.0000857 * lin[3 * p + 2]);
  return Y;
}

/**
 * The walls: near-neutral pixels in the interior's luminance range. Returns
 * their level (or a bright percentile when there are too few) and which pixels.
 */
function findWalls(lin: Float32Array, Y: Float32Array): { level: number; pixels: Uint32Array } {
  const n = Y.length;
  const sorted = Float32Array.from(Y).sort();
  const median = sorted[n >> 1];
  const pixels: number[] = [];
  for (let p = 0; p < n; p++) {
    const y = Y[p];
    if (y < median / 3 || y > median * 6) continue;
    const r = lin[3 * p] / y;
    const g = lin[3 * p + 1] / y;
    const b = lin[3 * p + 2] / y;
    if (r > 0 && b > 0 && Math.abs(Math.log(r / g)) < 0.06 && Math.abs(Math.log(b / g)) < 0.06) pixels.push(p);
  }
  if (pixels.length < 0.03 * n) {
    const level = sorted[Math.floor(n * 0.7)];
    return { level, pixels: Uint32Array.from({ length: n }, (_, i) => i).filter((i) => Y[i] > level / 1.5 && Y[i] < level * 1.5) };
  }
  const ys = Float32Array.from(pixels, (p) => Y[p]).sort();
  return { level: ys[Math.floor(ys.length * 0.6)], pixels: Uint32Array.from(pixels) };
}

/** A percentile of `values` over `pixels`. */
function levelOver(values: Float32Array, pixels: Uint32Array, q: number): number {
  return quantileInPlace(Float32Array.from(pixels, (p) => values[p]), q);
}

/**
 * Bright regions that contain real exterior light: connected areas above
 * `GLASS_STOPS` whose brightest pixel reaches `EXTERIOR_STOPS` above the walls.
 * A daylit window jamb or sill can be as bright as a shaded facade outside, but
 * the frame separates it from the pane and nothing in it is as bright as sky.
 */
function exteriorRegions(l: Float32Array, w: number, h: number, lw: number): Uint8Array {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const parent: number[] = [];
  const peak: number[] = [];
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  const limit = lw + GLASS_STOPS;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (l[i] <= limit) continue;
      const up = y > 0 ? label[i - w] : -1;
      const left = x > 0 ? label[i - 1] : -1;
      let id: number;
      if (up < 0 && left < 0) {
        id = parent.length;
        parent.push(id);
        peak.push(l[i]);
      } else {
        id = find(up >= 0 ? up : left);
        if (up >= 0 && left >= 0) {
          const other = find(left);
          if (other !== id) {
            parent[other] = id;
            peak[id] = Math.max(peak[id], peak[other]);
          }
        }
        peak[id] = Math.max(peak[id], l[i]);
      }
      label[i] = id;
    }
  }
  const keep = new Uint8Array(n);
  const bright = lw + EXTERIOR_STOPS;
  for (let i = 0; i < n; i++) if (label[i] >= 0 && peak[find(label[i])] >= bright) keep[i] = 1;
  return keep;
}

/** Soft mask of what is seen through windows: exterior regions, small dark details closed over, edges from the image. */
function glassMask(l: Float32Array, w: number, h: number, lw: number): Float32Array {
  const n = w * h;
  const exterior = exteriorRegions(l, w, h, lw);
  const bright = new Float32Array(n);
  for (let i = 0; i < n; i++) bright[i] = exterior[i] ? smoothstep(lw + GLASS_STOPS - 0.5, lw + GLASS_STOPS + 0.5, l[i]) : 0;
  const rc = radius(RADIUS.close, w);
  const closed = morph(morph(bright, w, h, rc, true), w, h, rc, false);
  const q = guidedFilter(l, closed, w, h, radius(RADIUS.glass, w), 0.04);
  for (let i = 0; i < n; i++) q[i] = Math.min(1, Math.max(0, q[i]));
  return q;
}

/**
 * Holes in the glass, filled in place: regions below 0.5 in the soft mask that
 * are enclosed by glass. The guided filter opens them at dark details of the
 * view (balconies, windows across the street). Larger holes must also be a
 * stop brighter than the walls, so a room object in front of the glass (a
 * plant, a lamp) is not taken for view.
 */
export function fillGlassHoles(soft: Float32Array, Y: Float32Array, wall: number, w: number, h: number): void {
  const n = w * h;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let tail = 0;
  const flood = (from: number): number => {
    let head = from;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      if (x > 0 && !seen[i - 1] && soft[i - 1] < 0.5) (seen[i - 1] = 1), (queue[tail++] = i - 1);
      if (x < w - 1 && !seen[i + 1] && soft[i + 1] < 0.5) (seen[i + 1] = 1), (queue[tail++] = i + 1);
      if (i >= w && !seen[i - w] && soft[i - w] < 0.5) (seen[i - w] = 1), (queue[tail++] = i - w);
      if (i < n - w && !seen[i + w] && soft[i + w] < 0.5) (seen[i + w] = 1), (queue[tail++] = i + w);
    }
    return tail - from;
  };
  // Regions touching the image's edge are open: the room around the windows.
  const seed = (i: number): void => {
    if (soft[i] < 0.5 && !seen[i]) (seen[i] = 1), (queue[tail++] = i);
  };
  for (let x = 0; x < w; x++) seed(x), seed((h - 1) * w + x);
  for (let y = 0; y < h; y++) seed(y * w), seed(y * w + w - 1);
  flood(0);
  // Every other region below 0.5 is enclosed by glass.
  for (let start = 0; start < n; start++) {
    if (soft[start] >= 0.5 || seen[start]) continue;
    const from = tail;
    seen[start] = 1;
    queue[tail++] = start;
    const size = flood(from);
    if (size > 0.002 * n) continue;
    if (size > 0.0002 * n && quantileInPlace(Float32Array.from(queue.subarray(from, from + size), (i) => Y[i]), 0.5) < 2 * wall) continue;
    for (let k = from; k < from + size; k++) soft[queue[k]] = 1;
  }
}

/** The q-quantile of `values`, reordering them in place (quickselect: linear time on average). */
export function quantileInPlace(values: Float32Array, q: number): number {
  const k = Math.min(values.length - 1, Math.max(0, Math.floor(q * (values.length - 1))));
  let lo = 0;
  let hi = values.length - 1;
  while (lo < hi) {
    const pivot = values[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (values[i] < pivot) i++;
      while (values[j] > pivot) j--;
      if (i <= j) {
        const t = values[i];
        values[i] = values[j];
        values[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return values[k];
}

/** Where the glass ends (see measureEdge). */
export interface GlassEdge {
  /** Signed distance to the edge in pixels: positive inside the glass, −FAR nowhere near glass. */
  distance: Float32Array;
  /** Blur of the edge nearest each pixel: a Gaussian σ in pixels. */
  blur: Float32Array;
}

/** The distance of pixels nowhere near glass. */
export const FAR = 1e4;

/**
 * The glass edge, measured from the image. The soft mask's contour follows
 * the view's content (a dark balcony against the frame dents it) and, refined
 * on log luminance, sits off the half-light point; under a pull of several
 * stops either shows as a torn or haloed edge. So across the contour, along
 * normals smoothed over a pane's detail, each luminance profile is searched
 * near the contour for the outermost steep fall in log luminance — the glass
 * edge is a blurred step, while light falling off across a frame lit by the
 * window is gradual. Either side of it, past the blur, lie the frame's level
 * and the view's; the edge is the point half-way between them in linear
 * light, about which a blurred step is symmetric, and the rise from a quarter
 * to three quarters gives the blur. The edge points are then smoothed along
 * the contour: where they lie on a line (a frame) they are replaced by a
 * robust line fit, so view detail against the frame (a dark balcony that
 * dents the mask, a step in the view near the edge) cannot pull the edge in;
 * a frame's line also bridges a long stretch of dark view against it, from the
 * clear steps further along. Elsewhere (a bed or a curtain in front of the
 * glass) the points take a short median. `viewLevel` (luminance; 0: unused) is
 * light no room surface reaches: a step with that much light outside it is a
 * step within the view (a darker strip of it along a bed), and the edge is
 * further out. On a pane's frame side (`frames`, see panes.ts) the edge is its
 * line, to its corners: contour points by it are measured square to it, only
 * for the blur. Which side of the edge a pixel lies on is decided by its
 * frame's lines there, elsewhere by a vote smoothed over a few pixels (so a bed's
 * or a curtain's edge has no spurs). Returns the signed distance to the edge and
 * its blur.
 */
export function measureEdge(Y: Float32Array, soft: Float32Array, w: number, h: number, viewLevel = 0, frames: FrameLine[] = []): GlassEdge {
  const n = w * h;
  const distance = new Float32Array(n).fill(-FAR);
  const blur = new Float32Array(n);
  let x0 = w;
  let x1 = -1;
  let y0 = h;
  let y1 = -1;
  for (let i = 0; i < n; i++) {
    if (soft[i] < 0.5) continue;
    const x = i % w;
    const y = (i / w) | 0;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const fallback = Math.max(0.5, 0.0006 * w);
  if (x1 < 0) return { distance, blur: blur.fill(fallback) };
  const reach = radius(RADIUS.reach, w);
  const pad = reach + radius(RADIUS.bloom, w) + 2;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad);
  y1 = Math.min(h - 1, y1 + pad);
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const m = bw * bh;
  const sharp = new Float32Array(m);
  const L = new Float32Array(m);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = (y + y0) * w + x + x0;
      sharp[y * bw + x] = soft[i] >= 0.5 ? 1 : 0;
      L[y * bw + x] = Y[i];
    }
  }
  // Thin breaks in the glass closed (a dark line of view detail splits off a piece of a pane).
  const rc = Math.max(1, Math.round(0.0012 * w));
  const glass = morph(morph(sharp, bw, bh, rc, true), bw, bh, rc, false);
  const tent = (src: Float32Array, r: number): Float32Array => boxMean(boxMean(src, bw, bh, r), bw, bh, r);
  const contour = tent(glass, radius(RADIUS.contour, w));
  const broad = tent(glass, radius(RADIUS.normal, w));

  // Pieces of glass smaller than the broad smoothing (a gap beside a curtain) keep their outline: normals from it, no profiles.
  const rn = radius(RADIUS.normal, w);
  const piece = new Int32Array(m).fill(-1);
  const area: number[] = [];
  const queue = new Int32Array(m);
  for (let start = 0; start < m; start++) {
    if (!glass[start] || piece[start] >= 0) continue;
    const id = area.length;
    let head = 0;
    let tail = 0;
    piece[start] = id;
    queue[tail++] = start;
    while (head < tail) {
      const j = queue[head++];
      const x = j % bw;
      for (const k of [x > 0 ? j - 1 : -1, x < bw - 1 ? j + 1 : -1, j - bw, j + bw]) {
        if (k < 0 || k >= m || !glass[k] || piece[k] >= 0) continue;
        piece[k] = id;
        queue[tail++] = k;
      }
    }
    area.push(tail);
  }
  const small = (j: number): boolean => {
    // A contour pixel may sit just outside its piece (the smoothed mask reaches past it): look at its neighbours.
    for (const k of [j, j - 1, j + 1, j - bw, j + bw]) if (piece[k] >= 0) return area[piece[k]] < 4 * rn * rn;
    return false;
  };

  // Contour pixels, and normals pointing out of the glass from the broadly smoothed mask (square to a pane's side across a dent).
  const pts: number[] = [];
  for (let y = 1; y < bh - 1; y++) {
    for (let x = 1; x < bw - 1; x++) {
      const j = y * bw + x;
      if (contour[j] >= 0.5 && (contour[j - 1] < 0.5 || contour[j + 1] < 0.5 || contour[j - bw] < 0.5 || contour[j + bw] < 0.5)) pts.push(j);
    }
  }
  const count = pts.length;
  const nx = new Float32Array(count);
  const ny = new Float32Array(count);
  const tOut = new Float32Array(count);
  const isSmall = Uint8Array.from(pts, (j) => (small(j) ? 1 : 0));
  // The frame side each contour point lies by (−1: none), and the sides with their blur.
  const lineOf = new Int16Array(count).fill(-1);
  const lines = frames.map((F) => ({ ...F, sigma: NaN }));
  for (let k = 0; k < count; k++) {
    const j = pts[k];
    let gx = broad[j + 1] - broad[j - 1];
    let gy = broad[j + bw] - broad[j - bw];
    if (Math.hypot(gx, gy) < 1e-4 || isSmall[k]) {
      gx = contour[j + 1] - contour[j - 1];
      gy = contour[j + bw] - contour[j - bw];
    }
    const len = Math.hypot(gx, gy) || 1;
    nx[k] = -gx / len;
    ny[k] = -gy / len;
    // By a frame side (within three pixels, facing the same way): its normal.
    if (!isSmall[k]) {
      const X = (j % bw) + 0.5 + x0;
      const Yc = ((j / bw) | 0) + 0.5 + y0;
      let nearest = 3;
      for (let f = 0; f < frames.length; f++) {
        const F = frames[f];
        const along = -F.ny * X + F.nx * Yc;
        if (nx[k] * F.nx + ny[k] * F.ny < 0.7 || along < F.lo || along > F.hi) continue;
        const d = Math.abs(F.c - (F.nx * X + F.ny * Yc));
        if (d >= nearest) continue;
        nearest = d;
        lineOf[k] = f;
      }
      if (lineOf[k] >= 0) {
        nx[k] = frames[lineOf[k]].nx;
        ny[k] = frames[lineOf[k]].ny;
      }
    }
    // Outwards the profile reaches half way to the next glass (across a mullion), at most `reach`.
    const cx = (j % bw) + 0.5;
    const cy = ((j / bw) | 0) + 0.5;
    let free = 2 * reach;
    let left = false;
    for (let t = 1; t <= 2 * reach; t++) {
      const sx = Math.floor(cx + nx[k] * t);
      const sy = Math.floor(cy + ny[k] * t);
      if (sx < 0 || sy < 0 || sx >= bw || sy >= bh) break;
      if (!glass[sy * bw + sx]) left = true;
      else if (left) {
        free = t;
        break;
      }
    }
    tOut[k] = Math.min(reach, Math.max(3, free / 2));
  }

  // One profile, every half pixel from outside (t = tOut) inwards to t = −reach. Returns the edge's offset along the
  // normal, its blur, whether the step is shaped like a blurred step (1) and its contrast in stops.
  const STEP = 0.5;
  const prof = new Float32Array(Math.ceil((2 * reach) / STEP) + 2);
  const scratch = new Float32Array(prof.length);
  const fall = new Float32Array(prof.length);
  const fall2 = new Float32Array(prof.length);
  const sample = (x: number, y: number): number => {
    const fx = Math.min(bw - 1.001, Math.max(0, x - 0.5));
    const fy = Math.min(bh - 1.001, Math.max(0, y - 0.5));
    const xa = fx | 0;
    const ya = fy | 0;
    const tx = fx - xa;
    const ty = fy - ya;
    const j = ya * bw + xa;
    return (1 - ty) * ((1 - tx) * L[j] + tx * L[j + 1]) + ty * ((1 - tx) * L[j + bw] + tx * L[j + bw + 1]);
  };
  const quantileOf = (a: number, b: number, q: number): number => {
    scratch.set(prof.subarray(a, b + 1));
    return quantileInPlace(scratch.subarray(0, b - a + 1), q);
  };
  const measure = (k: number, s: number): [number, number, number, number] | null => {
    const j = pts[k];
    const cx = (j % bw) + 0.5;
    const cy = ((j / bw) | 0) + 0.5;
    const to = tOut[k];
    const len = Math.floor((to + reach) / STEP) + 1;
    for (let q = 0; q < len; q++) prof[q] = sample(cx + nx[k] * (to - q * STEP), cy + ny[k] * (to - q * STEP));
    const tq = (q: number): number => to - q * STEP;
    const qAt = (t: number): number => Math.min(len - 1, Math.max(0, Math.round((to - t) / STEP)));
    // Falls of log luminance outwards within a few blur widths of the contour (over two blur widths); the edge is
    // the outermost that is a quarter as steep as the steepest: the glass edge is a blurred step, light falling
    // off across a frame lit by the window is gradual, and a step in the view just inside the edge (a white
    // facade beside a red one) comes before it. (For a bright view the fall is steepest about a blur width
    // outside the edge.)
    const span = Math.max(1, Math.round(s / STEP));
    const qa = Math.max(span + 1, qAt(2 * s + 3));
    const qb = Math.min(len - 2 - span, qAt(-(2 * s + 2)));
    // Beyond a step within the view the search reaches a little further out, with falls over twice the span too.
    const qFar = viewLevel > 0 ? Math.max(span + 1, qAt(2 * s + 7)) : qa;
    let steepest = 0;
    let steepest2 = 0;
    for (let q = qFar - 1; q <= qb + 1; q++) {
      fall[q] = Math.log2(prof[q + span] / prof[q - span]);
      fall2[q] = q >= 2 * span && q + 2 * span < len ? Math.log2(prof[q + 2 * span] / prof[q - 2 * span]) : NaN;
      if (q >= qa - 1) steepest = Math.max(steepest, fall[q]);
      if (fall2[q] === fall2[q]) steepest2 = Math.max(steepest2, fall2[q]);
    }
    let qe = -1;
    for (let q = qa; q <= qb; q++) {
      if (fall[q] >= Math.max(0.6, steepest / 4) && fall[q] >= fall[q - 1] && fall[q] >= fall[q + 1]) {
        qe = q;
        break;
      }
    }
    if (qe < 0) return null;
    // The levels either side past the blur.
    let te = tq(qe);
    let outer = quantileOf(qAt(te + Math.max(3, 4 * s)), qAt(te + Math.max(1.5, 2 * s)), 0.5);
    let V = quantileOf(qAt(te - Math.max(2, 3 * s)), qAt(Math.max(-reach, te - Math.max(4, 5 * s))), 0.5);
    // As much light outside as the view gives: a step within the view, a darker strip of it along a bed in front of
    // the glass. The edge is the fall further out from that strip to the room, gentler (the bed is more out of
    // focus than the frame); the view's level is the strip's.
    if (viewLevel > 0 && outer >= viewLevel) {
      for (let q = qFar; q < qe - span; q++) {
        const one = fall[q] >= Math.max(0.6, steepest / 4) && fall[q] >= fall[q - 1] && fall[q] >= fall[q + 1];
        const two = fall2[q] >= Math.max(0.8, steepest2 / 4) && fall2[q] >= fall2[q - 1] && fall2[q] >= fall2[q + 1];
        if (!one && !two) continue;
        const t = tq(q);
        const o = quantileOf(qAt(t + Math.max(3, 4 * s)), qAt(t + Math.max(1.5, 2 * s)), 0.5);
        const v = quantileOf(Math.min(qAt(t - Math.max(1, 1.5 * s)), qe - span), qe - span, 0.5);
        if (o >= viewLevel || v < viewLevel || !(v >= 1.5 * o)) continue;
        qe = q;
        te = t;
        outer = o;
        V = v;
        break;
      }
    }
    if (!(V >= 1.5 * outer)) return null;
    const q0 = Math.max(1, qAt(te + 3 * s));
    const cross = (level: number): number => {
      for (let q = q0; q < len; q++) {
        if (prof[q] < level) continue;
        return prof[q - 1] >= level ? tq(q) : tq(q - 1) - (STEP * (level - prof[q - 1])) / (prof[q] - prof[q - 1]);
      }
      return NaN;
    };
    const t25 = cross(outer + 0.25 * (V - outer));
    const t50 = cross(outer + 0.5 * (V - outer));
    const t75 = cross(outer + 0.75 * (V - outer));
    if (!(t25 >= t50 && t50 >= t75)) return null;
    // The blur only from steps shaped like a blurred step: the 10–90 % rise about 1.9 times the 25–75 % one
    // (view detail just inside the edge, or bloom, stretches one or the other).
    const w50 = t25 - t75;
    const w80 = cross(outer + 0.1 * (V - outer)) - cross(outer + 0.9 * (V - outer));
    return [t50, Math.max(0.25, w50 / 1.349), w50 > 0 && w80 > 1.4 * w50 && w80 < 2.6 * w50 ? 1 : 0, Math.log2(V / outer)];
  };
  // By a frame side the step is the steepest change of light near its line, either way (the view against the frame
  // is a step down where the view is bright, up where it is darker than the frame's lit lip): of the changes about
  // as strong as the strongest within the blur and a pixel and a half of the line, the nearest to it, at the
  // maximum of the change in linear light (the half-light point of a blurred step). The blur from its 25–75 % rise
  // between the levels just either side.
  const locateFrame = (k: number, s: number): [number, number, number, number] | null => {
    const F = lines[lineOf[k]];
    const j = pts[k];
    const cx = (j % bw) + 0.5;
    const cy = ((j / bw) | 0) + 0.5;
    const d = F.c - (F.nx * (cx + x0) + F.ny * (cy + y0));
    const r = s + 1.5;
    const len = Math.round((2 * r) / 0.25) + 1;
    const at = (t: number): number => sample(cx + nx[k] * t, cy + ny[k] * t);
    const g = new Float32Array(len);
    const rel = new Float32Array(len);
    for (let q = 0; q < len; q++) {
      const t = d - r + q * 0.25;
      g[q] = Math.abs(at(t + 0.5) - at(t - 0.5));
      rel[q] = g[q] / (at(t + 1.5) + at(t - 1.5));
    }
    let top = 0;
    for (let q = 1; q < len - 1; q++) top = Math.max(top, rel[q]);
    let qe = -1;
    for (let q = 1; q < len - 1; q++) {
      if (rel[q] < 0.5 * top || rel[q] < rel[q - 1] || rel[q] < rel[q + 1]) continue;
      if (qe < 0 || Math.abs(q - (len - 1) / 2) < Math.abs(qe - (len - 1) / 2)) qe = q;
    }
    if (qe < 0) return null;
    let qm = qe;
    for (let q = Math.max(1, qe - 2); q <= Math.min(len - 2, qe + 2); q++) if (g[q] > g[qm]) qm = q;
    const den = g[qm - 1] - 2 * g[qm] + g[qm + 1];
    const te = d - r + (qm + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (g[qm - 1] - g[qm + 1])) / den)) : 0)) * 0.25;
    const inner = at(te - r);
    const outer = at(te + r);
    const contrast = Math.abs(Math.log2(inner / outer));
    if (!(contrast >= 0.4)) return null;
    // From outside inwards, where the light passes `level`.
    const cross = (level: number): number => {
      for (let t = te + r; t > te - r; t -= 0.25) {
        const a = at(t);
        const b = at(t - 0.25);
        if ((a - level) * (b - level) <= 0 && a !== b) return t - (0.25 * (level - a)) / (b - a);
      }
      return NaN;
    };
    const lo = Math.min(inner, outer);
    const span = Math.abs(inner - outer);
    const w50 = Math.abs(cross(lo + 0.25 * span) - cross(lo + 0.75 * span));
    return [te, Math.max(0.25, w50 / 1.349), w50 > 0 ? 1 : 0, contrast];
  };
  // Three passes, each with the blur the last one found (it sets where the levels are read).
  const off = new Float32Array(count).fill(NaN);
  const sig = new Float32Array(count).fill(NaN);
  const clear = new Uint8Array(count);
  let s = 1.5;
  for (let pass = 0; pass < 3; pass++) {
    const found: number[] = [];
    for (let k = 0; k < count; k++) {
      const r = isSmall[k] ? null : lineOf[k] >= 0 ? locateFrame(k, s) : measure(k, s);
      off[k] = r ? r[0] : NaN;
      sig[k] = r && r[2] ? r[1] : NaN;
      // A clear step: view and frame a stop and a half apart or more.
      clear[k] = r && r[3] >= 1.5 ? 1 : 0;
      if (r && r[2]) found.push(r[1]);
    }
    if (found.length < 8) break;
    s = quantileInPlace(Float32Array.from(found), 0.5);
  }
  // Each frame side's blur: the median of its points' well-shaped steps.
  for (const [f, F] of lines.entries()) {
    const ss: number[] = [];
    for (let k = 0; k < count; k++) if (lineOf[k] === f && sig[k] === sig[k]) ss.push(sig[k]);
    F.sigma = ss.length >= 8 ? quantileInPlace(Float32Array.from(ss), 0.5) : NaN;
  }
  const valid: number[] = [];
  const validSig: number[] = [];
  for (let k = 0; k < count; k++) {
    if (off[k] === off[k]) valid.push(off[k]);
    if (sig[k] === sig[k]) validSig.push(sig[k]);
  }
  const offAll = valid.length ? quantileInPlace(Float32Array.from(valid), 0.5) : 0;
  const sigAll = validSig.length >= 8 ? quantileInPlace(Float32Array.from(validSig), 0.5) : fallback;

  // Along the contour: a robust line (Theil–Sen) through the clear steps nearby where most of them lie on it — so
  // faint stretches (dark view against the frame, where bloom on the frame can look like the edge) follow the
  // frame's line — else a short median. The blur: the median of the well-shaped steps nearby (the defocus
  // changes slowly), within half to twice the image's.
  const index = new Int32Array(m).fill(-1);
  for (let k = 0; k < count; k++) index[pts[k]] = k;
  const R = radius(RADIUS.along, w);
  const short = Math.max(2, R >> 2);
  const edgeOff = new Float32Array(count);
  const edgeSig = new Float32Array(count);
  const us: number[] = [];
  const os: number[] = [];
  const cs: number[] = [];
  const ss: number[] = [];
  const slopes: number[] = [];
  const near: number[] = [];
  const farU: number[] = [];
  const farO: number[] = [];
  for (let k = 0; k < count; k++) {
    if (isSmall[k]) {
      edgeOff[k] = offAll;
      edgeSig[k] = sigAll;
      continue;
    }
    const j = pts[k];
    const x = j % bw;
    const y = (j / bw) | 0;
    us.length = 0;
    os.length = 0;
    cs.length = 0;
    ss.length = 0;
    for (let yy = Math.max(0, y - 2 * R); yy <= Math.min(bh - 1, y + 2 * R); yy++) {
      for (let xx = Math.max(0, x - 2 * R); xx <= Math.min(bw - 1, x + 2 * R); xx++) {
        const k2 = index[yy * bw + xx];
        if (k2 < 0) continue;
        if (sig[k2] === sig[k2]) ss.push(sig[k2]);
        if (off[k2] !== off[k2]) continue;
        // Edge points in this pixel's frame (along its normal and across it); a pane's side bends into the
        // next at a corner, so normals within about 35° count and the inlier test below keeps one side.
        const dot = nx[k] * nx[k2] + ny[k] * ny[k2];
        if (dot < 0.8) continue;
        const dx = xx - x + off[k2] * nx[k2];
        const dy = yy - y + off[k2] * ny[k2];
        us.push(dy * nx[k] - dx * ny[k]);
        os.push(dx * nx[k] + dy * ny[k]);
        cs.push(clear[k2]);
      }
    }
    edgeSig[k] = Math.min(2 * sigAll, Math.max(0.5 * sigAll, ss.length >= 8 ? quantileInPlace(Float32Array.from(ss), 0.5) : sigAll));
    // By a frame side: its line.
    if (lineOf[k] >= 0) {
      const F = lines[lineOf[k]];
      edgeOff[k] = F.c - (F.nx * (x + 0.5 + x0) + F.ny * (y + 0.5 + y0));
      continue;
    }
    // The line through the clear steps, if they span a stretch of the edge here and most lie on it.
    const ci: number[] = [];
    for (let i = 0; i < os.length; i++) if (cs[i]) ci.push(i);
    let line = NaN;
    if (ci.length >= 8) {
      slopes.length = 0;
      const stride = Math.max(1, Math.floor(ci.length / 48));
      for (let a = 0; a < ci.length; a += stride) {
        for (let b = a + stride; b < ci.length; b += stride) {
          const du = us[ci[b]] - us[ci[a]];
          if (Math.abs(du) >= 3) slopes.push((os[ci[b]] - os[ci[a]]) / du);
        }
      }
      if (slopes.length >= 8) {
        const slope = quantileInPlace(Float32Array.from(slopes), 0.5);
        const at0 = quantileInPlace(Float32Array.from(ci, (i) => os[i] - slope * us[i]), 0.5);
        // Within the measurement's own scatter: where view detail just inside the edge is narrower than the
        // blur, the half-light point wanders by about a pixel.
        const tol = Math.max(1, 0.75 * edgeSig[k]);
        let inliers = 0;
        let lo = Infinity;
        let hi = -Infinity;
        for (const i of ci) {
          if (Math.abs(os[i] - at0 - slope * us[i]) > tol) continue;
          inliers++;
          lo = Math.min(lo, us[i]);
          hi = Math.max(hi, us[i]);
        }
        if (inliers >= 0.55 * ci.length && hi - lo >= R && lo <= R / 2 && hi >= -R / 2) line = at0;
      }
    }
    if (line !== line && !clear[k]) {
      // A long straight frame with dark view against it for a stretch (no clear step nearby): the frame's line from
      // the clear steps further along, if it passes close by.
      const L = 6 * R;
      farU.length = 0;
      farO.length = 0;
      for (let yy = Math.max(0, y - L); yy <= Math.min(bh - 1, y + L); yy++) {
        for (let xx = Math.max(0, x - L); xx <= Math.min(bw - 1, x + L); xx++) {
          const k2 = index[yy * bw + xx];
          if (k2 < 0 || !clear[k2] || off[k2] !== off[k2] || nx[k] * nx[k2] + ny[k] * ny[k2] < 0.95) continue;
          const dx = xx - x + off[k2] * nx[k2];
          const dy = yy - y + off[k2] * ny[k2];
          const o = dx * nx[k] + dy * ny[k];
          if (Math.abs(o) > 4 * edgeSig[k] + 6) continue;
          farU.push(dy * nx[k] - dx * ny[k]);
          farO.push(o);
        }
      }
      if (farU.length >= 16) {
        slopes.length = 0;
        const stride = Math.max(1, Math.floor(farU.length / 48));
        for (let a = 0; a < farU.length; a += stride) {
          for (let b = a + stride; b < farU.length; b += stride) {
            const du = farU[b] - farU[a];
            if (Math.abs(du) >= 6) slopes.push((farO[b] - farO[a]) / du);
          }
        }
        if (slopes.length >= 8) {
          const slope = quantileInPlace(Float32Array.from(slopes), 0.5);
          const at0 = quantileInPlace(Float32Array.from(farU, (u, i) => farO[i] - slope * u), 0.5);
          const tol = Math.max(1, 0.75 * edgeSig[k]);
          let inliers = 0;
          let lo = Infinity;
          let hi = -Infinity;
          for (let i = 0; i < farU.length; i++) {
            if (Math.abs(farO[i] - at0 - slope * farU[i]) > tol) continue;
            inliers++;
            lo = Math.min(lo, farU[i]);
            hi = Math.max(hi, farU[i]);
          }
          if (inliers >= 0.55 * farU.length && hi - lo >= 2 * R && lo <= 4 * R && hi >= -4 * R && Math.abs(at0) <= 2 * edgeSig[k] + 3) line = at0;
        }
      }
    }
    if (line === line) {
      edgeOff[k] = line;
      continue;
    }
    // Else the median of the clear steps close by (within twice as far if need be), or of all.
    near.length = 0;
    for (const i of ci) if (Math.abs(us[i]) <= short) near.push(os[i]);
    if (near.length < 3) {
      near.length = 0;
      for (const i of ci) if (Math.abs(us[i]) <= 2 * short) near.push(os[i]);
    }
    if (near.length < 3) {
      near.length = 0;
      for (let i = 0; i < os.length; i++) if (Math.abs(us[i]) <= short) near.push(os[i]);
    }
    edgeOff[k] = near.length ? quantileInPlace(Float32Array.from(near), 0.5) : off[k] === off[k] ? off[k] : offAll;
  }

  // Which side of the edge a pixel is on, by a vote of three that fail in different places: the glass mask; the
  // glass moved along each contour pixel's normal to its edge point (pixels whose centres the move passes change
  // side; at a corner a move can overshoot); and the side of the edge line through the nearest edge point (at a
  // corner the line cuts across). The distance is to the nearest edge point (the edge points as seeds, sub-pixel
  // positions, normals and blur averaged per pixel).
  const inside = Uint8Array.from(glass, (v) => (v ? 1 : 0));
  for (let k = 0; k < count; k++) {
    const o = edgeOff[k];
    const cx = (pts[k] % bw) + 0.5;
    const cy = ((pts[k] / bw) | 0) + 0.5;
    const steps = Math.ceil(Math.abs(o) / 0.25);
    for (let q = 1; q <= steps; q++) {
      const t = (o * q) / steps;
      const sx = Math.floor(cx + nx[k] * t);
      const sy = Math.floor(cy + ny[k] * t);
      if (sx < 0 || sy < 0 || sx >= bw || sy >= bh) break;
      const along = (sx + 0.5 - cx) * nx[k] + (sy + 0.5 - cy) * ny[k];
      if (o > 0 && along <= o) inside[sy * bw + sx] = 1;
      else if (o < 0 && along > o) inside[sy * bw + sx] = 0;
    }
  }
  for (let y = 1; y < bh - 1; y++) {
    for (let x = 1; x < bw - 1; x++) {
      // Single pixels the moves stepped past diagonally.
      const j = y * bw + x;
      const around = inside[j - 1] + inside[j + 1] + inside[j - bw] + inside[j + bw];
      if (around === 4) inside[j] = 1;
      else if (around === 0) inside[j] = 0;
    }
  }
  const ex = Float32Array.from(pts, (j, k) => (j % bw) + 0.5 + edgeOff[k] * nx[k]);
  const ey = Float32Array.from(pts, (j, k) => ((j / bw) | 0) + 0.5 + edgeOff[k] * ny[k]);
  const px = new Float32Array(m);
  const py = new Float32Array(m);
  const pnx = new Float32Array(m);
  const pny = new Float32Array(m);
  const ps = new Float32Array(m);
  const hits = new Float32Array(m);
  // A frame side's edge points lie on its line, every half pixel to its pane's corners, where it borders the glass;
  // they stand for the contour's own there.
  const frameSeed = new Int16Array(m);
  const withinPane = (pane: number, X: number, Yc: number, skip: number, tol: number): boolean => {
    for (const [g, G] of lines.entries()) if (g !== skip && G.pane === pane && G.nx * X + G.ny * Yc - G.c > tol) return false;
    return true;
  };
  const glassAt = (x: number, y: number): number => {
    const sx = Math.floor(x - x0);
    const sy = Math.floor(y - y0);
    return sx < 0 || sy < 0 || sx >= bw || sy >= bh ? 0 : glass[sy * bw + sx];
  };
  for (const [f, F] of lines.entries()) {
    const sigma = F.sigma === F.sigma ? F.sigma : sigAll;
    for (let u = F.lo; u <= F.hi; u += 0.5) {
      const X = F.c * F.nx - u * F.ny;
      const Yc = F.c * F.ny + u * F.nx;
      if (!withinPane(F.pane, X, Yc, f, 0.5) || !glassAt(X - 4 * F.nx, Yc - 4 * F.ny) || glassAt(X + 4 * F.nx, Yc + 4 * F.ny)) continue;
      const sx = Math.floor(X - x0);
      const sy = Math.floor(Yc - y0);
      if (sx < 0 || sy < 0 || sx >= bw || sy >= bh) continue;
      const e = sy * bw + sx;
      frameSeed[e] = f + 1;
      px[e] += X - x0;
      py[e] += Yc - y0;
      pnx[e] += F.nx;
      pny[e] += F.ny;
      ps[e] += sigma;
      hits[e]++;
    }
  }
  for (let k = 0; k < count; k++) {
    if (lineOf[k] >= 0) continue;
    const sx = Math.floor(ex[k]);
    const sy = Math.floor(ey[k]);
    if (sx < 0 || sy < 0 || sx >= bw || sy >= bh) continue;
    const e = sy * bw + sx;
    if (frameSeed[e]) continue;
    px[e] += ex[k];
    py[e] += ey[k];
    pnx[e] += nx[k];
    pny[e] += ny[k];
    ps[e] += edgeSig[k];
    hits[e]++;
  }
  const seed = new Uint8Array(m);
  for (let e = 0; e < m; e++) {
    if (!hits[e]) continue;
    seed[e] = 1;
    px[e] /= hits[e];
    py[e] /= hits[e];
    ps[e] /= hits[e];
  }
  // Each pixel's nearest edge point (seed pixel, −1: none) with the distance and blur there.
  blur.fill(sigAll);
  const nearestEdge = new Int32Array(m);
  const distances = (): void => {
    const nearest = nearestSeeds(seed, bw, bh).index;
    for (let j = 0; j < m; j++) {
      const s0 = nearest[j];
      nearestEdge[j] = -1;
      if (s0 < 0) continue;
      const X = (j % bw) + 0.5;
      const Yc = ((j / bw) | 0) + 0.5;
      const sx0 = s0 % bw;
      const sy0 = (s0 / bw) | 0;
      let best = Infinity;
      let e = s0;
      for (let sy = Math.max(0, sy0 - 1); sy <= Math.min(bh - 1, sy0 + 1); sy++) {
        for (let sx = Math.max(0, sx0 - 1); sx <= Math.min(bw - 1, sx0 + 1); sx++) {
          const c = sy * bw + sx;
          if (!seed[c]) continue;
          const d2 = (X - px[c]) ** 2 + (Yc - py[c]) ** 2;
          if (d2 < best) {
            best = d2;
            e = c;
          }
        }
      }
      const i = (((j / bw) | 0) + y0) * w + (j % bw) + x0;
      nearestEdge[j] = e;
      distance[i] = Math.sqrt(best);
      blur[i] = ps[e];
    }
  };
  distances();
  const side = new Uint8Array(m);
  for (let j = 0; j < m; j++) {
    const e = nearestEdge[j];
    if (e < 0) continue;
    const X = (j % bw) + 0.5;
    const Yc = ((j / bw) | 0) + 0.5;
    const line = (X - px[e]) * pnx[e] + (Yc - py[e]) * pny[e] <= 0 ? 1 : 0;
    // By a frame side: within its pane's frame sides, and in the glass mask (the frame does not reach past what
    // stands in front of the glass).
    const f = frameSeed[e] - 1;
    side[j] = f >= 0 ? (sharp[j] && withinPane(lines[f].pane, X + x0, Yc + y0, -1, 0) ? 1 : 0) : inside[j] + line + glass[j] >= 2 ? 1 : 0;
  }
  // Along a bed's or a curtain's edge the vote leaves a spur or a notch a few pixels across where its three
  // estimates part: there the side is smoothed (the majority of the 5 × 5 pixels around, twice; a frame's sides are
  // lines and stay), and edge points no longer on the boundary are dropped before the distances are taken again.
  for (let pass = 0; pass < 2; pass++) {
    const next = Uint8Array.from(side);
    for (let y = 2; y < bh - 2; y++) {
      for (let x = 2; x < bw - 2; x++) {
        const j = y * bw + x;
        const e = nearestEdge[j];
        if (e < 0 || frameSeed[e]) continue;
        let sum = 0;
        for (let dy = -2 * bw; dy <= 2 * bw; dy += bw) for (let dx = -2; dx <= 2; dx++) sum += side[j + dy + dx];
        next[j] = sum >= 13 ? 1 : 0;
      }
    }
    side.set(next);
  }
  let dropped = 0;
  for (let e = 0; e < m; e++) {
    if (!seed[e] || frameSeed[e]) continue;
    const x = e % bw;
    const y = (e / bw) | 0;
    let boundary = false;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(bh - 1, y + 1) && !boundary; yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(bw - 1, x + 1); xx++) if (side[yy * bw + xx] !== side[e]) boundary = true;
    if (boundary) continue;
    seed[e] = 0;
    dropped++;
  }
  if (dropped) distances();
  // Specks the vote leaves (a few pixels at a corner on the wrong side) join what surrounds them.
  const seen = new Uint8Array(m);
  for (let start = 0; start < m; start++) {
    if (seen[start]) continue;
    const v = side[start];
    let head = 0;
    let tail = 0;
    let edge = false;
    seen[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const j = queue[head++];
      const x = j % bw;
      if (x === 0 || x === bw - 1 || j < bw || j >= m - bw) edge = true;
      for (const k of [x > 0 ? j - 1 : -1, x < bw - 1 ? j + 1 : -1, j - bw, j + bw]) {
        if (k < 0 || k >= m || seen[k] || side[k] !== v) continue;
        seen[k] = 1;
        queue[tail++] = k;
      }
    }
    if (!edge && tail <= 6) for (let q = 0; q < tail; q++) side[queue[q]] = 1 - v;
  }
  for (let j = 0; j < m; j++) {
    const i = (((j / bw) | 0) + y0) * w + (j % bw) + x0;
    if (!side[j] && distance[i] > -FAR) distance[i] = -distance[i];
  }
  return { distance, blur };
}

/**
 * F: the colour just outside the glass edge — the frame, or a room object in
 * front of the glass — without the view's blur and bloom: a cross-bilateral
 * mean of the pixels clear of the edge (three blur widths out) within 2r,
 * counting those about as bright as what borders the pixel or somewhat darker
 * (bloom and spill only add light), so a white frame beside a dark curtain is
 * measured against the frame and the curtain against the curtain. Where
 * nothing outside is that bright, the plain mean of the clear outside pixels
 * stands in; where there are none, `level` (the frame and walls' luminance),
 * neutral. Interleaved linear RGB, like `lin`.
 */
export function frameColour(lin: Float32Array, Y: Float32Array, edge: GlassEdge, level: Float32Array, w: number, h: number, r: number): Float32Array {
  const n = w * h;
  const F = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) F[3 * i] = F[3 * i + 1] = F[3 * i + 2] = level[i];
  // Only the part of the image within reach of the glass needs it.
  let x0 = w;
  let x1 = -1;
  let y0 = h;
  let y1 = -1;
  for (let i = 0; i < n; i++) {
    if (edge.distance[i] <= -FAR) continue;
    const x = i % w;
    const y = (i / w) | 0;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < 0) return F;
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const m = bw * bh;
  const tent = (src: Float32Array, rr: number): Float32Array => boxMean(boxMean(src, bw, bh, rr), bw, bh, rr);
  const at = (j: number): number => (((j / bw) | 0) + y0) * w + (j % bw) + x0;
  const sure = new Float32Array(m);
  const ly = new Float32Array(m);
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j < m; j++) {
    const i = at(j);
    ly[j] = Math.log2(Y[i]);
    if (!(edge.distance[i] < -(3 * edge.blur[i] + 1))) continue;
    sure[j] = 1;
    if (ly[j] < lo) lo = ly[j];
    if (ly[j] > hi) hi = ly[j];
  }
  if (!(hi >= lo)) return F;
  // What each pixel is matched against: its own level where it is clear of the edge; at the edge, where it is lit
  // mostly by the view, the level of what borders it, read outwards along the distance's gradient past the blur
  // (the frame, a bed in front of the glass) — not whatever outside happens to be as bright as it.
  const key = Float32Array.from(ly);
  const dist = (x: number, y: number): number => edge.distance[(Math.min(bh - 1, Math.max(0, y)) + y0) * w + Math.min(bw - 1, Math.max(0, x)) + x0];
  const lum = (x: number, y: number): number => {
    const fx = Math.min(bw - 1.001, Math.max(0, x - 0.5));
    const fy = Math.min(bh - 1.001, Math.max(0, y - 0.5));
    const xa = fx | 0;
    const ya = fy | 0;
    const tx = fx - xa;
    const ty = fy - ya;
    const i = (ya + y0) * w + xa + x0;
    return (1 - ty) * ((1 - tx) * Y[i] + tx * Y[i + 1]) + ty * ((1 - tx) * Y[i + w] + tx * Y[i + w + 1]);
  };
  for (let j = 0; j < m; j++) {
    if (sure[j]) continue;
    const x = j % bw;
    const y = (j / bw) | 0;
    const gx = dist(x + 1, y) - dist(x - 1, y);
    const gy = dist(x, y + 1) - dist(x, y - 1);
    const len = Math.hypot(gx, gy);
    if (len < 1e-3) continue;
    const i = at(j);
    const t = edge.distance[i] + 3 * edge.blur[i] + 2;
    key[j] = Math.log2(Math.max(1e-7, lum(x + 0.5 - (gx / len) * t, y + 0.5 - (gy / len) * t)));
  }
  // Luminance bins 0.6 stop apart (hat-splatted); each pixel weighs bins up to about a stop below its key, barely those above.
  const step = 0.6;
  const bins = Math.min(24, Math.ceil((hi - lo) / step) + 1);
  const rf = 2 * r;
  const num = new Float32Array(3 * m);
  const den = new Float32Array(m);
  const wb = new Float32Array(m);
  const yb = [new Float32Array(m), new Float32Array(m), new Float32Array(m)];
  // The kernel over the pixel's level minus the bin's, tabulated every 0.02 stop over [−1, 3].
  const kernel = Float32Array.from({ length: 201 }, (_, t) => {
    const d = t * 0.02 - 1;
    return d >= 0 ? Math.exp((-d * d) / (2 * 0.7 * 0.7)) : Math.exp((-d * d) / (2 * 0.2 * 0.2));
  });
  for (let b = 0; b < bins; b++) {
    const c = lo + b * step;
    let members = 0;
    for (let j = 0; j < m; j++) {
      const t = sure[j] ? Math.max(0, 1 - Math.abs(ly[j] - c) / step) : 0;
      const i = at(j);
      wb[j] = t;
      for (let ch = 0; ch < 3; ch++) yb[ch][j] = t * lin[3 * i + ch];
      if (t > 0) members++;
    }
    if (members < 16) continue;
    const W = tent(wb, rf);
    const S = yb.map((plane) => tent(plane, rf));
    for (let j = 0; j < m; j++) {
      const t = Math.round((key[j] - c + 1) * 50);
      if (t < 0 || t > 200) continue;
      const k = kernel[t];
      for (let ch = 0; ch < 3; ch++) num[3 * j + ch] += k * S[ch][j];
      den[j] += k * W[j];
    }
  }
  // Where nothing outside is as bright as the pixel (the view side of the edge), the spatial mean of the
  // clear outside pixels around it stands in, so F stays smooth along the edge.
  const ws = tent(sure, rf);
  const spatial = [0, 1, 2].map((ch) => tent(Float32Array.from(sure, (v, j) => v * lin[3 * at(j) + ch]), rf));
  for (let j = 0; j < m; j++) {
    const i = at(j);
    for (let ch = 0; ch < 3; ch++) {
      const plain = ws[j] > 1e-4 ? (spatial[ch][j] + 0.01 * level[i]) / (ws[j] + 0.01) : level[i];
      F[3 * i + ch] = (num[3 * j + ch] + 0.01 * plain) / (den[j] + 0.01);
    }
  }
  return F;
}

/** Mean luminance of the frame and walls (not glass, within about a stop of the walls) around each pixel, tent-weighted. */
function frameLevel(Y: Float32Array, soft: Float32Array, lw: number, w: number, h: number, r: number): Float32Array {
  const n = w * h;
  const inner = new Float32Array(n);
  const Li = new Float32Array(n);
  // Frame and walls only: bloom from the view would raise the level, dark objects (curtains) lower it.
  const limit = 2 ** (lw + 0.3);
  const floor = 2 ** (lw - 1.5);
  for (let i = 0; i < n; i++) {
    inner[i] = soft[i] < 0.05 && Y[i] < limit && Y[i] > floor ? 1 : 0;
    Li[i] = inner[i] * Y[i];
  }
  // Tent-weighted (two boxes), so the level has no steps where the box meets a dark object.
  const s = boxMean(boxMean(inner, w, h, r), w, h, r);
  const sL = boxMean(boxMean(Li, w, h, r), w, h, r);
  const wall = 2 ** lw;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = s[i] > 1e-6 ? sL[i] / s[i] : wall;
  return out;
}

/** The standard normal distribution function (Abramowitz & Stegun 7.1.26; error below 1.5·10⁻⁷). */
function normalCdf(x: number): number {
  const z = Math.abs(x) * Math.SQRT1_2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 + 0.5 * erf : 0.5 - 0.5 * erf;
}

/**
 * The blur of an edge measured in a render, at `scale` times its resolution:
 * the render's own sampling blur (binning and resampling, about 0.35 px)
 * taken out before scaling, the finer output's (about 0.6 px) added back.
 * Measured on set 1: 1.6 px in the base render, 3.1 px at twice, 6.6 px at
 * four times its size.
 */
export function edgeBlurAt(blur: number, scale: number): number {
  return scale === 1 ? blur : Math.hypot(scale * Math.sqrt(Math.max(0, blur * blur - 0.35 * 0.35)), 0.6);
}

/**
 * Darkens the view by `pull` stops, in place on linear RGB. The view's share
 * of a pixel is the glass blurred like the image, α = Φ(distance / blur):
 * inside the glass a plain exposure change; at the edge only the view's share,
 * out = k·in + (1 − k)·min(in, (1 − α)·F) per channel with F the colour just
 * outside (frameColour), so the frame keeps its own colour rather than the
 * view's, and nothing is brightened; beyond the edge, light above F within the
 * bloom radius is glare from the view and dims with it. Clipped light
 * (`clipped`, 0–1 per pixel) is not pulled: it has no detail to show, and
 * stays white. `scale`: output pixels per unit of `distance` and `blur` (a
 * full-resolution render works from the base render's maps); `width`: the
 * output width the bloom radius refers to.
 */
export function pullWindow(lin: Float32Array, distance: Float32Array, blur: Float32Array, frame: Float32Array, pull: number, clipped: Float32Array | null, scale: number, width: number): void {
  if (!(pull > 0)) return;
  const k = 2 ** -pull;
  const D = RADIUS.bloom * width;
  for (let i = 0; i < distance.length; i++) {
    const d = distance[i] * scale;
    if (d <= -D) continue;
    const s = edgeBlurAt(blur[i], scale);
    const kc = clipped && clipped[i] > 0 ? 2 ** (-pull * (1 - clipped[i])) : k;
    const o = 3 * i;
    if (d >= 6 * s) {
      lin[o] *= kc;
      lin[o + 1] *= kc;
      lin[o + 2] *= kc;
      continue;
    }
    const a = normalCdf(d / s);
    if (a > 1e-3) {
      for (let c = 0; c < 3; c++) {
        const v = lin[o + c];
        lin[o + c] = kc * v + (1 - kc) * Math.min(v, (1 - a) * frame[o + c]);
      }
    } else {
      const z = 1 - smoothstep(Math.min(3 * s, D / 2), D, -d);
      for (let c = 0; c < 3; c++) {
        const v = lin[o + c];
        const f = frame[o + c];
        lin[o + c] = kc * v + (1 - kc) * (Math.min(v, f) + (1 - z) * Math.max(0, v - f));
      }
    }
  }
}

/**
 * The glass that is a lamp: a bright region taken for glass (a shade lit from
 * within) whose light is warm as a whole — its median log2 blue/green below
 * −0.45, where daylight views sit around +0.1 (a yellow facade in a view is
 * warm, the view as a whole is not). 1 per pixel of such regions.
 */
export function lampGlass(soft: Float32Array, lin: Float32Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const lamp = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (soft[start] < 0.5 || seen[start]) continue;
    let head = 0;
    let tail = 0;
    seen[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const j = queue[head++];
      const x = j % w;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j >= w ? j - w : -1, j < n - w ? j + w : -1]) {
        if (k < 0 || soft[k] < 0.5 || seen[k]) continue;
        seen[k] = 1;
        queue[tail++] = k;
      }
    }
    const members = queue.subarray(0, tail);
    const blue = quantileInPlace(Float32Array.from(members, (j) => Math.log2(Math.max(1e-7, lin[3 * j + 2]) / Math.max(1e-7, lin[3 * j + 1]))), 0.5);
    if (blue < -0.45) for (const j of members) lamp[j] = 1;
  }
  return lamp;
}

/**
 * The window's light on the room near the glass evened out, in place on the
 * tone levels (log2): a frame, a sill or the top of a bed lit straight from
 * the window, as bright as the walls or brighter, would glow against the
 * darkened view (a bedspread in front of the panes came out white). As the
 * walls' light is (LEVEL), it keeps `LEVEL.keep` of its excess over the same
 * surface further from the glass — found looking away from the glass, by its
 * colour — or, where no such surface is in reach (a mullion between panes),
 * over a little above the walls' `anchor`. Light beside a lamp (`lamps`, see
 * lampGlass) keeps its glow, and light within the pull's own blend (`share`)
 * is left to it. The darkening is at most 1.5 stops.
 */
export function evenWindowLight(tone: Float32Array, anchor: number, lin: Float32Array, edge: GlassEdge, share: Float32Array, lamps: Uint8Array, w: number, h: number): void {
  const n = w * h;
  const D = radius(RADIUS.spill, w);
  const KNEE = 0.25;
  const chroma = (i: number, c: number): number => Math.log2(Math.max(1e-7, lin[3 * i + c]) / Math.max(1e-7, lin[3 * i + 1]));
  const at = (x: number, y: number): number => Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)));
  const ref = new Float32Array(n).fill(NaN);
  const near: number[] = [];
  const todo: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = edge.distance[i];
    if (!(d < 0 && d > -D) || tone[i] <= anchor || share[i] >= 1) continue;
    const x = i % w;
    const y = (i / w) | 0;
    const gx = edge.distance[at(x + 1, y)] - edge.distance[at(x - 1, y)];
    const gy = edge.distance[at(x, y + 1)] - edge.distance[at(x, y - 1)];
    const len = Math.hypot(gx, gy);
    if (len < 1e-3) continue;
    const ux = gx / len;
    const uy = gy / len;
    // The glass beside it, past the edge's blur: a lamp's is left alone.
    if (lamps[at(x + ux * (2 - d + 3 * edge.blur[i]), y + uy * (2 - d + 3 * edge.blur[i]))]) continue;
    todo.push(i);
    // The same surface away from the glass: pixels of its colour beyond the window's reach, before another colour.
    const c0 = chroma(i, 0);
    const c2 = chroma(i, 2);
    near.length = 0;
    for (let t = 1; t <= 2 * D && near.length < 12; t++) {
      const j = at(x - ux * t, y - uy * t);
      const dj = edge.distance[j];
      if (dj > 0) break;
      if (Math.hypot(chroma(j, 0) - c0, chroma(j, 2) - c2) > 0.08) {
        if (near.length || dj <= -D) break;
        continue;
      }
      if (dj <= -D) near.push(tone[j]);
    }
    if (near.length >= 4) ref[i] = quantileInPlace(Float32Array.from(near), 0.5);
  }
  // The reference levels smoothed along the surface (each pixel's look is a single line through its texture).
  const has = Float32Array.from(ref, (r) => (r === r ? 1 : 0));
  const sum = Float32Array.from(ref, (r) => (r === r ? r : 0));
  const r = Math.max(1, Math.round(D / 4));
  const sHas = boxMean(has, w, h, r);
  const sSum = boxMean(sum, w, h, r);
  for (const i of todo) {
    const d = -edge.distance[i];
    const weight = (1 - smoothstep(D / 2, D, d)) * (1 - share[i]);
    const x = tone[i] - anchor;
    const level = has[i] ? sSum[i] / sHas[i] : NaN;
    let target: number;
    if (level === level && level < tone[i]) target = level + LEVEL.keep * (tone[i] - level);
    else if (x > KNEE) target = anchor + KNEE + LEVEL.keep * (x - KNEE);
    else continue;
    tone[i] -= Math.min(1.5, weight * (tone[i] - target));
  }
}

/**
 * Log2 illumination on the walls, smooth: normalized convolution of the wall
 * pixels at three scales (the larger ones fill gaps), on a half-size grid —
 * the field has no detail finer than that.
 */
function wallLight(l: Float32Array, mask: Float32Array, w: number, h: number): Float32Array {
  const hw = (w + 1) >> 1;
  const hh = (h + 1) >> 1;
  const hn = hw * hh;
  const ml = new Float32Array(hn);
  const mk = new Float32Array(hn);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const j = (y >> 1) * hw + (x >> 1);
      ml[j] += 0.25 * mask[i] * l[i];
      mk[j] += 0.25 * mask[i];
    }
  }
  let sum = 0;
  let count = 0;
  for (let j = 0; j < hn; j++) {
    sum += ml[j];
    count += mk[j];
  }
  const num = new Float32Array(hn);
  const den = new Float32Array(hn);
  for (const [share, weight] of [
    [LEVEL.radius, 1],
    [0.12, 0.1],
    [0.35, 0.01],
  ]) {
    const r = Math.max(1, Math.round((share * w) / 2));
    const a = boxMean(boxMean(ml, hw, hh, r), hw, hh, r);
    const b = boxMean(boxMean(mk, hw, hh, r), hw, hh, r);
    for (let j = 0; j < hn; j++) {
      num[j] += weight * a[j];
      den[j] += weight * b[j];
    }
  }
  const fallback = count ? sum / count : 0;
  const half = new Float32Array(hn);
  for (let j = 0; j < hn; j++) half[j] = den[j] > 1e-6 ? num[j] / den[j] : fallback;
  // Bilinear back to full size (half-size samples sit at the centres of 2 × 2 blocks).
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(hh - 1, Math.max(0, (y - 0.5) / 2));
    const y0 = Math.floor(fy);
    const y1 = Math.min(hh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(hw - 1, Math.max(0, (x - 0.5) / 2));
      const x0 = Math.floor(fx);
      const x1 = Math.min(hw - 1, x0 + 1);
      const tx = fx - x0;
      const top = half[y0 * hw + x0] + tx * (half[y0 * hw + x1] - half[y0 * hw + x0]);
      const bottom = half[y1 * hw + x0] + tx * (half[y1 * hw + x1] - half[y1 * hw + x0]);
      out[y * w + x] = top + ty * (bottom - top);
    }
  }
  return out;
}

/** Display-linear target of the walls' median for a brightness setting (0.6: L* 82, about 83 after finishing, as in professional interiors). */
const wallTarget = (brightness: number): number => Math.min(0.9, Math.max(0.3, 0.6 + 0.2 * (brightness - 1)));

/**
 * Exterior exposure for a median tone level: the median towards a bright
 * midtone (display 0.2, L* 52), within −0.3…+1 stop of the metered exposure
 * (which maps the meter's mid-grey, 0.125 of the clip level, to 0.18);
 * ±0.6 stop per brightness step.
 */
function exteriorGain(brightness: number, median: number): number {
  const metered = 1.44;
  const gain = Math.min(2 * metered, Math.max(metered * 2 ** -0.3, 0.2 / 2 ** median));
  return gain * 2 ** (0.6 * (brightness - 1));
}

/** Stops above the walls the view's bright part (VIEW_QUANTILE) is pulled to (0 → +1.6, 0.6 → −0.2, 1 → −1.4). */
const viewTarget = (windowPull: number): number => 1.6 - 3 * windowPull;

/** Display-linear gain for a pixel: tone mapping, shadows deepened below the walls' level, exposure. */
function displayGain(tone: number, l: number, scene: LookScene): number {
  const d = tone - scene.anchor;
  const t = d < 0 ? d * (1 + CURVE.depth * smoothstep(0, 4, -d)) : d;
  return 2 ** (scene.anchor + t - l) * scene.exposure;
}

/**
 * Scene-linear ProPhoto to finished display-linear sRGB for a run of pixels
 * (`l`: their log2 luminance): the tone-mapped luminance applied as a gain,
 * dehaze in the view (`viewShare`, 0–1, how much of the pull each pixel got),
 * black point, look table, shoulder, then finishing.
 */
export function toDisplay(lin: Float32Array, l: Float32Array, tone: Float32Array, viewShare: Float32Array, scene: LookScene, transform: ColorTransform, look: FinishParams, out: Float32Array): void {
  const n = l.length;
  for (let i = 0; i < n; i++) {
    const g = displayGain(tone[i], l[i], scene);
    const veil = scene.veil * viewShare[i];
    for (let c = 0; c < 3; c++) {
      const v = Math.max(0, lin[3 * i + c] * g - veil);
      // Black point, faded out by mid-grey so highlights keep their level.
      out[3 * i + c] = Math.max(0, v - scene.black * (1 - Math.min(1, v / 0.5)));
    }
  }
  if (transform.lookTable) applyHueSatTable(transform.lookTable, out, n);
  const s = CURVE.shoulder;
  const M = PROPHOTO_TO_SRGB;
  for (let i = 0; i < n; i++) {
    const r0 = out[3 * i];
    const g0 = out[3 * i + 1];
    const b0 = out[3 * i + 2];
    const r = r0 <= s ? r0 : s + (1 - s) * (1 - Math.exp(-(r0 - s) / (1 - s)));
    const g = g0 <= s ? g0 : s + (1 - s) * (1 - Math.exp(-(g0 - s) / (1 - s)));
    const b = b0 <= s ? b0 : s + (1 - s) * (1 - Math.exp(-(b0 - s) / (1 - s)));
    out[3 * i] = M[0] * r + M[1] * g + M[2] * b;
    out[3 * i + 1] = M[3] * r + M[4] * g + M[5] * b;
    out[3 * i + 2] = M[6] * r + M[7] * g + M[8] * b;
  }
  finish(out, look);
}

/** How much of the pull each pixel received, 0–1. */
export function viewShares(l: Float32Array, pulled: Float32Array, pull: number): Float32Array {
  const out = new Float32Array(l.length);
  if (pull > 0) for (let i = 0; i < l.length; i++) out[i] = Math.min(1, Math.max(0, (l[i] - pulled[i]) / pull));
  return out;
}

/**
 * Renders camera RGB (linear, 1.0 = reference white, not white-balanced) to the finished look.
 * `keepBase` also returns what a full-resolution render needs; `clip` says where the merge clipped.
 */
export function renderLook(camera: Float32Array, width: number, height: number, profile: CameraProfile, look: LookParams, keepBase = false, clip: ClipLevel | null = null): RenderedLook {
  const n = width * height;
  const transform = colorTransform(profile, look.neutral);
  const lin = Float32Array.from(camera);
  const clipped = clip ? recoverHighlights(lin, transform.neutral, clip) : null;
  cameraToProPhoto(transform, lin);
  const Y = luminance(lin);
  const l = Float32Array.from(Y, Math.log2);
  const interior = look.scene !== 'exterior';
  const walls = findWalls(lin, Y);
  const wall = walls.level;
  const lw = Math.log2(wall);

  // The view through the windows (interiors only): what the panes' frames enclose, less what stands in front of
  // the glass (panes.ts); glass that is no pane as the brightness shows it, its holes filled.
  const bright = interior ? glassMask(l, width, height, lw) : new Float32Array(n);
  const lamps = interior ? lampGlass(bright, lin, width, height) : new Uint8Array(n);
  let soft = bright;
  let frames: FrameLine[] = [];
  if (interior) {
    const { panes, label } = findPanes(l, lw + EXTERIOR_STOPS, bright, lamps, width, height);
    soft = paneMask(panes, label, bright, l, lin, width, height);
    fillGlassHoles(soft, Y, wall, width, height);
    frames = frameLines(panes, width, height);
  }
  const inside: number[] = [];
  const blown: number[] = [];
  for (let i = 0; i < n; i++) {
    if (soft[i] <= 0.7) continue;
    inside.push(l[i]);
    if (clipped && clipped[i] > 0.5) blown.push(l[i]);
  }
  inside.sort((a, b) => a - b);
  // Windows sit inside the room: bright regions running along the top edge are sky, not windows.
  let topGlass = 0;
  const topRows = Math.max(1, Math.round(height * 0.02));
  for (let i = 0; i < topRows * width; i++) topGlass += soft[i] >= 0.5 ? 1 : 0;
  const windows = interior && inside.length > 0.002 * n && topGlass < 0.3 * topRows * width;

  // The light on the walls evened out, as flash or local edits do in professional work: shaded walls
  // come up, walls beside the windows come down, and every object takes the gain of the walls around it.
  let level: Float32Array | null = null;
  let windowLevel = 0;
  if (interior) {
    const glassNear = boxMean(Float32Array.from(soft, (v) => (v >= 0.5 ? 1 : 0)), width, height, radius(RADIUS.bloom, width));
    const mask = new Float32Array(n);
    const used: number[] = [];
    for (const p of walls.pixels) {
      if (soft[p] >= 0.05 || glassNear[p] >= 0.02) continue;
      mask[p] = 1;
      used.push(p);
    }
    if (used.length > 0.01 * n) {
      const light = wallLight(l, mask, width, height);
      const ref = levelOver(light, Uint32Array.from(used), 0.5);
      level = Float32Array.from(light, (e) => -(1 - LEVEL.keep) * (e - ref));
      let sum = 0;
      let count = 0;
      for (let i = 0; i < n; i++) {
        if (soft[i] <= 0.7) continue;
        sum += level[i];
        count++;
      }
      windowLevel = count ? sum / count : 0;
    }
  }

  // How far to pull the view down: its bright part to the target above the (evened-out) walls.
  let pull = windows ? Math.max(0, inside[Math.floor(VIEW_QUANTILE * (inside.length - 1))] + windowLevel - (lw + viewTarget(look.windowPull))) : 0;
  // A window largely clipped in every frame (a single exposure) is pulled only as far as keeps the clipped part white.
  if (blown.length > 0.1 * inside.length) pull = Math.min(pull, Math.max(0, blown.sort((a, b) => a - b)[blown.length >> 1] + windowLevel - lw - WHITE_STOPS));
  // The glass edge and the colour outside it, then the pull in linear RGB; the full-resolution render works from the same edge.
  let edge: GlassEdge | null = null;
  let frame: Float32Array = new Float32Array(0);
  let px = lin;
  let Yp = Y;
  if (pull > 0) {
    const room = frameLevel(Y, soft, lw, width, height, radius(RADIUS.frame, width));
    edge = measureEdge(Y, soft, width, height, wall * 2 ** (GLASS_STOPS - 0.25), frames);
    frame = frameColour(lin, Y, edge, room, width, height, radius(RADIUS.sides, width));
    px = Float32Array.from(lin);
    pullWindow(px, edge.distance, edge.blur, frame, pull, clipped, 1, width);
    Yp = luminance(px);
  }
  const pulled = Float32Array.from(Yp, Math.log2);
  const share = viewShares(l, pulled, pull);

  const leveled = level ? Float32Array.from(pulled, (v, i) => v + level![i]) : pulled;
  const tone = localLaplacian(leveled, width, height, { sigma: TONE.sigma, beta: interior ? TONE.beta : TONE.betaExterior, alpha: 1 - 0.3 * look.clarity });
  // Interior: exposure from the walls' median after tone mapping.
  // Exterior: from the photographer's metered exposure and the median.
  const anchor = interior ? levelOver(tone, walls.pixels, CURVE.anchor) : quantileInPlace(Float32Array.from(tone), 0.5);
  if (edge) evenWindowLight(tone, anchor, lin, edge, share, lamps, width, height);
  const exposure = interior ? wallTarget(look.brightness) / 2 ** anchor : exteriorGain(look.brightness, anchor);
  const pre: LookScene = { wall, pull, anchor, exposure, veil: 0, black: 0 };

  // Dehaze: part of the view's darkest level is glare through the glass.
  let veil = 0;
  const darkest: number[] = [];
  for (let i = 0; i < n; i++) {
    if (share[i] < 0.9) continue;
    darkest.push(Math.min(px[3 * i], px[3 * i + 1], px[3 * i + 2]) * displayGain(tone[i], pulled[i], pre));
  }
  if (darkest.length > 100) veil = DEHAZE * quantileInPlace(Float32Array.from(darkest), 0.01);
  // Black point: the darkest 0.1% of the frame lands near black.
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = Math.max(0, Yp[i] * displayGain(tone[i], pulled[i], pre) - veil * share[i]);
  const black = Math.max(0, quantileInPlace(lum, 0.001) - 0.004);

  const scene: LookScene = { ...pre, veil, black };
  const rgb = new Float32Array(n * 3);
  toDisplay(px, pulled, tone, share, scene, transform, look, rgb);
  return {
    rgb,
    width,
    height,
    windowShare: inside.length / n,
    pull,
    temperature: transform.temperature,
    tint: transform.tint,
    base: keepBase
      ? { width, height, gain: Float32Array.from(tone, (t, i) => t - pulled[i]), distance: edge?.distance ?? new Float32Array(0), blur: edge?.blur ?? new Float32Array(0), frame, scene }
      : null,
  };
}

/** Linear sRGB → 8-bit sRGB RGBA, written from pixel `offset` of `out` on. */
export function toRgba8(rgb: Float32Array, out: Uint8ClampedArray, offset = 0): void {
  const q = (v: number): number => srgb8Table[v > 0 ? (v < 1 ? (v * 65535 + 0.5) | 0 : 65535) : 0];
  for (let p = 0, o = 4 * offset; p < rgb.length; p += 3, o += 4) {
    out[o] = q(rgb[p]);
    out[o + 1] = q(rgb[p + 1]);
    out[o + 2] = q(rgb[p + 2]);
    out[o + 3] = 255;
  }
}

const encode = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const srgb8Table = Uint8Array.from({ length: 65536 }, (_, i) => Math.round(255 * encode(i / 65535)));

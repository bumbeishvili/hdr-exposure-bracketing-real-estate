// Exposure fusion (Mertens, Kautz & Van Reeth 2007). Each pixel takes the
// display-referred exposures that show it best — well exposed, contrasty,
// saturated — blended across a Laplacian pyramid so the transitions carry no
// halos. Real-estate photographers know it as the natural Enfuse look; here it
// runs on synthetic exposures of one aligned, noise-optimal merge, so there is
// no ghost mixing and no noise from short frames in the shadows.

export interface FusionWeights {
  /** Exponents of the three quality measures. */
  exposedness: number;
  contrast: number;
  saturation: number;
  /** Width of the well-exposedness Gaussian. */
  sigma: number;
  /** Ideal display value; 0.5 in the paper, higher for a high-key, airy rendering. */
  center?: number;
  /** Per-pixel ideal display value, overriding `center`. */
  centerMap?: Float32Array;
}

interface Plane {
  data: Float32Array;
  w: number;
  h: number;
}

/**
 * Fuses display-referred images (interleaved RGB, roughly [0, 1]). `boost`
 * optionally multiplies each image's per-pixel weight (e.g. window pull).
 */
export function fuseExposures(images: Float32Array[], width: number, height: number, weights: FusionWeights, boost?: Array<Float32Array | null>): Float32Array {
  const n = width * height;
  const k = images.length;
  const levels = Math.max(1, Math.min(10, Math.floor(Math.log2(Math.min(width, height))) - 1));

  // Per-image weight maps, normalised across images.
  const maps = images.map((img, i) => weightMap(img, width, height, weights, boost?.[i] ?? null));
  for (let p = 0; p < n; p++) {
    let sum = 1e-12;
    for (let i = 0; i < k; i++) sum += maps[i][p];
    for (let i = 0; i < k; i++) maps[i][p] /= sum;
  }
  const weightPyramids = maps.map((m) => gaussianPyramid({ data: m, w: width, h: height }, levels));

  const out = new Float32Array(n * 3);
  for (let c = 0; c < 3; c++) {
    let blended: Plane[] | null = null;
    for (let i = 0; i < k; i++) {
      const channel = new Float32Array(n);
      for (let p = 0; p < n; p++) channel[p] = images[i][3 * p + c];
      const lap = laplacianPyramid({ data: channel, w: width, h: height }, levels);
      if (!blended) blended = lap.map((l) => ({ data: new Float32Array(l.data.length), w: l.w, h: l.h }));
      for (let l = 0; l < levels; l++) {
        const dst = blended[l].data;
        const src = lap[l].data;
        const wgt = weightPyramids[i][l].data;
        for (let p = 0; p < dst.length; p++) dst[p] += wgt[p] * src[p];
      }
    }
    const result = collapse(blended!);
    for (let p = 0; p < n; p++) out[3 * p + c] = result[p];
  }
  return out;
}

function weightMap(img: Float32Array, w: number, h: number, q: FusionWeights, boost: Float32Array | null): Float32Array {
  const n = w * h;
  const grey = new Float32Array(n);
  for (let p = 0; p < n; p++) grey[p] = 0.2126 * img[3 * p] + 0.7152 * img[3 * p + 1] + 0.0722 * img[3 * p + 2];
  const map = new Float32Array(n);
  const inv2s2 = 1 / (2 * q.sigma * q.sigma);
  const mid = q.center ?? 0.5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const r = img[3 * p];
      const g = img[3 * p + 1];
      const b = img[3 * p + 2];
      const xm = x > 0 ? p - 1 : p + 1;
      const xp = x < w - 1 ? p + 1 : p - 1;
      const ym = y > 0 ? p - w : p + w;
      const yp = y < h - 1 ? p + w : p - w;
      const contrast = Math.abs(4 * grey[p] - grey[xm] - grey[xp] - grey[ym] - grey[yp]);
      const mean = (r + g + b) / 3;
      const saturation = Math.sqrt(((r - mean) ** 2 + (g - mean) ** 2 + (b - mean) ** 2) / 3);
      const c = q.centerMap ? q.centerMap[p] : mid;
      const exposedness = Math.exp(-((r - c) ** 2 + (g - c) ** 2 + (b - c) ** 2) * inv2s2);
      let wgt = (contrast + 1e-3) ** q.contrast * (saturation + 1e-3) ** q.saturation * exposedness ** q.exposedness;
      if (boost) wgt *= boost[p];
      map[p] = wgt;
    }
  }
  return map;
}

/** Binomial [1 4 6 4 1]/16 blur, then every second sample; edges mirrored. */
function downsample(src: Plane): Plane {
  const { w, h, data } = src;
  const dw = Math.ceil(w / 2);
  const dh = Math.ceil(h / 2);
  const tmp = new Float32Array(dw * h);
  const at = (i: number, n: number): number => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < dw; x++) {
      const c = 2 * x;
      tmp[y * dw + x] =
        (data[row + at(c - 2, w)] + 4 * data[row + at(c - 1, w)] + 6 * data[row + at(c, w)] + 4 * data[row + at(c + 1, w)] + data[row + at(c + 2, w)]) / 16;
    }
  }
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const c = 2 * y;
    for (let x = 0; x < dw; x++) {
      out[y * dw + x] =
        (tmp[at(c - 2, h) * dw + x] + 4 * tmp[at(c - 1, h) * dw + x] + 6 * tmp[at(c, h) * dw + x] + 4 * tmp[at(c + 1, h) * dw + x] + tmp[at(c + 2, h) * dw + x]) / 16;
    }
  }
  return { data: out, w: dw, h: dh };
}

/** Inverse of `downsample`: zero insertion filtered with [1 4 6 4 1]/8 per axis, to size w × h. */
function upsample(src: Plane, w: number, h: number): Float32Array {
  const { w: sw, h: sh, data } = src;
  const at = (i: number, n: number): number => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);
  const tmp = new Float32Array(w * sh);
  for (let y = 0; y < sh; y++) {
    const row = y * sw;
    for (let x = 0; x < w; x++) {
      const half = x >> 1;
      tmp[y * w + x] =
        x & 1
          ? (4 * data[row + at(half, sw)] + 4 * data[row + at(half + 1, sw)]) / 8
          : (data[row + at(half - 1, sw)] + 6 * data[row + at(half, sw)] + data[row + at(half + 1, sw)]) / 8;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const half = y >> 1;
    for (let x = 0; x < w; x++) {
      out[y * w + x] =
        y & 1
          ? (4 * tmp[at(half, sh) * w + x] + 4 * tmp[at(half + 1, sh) * w + x]) / 8
          : (tmp[at(half - 1, sh) * w + x] + 6 * tmp[at(half, sh) * w + x] + tmp[at(half + 1, sh) * w + x]) / 8;
    }
  }
  return out;
}

function gaussianPyramid(base: Plane, levels: number): Plane[] {
  const pyr = [base];
  for (let l = 1; l < levels; l++) pyr.push(downsample(pyr[l - 1]));
  return pyr;
}

function laplacianPyramid(base: Plane, levels: number): Plane[] {
  const g = gaussianPyramid(base, levels);
  const lap: Plane[] = [];
  for (let l = 0; l < levels - 1; l++) {
    const up = upsample(g[l + 1], g[l].w, g[l].h);
    const d = new Float32Array(g[l].data.length);
    for (let p = 0; p < d.length; p++) d[p] = g[l].data[p] - up[p];
    lap.push({ data: d, w: g[l].w, h: g[l].h });
  }
  lap.push(g[levels - 1]);
  return lap;
}

function collapse(pyr: Plane[]): Float32Array {
  let img = pyr[pyr.length - 1];
  for (let l = pyr.length - 2; l >= 0; l--) {
    const up = upsample(img, pyr[l].w, pyr[l].h);
    const d = pyr[l].data;
    for (let p = 0; p < d.length; p++) up[p] += d[p];
    img = { data: up, w: pyr[l].w, h: pyr[l].h };
  }
  return img.data;
}

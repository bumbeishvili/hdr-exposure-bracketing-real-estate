// Gaussian and Laplacian pyramids (Burt & Adelson) on single-channel planes,
// with the binomial [1 4 6 4 1] kernel and mirrored edges.

/** Index i mirrored into [0, n) (whole-sample symmetric, any distance), for planes down to one pixel. */
function at(i: number, n: number): number {
  if (i >= 0 && i < n) return i;
  if (n === 1) return 0;
  const period = 2 * (n - 1);
  const j = ((i % period) + period) % period;
  return j < n ? j : period - j;
}

export interface Plane {
  data: Float32Array;
  w: number;
  h: number;
}

/** Binomial [1 4 6 4 1]/16 blur, then every second sample; edges mirrored. */
export function downsample(src: Plane): Plane {
  const { w, h, data } = src;
  const dw = Math.ceil(w / 2);
  const dh = Math.ceil(h / 2);
  const tmp = new Float32Array(dw * h);
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
export function upsample(src: Plane, w: number, h: number): Float32Array {
  const { w: sw, h: sh, data } = src;
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

export function gaussianPyramid(base: Plane, levels: number): Plane[] {
  const pyr = [base];
  for (let l = 1; l < levels; l++) pyr.push(downsample(pyr[l - 1]));
  return pyr;
}

export function laplacianPyramid(base: Plane, levels: number): Plane[] {
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

export function collapse(pyr: Plane[]): Float32Array {
  let img = pyr[pyr.length - 1];
  for (let l = pyr.length - 2; l >= 0; l--) {
    const up = upsample(img, pyr[l].w, pyr[l].h);
    const d = pyr[l].data;
    for (let p = 0; p < d.length; p++) up[p] += d[p];
    img = { data: up, w: pyr[l].w, h: pyr[l].h };
  }
  return img.data;
}

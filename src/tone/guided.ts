// Edge-aware smoothing (He, Sun & Tang's guided filter) and the box filters
// it is built from, morphology, and a nearest-seed distance transform.
// Smoothing a mask with the image as guide makes the mask's
// edges follow the image's edges: a window mask refined this way changes
// exactly where the window frame does, so an exposure change through it
// cannot leave a halo.

/** Mean over a (2r + 1)² box, edges clamped (running sums, linear time). */
export function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s;
      s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  const norm = 1 / ((2 * r + 1) * (2 * r + 1));
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s * norm;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Guided filter of `p` with guide `I` (both w × h): locally q = a·I + b. */
export function guidedFilter(I: Float32Array, p: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const n = w * h;
  const mI = boxMean(I, w, h, r);
  const mp = boxMean(p, w, h, r);
  const II = new Float32Array(n);
  const Ip = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    II[i] = I[i] * I[i];
    Ip[i] = I[i] * p[i];
  }
  const mII = boxMean(II, w, h, r);
  const mIp = boxMean(Ip, w, h, r);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = mII[i] - mI[i] * mI[i];
    a[i] = (mIp[i] - mI[i] * mp[i]) / (v + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxMean(a, w, h, r);
  const mb = boxMean(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = ma[i] * I[i] + mb[i];
  return q;
}

/**
 * Grey-scale dilation (max) or erosion (min) over a (2r + 1)² square,
 * separable, edges clamped; van Herk / Gil–Werman, constant time per pixel.
 */
export function morph(src: Float32Array, w: number, h: number, r: number, dilate: boolean): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const line = (get: (k: number) => number, put: (k: number, v: number) => void, len: number): void => {
    // Blocks of 2r + 1 from −r; prefix and suffix extremes within each block.
    const size = 2 * r + 1;
    const total = len + 2 * r;
    const ext = new Float32Array(total);
    for (let k = 0; k < total; k++) ext[k] = get(Math.min(len - 1, Math.max(0, k - r)));
    const pre = new Float32Array(total);
    const suf = new Float32Array(total);
    for (let k = 0; k < total; k++) {
      const v = ext[k];
      pre[k] = k % size === 0 ? v : dilate ? Math.max(pre[k - 1], v) : Math.min(pre[k - 1], v);
    }
    for (let k = total - 1; k >= 0; k--) {
      const v = ext[k];
      suf[k] = k === total - 1 || (k + 1) % size === 0 ? v : dilate ? Math.max(suf[k + 1], v) : Math.min(suf[k + 1], v);
    }
    // Window [k, k + 2r] in the extended line is output k.
    for (let k = 0; k < len; k++) put(k, dilate ? Math.max(suf[k], pre[k + 2 * r]) : Math.min(suf[k], pre[k + 2 * r]));
  };
  for (let y = 0; y < h; y++) line((k) => src[y * w + k], (k, v) => (tmp[y * w + k] = v), w);
  for (let x = 0; x < w; x++) line((k) => tmp[k * w + x], (k, v) => (out[k * w + x] = v), h);
  return out;
}

/**
 * The nearest seed of every pixel, by Euclidean distance (Danielsson's
 * two-pass 8SSEDT, carrying seed positions; approximate in rare
 * configurations). Returns the seed's index (−1 where there is none) and the
 * squared distance to it.
 */
export function nearestSeeds(seed: Uint8Array, w: number, h: number): { index: Int32Array; dist2: Float32Array } {
  const n = w * h;
  const index = new Int32Array(n).fill(-1);
  const dist2 = new Float32Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) {
    if (!seed[i]) continue;
    index[i] = i;
    dist2[i] = 0;
  }
  const relax = (i: number, x: number, y: number, j: number): void => {
    const s = index[j];
    if (s < 0) return;
    const dx = x - (s % w);
    const dy = y - ((s / w) | 0);
    const d = dx * dx + dy * dy;
    if (d < dist2[i]) {
      dist2[i] = d;
      index[i] = s;
    }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) relax(i, x, y, i - 1);
      if (y > 0) {
        relax(i, x, y, i - w);
        if (x > 0) relax(i, x, y, i - w - 1);
        if (x < w - 1) relax(i, x, y, i - w + 1);
      }
    }
    for (let x = w - 2; x >= 0; x--) relax(y * w + x, x, y, y * w + x + 1);
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) relax(i, x, y, i + 1);
      if (y < h - 1) {
        relax(i, x, y, i + w);
        if (x < w - 1) relax(i, x, y, i + w + 1);
        if (x > 0) relax(i, x, y, i + w - 1);
      }
    }
    for (let x = 1; x < w; x++) relax(y * w + x, x, y, y * w + x - 1);
  }
  return { index, dist2 };
}

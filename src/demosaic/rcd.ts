// RCD (Ratio Corrected Demosaicing, Luis Sanz Rodríguez) for a Bayer tile.
// Steps follow the reference algorithm as used in RawTherapee and darktable:
//  1. vertical/horizontal discrimination from squared high-pass filters,
//  2. a low-pass filter at red/blue sites,
//  3. green at red/blue sites from ratio-corrected, gradient-weighted neighbours,
//  4. red/blue at blue/red sites along the P/Q diagonals, then at green sites.
// Changes for HDR data: values are not clamped at 1 (only at 0), and the
// constants assume input scaled so the reference frame's white level is 1.

const EPS = 1e-5;
const EPSSQ = 1e-10;

/** Interpolation margin: output closer than this to a tile edge is not valid. */
export const RCD_BORDER = 12;

export interface RcdScratch {
  size: number;
  vh: Float32Array;
  pq: Float32Array;
  lpf: Float32Array;
  bufA: Float32Array;
  bufB: Float32Array;
}

export function rcdScratch(size: number): RcdScratch {
  return { size, vh: new Float32Array(size), pq: new Float32Array(size), lpf: new Float32Array(size), bufA: new Float32Array(size), bufB: new Float32Array(size) };
}

/**
 * Demosaics `cfa` (w × h, non-negative, white-balanced) into r, g, b.
 * `colors[(y & 1) * 2 + (x & 1)]` gives each site's colour (0 R, 1 G, 2 B).
 */
export function rcd(cfa: Float32Array, w: number, h: number, colors: readonly number[], r: Float32Array, g: Float32Array, b: Float32Array, scratch?: RcdScratch): void {
  const n = w * h;
  const s = scratch && scratch.size >= n ? scratch : rcdScratch(n);
  const { vh, pq, lpf, bufA: bufV, bufB: bufH } = s;
  const out = [r, g, b];
  const w2 = 2 * w;
  const w3 = 3 * w;
  const w4 = 4 * w;
  const isGreen = (x: number, y: number): boolean => colors[((y & 1) << 1) | (x & 1)] === 1;
  // First non-green column in row y.
  const firstNonGreen = (y: number, from: number): number => (isGreen(from, y) ? from + 1 : from);

  r.fill(0);
  g.fill(0);
  b.fill(0);
  for (let y = 0; y < h; y++) {
    const c0 = colors[(y & 1) << 1];
    const c1 = colors[((y & 1) << 1) | 1];
    for (let x = 0, i = y * w; x < w; x += 2, i += 2) {
      out[c0][i] = cfa[i];
      if (x + 1 < w) out[c1][i + 1] = cfa[i + 1];
    }
  }

  // Step 1: vertical / horizontal discrimination.
  vh.fill(0.5, 0, n);
  for (let y = 3; y < h - 3; y++) {
    for (let x = 3, i = y * w + 3; x < w - 3; x++, i++) {
      const c = cfa[i];
      const v = cfa[i - w3] - cfa[i - w] - cfa[i + w] + cfa[i + w3] - 3 * (cfa[i - w2] + cfa[i + w2]) + 6 * c;
      const hz = cfa[i - 3] - cfa[i - 1] - cfa[i + 1] + cfa[i + 3] - 3 * (cfa[i - 2] + cfa[i + 2]) + 6 * c;
      bufV[i] = v * v;
      bufH[i] = hz * hz;
    }
  }
  for (let y = 4; y < h - 4; y++) {
    for (let x = 4, i = y * w + 4; x < w - 4; x++, i++) {
      const V = Math.max(EPSSQ, bufV[i - w] + bufV[i] + bufV[i + w]);
      const H = Math.max(EPSSQ, bufH[i - 1] + bufH[i] + bufH[i + 1]);
      vh[i] = V / (V + H);
    }
  }

  // Step 2: low-pass filter at red and blue sites.
  for (let y = 2; y < h - 2; y++) {
    for (let x = firstNonGreen(y, 2), i = y * w + x; x < w - 2; x += 2, i += 2) {
      lpf[i] = cfa[i] + 0.5 * (cfa[i - w] + cfa[i + w] + cfa[i - 1] + cfa[i + 1]) + 0.25 * (cfa[i - w - 1] + cfa[i - w + 1] + cfa[i + w - 1] + cfa[i + w + 1]);
    }
  }

  // Step 3: green at red and blue sites.
  for (let y = 4; y < h - 4; y++) {
    for (let x = firstNonGreen(y, 4), i = y * w + x; x < w - 4; x += 2, i += 2) {
      const vc = vh[i];
      const vn = 0.25 * (vh[i - w - 1] + vh[i - w + 1] + vh[i + w - 1] + vh[i + w + 1]);
      const disc = Math.abs(0.5 - vc) < Math.abs(0.5 - vn) ? vn : vc;
      const c = cfa[i];
      const nG = EPS + Math.abs(cfa[i - w] - cfa[i + w]) + Math.abs(c - cfa[i - w2]) + Math.abs(cfa[i - w] - cfa[i - w3]) + Math.abs(cfa[i - w2] - cfa[i - w4]);
      const sG = EPS + Math.abs(cfa[i + w] - cfa[i - w]) + Math.abs(c - cfa[i + w2]) + Math.abs(cfa[i + w] - cfa[i + w3]) + Math.abs(cfa[i + w2] - cfa[i + w4]);
      const wG = EPS + Math.abs(cfa[i - 1] - cfa[i + 1]) + Math.abs(c - cfa[i - 2]) + Math.abs(cfa[i - 1] - cfa[i - 3]) + Math.abs(cfa[i - 2] - cfa[i - 4]);
      const eG = EPS + Math.abs(cfa[i + 1] - cfa[i - 1]) + Math.abs(c - cfa[i + 2]) + Math.abs(cfa[i + 1] - cfa[i + 3]) + Math.abs(cfa[i + 2] - cfa[i + 4]);
      const l = lpf[i];
      const nE = cfa[i - w] * (1 + (l - lpf[i - w2]) / (EPS + l + lpf[i - w2]));
      const sE = cfa[i + w] * (1 + (l - lpf[i + w2]) / (EPS + l + lpf[i + w2]));
      const wE = cfa[i - 1] * (1 + (l - lpf[i - 2]) / (EPS + l + lpf[i - 2]));
      const eE = cfa[i + 1] * (1 + (l - lpf[i + 2]) / (EPS + l + lpf[i + 2]));
      const vEst = (sG * nE + nG * sE) / (nG + sG);
      const hEst = (wG * eE + eG * wE) / (eG + wG);
      g[i] = Math.max(0, disc * hEst + (1 - disc) * vEst);
    }
  }

  // Step 4.0–4.1: P/Q diagonal discrimination at red and blue sites.
  const bufP = bufV;
  const bufQ = bufH;
  for (let y = 3; y < h - 3; y++) {
    for (let x = firstNonGreen(y, 3), i = y * w + x; x < w - 3; x += 2, i += 2) {
      const c = cfa[i];
      const p = cfa[i - w3 - 3] - cfa[i - w - 1] - cfa[i + w + 1] + cfa[i + w3 + 3] - 3 * (cfa[i - w2 - 2] + cfa[i + w2 + 2]) + 6 * c;
      const q = cfa[i - w3 + 3] - cfa[i - w + 1] - cfa[i + w - 1] + cfa[i + w3 - 3] - 3 * (cfa[i - w2 + 2] + cfa[i + w2 - 2]) + 6 * c;
      bufP[i] = p * p;
      bufQ[i] = q * q;
    }
  }
  pq.fill(0.5, 0, n);
  for (let y = 4; y < h - 4; y++) {
    for (let x = firstNonGreen(y, 4), i = y * w + x; x < w - 4; x += 2, i += 2) {
      const P = Math.max(EPSSQ, bufP[i - w - 1] + bufP[i] + bufP[i + w + 1]);
      const Q = Math.max(EPSSQ, bufQ[i - w + 1] + bufQ[i] + bufQ[i + w - 1]);
      pq[i] = P / (P + Q);
    }
  }

  // Step 4.2: red at blue sites and blue at red sites.
  for (let y = 4; y < h - 4; y++) {
    for (let x = firstNonGreen(y, 4), i = y * w + x; x < w - 4; x += 2, i += 2) {
      const ch = out[2 - colors[((y & 1) << 1) | (x & 1)]];
      const pc = pq[i];
      const pn = 0.25 * (pq[i - w - 1] + pq[i - w + 1] + pq[i + w - 1] + pq[i + w + 1]);
      const disc = Math.abs(0.5 - pc) < Math.abs(0.5 - pn) ? pn : pc;
      const gc = g[i];
      const nwG = EPS + Math.abs(ch[i - w - 1] - ch[i + w + 1]) + Math.abs(ch[i - w - 1] - ch[i - w3 - 3]) + Math.abs(gc - g[i - w2 - 2]);
      const neG = EPS + Math.abs(ch[i - w + 1] - ch[i + w - 1]) + Math.abs(ch[i - w + 1] - ch[i - w3 + 3]) + Math.abs(gc - g[i - w2 + 2]);
      const swG = EPS + Math.abs(ch[i + w - 1] - ch[i - w + 1]) + Math.abs(ch[i + w - 1] - ch[i + w3 - 3]) + Math.abs(gc - g[i + w2 - 2]);
      const seG = EPS + Math.abs(ch[i + w + 1] - ch[i - w - 1]) + Math.abs(ch[i + w + 1] - ch[i + w3 + 3]) + Math.abs(gc - g[i + w2 + 2]);
      const nwE = ch[i - w - 1] - g[i - w - 1];
      const neE = ch[i - w + 1] - g[i - w + 1];
      const swE = ch[i + w - 1] - g[i + w - 1];
      const seE = ch[i + w + 1] - g[i + w + 1];
      const pEst = (nwG * seE + seG * nwE) / (nwG + seG);
      const qEst = (neG * swE + swG * neE) / (neG + swG);
      ch[i] = Math.max(0, gc + (1 - disc) * pEst + disc * qEst);
    }
  }

  // Step 4.3: red and blue at green sites.
  for (let y = 4; y < h - 4; y++) {
    const x0 = isGreen(4, y) ? 4 : 5;
    for (let x = x0, i = y * w + x; x < w - 4; x += 2, i += 2) {
      const vc = vh[i];
      const vn = 0.25 * (vh[i - w - 1] + vh[i - w + 1] + vh[i + w - 1] + vh[i + w + 1]);
      const disc = Math.abs(0.5 - vc) < Math.abs(0.5 - vn) ? vn : vc;
      const gc = g[i];
      for (let c = 0; c <= 2; c += 2) {
        const ch = out[c];
        const nG = EPS + Math.abs(gc - g[i - w2]) + Math.abs(ch[i - w] - ch[i + w]) + Math.abs(ch[i - w] - ch[i - w3]);
        const sG = EPS + Math.abs(gc - g[i + w2]) + Math.abs(ch[i + w] - ch[i - w]) + Math.abs(ch[i + w] - ch[i + w3]);
        const wG = EPS + Math.abs(gc - g[i - 2]) + Math.abs(ch[i - 1] - ch[i + 1]) + Math.abs(ch[i - 1] - ch[i - 3]);
        const eG = EPS + Math.abs(gc - g[i + 2]) + Math.abs(ch[i + 1] - ch[i - 1]) + Math.abs(ch[i + 1] - ch[i + 3]);
        const nE = ch[i - w] - g[i - w];
        const sE = ch[i + w] - g[i + w];
        const wE = ch[i - 1] - g[i - 1];
        const eE = ch[i + 1] - g[i + 1];
        const vEst = (nG * sE + sG * nE) / (nG + sG);
        const hEst = (eG * wE + wG * eE) / (eG + wG);
        ch[i] = Math.max(0, gc + (1 - disc) * vEst + disc * hEst);
      }
    }
  }
}

/** Bilinear demosaic, for comparison and as a baseline. Same contract as `rcd`. */
export function bilinear(cfa: Float32Array, w: number, h: number, colors: readonly number[], r: Float32Array, g: Float32Array, b: Float32Array): void {
  const out = [r, g, b];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) {
      const c = colors[((y & 1) << 1) | (x & 1)];
      const cross = 0.25 * (cfa[i - 1] + cfa[i + 1] + cfa[i - w] + cfa[i + w]);
      const diag = 0.25 * (cfa[i - w - 1] + cfa[i - w + 1] + cfa[i + w - 1] + cfa[i + w + 1]);
      if (c === 1) {
        g[i] = cfa[i];
        const horiz = 0.5 * (cfa[i - 1] + cfa[i + 1]);
        const vert = 0.5 * (cfa[i - w] + cfa[i + w]);
        // The colour of the horizontal neighbours.
        const hc = colors[((y & 1) << 1) | ((x + 1) & 1)];
        out[hc][i] = horiz;
        out[2 - hc][i] = vert;
      } else {
        out[c][i] = cfa[i];
        g[i] = cross;
        out[2 - c][i] = diag;
      }
    }
  }
}

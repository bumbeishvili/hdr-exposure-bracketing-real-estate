// Real-estate finishing on display-referred linear sRGB, in Oklab so hue holds
// while lightness and chroma change. Clean whites takes the cast out of bright
// near-neutrals (walls, ceilings, trim); vibrance lifts muted colours and leaves
// near-neutrals alone; contrast is an S-curve on lightness that adds the "pop"
// fused images lack. Out-of-gamut colours are pulled towards grey, not clipped.

export interface FinishParams {
  /** −1…1: S-curve strength on lightness. */
  contrast: number;
  /** −1…1: chroma gain for muted colours. */
  vibrance: number;
  /** 0…1: how much of a cast is removed from bright near-neutrals. */
  cleanWhites: number;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** In place: interleaved linear sRGB, display-referred (1 = white). */
export function finish(rgb: Float32Array, p: FinishParams): void {
  for (let o = 0; o < rgb.length; o += 3) {
    const r = rgb[o] > 0 ? rgb[o] : 0;
    const g = rgb[o + 1] > 0 ? rgb[o + 1] : 0;
    const b = rgb[o + 2] > 0 ? rgb[o + 2] : 0;
    // Linear sRGB → Oklab (Ottosson).
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    let L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    let A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    let B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

    if (p.contrast) {
      const x = Math.min(Math.max(L, 0), 1);
      L = x + 2 * p.contrast * x * (1 - x) * (2 * x - 1);
    }
    const C = Math.sqrt(A * A + B * B);
    let scale = 1;
    if (p.cleanWhites > 0) scale *= 1 - p.cleanWhites * smoothstep(0.62, 0.92, L) * (1 - smoothstep(0.02, 0.09, C));
    if (p.vibrance) scale *= 1 + p.vibrance * (1 - smoothstep(0, 0.22, C)) * smoothstep(0.012, 0.05, C);
    A *= scale;
    B *= scale;

    // Oklab → linear sRGB.
    const l1 = L + 0.3963377774 * A + 0.2158037573 * B;
    const m1 = L - 0.1055613458 * A - 0.0638541728 * B;
    const s1 = L - 0.0894841775 * A - 1.291485548 * B;
    const l2 = l1 * l1 * l1;
    const m2 = m1 * m1 * m1;
    const s2 = s1 * s1 * s1;
    let ro = 4.0767416621 * l2 - 3.3077115913 * m2 + 0.2309699292 * s2;
    let go = -1.2684380046 * l2 + 2.6097574011 * m2 - 0.3413193965 * s2;
    let bo = -0.0041960863 * l2 - 0.7034186147 * m2 + 1.707614701 * s2;

    // Gamut: move towards the grey of the same lightness until every channel fits.
    const Lc = Math.min(Math.max(L, 0), 1);
    const grey = Lc * Lc * Lc;
    const t = Math.min(fit(ro, grey), fit(go, grey), fit(bo, grey));
    if (t < 1) {
      ro = grey + t * (ro - grey);
      go = grey + t * (go - grey);
      bo = grey + t * (bo - grey);
    }
    rgb[o] = ro;
    rgb[o + 1] = go;
    rgb[o + 2] = bo;
  }
}

/** Largest step from grey towards v that stays within [0, 1]. */
function fit(v: number, grey: number): number {
  if (v < 0) return grey / (grey - v);
  if (v > 1 && grey < 1) return (1 - grey) / (v - grey);
  return 1;
}

// The "bright & airy" real-estate default. White balance comes from the image.
// Kept apart from render.ts so the UI can import it without the rendering code.

export const REAL_ESTATE_LOOK = {
  /** −1…1.5: how bright and airy the room is rendered (walls at a clean white by default). */
  brightness: 1,
  /** 0…1: how far the view through the windows is pulled down (0.6: its sky just below the walls, a natural daylight exposure). */
  windowPull: 0.6,
  /** 0…1: midtone contrast from the local tone mapping (crisp, not gritty). */
  clarity: 0.15,
  /** −1…1: S-curve strength on lightness (a touch: tone mapping already gives the room its depth). */
  contrast: 0.05,
  /** −1…1: chroma gain for muted colours. */
  vibrance: 0.3,
  /** 0…1: how much of a cast is removed from bright near-neutrals (and how far they move to a slightly warm white). */
  cleanWhites: 0.7,
  /** Straighten verticals. */
  upright: true,
  /** Apply the lens's own corrections. */
  lens: true,
};

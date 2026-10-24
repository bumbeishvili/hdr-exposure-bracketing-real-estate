// The "bright & airy" real-estate default. White balance comes from the image.
// Kept apart from render.ts so the UI can import it without the rendering code.

export const REAL_ESTATE_LOOK = {
  /** −1…1.5: how bright and airy the room is rendered. */
  brightness: 1,
  /** 0…1: how much darker than the room the window view is kept, for detail. */
  windowPull: 0.6,
  /** −1…1: S-curve strength on lightness. */
  contrast: 0.15,
  /** −1…1: chroma gain for muted colours. */
  vibrance: 0.1,
  /** 0…1: how much of a cast is removed from bright near-neutrals. */
  cleanWhites: 0.6,
  /** Straighten verticals. */
  upright: true,
};

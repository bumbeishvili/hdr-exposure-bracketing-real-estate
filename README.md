# HDR Merger

A browser-based HDR merger for bracketed Sony A7C II ARW files, finished for real-estate photography: bright interiors, readable window views, clean white walls and straight verticals. It aims to beat Lightroom's Merge to HDR on tripod brackets, using no third-party image libraries.

> [!NOTE]
> **Status as of 24 Oct 2026: phases 1–7 built and tested on bracket set 1, plus a real-estate finishing stage.**
>
> - **Done:** ARW reader with SR2 decryption, inspection tool, noise model, sub-pixel alignment, noise-weighted raw merge with deghosting, RCD demosaic, the finished look (camera colour profile, interior auto white balance, exposure-fusion tone, clean whites, lens corrections, Upright), full-resolution JPEG export and float DNG export.
> - **Next:** open the DNG in Lightroom ([Phase 6](#roadmap)), check deghosting on set 3 ([Phase 7](#roadmap)), shoot a set in sharp focus, Ultra HDR gain-map JPEG.

**Contents:** [Getting started](#getting-started) · [What it does](#what-it-does) · [Findings](#findings-from-the-sample-files) · [Design decisions](#design-decisions) · [Pipeline](#pipeline) · [Camera and ARW facts](#sony-a7c-ii-and-arw-facts) · [Test data](#test-data) · [Roadmap](#roadmap) · [Risks](#constraints-and-risks) · [Validation](#validation) · [Project layout](#project-layout) · [References](#references)

## Getting started

Needs Node 22.18 or newer (it runs the TypeScript sources directly for tests and scripts).

```sh
npm install
npm run dev          # open http://localhost:5173 and drop the ARW files of one bracket
npm test             # unit tests; the sample checks run when app-samples/ has ARW files
npm run test:e2e     # Playwright drives the app with app-samples/ and saves screenshots
npm run build        # dist/ uses relative paths, so any static server (Live Server too) can host it
```

Put sample brackets in `app-samples/` (ARW files are gitignored). Opening `index.html` directly with Live Server does not work: the sources are TypeScript and need Vite (`npm run dev`) or a build.

### Using the app

The page is just the photo:

1. Drop the ARW files of one bracket (or click the drop area). A thin line at the top shows progress over a dimmed preview of the base frame.
2. After about 20 s the finished photo appears. It sharpens once more a few seconds later on high-density screens.
3. Hover the photo and click the download icon for the full-resolution JPEG (about 12 s).

The button in the top-right corner opens the workspace behind the photo: frames, exposure ratios, noise model, merge checks, the look controls (white balance, tone, colour, Upright, lens corrections), export sizes and the float DNG. <kbd>Esc</kbd> goes back to the photo.

Command-line tools for the numbers behind each stage:

```sh
node scripts/inspect.ts app-samples/*.ARW      # levels, clipping, measured exposure ratios, noise model
node scripts/merge.ts app-samples/*.ARW        # alignment, weight shares, seam check, dynamic range
node scripts/look.ts out/ app-samples/*.ARW    # finished real-estate look as PNGs (caches the merge)
npm run fixtures:exif                          # re-record exiftool reference values for the tests
```

## What it does

Every stage runs locally in a Web Worker; nothing is uploaded.

| Stage | What happens | Code |
| --- | --- | --- |
| Decode | TIFF/IFD parsing, uncompressed 14-bit CFA, Sony SR2 decryption, levels, white balance, Exif, bracket sequence | `src/raw/` |
| Inspect | Raw histograms on an EV axis, clipping per channel, measured exposure ratios against EXIF, sensor linearity | `src/analysis/stats.ts`, `exposure.ts` |
| Noise model | Var(v) = α(t)·s + β per CFA channel, fitted on flat pixels of adjacent-frame differences | `src/analysis/noise.ts` |
| Align | Sub-pixel translation per frame (Lucas–Kanade on green planes), chained to the base frame | `src/merge/align.ts` |
| Merge | Inverse-variance weighted average on the raw Bayer data, smooth roll-off near clipping, seam check | `src/merge/merge.ts`, `seams.ts` |
| Demosaic | RCD on padded tiles; 100% view demosaics on demand (bilinear available for comparison) | `src/demosaic/` |
| Colour | DNG-spec rendering with a camera profile (.dcp); interior auto white balance; click-a-white-wall picker | `src/color/` |
| Tone | Exposure fusion of synthetic exposures, aimed separately at the room (bright) and the window (detail) | `src/tone/fusion.ts`, `src/look/render.ts` |
| Finish | Clean whites, vibrance and contrast in Oklab | `src/look/finish.ts` |
| Deghost | Blocks where a frame disagrees with the base frame beyond its noise fall back to the base frame, with soft edges | `src/merge/deghost.ts` |
| Geometry | Lens corrections from the camera's own data (vignetting, distortion, lateral CA) and Upright (vertical lines), in one resampling; the crop keeps native resolution | `src/geometry/` |
| Export | Full-resolution sRGB JPEG (quality 100, no chroma subsampling, camera Exif): the look's coarse levels plus full-resolution detail fused band by band on a pool of workers. Float DNG of the merged raw data for Lightroom | `src/look/detail.ts`, `src/raw/dng.ts` |

Results on set 1 (DSC03495–DSC03499):

- Measured exposure steps are 2.00 EV (ratios 3.997–4.011); EXIF shutter times are off by up to 0.10 EV.
- Noise: about 4 e⁻/DN conversion gain, 1.2–1.4 DN read noise, 13.5 stops per frame; the model predicts pair residuals within 2% (median per pair).
- Frames move 0.07–0.21 px against the base frame, even on a tripod; alignment corrects it.
- The merge spans 20.4 stops with nothing left clipped. The worst mean step at a frame hand-off is 0.18% (0.3% in any region).
- RCD reaches 41.5 dB on synthetic fine detail against 26.1 dB for bilinear, with no zipper on step edges.
- Upright measured the camera at 5.4° pitch and 0.3° roll (with lens distortion undone first) and straightened it while keeping 97% of the frame.
- Deghosting flags 0.02% of the frame (a spot in the window view) and leaves the rest of this static scene alone.
- The full-resolution JPEG is 6780 × 4520 (the Upright and lens crop at native resolution), about 15 MB, in about 12 s on an M1 Pro. Scaled down, it matches the on-screen look within 1 level on average.
- The DNG is 7008 × 4672, 16-bit float, 67 MB, and passes `exiftool -validate`.

## Findings from the sample files

What set 1 showed against the plan below. The tables further down are updated to match.

- **Levels and white balance are not only in the encrypted SR2 block.** The raw IFD stores BlackLevel (512 ×4, tag 0x7310), WB_RGGBLevels (0x7313) and WhiteLevel (16383, 0xC61D) in the clear. SR2 repeats them; its decryption is implemented and checked against ExifTool anyway.
- **SR2's white level (15360) is not the clip.** Data clips at 16383 and stays linear within ±0.2% right up to it.
- **No masked optical-black border is stored.** The pixels outside the active area are image, so the "black level from masked pixels" fallback is impossible. It is not needed.
- **EXIF shutter speeds are rounded.** 1/6 s against 1/25 s implies 4.17×, while the frames measure 4.00×. Measuring ratios from the pixels was the right call.
- **Bracket order is base, darker, lighter, darker, lighter** on the A7C II. Set 1 is 5 frames at 2.0 EV.
- **Tripod brackets still move by 0.1–0.3 px**, so alignment is measured and applied.
- **Shot noise rises about 3.5% per doubling of shutter time**, so the noise model includes an exposure-time term.
- **Electronic front curtain was on**, although the capture settings say mechanical shutter.
- **Set 1 is out of focus for most of the frame.** Edges at the window frame take 12–16 px from 10% to 90%, so demosaic and sharpness cannot be judged on it. Shoot the next set with careful focus.
- **The view outside changes between frames** (clouds, light): exposure ratios differ by up to 2–3% in parts of the window. Deghosting handles the parts that move.
- **The lens corrections are worth applying.** The FE 35mm F1.4 GM at f/8 records 0.7 EV of corner vignetting, 0.5% distortion and up to 0.6 px of lateral CA at full resolution.
- **macOS cannot render floating-point DNGs.** Its raw engine reads the file (an integer copy of the same DNG renders correctly) but draws float data black. Lightroom and Camera Raw read float DNGs (HDRMerge writes the same kind), so they remain the target. Finder and Quick Look show the embedded preview.

## Design decisions

Settled choices, with the reason for each.

| Decision | Choice | Why |
| --- | --- | --- |
| Priority | Best-looking result, not easiest | User requirement |
| Dependencies | No third-party image libraries; own decoder, demosaic, merge, tone map | User requirement |
| Input | Sony ARW, A7C II, **Uncompressed 14-bit** only in phase 1 | Trivial to decode; lossless LJ92 later; lossy cRAW never |
| Platform | Browser: WASM/JS in Workers, WebGPU shaders | Confirmed viable (Viberoom does RAW decode in-browser) |
| Merge domain | Raw Bayer, pre-demosaic (HDR+ style) | Most accurate alignment and ghost detection on tripod sets |
| Exposure ratios | Estimated from overlapping unclipped pixels, not EXIF | Removes seams/banding from shutter-speed inaccuracy |
| Frame order | Sort by measured exposure, not filename | Sony shoots base, darker, lighter |
| White balance | Own auto-WB + manual picker; ignore as-shot WB | As-shot WB is a camera preset (Daylight on set 1), not the room's light |
| Output | Full-resolution JPEG + float DNG now; Ultra HDR gain-map JPEG (ISO 21496-1) later | The JPEG is the deliverable; the DNG keeps it editable; most browsers except Firefox show gain maps |
| Export quality | Native resolution (no upscaling after cropping), JPEG quality 100 with 4:4:4 chroma, sRGB with Exif | User requirement: export original quality |
| Interface | Just the photo by default; one button opens the workspace | User requirement: bare minimal result page |
| Known weak spot | Color | LibRaw-style matrices look flat; need own ColorChecker calibration. Until then: Adobe Standard profile for the same sensor |
| Real-estate look | Bright interior, detailed window, neutral walls, straight verticals by default | What listing photos are judged on |

## Pipeline

Ten stages, in order. Stages 1–6 run on raw Bayer data; demosaicing (7) produces the RGB that 8 onward use.

1. **Decode ARW** (built) — read 14-bit uncompressed CFA, black/white levels, EXIF exposure, CFA pattern.
2. **Black subtraction + clip masks** (built) — per-channel saturation masks, per frame.
3. **Exposure-ratio estimation** (built) — robust fit on pixels unclipped and above noise floor in both frames.
4. **Alignment** (built: global translation) — global homography, then per-tile refinement on exposure-normalized data. Tripod: may be near-identity; verify, don't assume.
5. **Noise-weighted linear merge** (built) — weight = exposure time / noise variance (Granados et al.); prefer longest unclipped exposure.
6. **Reference-frame deghosting** (built) — predict each frame from the reference; residual outside the noise model = motion; fall back to reference with soft masks.
7. **Demosaic** (built: RCD) — own RCD- or AMaZE-class implementation on the merged float CFA.
8. **Color** (built, interim profile) — auto-WB, camera→XYZ matrix (own calibration), then working space.
9. **Tone map** (built: synthetic exposure fusion) — local Laplacian filter (halo-free) or HDR+ synthetic exposure fusion. Lens corrections and Upright resample the image once here.
10. **Export** (built: full-resolution JPEG, float DNG) — the look is fused at a quarter of the linear resolution; the export adds the two finer octaves of the same fusion at full resolution. Ultra HDR gain-map JPEG still to do.

> [!NOTE]
> **Fork:** handheld brackets need sub-pixel warping, which is easier after demosaic. Phase 1 targets tripod only.

## Sony A7C II and ARW facts

> [!WARNING]
> Rows marked "Verified" were checked against set 1. Verify the rest before relying on them.

| Topic | Fact | Confidence |
| --- | --- | --- |
| Bit depth | Uncompressed and lossless compressed are 14-bit in all modes, incl. continuous bracketing; only lossy Compressed RAW drops to 12-bit | Verified for uncompressed bracketing |
| ARW encodings | Uncompressed 14-bit (trivial); lossy cRAW (16-px blocks, 7-bit deltas + tone curve); lossless (tiled LJ92) | High (only uncompressed seen) |
| Levels and WB | Black level, white level and as-shot WB are in the raw IFD in the clear and repeated in the encrypted SR2 block; SR2's 15360 white level is not the clip | Verified |
| Color matrix | ARW has no ready camera→XYZ matrix like DNG; SR2's "ColorMatrix" (0x7800) is a near-identity 3×3 | Verified |
| Buffer | Uncompressed 18 / lossless 27 / compressed 44 frames | High |
| Bracket order | Base, darker, lighter | Verified on the A7C II |
| Bracket limits | 9 frames max 1.0 EV; 3 and 5 frames up to 2.0 or 3.0 EV | 5 × 2.0 EV verified |
| Sensor | Non-stacked, slow readout: electronic shutter gives flicker banding and skew | High |
| Lens correction | Embedded parameters (SR2 tags 0x7032 vignetting, 0x7035 CA, 0x7037 distortion); apply after merge | Verified present and applied (darktable's decoding of the spline) |

## Test data

Three bracket sets were shot on 2026-10-24, five frames each. Set 1 is in `app-samples/` (DSC03495–DSC03499); sets 2 and 3 are not in the project yet.

| Set | Scene | Tests |
| :-: | --- | --- |
| 1 | Indoor room with bright daylight window | Dynamic range, exposure ratios, clipping |
| 2 | Outdoor sky/landscape, sun nearby | Highlight handling, extreme ratios |
| 3 | Movement (trees, people or water) | Deghosting |

### Capture settings

| Setting | Value |
| --- | --- |
| File format | RAW only, Uncompressed |
| Exposure | M mode, ISO 100, f/8 |
| Shutter | Mechanical (set 1 has electronic front curtain on) |
| Drive | Cont. Bracket 5 × 2.0 EV |
| Focus | Manual |
| White balance | Daylight |
| Turned off | SteadyShot, DRO, Long Exposure NR |
| Support | Tripod |

> [!IMPORTANT]
> **Open question:** exact EV step and frame count per set (2.0 vs 3.0 EV). Set 1: 5 frames at 2.0 EV. Sets 2 and 3 are still to be read.

## Roadmap

Each phase ends with a check on the real test files. Rough total: 3–4 months for one strong imaging engineer.

- [x] **Phase 1 — ARW reader.** Parse TIFF/IFD structure, locate CFA data, decode 14-bit uncompressed, decrypt SR2 for levels and WB.\
  *Done when:* bit depth, CFA pattern, black/white levels and exposure match exiftool for all 15 frames. Matches on all 5 frames of set 1; sets 2 and 3 are not in the project yet.
- [x] **Phase 2 — Inspection tool.** Per-frame histograms, clip percentage per channel, measured exposure ratios vs EXIF.\
  *Done when:* ratios sort frames correctly and differ from EXIF by a measured amount. Sorted correctly; EXIF off by up to 0.10 EV.
- [x] **Phase 3 — Noise model.** Fit variance vs signal at ISO 100 from flat regions or a dark-frame/flat-field pair.\
  *Done when:* model predicts residuals on static regions. Within 2% per pair (median), checked in tests.
- [x] **Phase 4 — Merge.** Alignment check + noise-weighted linear Bayer merge.\
  *Done when:* no seams on set 1; float output viewable. Mean hand-off step ≤ 0.18%.
- [x] **Phase 5 — Demosaic + preview.** RCD first; simple exposure-scaled sRGB preview.\
  *Done when:* no zipper or maze artifacts on fine detail. Verified on synthetic detail; set 1 is too soft to show demosaic artifacts.
- [ ] **Phase 6 — Float DNG export.** Built: 16-bit float CFA, colour matrices, white balance, Exif and a preview of the look; validates with exiftool.\
  *Done when:* Lightroom opens it and it edits like a normal raw. Needs a Lightroom check.
- [ ] **Phase 7 — Deghosting.** Built: reference-frame fallback with soft masks, an on/off switch and an overlay of what it changed; tested on a synthetic moving subject.\
  *Done when:* set 3 shows no ghosts vs Lightroom. Needs set 3.
- [ ] **Phase 8 — Tone mapping.** Local Laplacian on GPU.\
  *Done when:* no halos at window edges in set 1. Synthetic exposure fusion is in place; local Laplacian on the GPU is still open.
- [ ] **Phase 9 — Color calibration.** ColorChecker shots, fit matrix/LUT. Needs the physical body. Until then the Adobe Standard profile for the A7 IV (same sensor) is used.
- [ ] **Phase 10 — Ultra HDR export, LJ92 lossless decoder, handheld path.**

Real-estate finishing, added alongside:

- [x] Camera colour through a DNG camera profile (matrices, hue/sat map, look table)
- [x] Interior auto white balance (walls neutral), presets and a white-wall picker
- [x] Tone with separate room and window targets; brightness, window pull, contrast
- [x] Clean whites, vibrance
- [x] Upright (vertical lines)
- [x] Lens corrections from the embedded distortion, vignetting and CA parameters
- [x] Full-resolution JPEG export (full, half or small), quality 100 with Exif
- [x] Minimal result page: the photo, a download button on hover, one button for the workspace
- [ ] Local white balance for mixed daylight and tungsten

## Constraints and risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Memory | One 33 MP float32 RGB frame ≈ 400 MB; five frames exceed tab limits (iOS Safari tightest). The worker holds about 600 MB for set 1 | Merge on single-channel CFA (¼ the size); the full-resolution export renders 64-row bands on workers and never holds a full float RGB image |
| Color quality | Biggest gap vs Lightroom/Capture One, larger than any merge difference | Own ColorChecker calibration; DNG export as primary deliverable meanwhile; Adobe Standard profile for now |
| SR2 decryption | Resolved: decryption implemented; levels and WB are also stored in the clear | — |
| File System Access API | Missing in Safari, Firefox, all iOS browsers | Plain file input + download (in use) |
| Gain-map display | Firefox lacks ISO 21496-1 support | SDR base image is the fallback |
| Deghosting | Hardest part to match commercial tools | Tripod-first scope; optional ML masks later via WebGPU |
| Speed | About 20 s from drop to the finished photo for a 5-frame set in Chrome; 12 s more for the full-resolution JPEG on 7 workers | Parallel decode, WebGPU for merge and tone |

## Validation

Success = winning blind comparisons against Lightroom Merge to HDR and Photomatix on about 30 hard bracket sets.

- Mix: bright windows, foliage in wind, water, people, sun in frame, handheld.
- Compare the same tone-mapped look, judged blind, at 100% and full view.
- Check specifically: seams at clip transitions, halos, ghosts, shadow noise, color.
- The three sets shot on 2026-10-24 are the first entries.

## Project layout

```text
src/raw/         ARW and TIFF reading, Sony SR2 decryption; DNG, TIFF and JPEG Exif writing
src/analysis/    statistics, exposure ratios, noise model, previews
src/merge/       alignment, raw merge, deghosting, seam check, binning
src/demosaic/    RCD and bilinear
src/color/       camera profiles (.dcp), DNG colour maths, white balance
src/tone/        exposure fusion
src/look/        real-estate rendering and finishing; full-resolution detail (detail.ts)
src/geometry/    lens corrections and Upright
src/worker/      the pipeline worker, the render-worker pool and their messages
src/ui/          the app: the photo view, and the workspace (viewer, inspector, charts)
test/            unit tests (node --test), exiftool fixtures
e2e/             Playwright tests
scripts/         command-line tools
```

`src/color/profiles/Sony ILCE-7M4 Adobe Standard.dcp` is Adobe's Adobe Standard profile for the A7 IV, which uses the same 33 MP sensor as the A7C II. It was copied from Adobe Camera Raw; its ProfileEmbedPolicy is "allow copying". Replace it with your own calibration in Phase 9.

## References

- [Sony: RAW bit depth by model and mode](https://www.sony.co.th/en/electronics/support/articles/00229990)
- [Sony: ILCE-7CM2 RAW bit depth](https://www.sony.com.my/electronics/support/e-mount-body-ilce-7-series/ilce-7cm2l/articles/00229990)
- [pixls.us: A7C II support thread (owner bit-depth report)](https://discuss.pixls.us/t/support-for-ilce-7cm2/39621)
- [Sony help guide: RAW file type](https://helpguide.sony.net/ilc/2360/v1/en/contents/0404I_raw_file_type.html)
- [Sony help guide: continuous bracketing](https://helpguide.sony.net/ilc/2360/v1/en/contents/0407_drivemode_cont_bracket.html)
- [Sony help guide: D-Range Optimizer](https://helpguide.sony.net/ilc/2360/v1/en/contents/0409B_d_range_optimizer.html)
- [libraw-wasm](https://github.com/colorhythm/libraw-wasm) (reference only)
- [Viberoom: in-browser RAW development](https://glama.ai/mcp/servers/RatulMaharaj/viberoom)
- [HDR deghosting research (arXiv)](https://arxiv.org/pdf/2608.28674)
- [Firefox gain-map support request](https://connect.mozilla.org/t5/ideas/support-iso-21496-1-the-hdr-over-jpg-standard-via-gain-map-with/idc-p/138459)

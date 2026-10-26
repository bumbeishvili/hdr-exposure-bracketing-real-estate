# HDR Merger

A browser-based HDR merger for bracketed Sony A7C II ARW files, finished for real-estate photography: bright interiors, readable window views, clean white walls and straight verticals. It aims to beat Lightroom's Merge to HDR on tripod brackets, using no third-party image libraries.

> [!NOTE]
> **Status as of 25 Oct 2026: phases 1–7 built and tested on bracket set 1 and a second, focused room bracket, plus a real-estate finishing stage, also tried on 11 public single-frame Sony raws.**
>
> - **Done:** ARW reader with SR2 decryption, inspection tool, noise model, sub-pixel alignment, noise-weighted raw merge with deghosting, RCD demosaic, the finished look (camera colour profile, interior/exterior detection, auto white balance, evened-out wall light, local Laplacian tone mapping, a window pull over the panes their frames enclose, highlight recovery, warm clean whites, lens corrections, Upright; exposure levels measured from professional listing photos), single frames, full-resolution JPEG export and float DNG export.
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

1. Drop the ARW files of one bracket, or a single ARW (or click the drop area). A thin line at the top shows progress over a dimmed preview of the base frame. Files of several brackets (a whole folder) are split by the camera's shot counter and capture time; one bracket is merged and a line under the photo offers the others.
2. After about 23 s the finished photo appears. It sharpens once more a few seconds later on high-density screens.
3. Hover the photo and click the download icon for the full-resolution JPEG (about 11 s).

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
| Brackets | The files of a selection grouped into brackets (the camera's shot counter starting again, a pause longer than a bracket takes, another image size), so frames of different scenes are never merged | `src/analysis/brackets.ts` |
| Merge | Inverse-variance weighted average on the raw Bayer data, smooth roll-off near clipping (alike for the four samples of each Bayer quad, so a pixel's colours come from the same frames), seam check. A single frame passes through with a nominal noise model | `src/merge/merge.ts`, `seams.ts` |
| Demosaic | RCD on padded tiles; 100% view demosaics on demand (bilinear available for comparison) | `src/demosaic/` |
| Colour | DNG-spec rendering with a camera profile (.dcp). White balance from the walls in rooms when the camera's own auto measurement agrees, the camera's measurement otherwise; click-a-white-wall picker | `src/color/`, `src/look/render.ts` |
| Scene | Interior or exterior, from the metered exposure (EV at ISO 100), how much of the frame is near-neutral wall, and open sky along the top edge. Interiors get the window pull and exposure from the walls; exteriors keep the camera's exposure, nudged towards a bright midtone. Switchable in the workspace | `src/look/render.ts` |
| Highlights | Light clipped in every frame (a single exposure's window, the sun) is raised to neutral white before the colour transform, which would otherwise turn it magenta, and left out of the window pull | `src/look/render.ts`, `detail.ts` |
| Window pull | The view through the glass is exposed for its bright part (sky, sunlit facades) just below the walls. Its region is what the panes' frames enclose: each pane is found from its bright glass (much brighter than the walls, containing real exterior light) and bounded by the frame's straight edges — the one straight step in light that runs a side's whole length, with the frame alike beyond it; the view's own lines do not, and a lit bevel or lip beyond the glass edge is a smaller step — fitted to a fraction of a pixel through each row's edge. So the corners are square and a shaded courtyard, a dark car or a facade as dark as the frame is in the view, whatever the brightness says. Where no frame shows (a curtain or a bed hides it), the pane ends at what stands in front of the glass, and that is left out: it is outside the bright glass and joins the side where no frame shows, or covers the frame where it crosses it. Along those edges the edge is measured across the contour (half-way in linear light between it and the view) and smoothed along it, and a darker strip of view along a bed is followed out to the bed. The view's share of each pixel is the glass blurred like the photo; only that share is darkened, in linear RGB against the colour just outside (the frame, or a curtain or bed in front of the glass), so the frame keeps its own colour. Room surfaces the window lights directly (frames, sills, the top of a bed) are then evened out like the walls, so they do not glow against the darker view; a lamp's glow is left alone. The full-resolution export applies the same edge per pixel | `src/look/render.ts`, `detail.ts` |
| Tone | The light on the walls evened out, as flash or local edits do in professional work: the illumination is estimated from the walls themselves and 70% of its variation removed, and every object takes the walls' gain. Then local Laplacian tone mapping (Lightroom's Highlights/Shadows/Clarity operator), halo-free; exposure puts the walls' median at L* 83; tones below the walls deepened only slightly; highlights roll off from 0.55 so the walls lit by the windows stay below L* 92 | `src/tone/llf.ts`, `src/look/render.ts` |
| Finish | Clean whites (towards the slightly warm white of professionally edited walls), vibrance and a touch of contrast in Oklab | `src/look/finish.ts` |
| Deghost | Blocks where a frame disagrees with the base frame beyond its noise fall back to the base frame, with soft edges. The comparison uses the samples neither frame has near clipping, so a frame clipped over most of a block (a bright lawn) is still checked on its darker samples there (a person on it) | `src/merge/deghost.ts` |
| Geometry | Lens corrections from the camera's own data (vignetting, distortion, lateral CA) and Upright: vertical edges traced at sub-pixel precision, a robust vanishing-point fit, checked by mapping the lines back through the correction. One resampling; the crop keeps native resolution | `src/geometry/` |
| Export | Full-resolution sRGB JPEG (quality 100, no chroma subsampling, camera Exif): the look's coarse levels plus full-resolution detail fused band by band on a pool of workers. Float DNG of the merged raw data for Lightroom | `src/look/detail.ts`, `src/raw/dng.ts` |

Results on set 1 (DSC03495–DSC03499):

- Measured exposure steps are 2.00 EV (ratios 3.997–4.011); EXIF shutter times are off by up to 0.10 EV.
- Noise: about 4 e⁻/DN conversion gain, 1.2–1.4 DN read noise, 13.5 stops per frame; the model predicts pair residuals within 2% (median per pair).
- Frames move 0.07–0.21 px against the base frame, even on a tripod; alignment corrects it.
- The merge spans 20.4 stops with nothing left clipped. The worst mean step at a frame hand-off is 0.18% (0.3% in any region).
- RCD reaches 41.5 dB on synthetic fine detail against 26.1 dB for bilinear, with no zipper on step edges.
- Upright measured the camera at −3.9° pitch and 0.3° roll (with lens distortion undone first). After correction the window frame and wall corners measure within 0.1° of vertical, keeping 97% of the frame.
- The walls land at L* 82 (the wall right of the window) and 76 (the shaded left wall), slightly warm (b* 0 to +2); 2.0% of the image is above L* 92 and none above 97, 1.5% is below L* 20, and the 95th percentile is L* 90. The window pull darkens the view by 5.0 stops: its sky at L* 65–88, the buildings at 50–52. The bedspread lands at L* 62, the curtain at 40.
- The bedspread's top, lit straight from the window, renders light teal at L* 83–89 (it came out near white, L* 89–93 with half the colour, against the darkened view); the mullion and the frame beside the right pane at L* 89 and 92 instead of 92 and 96.
- The glass edge's blur measures 1.6 px at a quarter of full size, 3.1 px at half and 6.6 px at full size (the edge profiles of set 1's out-of-focus window), and the edges run straight and as soft as the rest of the photo: no torn edges, pink or cyan fringes, cut-outs or glow (checked as luminance profiles across each edge, at 1:1 on the screen render and in the full-resolution export).
- On the focused room bracket (DSC03500–DSC03504) every pane is a clean quadrilateral to its corners: the dark facades in the corners by the mullion, the shaded courtyard, the red facade, the cars and the garage entrance are pulled with the rest of the view (they came out as white cut-outs and white corner blobs), and the frame's lit lip next to the glass stays frame (it came out as a dark line along the mullion). Where the curtain hides the panes' right sides the edge follows the curtain. The ceiling lamp keeps its glow.
- The focused bracket's tones: 3.8% of the frame above L* 92, 1.7% below L* 20, the 95th percentile at L* 91.
- The people crossing the courtyard during the bracket come from one frame: the brightest frame, clipped on the lawn around them, had escaped the motion check and painted them again where it saw them, in green and magenta where only some of a pixel's colours came from it.
- Deghosting flags 0.09% of the frame (spots in the window view and along its edges) and leaves the rest of this static scene alone. On the focused room bracket it flags 1.9%: the people in the courtyard, a crane turning during the bracket (its colour fringes are gone too) and the glass's edges, where the brightest frames give way to the darker ones.
- The full-resolution JPEG is 6808 × 4540 (the Upright and lens crop at native resolution), about 16 MB, in about 11 s on an M1 Pro. Scaled down, it matches the on-screen look within 1 level on average.
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
- **Set 1 is out of focus for most of the frame.** Edges at the window frame take about 17 px from 10% to 90% at full resolution (a blur of σ = 6.6 px), so demosaic and sharpness cannot be judged on it. Shoot the next set with careful focus.
- **The view outside changes between frames** (clouds, light): exposure ratios differ by up to 2–3% in parts of the window. Deghosting handles the parts that move.
- **The first Upright doubled the tilt.** Its input was read at the wrong size after the lens crop and the Hough fit was coarse, so the "correction" leaned verticals twice as far. It is now measured independently on the output: each long edge is fitted on its own.
- **A daylit window jamb is as bright as a shaded facade outside** (+2.5 stops). Glass is recognised by containing real exterior light (sky or sunlit facades, 3+ stops above the walls), not by brightness alone.
- **Out-of-focus bloom spreads the view's light onto the frame** (up to 1.8× the wall level for 60 px at full resolution). It is dimmed with the view, otherwise it shows as a white band once the view is pulled down.
- **The lens corrections are worth applying.** The FE 35mm F1.4 GM at f/8 records 0.7 EV of corner vignetting, 0.5% distortion and up to 0.6 px of lateral CA at full resolution.
- **The camera's own auto white balance is in every file.** SR2 tag 0x7312 holds the camera's AWB measurement even when a preset was set: 6044 K / +35 on set 1, against 5989 K / +37 from the walls and 5392 K for the Daylight preset.
- **The interior assumptions break outdoors.** On public Sony raws the walls-based white balance read a sunlit lawn as 10979 K (orange), and exposing for "walls" blew out foliage. Rooms meter at EV100 5–10.5 with 30% or more of the frame near-neutral; the outdoor samples metered 8.6–12.6 with 0–22%. Hence the scene detection and the camera's measurement as the fallback.
- **Clipped light turns magenta when it is pulled down.** Set 1's base frame alone has 10.6% clipped (the window); darkened by the window pull it rendered hot pink, because green clips first and white balance lifts red and blue. Brackets avoid it (the darkest frame clips nowhere); single frames need the highlight recovery.
- **Professional interiors do not put walls near white.** Six finished listing photos from an editing service measure median L* 50–81, 95th percentile 78–91, 99th 93–98, and 0–1% of pixels above L* 97; their walls sit evenly at L* 79–89 with a slight warmth (b* +1.7 to +2.2), and the view through a window at L* 51–57, well below the walls. The first look here had 12% near white and walls from L* 54 to 99. The exposure targets now come from these measurements.
- **Mild contrast steps add up to a harsh look.** Deepening the tones below the walls by up to 35%, a highlight shoulder from 0.65 and a 0.15 S-curve at the end each looked moderate alone. Together they put 19% of set 1's frame above L* 92 (the walls beside the window, the frame) and 3.2% below L* 20, with about 20–30% more mid-scale local contrast than the listing photos (band-pass RMS of L* at 8–32 px, 1024 px wide). The listing photos have 1.5–3.8% above L* 92 and 0.6–2.5% below L* 20. With 10% deepening, the shoulder from 0.55 and a 0.05 S-curve, set 1 has 2.8% and 1.5%, and its local contrast is within the listing photos' range.
- **The light on the walls varies by more than a stop** across set 1's room (the 30th to 90th percentile of wall luminance spans 1.35 stops). A global exposure either greys the shaded walls or blows out those beside the window; evening the light out first is what makes the walls read as one clean white.
- **A soft mask refined on log luminance sits off the glass edge.** At a blurred frame/view edge its 0.5 contour lies where L = √(F·V), not where the view makes up half the light, and a dark balcony against the frame dents it. The edge is measured instead.
- **Deciding glass from frame pixel by pixel tears the edge.** Taking each edge pixel's view share from its brightness, α = (L − F)/(V − F), follows the view's content: a dark balcony against the frame read as frame and stayed white (torn, toothed edges); a red facade along the frame, darker than the rest of the view, read as mostly frame and came out at frame brightness in its own red, as pink; and the switch to the full pull a few pixels in cut hard shapes into it. Under a 5-stop pull every such error shows. The edge is now geometric: measured across the contour, straightened along the frame, blurred like the photo.
- **The pull has to work in colour.** Darkening a pixel's luminance keeps its chromaticity, so frame pixels lit partly by a red facade or by the sky turned pink or cyan once their brightness came down. Subtracting the view's share in RGB, against the colour just outside, keeps the frame white and the bed teal.
- **The lens blur at the glass edge is a clean step that scales with resolution.** On set 1 it measures σ = 1.6 px at a quarter of full size, 3.1 px at half and 6.6 px at full, so the edge measured on the quarter-size render carries to every output size.
- **Light near the window fools level matching.** The window lights the inner frame and the bed beside it, so a frame next to a curtain can be brighter than the room by more than half a stop and the bed's folds near the window as bright as the view's blur on it. The edge is the steepest outward fall near the contour, not the first fall to room level, and the colour outside is matched against what borders each edge pixel, not against whatever is as bright as it.
- **View can be darker than a frame the sky lights.** The focused room bracket's shaded courtyard and red facade sit 0.8–1.5 stops above its walls; set 1's sky-lit frames reach 1.1–1.3. No brightness threshold separates them, in either photo: the frames in the band just outside the glass reach +0.9 to +1.2 in both. The frame does: a pane is the quadrilateral its frame's straight edges enclose.
- **Rules about regions fail at the corners.** Completing the panes region by region (inside a pane's box, what stops at the frame is view) left white blobs in the corners by the mullion: a facade there as grey as the frame read as carrying on past the box. Under a 5-stop pull every misread region shows. Finding the frame's lines instead, the corners are where they meet.
- **A frame's lit bevel can pass for view, and a strip of view for a lip.** Set 1's opening sash has a 10 px bevel (at a quarter of full size) lit by the window to 1.5–2.9 stops above the walls, above the glass threshold; the focused bracket's view ends in a kerb-like strip along the transom. Both put two straight steps along the side a few pixels apart. The glass edge is the larger: view against frame, not frame against frame or view against view.
- **A clipped frame was never checked for motion.** The motion test skipped any block where a frame had clipped samples; the brightest frame clips on the bright lawn, so its samples of the people walking there — dark, unclipped — kept full weight wherever it saw them. Per-sample clipping also let green come from other frames than red and blue, which turned the ghosts green and magenta.
- **Fly screens alias on the sensor.** A screen's mesh over a pane comes out as a herringbone pattern with blue and yellow stripes, in the camera's own JPEG as much as here. A median on the colour differences (raw converters' false-colour suppression) removed the thin red of a crane's lattice before it dented the pattern, so it is not applied.
- **A bed in front of a window outshines the darkened view.** Its top, lit straight from the window, is 0.7 stop above the walls and the rest of the bed 0.6 to 1.3 below; with the view 5 stops darker it came out as white foam along the panes. Evening that light out against the same bed further from the window, as the walls' light is evened out, gives it back its colour.
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
| White balance | Walls-based auto WB in rooms when the camera's own AWB measurement agrees (within 60 mired and 20 tint); the camera's measurement otherwise and outdoors; manual picker | As-shot WB is a camera preset (Daylight on set 1), not the room's light; the walls estimate is the better one indoors but misfires on foliage |
| Scenes | Interior or exterior detected per image, overridable | Interiors and exteriors need different exposure logic, and the window pull must never touch a sky |
| Output | Full-resolution JPEG + float DNG now; Ultra HDR gain-map JPEG (ISO 21496-1) later | The JPEG is the deliverable; the DNG keeps it editable; most browsers except Firefox show gain maps |
| Export quality | Native resolution (no upscaling after cropping), JPEG quality 100 with 4:4:4 chroma, sRGB with Exif | User requirement: export original quality |
| Interface | Just the photo by default; one button opens the workspace | User requirement: bare minimal result page |
| Known weak spot | Color | LibRaw-style matrices look flat; need own ColorChecker calibration. Until then: Adobe Standard profile for the same sensor |
| Real-estate look | Bright, evenly lit interior, natural window view, clean warm-white walls, straight verticals by default | What listing photos are judged on |
| Exposure targets | Measured from professional listing photos: walls' median L* 83, 2–4% of the frame above L* 92 and about 2% below L* 20, the view's bright part just below the walls | A look tuned by eye had walls from L* 54 to 99 and 12% blown, and stacked contrast steps later made the room look harsh; the references settle what "bright and airy" means in numbers |
| Tone mapping | Wall light evened out, then local Laplacian filtering, plus a window pull along the measured glass edge; not exposure fusion | Fusion looked flat and grey with a hazy view; the local Laplacian is the operator behind Lightroom's tone controls and is halo-free when the remap is symmetric and the pyramid goes to one pixel; it cannot even out a 1-stop light falloff on walls without flattening everything else |

## Pipeline

Ten stages, in order. Stages 1–6 run on raw Bayer data; demosaicing (7) produces the RGB that 8 onward use.

1. **Decode ARW** (built) — read 14-bit uncompressed CFA, black/white levels, EXIF exposure, CFA pattern.
2. **Black subtraction + clip masks** (built) — per-channel saturation masks, per frame.
3. **Exposure-ratio estimation** (built) — robust fit on pixels unclipped and above noise floor in both frames.
4. **Alignment** (built: global translation) — global homography, then per-tile refinement on exposure-normalized data. Tripod: may be near-identity; verify, don't assume.
5. **Noise-weighted linear merge** (built) — weight = exposure time / noise variance (Granados et al.); prefer longest unclipped exposure.
6. **Reference-frame deghosting** (built) — predict each frame from the reference on the samples neither has near clipping; residual outside the noise model = motion; fall back to reference with soft masks.
7. **Demosaic** (built: RCD) — own RCD- or AMaZE-class implementation on the merged float CFA.
8. **Color** (built, interim profile) — auto-WB, camera→XYZ matrix (own calibration), then working space.
9. **Tone map** (built: window pull + local Laplacian) — the view through the windows (the panes their frames enclose) is pulled down in linear RGB through its share of each pixel (the glass edge, blurred like the photo), then local Laplacian filtering compresses the remaining range halo-free. Lens corrections and Upright resample the image once here.
10. **Export** (built: full-resolution JPEG, float DNG) — the look is computed at a quarter of the linear resolution; the export applies the window pull per pixel from the measured edge (its distance scaled up, its blur at full size) and carries the tone mapping across as a gain, upsampled along the full-size image's own edges. Ultra HDR gain-map JPEG still to do.

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

Three bracket sets were shot on 2026-10-24, five frames each. Set 1 is in `app-samples/` (DSC03495–DSC03499); sets 2 and 3 are not in the project yet. A second room bracket, in focus (DSC03500–DSC03504: the same room towards a full-height window with a fly screen, a curtain over its right side, a ceiling lamp in view, people crossing the courtyard), was shot the next day and is not in the project either. The folder it came in holds set 1 too; dropped together, the two brackets are told apart and merged separately.

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

### Public samples

Twelve uncompressed-raw samples from [raw.pixls.us](https://raw.pixls.us) cover what set 1 does not: exteriors, foliage, a glass facade, a colour chart under tungsten. They are single frames from the A7C II (×2), A7 IV (×2), A7 III, A7R II, A7R III, A7R IVa, A9, A9 II, A1 and A7. Keep them in `app-samples/raw.pixls.us/<model>/` (gitignored); `e2e/single-frame.spec.ts` uses the A7C II landscape.

- 11 decode and render. The A7 file is in fact compressed and is rejected with a message.
- Nine are detected as exteriors. The colour chart reads as an interior, like set 1, and so do the two A7 IV street scenes (EV100 8.6–9.3), which the interior path renders well.
- Exteriors against the camera's own JPEG: median L* 52–55 against 41–60, highlights at the same level, chroma within 2 on the A7C II files. The other bodies are rendered with the A7 IV profile, so their colour is only approximate.
- A single frame's full-resolution export matches the on-screen render (median within 6 levels).

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
- [ ] **Phase 7 — Deghosting.** Built: reference-frame fallback with soft masks, an on/off switch and an overlay of what it changed; tested on synthetic moving subjects (one against a lawn that the long frame clips) and the people crossing the focused room bracket's courtyard.\
  *Done when:* set 3 shows no ghosts vs Lightroom. Needs set 3.
- [x] **Phase 8 — Tone mapping.** Local Laplacian (on the CPU) with a window pull along the measured glass edge.\
  *Done when:* no halos at window edges in set 1. Checked at 1:1 in the full-resolution export and with synthetic step tests (overshoot under 0.1 stop). Moving it to the GPU is still open.
- [ ] **Phase 9 — Color calibration.** ColorChecker shots, fit matrix/LUT. Needs the physical body. Until then the Adobe Standard profile for the A7 IV (same sensor) is used.
- [ ] **Phase 10 — Ultra HDR export, LJ92 lossless decoder, handheld path.**

Real-estate finishing, added alongside:

- [x] Camera colour through a DNG camera profile (matrices, hue/sat map, look table)
- [x] Interior auto white balance (walls neutral), presets and a white-wall picker
- [x] Tone with separate room and window targets; brightness, window pull, contrast
- [x] Even wall light; exposure and highlight levels from professional references
- [x] Panes from their frames' straight edges, square to the corners; what stands in front of the glass left out
- [x] Measured glass edge: straight along frames, as soft as the photo; no torn edges, colour fringes, glow or ring
- [x] Clean whites (slightly warm), vibrance
- [x] Upright (vertical lines)
- [x] Lens corrections from the embedded distortion, vignetting and CA parameters
- [x] Full-resolution JPEG export (full, half or small), quality 100 with Exif
- [x] Minimal result page: the photo, a download button on hover, one button for the workspace
- [x] Interior/exterior detection, the camera's white balance outdoors, highlight recovery
- [x] Single frames (no bracket)
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
| Scene detection | Twilight exteriors (EV100 under 9.5, lit windows) read as interiors; no sky replacement | Interior/Exterior switch in the workspace |
| Speed | About 23 s from drop to the finished photo for a 5-frame set in Chrome; 11 s more for the full-resolution JPEG on 7 workers | Parallel decode, WebGPU for merge and tone |
| Window edge | Frame sides are lines; along a bed or curtain in front of the glass the edge follows measurements at a quarter of full size, which wander by a pixel where view detail beside the edge is narrower than the blur (4 at full size), and a darker strip of view along a bed is only followed out when it is still brighter than any room surface. A pane is found from its bright glass: one whose view is dark along a whole side for more than 4% of the image width beyond its bright part, or a curved pane, is bounded by that bright part there; something standing wholly inside a pane, touching neither the frame nor anything outside it, is taken for view; frames lit as brightly as the sky would join panes into one. On an out-of-focus edge, the dark seal between a lit bevel and the view (bright with the view's glare and a colour fringe) stays with the frame: set 1's sash bevel reads about 3 px wider | Measure on the half-size image for exports; a manual brush, as editors use |

## Validation

Success = winning blind comparisons against Lightroom Merge to HDR and Photomatix on about 30 hard bracket sets.

- Mix: bright windows, foliage in wind, water, people, sun in frame, handheld.
- Compare the same tone-mapped look, judged blind, at 100% and full view.
- Check specifically: seams at clip transitions, halos, ghosts, shadow noise, color.
- The three sets shot on 2026-10-24 are the first entries.

## Project layout

```text
src/raw/         ARW and TIFF reading, Sony SR2 decryption; DNG, TIFF and JPEG Exif writing
src/analysis/    statistics, exposure ratios, noise model, previews, brackets in a selection
src/merge/       alignment, raw merge, deghosting, seam check, binning
src/demosaic/    RCD and bilinear
src/color/       camera profiles (.dcp), DNG colour maths, white balance
src/tone/        local Laplacian filter, guided filter, pyramids
src/look/        real-estate rendering and finishing; window panes (panes.ts); full-resolution detail (detail.ts)
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

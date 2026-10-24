# HDR Merger

A browser-based HDR merger for bracketed Sony A7C II ARW files. It aims to beat Lightroom's Merge to HDR on tripod brackets, using no third-party image libraries.

> [!NOTE]
> **Status as of 24 Oct 2026: planning done, no code yet.**
>
> - **Done:** software survey, feasibility research, pipeline design, camera configured, three test bracket sets shot.
> - **Next:** upload one bracket set and write the uncompressed ARW reader ([Phase 1](#roadmap)).

**Contents:** [Design decisions](#design-decisions) · [Pipeline](#pipeline) · [Camera and ARW facts](#sony-a7c-ii-and-arw-facts) · [Test data](#test-data) · [Roadmap](#roadmap) · [Risks](#constraints-and-risks) · [Validation](#validation) · [Development](#development) · [References](#references)

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
| White balance | Own auto-WB + manual picker; ignore as-shot WB | WB is metadata only; Sony's is in encrypted SR2 |
| Output | Ultra HDR gain-map JPEG (ISO 21496-1) + float DNG | All major browsers except Firefox show gain maps; DNG keeps it editable |
| Known weak spot | Color | LibRaw-style matrices look flat; need own ColorChecker calibration |

## Pipeline

Ten stages, in order. Stages 1–5 run on raw Bayer data; 6 onward on RGB.

1. **Decode ARW** — read 14-bit uncompressed CFA, black/white levels, EXIF exposure, CFA pattern.
2. **Black subtraction + clip masks** — per-channel saturation masks, per frame.
3. **Exposure-ratio estimation** — robust fit on pixels unclipped and above noise floor in both frames.
4. **Alignment** — global homography, then per-tile refinement on exposure-normalized data. Tripod: may be near-identity; verify, don't assume.
5. **Noise-weighted linear merge** — weight = exposure time / noise variance (Granados et al.); prefer longest unclipped exposure.
6. **Reference-frame deghosting** — predict each frame from the reference; residual outside the noise model = motion; fall back to reference with soft masks.
7. **Demosaic** — own RCD- or AMaZE-class implementation on the merged float CFA.
8. **Color** — auto-WB, camera→XYZ matrix (own calibration), then working space.
9. **Tone map** — local Laplacian filter (halo-free) or HDR+ synthetic exposure fusion.
10. **Export** — float DNG (linear, editable) and Ultra HDR gain-map JPEG.

> [!NOTE]
> **Fork:** handheld brackets need sub-pixel warping, which is easier after demosaic. Phase 1 targets tripod only.

## Sony A7C II and ARW facts

> [!WARNING]
> Verify every row against the real files before relying on it.

| Topic | Fact | Confidence |
| --- | --- | --- |
| Bit depth | Uncompressed and lossless compressed are 14-bit in all modes, incl. continuous bracketing; only lossy Compressed RAW drops to 12-bit | High (Sony table + owner report) |
| ARW encodings | Uncompressed 14-bit (trivial); lossy cRAW (16-px blocks, 7-bit deltas + tone curve); lossless (tiled LJ92) | High |
| Levels and WB | Black/white levels and as-shot WB sit in Sony's encrypted SR2 private block | High |
| Color matrix | ARW has no ready camera→XYZ matrix like DNG | High |
| Buffer | Uncompressed 18 / lossless 27 / compressed 44 frames | High |
| Bracket order | Base, darker, lighter | Medium (older bodies) |
| Bracket limits | 9 frames max 1.0 EV; 3 and 5 frames up to 2.0 or 3.0 EV | Medium (older bodies) |
| Sensor | Non-stacked, slow readout: electronic shutter gives flicker banding and skew | High |
| Lens correction | Embedded parameters; apply after merge | Medium |

## Test data

Three bracket sets were shot on 2026-10-24, five frames each.

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
| Shutter | Mechanical |
| Drive | Cont. Bracket 5 × 2.0 EV |
| Focus | Manual |
| White balance | Daylight |
| Turned off | SteadyShot, DRO, Long Exposure NR |
| Support | Tripod |

> [!IMPORTANT]
> **Open question:** exact EV step and frame count per set (2.0 vs 3.0 EV) — read from the files.

## Roadmap

Each phase ends with a check on the real test files. Rough total: 3–4 months for one strong imaging engineer.

- [ ] **Phase 1 — ARW reader.** Parse TIFF/IFD structure, locate CFA data, decode 14-bit uncompressed, decrypt SR2 for levels and WB.\
  *Done when:* bit depth, CFA pattern, black/white levels and exposure match exiftool for all 15 frames.
- [ ] **Phase 2 — Inspection tool.** Per-frame histograms, clip percentage per channel, measured exposure ratios vs EXIF.\
  *Done when:* ratios sort frames correctly and differ from EXIF by a measured amount.
- [ ] **Phase 3 — Noise model.** Fit variance vs signal at ISO 100 from flat regions or a dark-frame/flat-field pair.\
  *Done when:* model predicts residuals on static regions.
- [ ] **Phase 4 — Merge.** Alignment check + noise-weighted linear Bayer merge.\
  *Done when:* no seams on set 1; float output viewable.
- [ ] **Phase 5 — Demosaic + preview.** RCD first; simple exposure-scaled sRGB preview.\
  *Done when:* no zipper or maze artifacts on fine detail.
- [ ] **Phase 6 — Float DNG export.**\
  *Done when:* Lightroom opens it and it edits like a normal raw.
- [ ] **Phase 7 — Deghosting.**\
  *Done when:* set 3 shows no ghosts vs Lightroom.
- [ ] **Phase 8 — Tone mapping.** Local Laplacian on GPU.\
  *Done when:* no halos at window edges in set 1.
- [ ] **Phase 9 — Color calibration.** ColorChecker shots, fit matrix/LUT. Needs the physical body.
- [ ] **Phase 10 — Ultra HDR export, LJ92 lossless decoder, handheld path.**

## Constraints and risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Memory | One 33 MP float32 RGB frame ≈ 400 MB; five frames exceed tab limits (iOS Safari tightest) | Merge on single-channel CFA (¼ the size), tile processing, float16 where safe |
| Color quality | Biggest gap vs Lightroom/Capture One, larger than any merge difference | Own ColorChecker calibration; DNG export as primary deliverable meanwhile |
| SR2 decryption | Levels and WB unavailable until solved | Fallback: read black level from masked border pixels; white level from histogram peak |
| File System Access API | Missing in Safari, Firefox, all iOS browsers | Plain file input + download |
| Gain-map display | Firefox lacks ISO 21496-1 support | SDR base image is the fallback |
| Deghosting | Hardest part to match commercial tools | Tripod-first scope; optional ML masks later via WebGPU |

## Validation

Success = winning blind comparisons against Lightroom Merge to HDR and Photomatix on about 30 hard bracket sets.

- Mix: bright windows, foliage in wind, water, people, sun in frame, handheld.
- Compare the same tone-mapped look, judged blind, at 100% and full view.
- Check specifically: seams at clip transitions, halos, ghosts, shadow noise, color.
- The three sets shot on 2026-10-24 are the first entries.

## Development

To start [Phase 1](#roadmap), paste the kickoff prompt into a new session along with this README and one bracket set (5 ARW files, or the darkest and brightest if size is a problem).

<details>
<summary><strong>Kickoff prompt</strong></summary>

```text
I'm building a browser-based HDR merger for Sony A7C II bracketed ARW files,
quality-first, no third-party image libraries. The attached README has the
design decisions, pipeline and roadmap.

Start Phase 1: write an uncompressed 14-bit ARW reader in TypeScript (runs in
a Web Worker, also runnable in Node for testing).

1. Inspect the attached ARW files: IFD structure, compression tag, bit depth,
   CFA pattern, dimensions, EXIF exposure, SR2 location.
2. Report black/white levels, per-channel clip percentages and measured
   exposure ratios vs EXIF for each frame.
3. Then write the reader with tests against these files.

Flag anything in the files that contradicts the README.
```

</details>

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

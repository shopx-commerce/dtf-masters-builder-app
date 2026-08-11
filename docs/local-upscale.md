# Increase Quality — client-side super-resolution

"Increase Quality" runs Real-ESRGAN in the customer's browser on WebGPU. Nothing
is uploaded and no API token is involved.

> The server still carries `POST /api/upscale-image` and
> `server/lib/local-upscale.ts` from the earlier Replicate/ncnn design. **The
> editor no longer calls either.** They are unused, not deleted.

## The pieces

| File | Responsibility |
| --- | --- |
| `client/src/lib/upscale-support.ts` | `UPSCALE_FEATURE_ENABLED` and the WebGPU adapter probe (`detectUpscaleSupport`). |
| `client/src/lib/upscale-manager.ts` | Main-thread owner of the worker. One job at a time, the speed gate, and the pixel-budget check. |
| `client/src/lib/upscale-worker.ts` | ONNX Runtime Web on the WebGPU execution provider. Owns the session and runs the tiles. |
| `client/src/lib/upscale-tiling.ts` | Tile planning, cosine blend ramps, colour bleed. Pure functions. |
| `client/src/lib/print-source-edit.ts` | Writes the result back onto the design's print source. |
| `client/public/models/` | `realesr-general-x4v3-fp16.onnx` (2.4 MB) and `realesr-general-x4v3.onnx` (4.9 MB). |
| `client/public/ort/` | ORT wasm runtime, copied in by the `ortAssets` plugin in `vite.config.ts` at `buildStart`. Gitignored. |

The UI is a toolbar control gated on `canIncreaseQuality`; its handler calls
`getUpscaleManager()` and commits the output through `printSourceFieldsAfterEdit`.

## How a job runs

The network is `SRVGGNetCompact`, a fixed **4x** RGB model. Everything else is
arranged around those two facts.

1. **Scale.** 4x is the native output. 2x is an exact 2x2 average of it, so
   neither factor needs a resampling filter that could ring on an alpha edge.
   `resolveUpscaleScale` picks the largest offered factor whose result still fits
   the editor's 40 MP / `vectorExportMaxEdge()` budget, or returns 0.
2. **Colour bleed.** Transparent pixels carry no meaningful colour, so their RGB
   is flooded outward from the nearest opaque neighbour before inference.
   Without it the network mixes the transparent region's black into the edge and
   the result prints with a dark fringe.
3. **Tiles.** The image is cut into overlapping tiles with a 16 px halo. Each
   tile is blended into the destination with a cosine ramp across the overlap;
   the ramps form a partition of unity, so no seam survives.
4. **Alpha.** The model has no alpha channel, so alpha is upscaled by a **second
   full pass** with the alpha plane replicated into R, G and B. That doubles the
   inference cost of any design with transparency, which is why the speed gate's
   reference job includes alpha.
5. **Session reuse.** The worker caches the `InferenceSession`. The first job of
   a tab pays model fetch plus shader compilation; every job after it does not.

## The speed gate

WebGPU being *present* says nothing about it being *usable* — an integrated
adapter can be twenty times slower than the discrete one in the same laptop, and
Chrome on Windows picks the integrated one by default. So the control is not
shown until the machine has been measured.

`isFastEnough()` warms the shaders on a single tile, times it, and derives
microseconds per model pixel. The control appears only if the reference job — 2
megapixels with alpha, so two passes — is projected to finish inside
`MAX_REFERENCE_MS` (25 s).

Two details matter:

- **Best-of-N inside one warm-up.** The warm-up is triggered as a design lands,
  which is exactly when decode, contour tracing and thumbnailing are saturating
  the machine. A single cold sample read as much as 19 us/model px on hardware
  that steadily does 1. `warmup` therefore takes several timed samples and keeps
  the fastest, stopping early once one comes in under budget.
- **A negative verdict is retried, a positive one is not.** Nothing later can
  make the hardware faster, so "fast enough" is final. "Too slow" is allowed up
  to `MAX_CALIBRATION_RUNS` measurements across the tab's life, because the
  cheapest way to earn it is to have been measured during an upload. A worker
  that fails to construct sets `calibrationBroken` and is never retried.

With no WebGPU adapter, `detectUpscaleSupport` returns
`{ available: false, reason: 'no-webgpu' }` and the control is never rendered.

## What it does to the design

The point is print resolution, not on-sheet size. After a 2x upscale a design
holds twice the pixels across the same physical inches, so its effective DPI
doubles and `widthInches`/`heightInches` do not move.

`printSourceFieldsAfterEdit` commits that. Two of its fields are easy to get
wrong:

- `file` **must** be the full-resolution result, because a draft save persists
  exactly one blob per design and recovery decodes it as the print source
  (`draft-preview-cap.ts`). Persisting the editor preview instead silently threw
  the upscale away while keeping the raised DPI number, so a recovered design
  claimed 144 DPI over 892 px of pixels.
- The vector sources (`svgSource`, `originalPdfData`, `vectorInkBox`) must be
  cleared. They take priority at export and would re-rasterise the original
  artwork over the edit.

## Refusals

All of these toast and change nothing:

| Case | Message |
| --- | --- |
| Vector artwork (SVG/PDF) | "already prints sharp at any size" |
| Effective DPI already at the print target | "already at full print resolution for its current size" |
| 2x would exceed the editor's pixel budget | "upscaling it would exceed the editor's size limit" |

Running it twice is allowed and compounds: 72 -> 144 -> 288 DPI, subject to the
budget check each time.

## Measured, Aug 2026

On an NVIDIA Blackwell adapter (RTX 5060 laptop), fp16, Chrome forced onto the
discrete GPU:

| Job | Wall | Inference | Tiles |
| --- | --- | --- | --- |
| 1000x1000 -> 2000x2000, alpha, first job of the tab | 12.0 s | 8.0 s | 18 |
| same, subsequent jobs | 6.1–7.1 s | 5.6–6.3 s | 18 |
| 1500x1500 -> 6000x6000 (4x, 36 MP out) | 5.5 s | 5.0 s | 16 |
| 892x840 -> 1784x1680 through the UI, including draft save | 7.7 s | 4.2 s | 8 |

Steady-state throughput is 1.5–2.4 us per model pixel; JS heap sits flat at
about 47 MB across six consecutive jobs. Against a bicubic 2x of the same input
the network gains 3.1 dB PSNR on synthetic line art and 9.0 dB on photographic
artwork, so a fallback resize is easy to tell apart from a real run.

Chrome selects the integrated adapter by default on Windows and ignores
`powerPreference` (crbug.com/369219127); `--force_high_performance_gpu` is the
only way to reach the discrete GPU, which is what
`tmp-verify/cdp-dgpu.mjs` does.

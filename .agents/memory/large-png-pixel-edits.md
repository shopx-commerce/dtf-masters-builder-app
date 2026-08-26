---
name: Large PNG pixel edits
description: Why browser-side pixel edits on print artwork must stream rows instead of decoding whole images, and how previews should be derived.
---

Any browser-side pixel edit of a print-resolution PNG must stream: inflate → unfilter
one row → edit/verify that row → re-filter → deflate → forget it. Peak memory is then a
few rows regardless of image size. Use the platform's `DecompressionStream`/
`CompressionStream` rather than a decode-everything PNG library.

**Why:** whole-image decoders materialise width × height × 4 bytes plus a copy per stage,
so a feature built on one needs a megapixel cap to stay safe — and that cap lands *below*
ordinary customer artwork (a 22×30 in design at 300 DPI is 59 MP), which shows up as the
feature refusing normal work as "too large". Streaming removes the cap instead of raising
it: 59 MP recolours in ~3 s with single-digit MB of heap growth.

**How to apply:**
- Keep the whole-image decoder as a fallback for what the row walker cannot handle
  (interlaced/Adam7), and leave its caps on that path only.
- Verify invariants *while* streaming (e.g. prove the single-ink rule on every visible
  pixel as rows go by) rather than trusting an earlier analysis pass.
- Early-stopping at the last row a crop needs also skips the codec's end-of-stream check,
  so only do it when there is real work to skip. When the crop reaches the bottom row,
  drain to EOF: that is what catches a source truncated or corrupted after its last
  scanline, and reject any inflated bytes beyond the declared rows.
- Validate the header before allocating: a per-axis dimension limit is needed on top of a
  total-pixel budget, or a 400,000,000 × 1 header passes the budget and asks for
  gigabyte rows. Expand palettes to a full 256-entry table with a validity flag — an
  out-of-range index otherwise reads `undefined` and stores as black.
- Never decode the full-resolution *result* just to show it. Repaint the existing capped
  preview (canvas `source-in` fill), and fall back to a real decode only when no preview
  exists or its aspect ratio disagrees with the output.
- A stream has no meaningful size-derived duration, so replace size-based timeouts with a
  stall watchdog re-armed by progress messages.
- Worker bundles are a single IIFE here, so a dynamic `import()` inside worker-reachable
  code fails the production build even though dev and tests pass. Import statically.

---
name: Blank export guards
description: Why gangsheet exports validate their own pixel output, and the rules for doing that safely (no downsample probes, teardown on failure).
---

# Blank export guards

**Rule:** every export path (worker strip-streaming, worker legacy whole-canvas, DOM-canvas fallbacks in the export and cart models) must verify the rendered sheet contains at least one non-transparent pixel before encoding/uploading, and throw a descriptive error when a sheet with designs comes out all-zero. A null pre-render stamp context is a fatal error, never a silent design skip.

**Why:** a customer's production PNG uploaded to R2 was valid, correctly sized (7350×10500 @300 DPI), and 100% transparent — iOS silently no-ops canvas work past the tab's graphics-memory budget (getContext can return null, drawImage can no-op, oversized canvases read back as zeros) and no layer checked the output, so a blank print reached a production URL with zero errors.

**How to apply:**
- Strip path: piggyback on the existing per-row zero scan (`isRowAllZero`) — tracking "saw ink" there is free and exact.
- Whole-canvas checks must scan alpha at **native resolution in horizontal bands** (~4 MP per band, early-exit on first opaque pixel). Never use a small downsampled probe: averaging a tiny design over a huge sheet can round alpha to 0 and false-flag a good export.
- On any mid-stream encode failure, abort the CompressionStream writer, cancel the reader, await the drain promise, and release bitmap/stamp caches before rethrowing — the worker may be reused and these devices are already memory-starved.
- Known gap: the fluorescent production PDF path (`exportProductionPdf`) has no equivalent final check.
- The `.png.png` double extension in R2 content-disposition comes from the Shopify/Cloudflare shell (it appends `.png` to an already-suffixed name); not fixable in this repo.

## Edit-mode reuse escape hatch

The edit flow's content-signature shortcut reuses the stored production file when nothing changed — it inherently trusts that file, so a corrupt upload persists across every "Update design" until something forces a rebuild. The "Regenerate file" checkbox (edit mode only) is that escape hatch: it forces a full export + upload to the same production key, overwriting in place (production URLs are stable by design; only the `?v=` param bumps).

**Rule:** the forced-regenerate flag may reset **only** on a trusted `dtf-builder-cart-status: done` (guarded by `isTrustedShellMessage` + `isTrustedCartStatus`), never at post time. **Why:** the shell reports failure asynchronously — it never enters the submit handler's catch — so resetting when the message is posted would send the retry straight back through the reuse path with the bad file intact.

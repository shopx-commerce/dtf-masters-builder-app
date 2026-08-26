---
name: Preview worker boundary
description: Preview-only thumbnail and color work may run in workers without changing export or cart rendering.
---

Preview worker offloading remains bounded and recoverable. PNG export may also use a dedicated worker when the output contract is preserved: send encoded source buffers, decode only the designs needed for the current strip, close decoded bitmaps immediately, and fall back with an explicit warning. Thumbnail jobs should use request IDs, ignore stale results, revoke generated blob URLs, and fall back to the existing main-thread path.

**Why:** Large sheets need responsive interaction, but export and cart output must remain pixel- and coordinate-compatible.

**How to apply:** Gate worker export on Worker, OffscreenCanvas, createImageBitmap, and CompressionStream. Keep 300 DPI, normalized placement, alpha behavior, labels, and PDF behavior unchanged. High-zoom halftone inspection may use a bounded selected-layer detail canvas, but never replace the full-sheet/export path.

Desktop selected-raster sharpening must decode only one retained print source at a quantized, viewport-sized target, keep at most one active bitmap plus one pending request, and require an exact design/source/crop/size key before displaying it.

**Why:** Raising the base sheet resolution penalizes every design, while retaining-source dimensions differ from the capped editor preview; stale same-design bitmaps can also show the wrong crop during replacement.

**How to apply:** Track print-source pixel dimensions separately from preview dimensions, budget the source before worker decode, close replaced bitmaps, terminate stale workers, and use the normal sheet preview for mobile, multi-select, gestures, failures, and pending keys.

Anything that gates rendering must be observable by React: derive overlay eligibility from state (or a state tick bumped by every path that clears a gesture ref) and list the show flags and ready bitmap in the render effect's deps. Deduplicate pending worker requests against the live request id, never against a record an effect cleanup may have staled.

**Why:** Ref-only gating leaves the overlay suppressed after a gesture settles because nothing schedules a render; a ref-published bitmap can be swapped between the approving render and the paint; and a stale pending record makes every later request look like a duplicate, so no decode is ever posted.

**How to apply:** The detail overlay must not cover the whole design — selection handles, the print label, and the fluorescent spot pulse are painted into the sheet canvas beneath it. Keep the inset clip and remove the resulting seam by painting that ring from the same detail bitmap.
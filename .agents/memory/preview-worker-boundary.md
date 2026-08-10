---
name: Preview worker boundary
description: Preview-only thumbnail and color work may run in workers without changing export or cart rendering.
---

Preview worker offloading remains bounded and recoverable. PNG export may also use a dedicated worker when the output contract is preserved: send encoded source buffers, decode only the designs needed for the current strip, close decoded bitmaps immediately, and fall back with an explicit warning. Thumbnail jobs should use request IDs, ignore stale results, revoke generated blob URLs, and fall back to the existing main-thread path.

**Why:** Large sheets need responsive interaction, but export and cart output must remain pixel- and coordinate-compatible.

**How to apply:** Gate worker export on Worker, OffscreenCanvas, createImageBitmap, and CompressionStream. Keep 300 DPI, normalized placement, alpha behavior, labels, and PDF behavior unchanged. High-zoom halftone inspection may use a bounded selected-layer detail canvas, but never replace the full-sheet/export path.
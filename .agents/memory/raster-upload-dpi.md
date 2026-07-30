---
name: Raster upload DPI handling
description: Physical-size defaults and metadata rules for uploaded PNG/JPEG artwork.
---

The PNG DPI fallback is conditional on placement behavior. In codebases without an artboard size clamp, metadata-free PNGs need a 300 DPI fallback because 72 DPI can create enormous initial physical sizes. In this editor, oversized uploads are clamped with `initialS = Math.min(1, maxSx, maxSy)`, so preserve Sharp's `metadata.density || 72` behavior to avoid making uploads open four times smaller.

**Why:** A 300 DPI fallback fixes overflow only when no client-side size ceiling exists. With artboard clamping, DPI controls the initial placed size while the clamp already guarantees fit; changing 72 to 300 changes established placement behavior rather than fixing overflow.

**How to apply:** Before changing server DPI handling, inspect the upload placement function for a shared scale ceiling such as `Math.min(1, maxSx, maxSy)`. Only use the 300 fallback when that clamp is absent, and never silently lower valid embedded DPI based on pixel dimensions.
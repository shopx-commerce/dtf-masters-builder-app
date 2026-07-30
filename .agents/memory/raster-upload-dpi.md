---
name: Raster upload DPI handling
description: Physical-size defaults and metadata rules for uploaded PNG/JPEG artwork.
---

The PNG DPI fallback is conditional on both placement behavior and artwork type. In this editor, metadata-free transparent PNG artwork uses a 300 DPI upload fallback, while ordinary opaque/JPEG uploads preserve Sharp's 72-DPI behavior. The client still clamps oversized uploads with `initialS = Math.min(1, maxSx, maxSy)`.

**Why:** Transparent PNG exports often contain print-resolution pixels but no pHYs chunk; Sharp's synthetic 72 DPI makes those designs open several times too large. Applying 300 DPI to opaque/JPEG artwork changes normal designs that intentionally rely on their existing metadata behavior.

**How to apply:** Keep the server fallback unchanged. In the client, detect a PNG with no real pHYs metadata and meaningful transparency before using the 300 DPI fallback. Preserve valid embedded DPI and leave opaque/JPEG uploads on their existing path.
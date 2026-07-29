---
name: Raster upload DPI handling
description: Physical-size defaults and metadata rules for uploaded PNG/JPEG artwork.
---

Raster uploads must use a stable 300 DPI default when physical-resolution metadata is missing or invalid, and valid metadata must not be silently rewritten to a lower DPI based on pixel dimensions. For PNGs, Sharp may report 72 DPI even when no pHYs chunk exists; treat that as synthetic metadata.

**Why:** Dividing pixels by a fallback such as 72 or 144 DPI can make a correctly prepared 12-inch design appear 25–50 inches wide; browser image dimensions alone do not provide print size. Sharp’s default 72 density caused metadata-free uploads to bypass the intended fallback.

**How to apply:** Keep client and server fallbacks aligned at the production print DPI, cap only invalid/excessive values as intended, and treat metadata inspection as sizing input rather than a reason to resize the artwork.
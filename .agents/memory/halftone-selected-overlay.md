---
name: Halftone HD detail overlay rules
description: Constraints for the selected-design halftone overlay canvas in the preview (zoom >= 3).
---

The preview uses a separate pixel-preserving overlay canvas (imageRendering: pixelated, clipPath inset(6px)) for the SELECTED halftoned design at zoom >= 3, so CSS zoom interpolation doesn't soften the dot pattern.

**Rules:**
1. The overlay must only activate when the halftone raster fits its size caps (MAX_AREA / MAX_EDGE) so it renders 1:1. Nearest-neighbor DOWNSCALING a halftone raster shreds the dot pattern — looks washed-out/speckled while selected, correct when deselected. Oversized rasters must fall back to the normal main-canvas path (same as the deselected composite).
2. The main canvas must still draw the design's 6px perimeter ring under the overlay (evenodd clip); drawing nothing leaves the clip ring empty (looks cropped), and drawing the full image doubles two differently-filtered rasters (ghost seam). Ring-only is the compromise.

**Why:** customer-visible: a selected halftone that looks wrong makes users think it will print wrong.

**How to apply:** any change to the overlay activation condition, its clip inset, or the caps must keep both invariants; verify selected vs deselected appearance of a large 300-DPI halftone at zoom >= 3.

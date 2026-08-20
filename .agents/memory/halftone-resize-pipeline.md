---
name: Halftone resize pipeline
description: Rules for preserving halftone dot geometry when designs are resized, exported, or restored.
---

Halftoned designs must retain their original source pixels and halftone settings separately from the screened raster. When physical width, height, or transform scale changes, rebuild the screen from the original pixels at the final printed size; never screen an already-halftoned raster.

**Why:** The editor stores physical size separately from image pixels. Scaling a screen generated at the previous size changes its physical dot pitch and can create soft, uneven, or visually distorted dots.

**How to apply:** Keep halftone metadata with the layer state, regenerate after size changes with stale-job protection, and use binary-alpha/nearest-neighbour treatment consistently in preview, PNG download, PDF, and production upload paths.

A customer-triggered halftone may trim transparent padding from the screened result, but it must crop and durably persist the matching un-screened source in the same action. Map bounds conservatively between pixel grids, correct the layer geometry so visible ink does not move, and preserve the source in undo/redo history. Maintenance rebuilds should not re-trim.

**Why:** Keeping only the screened crop causes resize, refresh, or redo to either restore old margins or screen already-screened dots. Re-trimming every automatic rebuild can also feed back as the dot phase changes at the frame edges.

**How to apply:** Treat screen crop, source crop, physical geometry, DPI metadata, and history state as one atomic halftone commit. Floor leading source edges and ceil trailing edges so rounding never clips contributing pixels.
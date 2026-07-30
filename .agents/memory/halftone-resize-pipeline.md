---
name: Halftone resize pipeline
description: Rules for preserving halftone dot geometry when designs are resized, exported, or restored.
---

Halftoned designs must retain their original source pixels and halftone settings separately from the screened raster. When physical width, height, or transform scale changes, rebuild the screen from the original pixels at the final printed size; never screen an already-halftoned raster.

**Why:** The editor stores physical size separately from image pixels. Scaling a screen generated at the previous size changes its physical dot pitch and can create soft, uneven, or visually distorted dots.

**How to apply:** Keep halftone metadata with the layer state, regenerate after size changes with stale-job protection, and use binary-alpha/nearest-neighbour treatment consistently in preview, PNG download, PDF, and production upload paths.
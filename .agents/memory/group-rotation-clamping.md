---
name: Group rotation clamping
description: Multi-design rotation must preserve relative spacing and clamp the rotated selection as one group.
---

Multi-selection rotation is a geometric group operation: rotate every design center around the combined selection-bounds center, update each design’s own rotation, then apply one shared translation if the rotated group reaches an artboard edge. Never clamp selected designs independently after rotation, because that changes their relative spacing and can cause overlap.

**Why:** Independent per-design clamping made selected designs rotate in place and pull into each other near canvas limits.

**How to apply:** Keep drag-handle rotation and toolbar/preset rotation on the same group-geometry path.
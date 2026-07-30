---
name: Group rotation clamping
description: Multi-design rotation must preserve relative spacing and clamp the rotated selection as one group.
---

Multi-selection rotation is a geometric group operation: rotate every design center around the combined selection-bounds center and update each design’s own rotation. If the rotated group reaches an artboard edge, reject that angle and keep the last valid group position/rotation. Never clamp selected designs independently or shift the group at the edge.

**Why:** Independent per-design clamping made selected designs rotate in place and pull into each other near canvas limits; shifting at the edge allowed a rotation to continue beyond the user’s intended bounds.

**How to apply:** Keep drag-handle rotation and toolbar/preset rotation on the same group-geometry path.
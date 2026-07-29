---
name: Low-zoom selection controls
description: Selection handle sizing and rotation hit testing when the artboard is fit small.
---

When the artboard is zoomed below 100%, selection corner handles and their rotation hit zones should be reduced to 25% of the regular size. At 100% and above, preserve the normal control dimensions.

**Why:** Inverse-zoom scaling keeps controls screen-sized, but at fit-to-sheet zoom it makes corners visually dominate small designs and lets rotation activate too far from the corner.

**How to apply:** Use one shared low-zoom scale for single- and multi-selection rendering and hit testing so the visible control and its interactive area stay aligned.
---
name: Low-zoom selection controls
description: Selection handle sizing and rotation hit testing when the artboard is fit small.
---

When the canvas is genuinely zoomed out below 50%, selection corner handles and their rotation hit zones should be reduced to 25% of the regular size. At 50% and above, including the full-gangsheet view, preserve the normal control dimensions.

**Why:** Inverse-zoom scaling keeps controls screen-sized, but only extreme zoom-out makes corners visually dominate small designs. The full-gangsheet view still needs the normal controls to remain usable.

**How to apply:** Use one shared low-zoom scale for single- and multi-selection rendering and hit testing so the visible control and its interactive area stay aligned.
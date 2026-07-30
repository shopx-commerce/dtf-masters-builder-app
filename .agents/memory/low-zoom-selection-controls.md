---
name: Low-zoom selection controls
description: Selection handle sizing and rotation hit testing when the artboard is fit small.
---

When the canvas is genuinely zoomed out below 50%, selection corner handles and their rotation hit zones should be reduced to 25% of the regular size. At 50% and above, including the full-gangsheet view, preserve the normal control dimensions. Handle size must also be capped against the selected design or group’s smallest canvas dimension so large/tall sheets cannot make controls overwhelm tiny designs.

**Why:** Inverse-zoom scaling keeps controls screen-sized, but a fixed screen target can cover a large fraction of a tiny design when the whole gangsheet is fit into view. A proportional cap preserves usability without letting controls dominate.

**How to apply:** Use one shared low-zoom scale for single- and multi-selection rendering and hit testing so the visible control and its interactive area stay aligned.
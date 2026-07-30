---
name: Low-zoom selection controls
description: Selection handle sizing and rotation hit testing when the artboard is fit small.
---

At the actual fit-to-sheet zoom, selection corner handles and their rotation hit zones should be reduced to 25% of the regular size. Any zoom level above the fit zoom, including zooming into a selected design, must preserve the normal control dimensions.

**Why:** A fixed zoom cutoff can classify a normal full-sheet view as zoomed in or classify a selected-design view as zoomed out depending on viewport size. Comparing with the computed fit zoom isolates the compact treatment to the actual overview state.

**How to apply:** Use one shared low-zoom scale for single- and multi-selection rendering and hit testing so the visible control and its interactive area stay aligned.
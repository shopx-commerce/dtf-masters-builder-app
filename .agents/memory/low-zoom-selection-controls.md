---
name: Low-zoom selection controls
description: Selection handle sizing and rotation hit testing when the artboard is fit small.
---

Only the explicit fit-to-sheet overview should reduce selection corner handles and their rotation hit zones to 25% of the regular size. Any user-zoomed view, including zooming into a selected design, must preserve the normal control dimensions.

**Why:** The computed minimum zoom is a measurement value and can change during layout recalculation, incorrectly making a zoomed-in view inherit compact controls. An explicit fit-view state isolates the compact treatment to the overview action.

**How to apply:** Use one shared low-zoom scale for single- and multi-selection rendering and hit testing so the visible control and its interactive area stay aligned.
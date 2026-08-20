---
name: Legacy arrangement boundary
description: The boundary between restored legacy auto-arrange behavior and current grouped editor mapping.
---

Restore auto-arrange behavior in the worker by changing its candidate algorithms and ranking only; keep grouped designs represented as super-items and map their shared translations in the editor layer.

**Why:** The legacy packing behavior is part of the expected editor interaction, while group geometry preservation is a newer requirement that must remain intact.

**How to apply:** When changing arrangement again, compare worker behavior against the pre-optimization implementation without moving group bounding-box construction or member translation into the worker.

Duplicate-aware optimization must add candidate orderings rather than replace the legacy portfolio. Activate it only for a genuinely repeated sheet, keep every copy as its own physical item, and let grid/mask source preference break only exact raw-height ties on the same purchasable rung.

**Why:** A weak duplicate signal changes ordinary mixed sheets, while a geometric tie tolerance can straddle a Shopify height boundary and charge for more film. Groups are layout units, not duplicate families.

**How to apply:** Keep duplicate identity as optional packing metadata; omit it from group super-items. Compare billable height before raw height, preserve the honestly shorter candidate, and apply source-kind preference only after both tie.
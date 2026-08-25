---
name: Mobile contextual sheet dismissal
description: Rules for hiding mobile selection controls without disabling canvas manipulation.
---

Mobile sizing/design controls may be dismissed independently from canvas selection. Dismissal is scoped to the complete selected-ID set, remains in effect while that unchanged selection is dragged, and resets when any design is added to or removed from the selection.

**Why:** Customers sometimes select artwork only to reposition it. Clearing selection would prevent that drag, while tracking only the primary ID misses marquee and layer multi-selection changes.

**How to apply:** Keep sheet visibility separate from editor selection state. Build a stable key from the primary ID plus all selected IDs, and keep close buttons as accessible siblings of draggable sheet handles rather than nesting interactive controls.
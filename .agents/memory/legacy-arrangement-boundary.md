---
name: Legacy arrangement boundary
description: The boundary between restored legacy auto-arrange behavior and current grouped editor mapping.
---

Restore auto-arrange behavior in the worker by changing its candidate algorithms and ranking only; keep grouped designs represented as super-items and map their shared translations in the editor layer.

**Why:** The legacy packing behavior is part of the expected editor interaction, while group geometry preservation is a newer requirement that must remain intact.

**How to apply:** When changing arrangement again, compare worker behavior against the pre-optimization implementation without moving group bounding-box construction or member translation into the worker.
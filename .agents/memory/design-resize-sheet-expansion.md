---
name: Design resize sheet expansion
description: Manual design sizing must promote the gangsheet before applying a requested size that exceeds the current height bound.
---

Manual height edits should accept the requested value, select the smallest configured gangsheet height that contains the resized design, preserve the design position while changing sheet coordinates, and full-sheet arrange after expansion.

**Why:** Clamping the input to the current sheet height made valid edits appear not to save when a design needed the next gangsheet bound.

**How to apply:** Keep size-input limits at the largest configured bound and reuse the copy-count expansion pattern for the resize transaction.
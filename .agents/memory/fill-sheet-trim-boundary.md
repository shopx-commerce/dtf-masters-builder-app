---
name: Fill Sheet trim boundary
description: Ordering and ownership rules that keep Fill Sheet's overflow-trim safe inside the arrange pipeline.
---

Fill Sheet works by overshooting its copy count and letting the arrange pipeline delete the extras. Rules that keep that safe:

1. Trim expendable fill copies (overflowing, not anchored) **before** the overflow→sheet-growth ladder, and recompute overflow from the remainder. A fill copy must never grow the sheet; only a customer-placed design still overflowing after the trim may trigger growth.
2. The expendable-id set must survive every path an arrange request can take — ladder continuations forward it, queued-request merges set-union it. A dropped id turns a disposable copy into an "original" that grows the sheet.
3. Fill copies are created groupless: grouped designs pack as prefixed super-items whose ids can never match per-design fill ids, so a grouped copy would silently dodge the trim.

**Why:** The packer returns overflowing items rather than dropping them, and the pre-existing overflow response was "grow the sheet, then toast" — correct for customer designs, wrong for disposable fill copies. Review also caught that ladder growth snapshotting on its first rung splits undo: operations that snapshot once themselves must have growth inherit their snapshot-skip intent, or one Ctrl+Z stops at a half-grown sheet.

**How to apply:** When changing arrange overflow handling, ladder growth, or request coalescing: keep trim-before-growth ordering, carry the expendable-id set through continuations and merges, and keep undo-snapshot ownership with the operation that started the arrange. Serialize fill-style bulk appends behind the arrange lock plus a pending flag — two batches computed against one design snapshot double-count capacity and strand the second batch untrimmable.

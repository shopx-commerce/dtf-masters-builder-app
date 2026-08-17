---
name: Edit-split row identity
description: Rules for the layers-panel row key (name + size + edit-split tag) and the traps found when adding the third segment.
---

Layer rows group copies by a composite identity: base name + size key + an
optional `editSplit` tag stamped when a pixel-changing tool (halftone, upscale,
pixel clean, crop) touches SOME but not ALL members of a row. The single source
for key building, stamping, and badge mapping is `client/src/lib/edit-split.ts`
(pure rule covered by `scripts/verify-edit-split.ts`).

**Rule 1 — every row-key consumer must build the same 3-segment key.** The
grouping memo, the view's React `key`/`rowKey` prop, and any editing-store
lookup keyed by row must all include the tag segment.
**Why:** the first implementation updated only the grouping memo; the view kept
a 2-segment key, so a split copy's row and its source row (same name + size)
collided — duplicate React keys and shared rename/count state. Review caught it.
**How to apply:** when touching row identity, grep for `` `${...}::${...}` ``
templates and rowKey construction outside the lib before calling it done.

**Rule 2 — uniform edits never stamp.** Editing a whole row, a lone design, or
running a row-wide/all-designs tool must be a no-op (same array reference).
Tags are unique per gesture and never merged across gestures.
**Why:** print-shop flow is "halftone the whole row"; stamping uniform edits
would shatter rows the user thinks of as one design. System-initiated rebuilds
(halftone resize re-screen, restored-source rebuild — the `skipSnapshot` paths)
must also never stamp, or resizing a halftoned multi-copy design explodes rows.

**Rule 3 — optional per-design scalars that affect identity need explicit
write-back in undo/redo restore.** `applySnapshot` spreads the live design, so
any field absent from the snapshot JSON silently keeps its live value; add the
field to the serializer AND assign it explicitly (including `undefined`, which
is what clears a tag on undo so the copy re-joins its row).
**Why:** same trap class as the print-label flag before it — undo restored old
pixels but kept the split row. Persistence has five mirror sites to keep in
lockstep: history snapshot, draft storage (type/signature/toStored/fromStored),
cart settings bag, restore-from-cart, and the DesignItem type.

Deliberately excluded from splitting: rotation/flips (transform-only), the
name-stamp toggle (row-wide by design). Print labels read `design.name` only —
row identity must never leak into printed output; that is why the tag is a
separate field instead of a rename.

---
name: Unplaceable copies heap on the bottom edge
description: Why "random red overlap outlines that Auto-Arrange never clears" is a full sheet, not a packing bug, and what the commit path must do about it.
---

A design the nester cannot place is not reported at a bad position — it is reported in a column
of its own *below* the sheet. Because placements are normalised against the sheet, committing
those positions folds every leftover onto the same spot on the bottom edge, on top of artwork
that did fit.

**Rule:** copies that a run created moments ago and still cannot place, once the height ladder
has climbed as far as it may, must be taken back rather than committed. Only such copies —
never a design the customer made — and only at commit time.

**Why:** the heap is what customers report as a nesting bug ("red overlap marks appear
randomly"), and it is self-sealing. Once heaped, those copies are *on* the sheet, so the
settled check treats them as work the customer can see and every later arrange deliberately
leaves them where they are. Pressing Auto-Arrange again therefore never clears it, which is
exactly what makes it read as a packer fault. Changing the margin appears to fix it only
because that path forces a whole-sheet repack.

Before blaming the packer for overlaps, measure capacity: rasterise the real artwork into a
nest mask, pack N copies, and compare the film required against the tallest purchasable sheet.
A shortage that survives that test is film, not geometry. Rotation is not the culprit either —
verify any ink-overlap checker distinguishes all four quarter-turns, since collapsing rotation
modulo 180 fabricates hits and sends the investigation the wrong way.

**How to apply:** trimming for a full sheet has two distinct moments, and they are not
interchangeable. Trimming *before* the ladder withholds growth (Fill Sheet, which must never
buy film). Trimming *at commit* still lets the sheet grow first and only spends copies as a
last resort (raising a copy count, where growing is the whole point). A run that needs the
second must not reuse the first.

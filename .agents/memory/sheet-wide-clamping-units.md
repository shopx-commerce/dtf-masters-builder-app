---
name: Sheet-wide clamping must treat a group as one unit
description: Why clamping designs to the artboard one at a time silently destroys group spacing, and what to use instead.
---

Clamping designs back onto the artboard **one design at a time over a whole sheet** is a bug,
not a style choice. If one member of a group has ink past a sheet edge, a per-design clamp pulls
only that member back and leaves its siblings where they were — the spacing *inside* the group
changes even though nothing asked it to.

**Why:** it surfaced as "the margins inside my groups keep changing when I upload more designs".
Grouping and packing were both correct — a group is collapsed into one super-rect and the arrange
commit applies one shared translation. The damage came *after* the pack, from a clamp pass that
did not know about groups. It compounds because each upload can trigger a ladder grow or an
auto-shrink, and each of those re-clamped every design on the sheet.

The codebase already knew the hazard before this was fixed: the sheet-shrink path carries a
comment explaining that it avoids the artboard-resize handler precisely because that clamps
designs individually.

**How to apply:** any clamp that runs over more than one design must group members into units,
union each unit's ink boxes, and apply a single shared delta per unit. Genuine single-design
sites — a keyboard nudge, a duplicate or paste of one new design, a single-design resize — are
fine with the per-design clamp and should keep using it.

Two related traps:

- Clamp **after** applying placements, in a separate pass. Clamping inside the same map that
  applies the packer's placements sees each design in isolation and reintroduces the bug.
- Rigid translations that divide by a *new* sheet height (band reseats, sheet shrink) are not
  affected — they move everything by construction. Only clamps are.

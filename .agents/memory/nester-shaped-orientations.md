---
name: Shaped silhouettes need half and three-quarter turns
description: Why the packer could not nest a triangle, and what "bounds may leave the sheet" already does.
---

Two separate things get confused here. Keep them apart.

## What already works: bounds off the sheet

The mask nester already allows a design's *bounding box* to hang off the sheet while its ink
stays on. Silhouettes are trimmed to their ink before packing, and the placement-to-centre
conversion deliberately does not clamp. The out-of-bounds warning and the artboard clamp both
measure ink, not the box, so neither undoes such a placement.

A consequence worth knowing: because the silhouette is trimmed to its ink bounding box,
"every inked cell is on the sheet" and "the trimmed rectangle is on the sheet" are the *same
constraint*. There is no further gain to be had from letting the trimmed rectangle overhang.

## What was actually broken: orientations

The nester offered only 0° and 90°, and offered 90° only when width and height differed by more
than a tenth of an inch. A triangle in a square footprint therefore got **no rotation at all**.

**Why that is wrong:** the footprint test is a rectangle question. A triangle is unchanged in
footprint by a turn but completely changed in shape, and two triangles tile a rectangle when one
is upside down — at no other pair of angles. The shape is what nests, not the box.

**How to apply:** decide by ink share of the trimmed bounding box. Below ~95% the silhouette has
a concavity worth turning, and gets 90°, 180° and 270°. At or above, it is effectively a
rectangle: the extra orientations are congruent to the ones already offered and would double the
search for an identical answer. This keeps ordinary rectangular uploads paying nothing.

**Trap:** once the nester can emit 180°/270°, any consumer asking `rotation === 90` to decide
whether width and height swap is wrong — 270° swaps them too, 180° does not. Normalise the angle
and test for an odd quarter, and let genuinely off-axis angles (a user can set those by hand)
fall through to the upright footprint.

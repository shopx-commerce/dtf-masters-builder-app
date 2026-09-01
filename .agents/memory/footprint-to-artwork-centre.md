---
name: Converting a packed footprint centre to an artwork centre
description: The label-band offset that only reveals its sign error once the packer starts rotating designs.
---

A design carrying a print label is packed as one taller block — artwork plus the label band
below it — so the packer reports the centre of the *pair*. What the editor stores as the
design's position is the centre of the **artwork alone**, with the band understood to hang
below. Converting between them is not optional; skipping or mis-signing it puts the design a
whole band-width away from the film the nester reserved.

**The conversion:** in the design's own frame the artwork centre is half a band *above* the
footprint centre, i.e. offset `(0, -band/2)`. Rotate that by the same y-down matrix the canvas
and the bounds computation use:

```
x = footprintX + (band / 2) * sin(theta)
y = footprintY - (band / 2) * cos(theta)
```

**Why this is worth remembering:** the horizontal term is zero at 0° and at 180°, so a sign
error in it is invisible for every unrotated design and shows up only when the packer turns one.
It sat wrong for a long time, costing rotated labelled designs about a band of displacement —
small enough to read as slightly tight spacing rather than as a bug. It became reachable in a
second direction as soon as the nester started emitting three-quarter turns.

**How to apply:** do the conversion through one named helper shared by every caller, and test it
by round-tripping — step half a band along the rotated local "down" from the returned artwork
centre and assert you land back on the packer's footprint centre. Deriving the inverse
independently in the test is what catches a sign error; asserting the formula against itself
does not.

Not affected: paths that hand the packer a design's *bounds* rather than a centre. Rotated bounds
already include the band, and a top-left corner has no sign to get wrong.

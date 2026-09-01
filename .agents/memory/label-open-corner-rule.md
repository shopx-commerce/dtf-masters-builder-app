---
name: The file-name stamp may only sit in an open corner
description: Why "the label box misses the ink" is the wrong test for placing a print label inside artwork.
---

The print label (the design's file name) can either sit in a band below the artwork — always
safe, costs film — or inside the artwork's own bottom-right corner, which costs nothing. The
inside placement is the only way the stamp can land on a design, so its admission test is the
whole story.

**Rule:** a moat of clear film around the label box is *not* sufficient. The probe must run from
the moat's top-left out to the artwork's right and bottom edges — the label may only sit in a
corner it can see out of.

**Why:** a moat-only test is satisfied by any hole large enough to hold the box: the counter of
an O, the gap between two elements, the space under a descender. A label dropped into a hole is
clear of ink by the letter of the test and still reads, to the person looking at the sheet, as
the file name printed across the middle of their design. It is worst on white artwork, where the
label's opaque white background box blends into the design and only the black text shows — which
is how it was reported.

**How to apply:** the open-corner probe cleanly separates the two cases. An empty margin at the
edge of the bounding box (under a line of text, the flat side of an L) still passes and still
costs no film. An interior pocket now fails and takes the band below.

Two things ruled out while diagnosing this, worth not re-investigating:

- **Flips are not implicated.** The mask is built in displayed space with the flips already
  applied, and the label is drawn in that same space after undoing the flip. Mask and draw agree.
- **Aspect mismatch is not implicated.** Both the mask builder and the canvas size artwork from
  design inches times scale; neither uses the source image's pixel aspect. They cannot disagree
  about which corner is which.

The clearance was also widened from 0.05" (one mask cell — too fine to survive rounding in
either direction) to 0.25".

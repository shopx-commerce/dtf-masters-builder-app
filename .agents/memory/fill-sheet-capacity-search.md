---
name: Fill Sheet capacity search
description: Why Fill Sheet measures capacity by repacking to saturation instead of estimating it once, and the rules that search has to obey.
---

# Capacity is observed, never derived

A formula cannot say how many copies a gangsheet holds. Capacity depends on how the artwork
interlocks, which is the packer's business and nobody else's. Any grid-and-area estimate is
a first guess: it is charged a full gap ring per existing design, gets no credit for
silhouettes that nest into each other, and knows nothing of the packer's reduced-gap
variants. An estimate used as an answer leaves film empty, which is exactly what customers
report.

**The rule:** a fill packs, measures what survived, and packs again — a bracket-and-bisect
search. All copies fit → raise the count. Copies trimmed → that count is the upper bracket.
Then bisect until the brackets close.

**Why:** the reported bug was "sometimes there is plenty of space and it doesn't fill it",
and every part of it came from trusting a number nobody had verified against a pack.

## The packer is not monotonic in item count

Handing it a large surplus does not simply leave the extras overflowing. It is a heuristic
search over the whole item set, so the winning layout changes, and the best layout of far
too many items is worse than the best layout of roughly the right number — a pack of 248
copies on a sheet that comfortably holds 129 settled 124. Hence a modest growth step rather
than doubling, and hence the search bisects on the *total* count rather than assuming that
what fit once will fit again.

The same non-monotonicity means "a binary search found N copies that fit" does not imply
N-1 fit. Do not write a test asserting the loop beats a particular number; assert the
property that matters — when the fill stops, one more copy does not fit.

## What a fill must never do

- **Never grow the sheet.** The customer is filling the film they already bought.
- **Never shrink it either.** The auto-shrink that follows an ordinary clean pack is exactly
  wrong here: it measures a half-filled sheet and crops the film the fill exists to use. With
  a manually chosen height it cannot shrink, so it slides the artwork up and leaves the empty
  band at the bottom instead.
- **Never revert the whole operation.** A pass that cannot place the customer's own designs
  undoes *itself*, by deleting the copies it added from live state. Copies earlier passes
  placed have earned their spot, and anything the customer changed while the pack ran is none
  of the rollback's business.

## Budget the frozen time, not the passes

Packing normally happens in a worker. When it falls back to the main thread the page stops
repainting, so the loading animation the customer was promised freezes. Budget that in
milliseconds of blocked UI thread, measured around the pack alone — never around the pass,
which may include a ten-second wait on a worker that never answered and during which the page
was perfectly alive. Ending the search on the mere fact of a main-thread pack throws away the
accuracy the search exists for.

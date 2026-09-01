---
name: Copy-count and duplicate arrangement
description: Scope and stability are two separate axes on the arranges the user did not ask for; conflating them causes opposite complaints.
---

Adding copies — a layer's copy count, Duplicate on the toolbar, Ctrl/Cmd+D — triggers an
arrange the customer did not press a button for. Two independent options govern it, and every
bug in this area comes from treating them as one.

## Scope: always whole-sheet

The arranger reads a multi-design selection as "arrange only these", freezing everything else
into fixed obstacles. Every copy path leaves the new copies selected for layer feedback, so
without an explicit whole-sheet flag the copies are packed into whatever gaps the untouched
sheet happens to leave — which stacks them into a column, and on a full sheet fails outright.

## Stability: absorb, do not rebuild

Copy paths must **not** ask for a full repack. A full repack tells the packer it may move
settled work, and a sheet with four designs sitting together and film to spare comes back
completely rearranged. Pressing a button labelled Duplicate is not a request to relayout the
sheet.

**Why this is safe for film cost:** the stable layout is not simply preferred. A from-scratch
layout that reaches a cheaper purchasable rung wins outright, and a tie is taken too when it
removes real slack without rearranging most of the sheet. Only a repack that costs the same
and buys nothing is declined. If the copies genuinely do not fit, the overflow path repacks
the whole sheet from scratch before any sheet growth is considered.

**How to apply:** copy/duplicate paths get whole-sheet scope and no full repack. Reserve the
full repack for things the user explicitly asked to re-tidy — the Auto-Arrange button, Apply
on an unchanged count — and for changes to a sheet-wide property such as the margin, where
every position is invalidated anyway.

## An overflow is only real once both axes have been widened

A selected-only pack's overflow means "not in the shape the frozen designs left", not "the
film is full". A stable pack's overflow means "not without moving something". Neither is
evidence of a genuine shortage, and acting on either is how a sheet grows a rung it did not
need.

This matters because of how an unplaceable design is committed: one that is already on the
sheet keeps its current position rather than being heaped at the bottom edge. That is right
when the film is truly full and wrong otherwise — a copy that landed on its neighbour stays
on its neighbour, the red overlap outlines never clear, and pressing Auto-Arrange again
reruns the identical pack and reaches the identical conclusion. The user-visible symptom is
"auto-arrange does nothing; I have to change the margin to fix it" — the margin selector
clears it because changing a sheet-wide property forces a full whole-sheet repack.

So the retry that second-guesses an overflow must widen **both** axes: full repack *and*
whole-sheet scope. Widening only stability leaves the obstacle set intact and the second
opinion agrees with the first by construction.

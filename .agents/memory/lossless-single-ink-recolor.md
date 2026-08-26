---
name: Single-ink recolor
description: Correctness boundary for changing the one ink in a PNG design without damaging transparency, softness, print resolution, or later edits.
---

Recolor the authoritative PNG bytes directly, never pixels that have passed through a canvas. Ignore RGB only where alpha is zero. Preserve the PNG pHYs resolution chunk.

**Why:** browser canvas decode/edit cycles can premultiply edge RGB and silently change soft alpha; a print source that loses pHYs prints at the wrong size.

**How to apply:** keep recoloring in a bounded worker, bind the commit to the source revision that was analyzed, and make the replacement PNG the durable print source. Do not recolor screened halftone dots; operate on an unscreened source or refuse the edit.

## What counts as one ink

Requiring byte-identical RGB on every visible pixel is too strict for real customer artwork and was abandoned. Almost nothing customers upload passes it: anti-aliased edges are greys at full alpha, white designs flattened over black arrive with darkened RGB on their semi-transparent pixels, and re-saves leave stray pixels. Read the artwork instead as one ink K plus a paper endpoint P (no ink), with each visible pixel's position on that segment being its *coverage*.

- **uniform** — RGB constant within noise. Coverage 1, alpha copied untouched. The exact case must stay byte-identical.
- **premultiplied** — RGB/alpha constant. Coverage 1, alpha copied untouched.
- **blend** — coverage from projection onto the segment; output alpha = alpha x coverage.

**Why:** the same pixel means two different things depending on the population it sits in. (128,128,128,128) is full-strength ink at half opacity under premultiplied, and half coverage under blend; applying blend to premultiplied artwork counts the softness twice and prints at a fraction of the intended density. So the alpha-preserving readings are tried first and the shape is decided once per image, never per pixel.

**How to apply:** allow the change when one ink covers >=95% of the alpha-weighted artwork, and refuse the rest with the measured share rather than a vague "more than one colour". Guard separately against two-tone artwork: if a large share of the weight sits at the paper end of the segment, it is black-on-white text or a photo, not one ink with soft edges — read as coverage, that half would silently vanish. Which end is ink cannot be settled by goodness of fit: a greyscale ramp fits equally well upside down, so rank candidate papers by how much of the artwork each leaves as actual ink.

## Measuring must be exhaustive

Never sample a subset of rows when deciding what the artwork is, even on hundred-megapixel sources.

**Why:** the memory bound comes from the fixed-size histogram, not from how many rows feed it, so sampling buys only CPU — and a second ink that happens to live on the skipped rows is reported as no second ink at all and then painted over. A wrong refusal annoys; a wrong acceptance destroys a customer's design.

## Two passes, one decision

A recolour reads the source twice: once to decide the model, once to write. The first row cannot be written until the whole population has been seen.

**How to apply:** let callers that already analysed a source hand the model back for the apply pass, but validate every field of it (dimensions, kind, endpoints, finite coefficients) before trusting it, and re-measure when anything fails — a model from a different image applies the wrong density silently. Previews may derive coverage from the display-size preview rather than the print source: coverage is a plane through RGB, so downscaling then taking coverage equals taking coverage then downscaling.

## Job guards and the start helper

Bind apply to the analyzed source *before* spending CPU, not only before committing. Abandoning a job must terminate its worker; an in-flight guard may only be released by the job that still owns the active token; recoloring to the colour already present must short-circuit.

A helper that starts a new job by superseding the previous one must release the old in-flight claim *before* the new job claims it — claim after the call, never before.

**Why:** claiming first reads as correct and is silently undone by the very call that starts the protected job, so a double click still starts two print-resolution decodes. The ordering cannot be settled by reading the code — only by a test that actually double-clicks.

**How to apply:** order every caller as: check the guard, start the job, then claim. Release the claim in cleanup only when the finishing job still owns the current token.

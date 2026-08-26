---
name: Lossless single-ink recolor
description: Correctness boundary for changing one solid PNG ink without damaging transparency, print resolution, or later edits.
---

Recolor the authoritative PNG bytes directly, never pixels that have passed through a canvas. Ignore RGB only where alpha is zero, and require every visible pixel to have exactly the same straight RGB samples before allowing the edit. Preserve every alpha sample and the PNG pHYs resolution chunk.

**Why:** Browser canvas decode/edit cycles can premultiply edge RGB and silently change soft alpha. Even slight visible RGB variation may be matte contamination or shading, so permissive clustering can claim an exact result while changing the artwork.

**How to apply:** Keep recoloring in a bounded worker, bind the commit to the source revision that was analyzed, and make the replacement PNG the durable print source. Do not recolor screened halftone dots; operate on an unscreened source or refuse the edit.

Bind apply to the analyzed source *before* spending CPU, not only before committing: hold the identity of the source that eligibility was proven against and refuse the run when the design's current print source differs. Print-resolution PNG work is seconds long, so abandoning a job must terminate its worker, an in-flight guard may only be released by the job that still owns the active token, and recoloring to the colour already present must short-circuit instead of rewriting the print source.

**Why:** A post-work identity check recolors bytes eligibility never proved; a stale job's cleanup otherwise unlocks the job that replaced it; and a no-op rewrite still costs a decode/encode, a history entry, and a fresh upload at checkout.
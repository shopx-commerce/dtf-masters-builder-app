---
name: Lossless single-ink recolor
description: Correctness boundary for changing one solid PNG ink without damaging transparency, print resolution, or later edits.
---

Recolor the authoritative PNG bytes directly, never pixels that have passed through a canvas. Ignore RGB only where alpha is zero, and require every visible pixel to have exactly the same straight RGB samples before allowing the edit. Preserve every alpha sample and the PNG pHYs resolution chunk.

**Why:** Browser canvas decode/edit cycles can premultiply edge RGB and silently change soft alpha. Even slight visible RGB variation may be matte contamination or shading, so permissive clustering can claim an exact result while changing the artwork.

**How to apply:** Keep recoloring in a bounded worker, bind the commit to the source revision that was analyzed, and make the replacement PNG the durable print source. Do not recolor screened halftone dots; operate on an unscreened source or refuse the edit.
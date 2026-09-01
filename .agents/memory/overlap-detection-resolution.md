---
name: Overlap detection resolution
description: Why the red overlap marks must rasterise at a physical pixels-per-inch, never at a fraction of the preview canvas.
---

The red overlap check must run at a resolution derived from the sheet's **physical size**
(pixels per inch), never from the preview canvas, the zoom, or the container.

**Why:** a gang sheet of any length is fitted into the same preview box, so a display-derived
scale gets coarser the longer the sheet. At roughly two pixels to the inch a 1/16" margin is
an eighth of a pixel: neighbouring copies rasterise into the same pixel and designs that
never touch are reported as overlapping. It presents as red marks that appear "randomly" on
long sheets, that Auto-Arrange cannot clear (the layout is genuinely fine), that a bigger
margin does clear, and that differ between the workspace and the storefront because the two
size their preview differently. Chasing this in the packer is wasted effort — run the real
packer over the customer's numbers first and confirm whether the layout is actually clean
before touching placement code.

**How to apply:** the detection resolution has to leave the smallest margin the editor offers
at least ~3px of clear sheet after `drawImage` resampling. Express edge tolerances in inches
and convert, so they mean the same thing on a 24" sheet and a 370" one. Never rasterise the
whole sheet per design at that resolution — test per pair, over the intersection of their ink
bounds only, on one reused canvas. When a region is capped for memory, scale the drawing
(`ctx.scale`) rather than shrinking the canvas alone, which silently tests only its top-left
corner. Keep the worker and any main-thread fallback on one shared implementation: separate
copies drifted to different resolutions and gave different answers for the same sheet.

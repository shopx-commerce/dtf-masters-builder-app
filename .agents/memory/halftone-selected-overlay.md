---
name: Selected-design HD detail overlay rules
description: Constraints for the preview's high-resolution overlay canvas over the selected design (halftone and ordinary paths), and the seam it shares with the sheet canvas.
---

The preview paints the SELECTED design a second time, at high resolution, into an overlay canvas above the sheet canvas: nearest-neighbour 1:1 for halftones (so CSS zoom cannot soften the dot pattern), a worker-decoded export-blob bitmap for ordinary artwork. The overlay clips itself back from the design's edge; the sheet canvas paints exactly that perimeter band through an evenodd clip.

**Rules:**
1. The halftone overlay must only activate when the raster fits its size caps, so it renders 1:1. Nearest-neighbour DOWNSCALING a halftone shreds the dots — washed-out/speckled while selected, correct when deselected. Oversized rasters fall back to the main-canvas path.
2. The sheet canvas must paint the perimeter band and nothing more. Painting nothing leaves it transparent and the design looks cropped; painting the whole design under the overlay double-composites alpha, so soft and antialiased edges preview denser than they print.
3. **The band is measured in screen px, not sheet px.** It exists only to keep the selection chrome (handles, outline glow, label) visible, and that chrome is drawn at a fixed on-screen size at every zoom. The sheet canvas is CSS-scaled, so a band expressed in sheet px multiplies with the magnification: a fixed 6 px inset became a ~70 px frame of low-resolution artwork around a crisp interior at high zoom, which customers read as "part of my design isn't rendering properly". Divide the chrome's on-screen extent by the zoom.
4. Both sides of the band must come off the same raster, sampled the same way — the halftone band with smoothing disabled, the ordinary band from the detail bitmap — or the boundary puts a smoothed mip level against a crisp one.
5. **The clip may never sit further in than the painted band.** The clip lands with React's DOM commit and the band with a canvas repaint from a passive effect; neither is guaranteed to reach the screen first, so the two disagree for at least one frame whenever the inset changes. Clip smaller than band = harmless overlap; clip larger = a transparent gash around the design for a frame. Take the minimum of the pending and last-painted insets and the unsafe case becomes unreachable in both zoom directions.
6. Anything the band is sized from must be debounced off live zoom, because the sheet canvas deliberately does not repaint during a zoom gesture.

**Why:** customer-visible. A selected design that looks wrong makes users think it will print wrong, and the whole point of zooming in is to inspect print quality — so the artifact is worst exactly when it is being looked at hardest.

**How to apply:** any change to the overlay's activation, its clip inset, the caps, or the max zoom must keep all of these; verify a large 300-DPI halftone and a photographic full-colour design, selected and deselected, at both ends of the zoom range.

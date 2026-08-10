/**
 * Pixel geometry for gangsheet rendering.
 *
 * `dpi` is ALWAYS a parameter and is never read from a constant in here. The cart path pins DPI to
 * EXPORT_DPI, the download/export path can downscale it (Math.min(EXPORT_DPI, dpiByArea, dpiByDim)),
 * and the cart-preview path deliberately uses a tiny DPI. A helper that reached for EXPORT_DPI
 * itself would silently produce full-size output on the two paths that must not get it.
 *
 * Both helpers clamp to a minimum of 1px: a zero-width canvas throws on some browsers, and a
 * sub-pixel design would otherwise round to 0. Note the PDF branch of useImageEditorModelExport.ts
 * uses an intentionally UNCLAMPED variant of this formula and is not routed through here — see the
 * comment at that call site before changing it.
 *
 * The export worker (lib/export-worker.ts) keeps its own inline copy of the drawW/drawH formula on
 * purpose: it is bundled as a separate worker chunk and is the single most critical render path in
 * the app, so it is deliberately left untouched. Keep the two in sync if this formula ever changes.
 */

export interface OutputPixelSize {
  outW: number;
  outH: number;
}

export interface DesignDrawSize {
  drawW: number;
  drawH: number;
}

/** Full sheet size in pixels for an artboard measured in inches. */
export function computeOutputPixelSize(
  widthInches: number,
  heightInches: number,
  dpi: number,
): OutputPixelSize {
  return {
    outW: Math.max(1, Math.round(widthInches * dpi)),
    outH: Math.max(1, Math.round(heightInches * dpi)),
  };
}

/**
 * On-sheet pixel size of one placed design. `scale` is the design's transform scale (`transform.s`
 * on the React side, `s` in the worker's flattened payload) — passed explicitly rather than taking
 * a design object, because those two call sites disagree on the object's shape.
 */
export function computeDesignDrawSize(
  widthInches: number,
  heightInches: number,
  scale: number,
  dpi: number,
): DesignDrawSize {
  return {
    drawW: Math.max(1, Math.round(widthInches * scale * dpi)),
    drawH: Math.max(1, Math.round(heightInches * scale * dpi)),
  };
}

/**
 * DPI that fits a sheet inside a maximum pixel dimension, for the small cart preview. Returns a
 * DPI (not a size) so the caller keeps using the same geometry helpers above for the actual sizing.
 */
export function computePreviewDpi(
  widthInches: number,
  heightInches: number,
  maxLongestSidePx: number,
): number {
  const longestInches = Math.max(widthInches, heightInches);
  if (!(longestInches > 0)) return 1;
  return Math.max(1, maxLongestSidePx / longestInches);
}

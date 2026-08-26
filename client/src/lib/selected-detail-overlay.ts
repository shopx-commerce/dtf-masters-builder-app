/**
 * How far the selected-design HD overlay stops short of the design's edge.
 *
 * The overlay is the only thing on screen showing the artwork at the resolution the customer
 * is zoomed to. Everything it does *not* cover falls back to the sheet canvas, whose backing
 * store is capped in area and then CSS-scaled by the zoom — so any band the overlay holds
 * back is a band of visibly softer, blockier artwork with a seam down the middle of the
 * design. The band is not decoration; it is the part of the design that does not get the
 * high-resolution treatment.
 *
 * It exists because the selection chrome — the four corner handles, the outline, the print
 * label — is painted into the sheet canvas *underneath* the overlay. An overlay reaching the
 * design's edge would bury the handles the customer grabs behind opaque artwork.
 */

/**
 * The widest the band may ever be, in preview CSS px.
 *
 * This was the fixed inset before it was made zoom-aware, and it is kept as the ceiling so
 * nothing changes at the zoom levels where the overlay first appears.
 */
export const SELECTED_DETAIL_MAX_INSET_CSS_PX = 6;

/**
 * A hairline floor, so the clip and the ring it pairs with never collapse to zero width and
 * leave the chrome with nothing at all.
 */
export const SELECTED_DETAIL_MIN_INSET_CSS_PX = 0.25;

/**
 * The band's width in preview CSS px — the space the overlay leaves for the chrome.
 *
 * `chromeCssPx` is the chrome's extent in **screen** CSS px, which is a constant: handles are
 * drawn at a fixed on-screen size precisely so they stay grabbable at any magnification. The
 * band that protects them therefore has to be a constant on screen too, and the preview's own
 * coordinates are the screen's divided by the zoom.
 *
 * Getting this wrong in the obvious way — a fixed number of preview px — is what made the
 * artwork look broken at high zoom. Six preview px is six screen px at 100%, which is exactly
 * a desktop handle's half-extent and where the number came from; but the sheet is CSS-scaled,
 * so at 12x the very same six px is a 72 px band of low-resolution artwork wrapped around a
 * crisp interior, protecting a handle that is still twelve px across. The customer sees a
 * rectangle of "good" artwork sitting inside their design, and the harder they zoom in to
 * inspect their work, the worse it gets.
 */
export function selectedDetailInsetCssPx(zoom: number, chromeCssPx: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return SELECTED_DETAIL_MAX_INSET_CSS_PX;
  if (!Number.isFinite(chromeCssPx) || chromeCssPx <= 0) return SELECTED_DETAIL_MAX_INSET_CSS_PX;
  return Math.min(
    SELECTED_DETAIL_MAX_INSET_CSS_PX,
    Math.max(SELECTED_DETAIL_MIN_INSET_CSS_PX, chromeCssPx / zoom),
  );
}

/**
 * What the overlay actually clips to while the band underneath catches up.
 *
 * The band and the clip are computed from the same number but applied by two different
 * mechanisms — the clip lands with React's DOM commit, the band with a canvas repaint from an
 * effect — and neither is guaranteed to reach the screen first. So for at least one frame after
 * the inset changes, the two hold different values, and only one direction of disagreement is
 * survivable:
 *
 *   - clip inset **smaller** than the band's: the overlay reaches out over artwork the sheet
 *     canvas also painted. They overlap. Invisible, because the overlay is on top and holds the
 *     same artwork.
 *   - clip inset **larger** than the band's: neither layer owns the strip between them, and the
 *     design shows a transparent gash around its perimeter for a frame.
 *
 * Taking the smaller of the pending and painted insets makes the first case the only one
 * reachable, whichever way the zoom moved and whichever layer updates first. Zooming in shrinks
 * the inset, so the clip may adopt it immediately; zooming out grows it, so the clip waits for
 * the repaint that widens the band. Both converge the moment the two values agree.
 */
export function selectedDetailClipInsetCssPx(pendingCssPx: number, paintedCssPx: number): number {
  const pending = Number.isFinite(pendingCssPx) ? pendingCssPx : SELECTED_DETAIL_MAX_INSET_CSS_PX;
  const painted = Number.isFinite(paintedCssPx) ? paintedCssPx : SELECTED_DETAIL_MAX_INSET_CSS_PX;
  return Math.max(0, Math.min(pending, painted));
}

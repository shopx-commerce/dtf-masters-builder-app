/**
 * Sizing arithmetic for fitting a gangsheet to the artwork on it.
 *
 * Kept free of any browser dependency so it can be exercised directly by
 * `scripts/test-sheet-fit.ts`. Measuring where the ink actually is needs a canvas and lives in
 * `components/image-editor/utils.ts`; everything that decides which height to buy and how far
 * to slide the artwork is here, because that is the part that moves money.
 */

/** Margin used when the sheet is on "auto" gap, matching the packer's own default. */
export const DEFAULT_SHEET_MARGIN = 0.25;

/**
 * `required` is a sum of floating-point bounds, so artwork measuring exactly 12" can land on
 * 12.0000000001 and push the customer up a whole size for a rounding error.
 */
const FIT_EPS = 1e-6;

/** Vertical span of the artwork on a sheet, in inches from the sheet's top edge. */
export type InkBand = { minY: number; maxY: number };

/**
 * Smallest purchasable height that holds `bandHeight` of artwork with `margin` above and
 * below it, or null when nothing in the list is big enough.
 *
 * `heights` must be sorted ascending — the same precondition the expansion path relies on, and
 * why both places that build the list normalise it first.
 */
export function fitHeightForBand(
  bandHeight: number,
  margin: number,
  heights: number[],
): number | null {
  const required = bandHeight + margin * 2;
  for (const h of heights) {
    if (h >= required - FIT_EPS) return h;
  }
  return null;
}

/**
 * Decide whether a sheet can be dropped to a smaller purchasable height, and by how far the
 * artwork has to slide up to land on it.
 *
 * Returns null whenever shrinking is not on the table: the artwork needs the height it has,
 * nothing in the list is small enough, or a height the customer picked by hand blocks it.
 * Never returns a height above `currentHeight` — growing is the expansion path's job, and
 * letting this function grow the sheet is how you get the two fighting each other.
 *
 * `shift` is what makes this safe: subtracting it from every design's absolute Y moves the
 * whole arrangement as one rigid block to sit `margin` below the new top edge. Because the
 * band's height is unchanged by a translation, artwork that fitted inside its own band before
 * still fits inside it afterwards, so no design can be pushed off the shorter sheet and no
 * re-pack is needed.
 */
export function planSheetShrink(args: {
  band: InkBand;
  currentHeight: number;
  margin: number;
  heights: number[];
  /** Height the customer last chose by hand; shrinking stops there. */
  manualFloor?: number | null;
}): { height: number; shift: number } | null {
  const { band, currentHeight, margin, heights, manualFloor } = args;
  const bandHeight = band.maxY - band.minY;
  if (!Number.isFinite(bandHeight) || bandHeight < 0) return null;

  const fitted = fitHeightForBand(bandHeight, margin, heights);
  if (fitted === null) return null;

  const height = manualFloor != null ? Math.max(fitted, manualFloor) : fitted;
  if (height >= currentHeight) return null;

  return { height, shift: band.minY - margin };
}

/**
 * Slide the artwork off the top edge without changing the height, for the sheets
 * `planSheetShrink` declines.
 *
 * The packers place from y=0 — none of them has a border inset, which is why the top row of
 * an arrange lands flush against the sheet edge while every shrink-produced layout sits
 * `margin` below it. Ink on the edge of a DTF sheet is a production risk, so this closes
 * that gap, and it is deliberately the *cheap* half of the fix: it is a pure translation, so
 * it can never move the sheet onto a taller rung of the height ladder. Reserving the margin
 * inside the packer instead measured at one extra rung in roughly 2% of sheets
 * (`scripts/bench-arrange-margin.ts`), which on a 12" order is a doubling.
 *
 * On a sheet too tight for `margin` at both ends it does not give up and leave the ink on the
 * edge; it centres the band in whatever slack there is, so both ends get `slack / 2`. Honouring
 * the full margin there would mean buying a taller rung, which is not this function's decision
 * to make, but half a margin costs nothing and still keeps ink off the edge.
 *
 * It never moves artwork *up*: a band already clear of the inset is where the customer put it,
 * and a band taller than the sheet has no slack to redistribute.
 *
 * `shift` matches `planSheetShrink`'s sign convention: subtract it from every design's
 * absolute Y. Here it is always negative, so the arrangement moves down as one rigid block.
 */
export function planBandReseat(args: {
  band: InkBand;
  currentHeight: number;
  margin: number;
}): { shift: number } | null {
  const { band, currentHeight, margin } = args;
  const bandHeight = band.maxY - band.minY;
  if (!Number.isFinite(bandHeight) || bandHeight < 0) return null;

  const slack = currentHeight - bandHeight;
  const inset = Math.min(margin, slack / 2);
  if (inset <= FIT_EPS) return null;
  if (band.minY >= inset - FIT_EPS) return null;

  return { shift: band.minY - inset };
}

/**
 * Next height to try when a pack overflowed, skipping the rungs that cannot possibly work.
 *
 * The expansion path used to step to `heights.find(h => h > currentHeight)` and pack again,
 * learning nothing from the pack it had just thrown away. On artwork that needs several
 * sizes more than it has, that is one full re-pack and composite rebuild per rung: twenty
 * 14.22" designs on a 24.5" sheet walked 48" to 340" in nine packs, eight of them pointless.
 *
 * `minRequiredHeight` comes from `packingHeightLowerBound`, and the contract that makes
 * this safe is that it is a *lower* bound — a height below which no legal arrangement
 * exists. Every rung this skips would therefore have overflowed too, so the rung landed on
 * is exactly the one the one-at-a-time loop would have reached, just sooner. If the bound
 * is weak the result is only the next rung up, which is the old behaviour, so nothing can
 * end up overflowing silently.
 *
 * Note what is deliberately *not* added here: the sheet-edge margin. The packer is handed
 * the whole sheet and has no border inset, so a rung has to hold the artwork, not the
 * artwork plus two margins. Requiring the margins would skip rungs that the packer would in
 * fact have succeeded on, which is the ladder cost that got the packer-side inset rejected
 * in the first place — see `planBandReseat`. The margin is honoured afterwards by sliding
 * the finished band, which cannot change the height.
 *
 * Returns null when there is nowhere left to grow.
 */
export function planLadderJump(args: {
  currentHeight: number;
  /** Lower bound on the height any legal layout of this artwork needs. */
  minRequiredHeight: number;
  heights: number[];
}): number | null {
  const { currentHeight, minRequiredHeight, heights } = args;
  const taller = heights.filter(h => h > currentHeight);
  if (taller.length === 0) return null;
  if (!Number.isFinite(minRequiredHeight) || minRequiredHeight <= 0) return taller[0];
  return taller.find(h => h >= minRequiredHeight - FIT_EPS) ?? taller[taller.length - 1];
}

/**
 * Fill Sheet's capacity policy: how many copies to try, and when to stop trying.
 *
 * Kept apart from the editor hook because the interesting part is arithmetic
 * and a state machine, both of which are worth testing against the real packer
 * without a React tree — see `fill-sheet.test.ts`.
 *
 * The governing idea: **nobody can predict what the packer will do.** It runs a
 * sweep of six rectangle heuristics plus a bitmap nester over the artwork's
 * actual silhouettes, at three different gaps, and picks the best of them.
 * Irregular artwork interlocks; rectangles do not. So any formula that answers
 * "how many fit" from width and height alone is a guess, and a guess is only
 * ever used here to pick the *first* batch. What decides the final count is the
 * packer itself: keep adding copies until it starts refusing them.
 */

/** Fill Sheet never pushes the design count past this — the editor has to stay interactive. */
export const MAX_FILL_TOTAL_DESIGNS = 500;

/**
 * How many packs one fill may run.
 *
 * The search needs a handful: one to place the estimate, one or two to bracket the true
 * capacity, then a bisection whose interval starts at a quarter of the estimate and halves
 * every pass. Ten is enough to land exactly on the answer for any sheet the design cap
 * allows, and the time budget stops it long before this on a sheet where packs are slow.
 */
export const MAX_FILL_PASSES = 10;

/**
 * How long a fill may keep packing before it settles for what it has.
 *
 * A pass is a whole arrange (up to 10s if the worker has to time out and fall
 * back), so this is a ceiling on a rare bad case, not a target. Filling is a
 * deliberate, explicit action with a veil over the preview the whole time —
 * taking a few seconds to fill the sheet accurately is the trade this feature
 * is supposed to make.
 */
export const FILL_TIME_BUDGET_MS = 30_000;

/**
 * A first guess at how many copies of `ref` the empty film could hold: grid
 * capacity in whichever orientation holds more, minus an area-weighted estimate
 * of what the existing designs consume.
 *
 * Systematically low — every term rounds against it. Both grid dimensions floor,
 * every existing design is charged a full gap on all four sides, and neither
 * the nester's interlocking nor the packers' half-gap fallback is modelled. That
 * is fine, and deliberate: this only has to put the first pass in the right
 * order of magnitude. `planNextFillPass` corrects it from the packer's actual
 * answer, so an estimate that is half the truth costs one extra pass rather
 * than half a sheet of empty film.
 */
export function estimateFillCount(
  ref: { w: number; h: number },
  existing: readonly { w: number; h: number }[],
  gap: number,
  sheetW: number,
  sheetH: number,
): number {
  const rw = ref.w;
  const rh = ref.h;
  const g = Math.max(0, gap);
  if (!(rw > 0) || !(rh > 0) || !(sheetW > 0) || !(sheetH > 0)) return 0;
  const colsN = Math.floor((sheetW + g) / (rw + g));
  const rowsN = Math.floor((sheetH + g) / (rh + g));
  let totalCapacity = colsN * rowsN;
  // Non-square designs may pack better rotated 90°.
  if (Math.abs(rw - rh) > 0.01) {
    const colsR = Math.floor((sheetW + g) / (rh + g));
    const rowsR = Math.floor((sheetH + g) / (rw + g));
    totalCapacity = Math.max(totalCapacity, colsR * rowsR);
  }
  if (totalCapacity <= 0) return 0;
  const refCellArea = (rw + g) * (rh + g);
  const consumedSlots = existing.reduce(
    (acc, d) => acc + ((d.w + g) * (d.h + g)) / refCellArea,
    0,
  );
  return Math.max(0, Math.round(totalCapacity - consumedSlots));
}

/** What one pack of a fill pass did, as far as the fill is concerned. */
export type FillPassOutcome = {
  /** Copies the packer could not place, which the arrange then deleted. */
  trimmed: number;
  /** The pass could not be honoured at all, and the sheet was put back. */
  reverted: boolean;
};

export type FillPlan =
  | {
      kind: 'pack';
      /** How many copies to append before this pack. */
      batch: number;
      /**
       * Pack with the existing layout held in place instead of from scratch.
       * Only used to rescue a pass a fresh repack could not honour.
       */
      stable: boolean;
    }
  | {
      kind: 'stop';
      reason:
        | 'saturated'
        | 'reverted'
        | 'nothingFits'
        | 'passLimit'
        | 'designLimit'
        | 'timeBudget'
        | 'frozenBudget';
    };

export type FillPassState = {
  /** Passes already packed. 0 on the first call. */
  pass: number;
  /** Copies appended so far across this fill and still on the sheet. */
  added: number;
  /** Size of the batch the last pass appended. */
  lastBatch: number;
  /** Designs currently on the sheet, copies included. */
  totalDesigns: number;
  /** Milliseconds since the fill started. */
  elapsedMs: number;
  /**
   * Of those milliseconds, how many were spent packing on the UI thread with the page
   * frozen. See `FILL_FROZEN_BUDGET_MS`.
   */
  frozenMs: number;
  /** Result of the last pass, or null before the first. */
  outcome: FillPassOutcome | null;
  /** Whether the stable-layout rescue has already been spent on this fill. */
  usedStableRetry: boolean;
  /** First-pass guess from `estimateFillCount`. */
  estimate: number;
  /**
   * Smallest copy count the packer has already refused, or null while it has refused
   * none. The upper bracket of the search.
   */
  highFail: number | null;
};

/**
 * How much a pass raises the copy count while the ceiling is still unknown.
 *
 * A quarter, not a doubling, and the reason is a property of the packer rather than of
 * the arithmetic. It is a heuristic search over the whole item set, so a large surplus
 * does not simply leave the extras overflowing — it changes which layout wins, and the
 * best layout of far too many items is worse than the best layout of roughly the right
 * number. Packing 248 copies onto a sheet that comfortably holds 129 settled 124 of them.
 * Modest steps keep every pass near a layout the customer would actually want.
 */
const GROWTH_RATIO = 0.25;

/**
 * How many seconds of *frozen* packing a fill may spend before it settles for what it has.
 *
 * Packing normally happens in a worker, where a long pass costs the customer nothing but
 * time: the veil keeps animating and the loop keeps searching. When there is no worker, or
 * one times out, the same pack runs on the UI thread and the tab stops repainting until it
 * finishes — so this budget is spent in the only currency that matters there, seconds of a
 * dead-looking page, rather than in passes. A browser that packs in milliseconds still gets
 * the full search; one that takes seconds a pack gets a couple and then stops.
 *
 * Two honest limitations. The budget is retrospective — it can only be charged once a pack
 * returns, so one pathological pack can block for longer than this before anything is in a
 * position to notice; bounding that would mean teaching the shared packing core to yield
 * mid-pack. And a fill that spends this budget stops short of saturation deliberately,
 * trading the last of the film for a page that responds.
 */
export const FILL_FROZEN_BUDGET_MS = 8_000;

/**
 * Decide the next pass of a fill, or end it.
 *
 * A bracket-and-bisect search for the largest number of copies the packer will accept,
 * because that number cannot be derived — only observed:
 *
 * - **Grow.** While nothing has been refused, each pass raises the copy count by
 *   `GROWTH_RATIO`. A pass whose copies all fit proves the sheet held that many, and the
 *   lower bracket moves up.
 * - **Bracket.** The first pass to get copies trimmed has found a count the packer will
 *   not take. That is the upper bracket, and reaching it costs the customer nothing: the
 *   copies that did not fit are deleted before they are ever seen.
 * - **Bisect.** Knowing a count that fits and a count that does not, each further pass
 *   tries the midpoint. The interval halves every time, so the fill ends on the number of
 *   copies the sheet actually holds rather than on an estimate of it.
 * - **Rescue.** A pass that is *reverted* means the fresh repack could not even re-place
 *   the customer's own designs at this height. That is a failure of the heuristics rather
 *   than a shortage of film, so it is worth one retry with the existing layout held in
 *   place and the copies slotted into what is left over.
 */
export function planNextFillPass(state: FillPassState): FillPlan {
  const remaining = Math.max(0, MAX_FILL_TOTAL_DESIGNS - state.totalDesigns);

  if (state.outcome === null) {
    // The estimate can be zero on a sheet that is merely *nearly* full, where
    // the packer may still have room the grid model cannot see. One probe copy
    // answers that honestly; if it does not fit, it is trimmed and the fill
    // stops having changed nothing.
    const batch = Math.min(Math.max(1, state.estimate), remaining);
    return batch >= 1 ? { kind: 'pack', batch, stable: false } : { kind: 'stop', reason: 'designLimit' };
  }

  // Ceilings first, and that includes ahead of the rescue below: a rescue is still a pack,
  // and one scheduled past the pass count or the time budget breaks the promise those
  // ceilings make about how long a click can run for.
  if (state.pass >= MAX_FILL_PASSES) return { kind: 'stop', reason: 'passLimit' };
  if (state.elapsedMs >= FILL_TIME_BUDGET_MS) return { kind: 'stop', reason: 'timeBudget' };
  if (state.frozenMs >= FILL_FROZEN_BUDGET_MS) return { kind: 'stop', reason: 'frozenBudget' };
  if (remaining < 1) return { kind: 'stop', reason: 'designLimit' };

  if (state.outcome.reverted) {
    if (state.usedStableRetry) return { kind: 'stop', reason: 'reverted' };
    const batch = Math.min(Math.max(1, state.lastBatch), remaining);
    return batch >= 1 ? { kind: 'pack', batch, stable: true } : { kind: 'stop', reason: 'reverted' };
  }

  if (state.highFail === null) {
    return {
      kind: 'pack',
      batch: Math.min(Math.max(2, Math.ceil(state.added * GROWTH_RATIO)), remaining),
      stable: false,
    };
  }

  // Bisect what is left of the bracket. `added` — the largest count known to fit — is read
  // fresh each pass rather than remembered, because a trim can take copies from earlier
  // passes too, and the search has to bisect from where the sheet actually is.
  const target = Math.floor((state.added + state.highFail) / 2);
  const batch = Math.min(target - state.added, remaining);
  if (batch < 1) {
    // The brackets have closed: the sheet holds what it holds. Closing at zero means the
    // packer would not take even the first copy.
    return state.added > 0 ? { kind: 'stop', reason: 'saturated' } : { kind: 'stop', reason: 'nothingFits' };
  }
  return { kind: 'pack', batch, stable: false };
}

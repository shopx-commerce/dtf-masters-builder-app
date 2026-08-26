import { describe, expect, it } from "vitest";
import { runArrange, type PlacedItem } from "@/lib/arrange-core";
import {
  FILL_FROZEN_BUDGET_MS,
  FILL_TIME_BUDGET_MS,
  MAX_FILL_PASSES,
  MAX_FILL_TOTAL_DESIGNS,
  estimateFillCount,
  planNextFillPass,
  type FillPassState,
} from "@/lib/fill-sheet";

const baseState = (over: Partial<FillPassState> = {}): FillPassState => ({
  pass: 1,
  added: 10,
  lastBatch: 10,
  totalDesigns: 12,
  elapsedMs: 0,
  outcome: { trimmed: 0, reverted: false },
  frozenMs: 0,
  usedStableRetry: false,
  estimate: 10,
  highFail: null,
  ...over,
});

describe("estimateFillCount", () => {
  it("counts the grid an empty sheet holds", () => {
    // 22 / (2 + 0.25) → 9 across, 60 / (2 + 0.25) → 26 down, allowing the last
    // column and row to do without a trailing gap.
    expect(estimateFillCount({ w: 2, h: 2 }, [], 0.25, 22, 60)).toBe(9 * 26);
  });

  it("credits the better of the two orientations", () => {
    // Upright, a 6x2 fits 3 across; turned, 10 — the sheet holds far more that way and the
    // packer is free to turn it, so the estimate may not price it as if it could not.
    const upright = Math.floor(22.25 / 6.25) * Math.floor(60.25 / 2.25);
    const turned = Math.floor(22.25 / 2.25) * Math.floor(60.25 / 6.25);
    expect(turned).toBeGreaterThan(upright);
    expect(estimateFillCount({ w: 6, h: 2 }, [], 0.25, 22, 60)).toBe(turned);
  });

  it("charges existing designs against capacity", () => {
    const empty = estimateFillCount({ w: 2, h: 2 }, [], 0.25, 22, 60);
    const occupied = estimateFillCount({ w: 2, h: 2 }, [{ w: 10, h: 20 }], 0.25, 22, 60);
    expect(occupied).toBeLessThan(empty);
    expect(occupied).toBeGreaterThan(0);
  });

  it("returns zero rather than a negative when nothing can fit", () => {
    expect(estimateFillCount({ w: 40, h: 40 }, [], 0.25, 22, 60)).toBe(0);
    expect(estimateFillCount({ w: 0, h: 2 }, [], 0.25, 22, 60)).toBe(0);
    expect(estimateFillCount({ w: 2, h: 2 }, [{ w: 22, h: 60 }], 0.25, 22, 60)).toBe(0);
  });
});

describe("planNextFillPass", () => {
  it("opens with the estimate", () => {
    const plan = planNextFillPass(baseState({ pass: 0, added: 0, lastBatch: 0, outcome: null, estimate: 37, totalDesigns: 3 }));
    expect(plan).toEqual({ kind: "pack", batch: 37, stable: false });
  });

  it("probes with one copy when the estimate says the sheet is full", () => {
    // The regression this whole loop exists for: the estimate is systematically low, so
    // "zero" is a claim only the packer can settle. Asking costs one copy that gets trimmed.
    const plan = planNextFillPass(baseState({ pass: 0, added: 0, lastBatch: 0, outcome: null, estimate: 0, totalDesigns: 3 }));
    expect(plan).toEqual({ kind: "pack", batch: 1, stable: false });
  });

  it("grows by a quarter while nothing has been refused", () => {
    expect(planNextFillPass(baseState({ added: 40, lastBatch: 40, totalDesigns: 42 })))
      .toEqual({ kind: "pack", batch: 10, stable: false });
    // Never stalls on a sheet holding one or two copies, where a quarter rounds to nothing.
    expect(planNextFillPass(baseState({ added: 1, lastBatch: 1, totalDesigns: 3 })))
      .toEqual({ kind: "pack", batch: 2, stable: false });
  });

  it("bisects between the count that fit and the count that did not", () => {
    // 120 fit, 150 was refused: try 135.
    expect(planNextFillPass(baseState({ added: 120, lastBatch: 30, totalDesigns: 122, highFail: 150 })))
      .toEqual({ kind: "pack", batch: 15, stable: false });
    // ...and keep halving what is left of the interval.
    expect(planNextFillPass(baseState({ added: 135, lastBatch: 15, totalDesigns: 137, highFail: 150 })))
      .toEqual({ kind: "pack", batch: 7, stable: false });
  });

  it("stops when the brackets close on the true capacity", () => {
    expect(planNextFillPass(baseState({
      added: 128,
      lastBatch: 1,
      totalDesigns: 130,
      highFail: 129,
      outcome: { trimmed: 1, reverted: false },
    }))).toEqual({ kind: "stop", reason: "saturated" });
  });

  it("settles for what it has once packing has frozen the page for long enough", () => {
    // Cheap packs on the UI thread are not a reason to stop searching...
    expect(planNextFillPass(baseState({ frozenMs: 200 })))
      .toEqual({ kind: "pack", batch: 3, stable: false });
    // ...but a page that has been unresponsive for eight seconds is.
    expect(planNextFillPass(baseState({ frozenMs: FILL_FROZEN_BUDGET_MS })))
      .toEqual({ kind: "stop", reason: "frozenBudget" });
  });

  it("will not spend a rescue it no longer has the passes or the seconds for", () => {
    const reverted = { trimmed: 0, reverted: true };
    expect(planNextFillPass(baseState({ pass: MAX_FILL_PASSES, outcome: reverted })))
      .toEqual({ kind: "stop", reason: "passLimit" });
    expect(planNextFillPass(baseState({ elapsedMs: FILL_TIME_BUDGET_MS, outcome: reverted })))
      .toEqual({ kind: "stop", reason: "timeBudget" });
  });

  it("reports a sheet that could not take a single copy", () => {
    expect(planNextFillPass(baseState({
      added: 0,
      lastBatch: 1,
      totalDesigns: 3,
      highFail: 1,
      outcome: { trimmed: 1, reverted: false },
    }))).toEqual({ kind: "stop", reason: "nothingFits" });
  });

  it("rescues a reverted pass once, with the layout held in place", () => {
    const reverted = baseState({ added: 0, lastBatch: 8, outcome: { trimmed: 0, reverted: true } });
    expect(planNextFillPass(reverted)).toEqual({ kind: "pack", batch: 8, stable: true });
  });

  it("comes down off a count the packer would not lay out", () => {
    // The reported bug. An overshoot does not leave the surplus hanging off the film — it
    // wrecks the layout until the customer's own designs stop fitting, and the pass reverts.
    // Asking for the same number again is the one thing that cannot work, so once the
    // stable rescue is spent the search has to bisect below it like any other refusal.
    const spent = baseState({
      added: 0,
      lastBatch: 19,
      totalDesigns: 2,
      usedStableRetry: true,
      highFail: 19,
      outcome: { trimmed: 0, reverted: true },
    });
    expect(planNextFillPass(spent)).toEqual({ kind: "pack", batch: 9, stable: false });
    // And keeps coming down while it keeps reverting, rather than giving up at the first one.
    expect(planNextFillPass({ ...spent, lastBatch: 9, highFail: 9 }))
      .toEqual({ kind: "pack", batch: 4, stable: false });
  });

  it("does not call a sheet full on the word of a reverted pass", () => {
    // Brackets closed with nothing placed, but the last pass reverted — the packer never
    // said the copy would not fit, it failed to lay the sheet out. The customer is looking
    // at that space; telling them the sheet is full is telling them something untrue.
    expect(planNextFillPass(baseState({
      added: 0,
      lastBatch: 1,
      usedStableRetry: true,
      highFail: 1,
      outcome: { trimmed: 0, reverted: true },
    }))).toEqual({ kind: "stop", reason: "reverted" });
    // A trim at the same point is real evidence, and still reads as full.
    expect(planNextFillPass(baseState({
      added: 0,
      lastBatch: 1,
      highFail: 1,
      outcome: { trimmed: 1, reverted: false },
    }))).toEqual({ kind: "stop", reason: "nothingFits" });
  });

  it("stops on a revert it has no bracket for", () => {
    // Nothing has been refused at a known count, so there is no interval to bisect and the
    // only untried number is the one that just failed. Stopping beats looping.
    expect(planNextFillPass(baseState({
      added: 0,
      lastBatch: 8,
      usedStableRetry: true,
      highFail: null,
      outcome: { trimmed: 0, reverted: true },
    }))).toEqual({ kind: "stop", reason: "reverted" });
  });

  it("honours the design, pass and time ceilings", () => {
    expect(planNextFillPass(baseState({ totalDesigns: MAX_FILL_TOTAL_DESIGNS })))
      .toEqual({ kind: "stop", reason: "designLimit" });
    expect(planNextFillPass(baseState({ pass: MAX_FILL_PASSES })))
      .toEqual({ kind: "stop", reason: "passLimit" });
    expect(planNextFillPass(baseState({ elapsedMs: FILL_TIME_BUDGET_MS })))
      .toEqual({ kind: "stop", reason: "timeBudget" });
  });

  it("never plans a batch that would breach the design cap", () => {
    expect(planNextFillPass(baseState({
      added: 400,
      lastBatch: 400,
      totalDesigns: MAX_FILL_TOTAL_DESIGNS - 5,
    }))).toEqual({ kind: "pack", batch: 5, stable: false });
    expect(planNextFillPass(baseState({
      added: 400,
      lastBatch: 100,
      totalDesigns: MAX_FILL_TOTAL_DESIGNS - 5,
      highFail: 460,
    }))).toEqual({ kind: "pack", batch: 5, stable: false });
  });
});

/* ------------------------------------------------------------------------- *
 * The loop against the real packer.
 *
 * `planNextFillPass` is only as good as what happens when its plan meets
 * `runArrange`, so these drive the actual packer the editor uses and check the
 * property the feature is judged on: when the fill stops, one more copy must
 * not fit. Everything the hook does around the packer — appending the batch,
 * deleting trimmed copies, reverting a pass that could not place an original —
 * is reproduced here; nothing about the packing itself is stubbed.
 * ------------------------------------------------------------------------- */

type SimItem = { id: string; w: number; h: number; fill: number };

const pack = (items: SimItem[], sheetW: number, sheetH: number, gap: number, preferStable = false): PlacedItem[] =>
  runArrange({
    type: "arrange",
    requestId: 1,
    items,
    usableW: sheetW,
    usableH: sheetH,
    artboardWidth: sheetW,
    artboardHeight: sheetH,
    isAggressive: true,
    customGap: gap,
    preferStable,
  }).result;

/** Would one more copy of `ref` still fit alongside `items`? */
const holdsOneMore = (items: SimItem[], ref: SimItem, sheetW: number, sheetH: number, gap: number): boolean => {
  const probe: SimItem = { ...ref, id: "probe" };
  return !pack([...items, probe], sheetW, sheetH, gap).some(p => p.overflows);
};

/**
 * The editor's fill loop, with the React and worker layers taken out: append the batch the
 * planner asks for, pack, delete overflowing copies, and report what happened back to the
 * planner. Returns the sheet it settled on.
 */
function simulateFill(opts: {
  existing: SimItem[];
  ref: SimItem;
  sheetW: number;
  sheetH: number;
  gap: number;
  /** Stand in for a pessimistic opening guess, to prove the loop is not bound by it. */
  estimate?: number;
}) {
  const { existing, ref, sheetW, sheetH, gap } = opts;
  const originalIds = new Set(existing.map(d => d.id));
  const estimate = opts.estimate ?? estimateFillCount(ref, existing, gap, sheetW, sheetH);

  let designs = [...existing];
  let pass = 0;
  let added = 0;
  let lastBatch = 0;
  let usedStableRetry = false;
  let highFail: number | null = null;
  let packs = 0;
  let outcome: { trimmed: number; reverted: boolean } | null = null;
  let stopReason = "";

  for (;;) {
    const plan = planNextFillPass({
      pass,
      added,
      lastBatch,
      totalDesigns: designs.length,
      elapsedMs: 0,
      // The harness packs synchronously in Node; a real fill only charges this budget for
      // packs that ran on the UI thread, which the worker keeps it off in the browser.
      frozenMs: 0,
      outcome,
      usedStableRetry,
      estimate,
      highFail,
    });
    if (plan.kind === "stop") { stopReason = plan.reason; break; }
    if (plan.stable) usedStableRetry = true;

    const prePass = designs;
    const copies: SimItem[] = Array.from({ length: plan.batch }, (_, i) => ({
      ...ref,
      id: `fill-${pass}-${i}`,
    }));
    const candidate = [...prePass, ...copies];
    const placed = pack(candidate, sheetW, sheetH, gap, plan.stable);
    packs += 1;
    pass += 1;
    lastBatch = plan.batch;

    const overflowing = new Set(placed.filter(p => p.overflows).map(p => p.id));
    const thisPass = new Set(copies.map(c => c.id));

    // An original that no longer fits is not something a fill may spend, so the pass undoes
    // itself — exactly as `applyResult` does under `noGrow`.
    if (placed.some(p => p.overflows && originalIds.has(p.id))) {
      // Not a clean rewind. The trim runs first and takes every overflowing copy with it,
      // including ones earlier passes placed; only this pass's copies come back. Production
      // reports exactly that count so the tally follows the sheet — mirror it here or the
      // harness proves the loop correct for a state machine that is not the one shipping.
      const earlierLost = [...overflowing].filter(id => !thisPass.has(id) && !originalIds.has(id));
      designs = prePass.filter(d => !earlierLost.includes(d.id));
      // Still a count the packer refused, and recorded as one — see the hook's
      // `lowerBracket`. Without this the search has nothing to bisect against and can only
      // ask for the same number again.
      highFail = Math.min(highFail ?? Infinity, added + plan.batch);
      added -= earlierLost.length;
      outcome = { trimmed: earlierLost.length, reverted: true };
      continue;
    }
    const trimmed = overflowing;
    designs = candidate.filter(d => !trimmed.has(d.id));
    added += plan.batch;
    if (trimmed.size > 0) {
      // The count just refused becomes the upper bracket, exactly as the hook records it.
      highFail = Math.min(highFail ?? Infinity, added);
      added -= trimmed.size;
    }
    outcome = { trimmed: trimmed.size, reverted: false };
  }

  return { designs, added, estimate, packs, stopReason };
}

describe("fill loop against the real packer", () => {
  it("fills a blank sheet until one more copy would not fit", () => {
    const sheetW = 22, sheetH = 24, gap = 0.25;
    const ref: SimItem = { id: "ref", w: 3.5, h: 2.5, fill: 1 };
    const existing: SimItem[] = [{ ...ref, id: "original" }];

    const out = simulateFill({ existing, ref, sheetW, sheetH, gap });

    expect(out.stopReason).toBe("saturated");
    expect(holdsOneMore(out.designs, ref, sheetW, sheetH, gap)).toBe(false);
  });

  it("is not bound by a short opening estimate", () => {
    // The reported bug. The estimate is a grid at full gap minus an area charge that gives
    // every existing design its own gap ring; the packer beats both of those, so a
    // one-shot fill stopped with film to spare. Driving it to saturation must place at
    // least as many copies as the estimate, and here strictly more.
    const sheetW = 22, sheetH = 24, gap = 0.25;
    const ref: SimItem = { id: "ref", w: 1.5, h: 1.5, fill: 1 };
    // A dozen assorted designs already on the sheet, which is where a formula is at its
    // worst: each one is charged a full gap on all four sides, so the film it believes is
    // spoken for is measurably more than the film that is.
    const existing: SimItem[] = Array.from({ length: 12 }, (_, i) => ({
      id: `e${i}`,
      w: 2 + (i % 3),
      h: 1.5 + (i % 4) * 0.5,
      fill: 1,
    }));
    // A third of what the sheet holds, standing in for any reason the opening guess comes
    // in low — the packer's half-gap fallback, silhouettes that interlock, a sheet already
    // carrying work. The old fill added exactly this many and stopped.
    const short = Math.floor(estimateFillCount(ref, existing, gap, sheetW, sheetH) / 3);
    const oneShot = [...existing, ...Array.from({ length: short }, (_, i) => ({ ...ref, id: `s${i}` }))];
    expect(holdsOneMore(oneShot, ref, sheetW, sheetH, gap)).toBe(true);

    const out = simulateFill({ existing, ref, sheetW, sheetH, gap, estimate: short });

    expect(out.added).toBeGreaterThan(short);
    expect(holdsOneMore(out.designs, ref, sheetW, sheetH, gap)).toBe(false);
    expect(out.packs).toBeLessThanOrEqual(MAX_FILL_PASSES);
  });

  it("fills a sheet whose first estimate the packer will not lay out", () => {
    // The customer's report: a sheet with obvious space left, told there was no room. One
    // large design and one small one, and the small one is what Fill Sheet clones. Nineteen
    // copies is what the estimate asks for; at that count the packer cannot re-place the
    // large design and the whole pass reverts. So did the retry, and the fill then declared
    // the sheet full — while ten copies go on without complaint.
    const sheetW = 22, sheetH = 12, gap = 0.25;
    const ref: SimItem = { id: "small", w: 1.5, h: 1.5, fill: 1 };
    const existing: SimItem[] = [{ id: "big", w: 20, h: 9.5, fill: 1 }, ref];

    // The premise: the opening estimate is a count this sheet cannot be laid out at.
    const estimate = estimateFillCount(ref, existing, gap, sheetW, sheetH);
    const overshoot = pack(
      [...existing, ...Array.from({ length: estimate }, (_, i) => ({ ...ref, id: `o${i}` }))],
      sheetW, sheetH, gap,
    );
    expect(overshoot.some(p => p.overflows && p.id === "big")).toBe(true);

    const out = simulateFill({ existing, ref, sheetW, sheetH, gap });

    expect(out.added).toBeGreaterThan(0);
    expect(out.stopReason).not.toBe("nothingFits");
    expect(out.stopReason).not.toBe("reverted");
    // And it did not merely add one or two: it found what the film actually holds.
    expect(holdsOneMore(out.designs, ref, sheetW, sheetH, gap)).toBe(false);
    expect(out.packs).toBeLessThanOrEqual(MAX_FILL_PASSES);
  });

  it("adds nothing and says so when the sheet really is full", () => {
    const sheetW = 22, sheetH = 12, gap = 0.25;
    const ref: SimItem = { id: "ref", w: 21, h: 11, fill: 1 };
    const existing: SimItem[] = [{ ...ref, id: "original" }];

    const out = simulateFill({ existing, ref, sheetW, sheetH, gap });

    expect(out.added).toBe(0);
    expect(out.designs.map(d => d.id)).toEqual(["original"]);
    expect(out.stopReason).toBe("nothingFits");
  });

  it("terminates within its ceilings on a sheet that could swallow thousands", () => {
    const sheetW = 22, sheetH = 60, gap = 0;
    const ref: SimItem = { id: "ref", w: 0.5, h: 0.5, fill: 1 };
    const out = simulateFill({ existing: [{ ...ref, id: "original" }], ref, sheetW, sheetH, gap });

    expect(out.designs.length).toBeLessThanOrEqual(MAX_FILL_TOTAL_DESIGNS);
    expect(out.packs).toBeLessThanOrEqual(MAX_FILL_PASSES);
    expect(["saturated", "designLimit", "passLimit"]).toContain(out.stopReason);
  });
});

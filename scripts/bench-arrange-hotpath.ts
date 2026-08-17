/**
 * What one auto-arrange and one duplicate actually cost, broken down by stage.
 *
 *   npx tsx scripts/bench-arrange-hotpath.ts
 *
 * The editor reports lag on three operations that all funnel into `runArrange`: pressing
 * Auto-Arrange, changing a layer's copy count, and duplicating. This bench times the pieces
 * that operation is built from, at 10 / 50 / 100 designs, so the report can attribute the
 * wall clock rather than guess at it:
 *
 *   runArrange              the whole thing, as the worker calls it.
 *   rect sweep only         `runArrange` with no masks, which skips the nester entirely.
 *   nestPack                one bitmap nest, x3 in a real arrange.
 *   keepPositionsNest       the stability candidate, run once more on top of the sweep.
 *   packingHeightLowerBound the sizing bound `describe` computes on every arrange.
 *   inkInset (warm/cold)    the per-design silhouette measurement the shrink path uses.
 *
 * `noRotate` is measured separately because groups are now packed with it set, and the
 * question is whether forbidding rotation makes the packers work harder or just worse.
 *
 * Conventions follow `bench-arrange-ladder.ts`: same synthetic shape corpus, same ladder,
 * same direct imports of the real modules so there is no reimplementation to drift.
 */

import { runArrange, packingHeightLowerBound, type ArrangeInput } from '../client/src/lib/arrange-core';
import {
  inkInset,
  nestPack,
  keepPositionsNest,
  NEST_CELL_INCHES,
  type NestMask,
} from '../client/src/lib/nest-core';
import { DEFAULT_SHEET_MARGIN, planSheetShrink } from '../client/src/lib/sheet-fit';

const CELL = NEST_CELL_INCHES;
const GAP = DEFAULT_SHEET_MARGIN;
const SHEET_W = 22;
const LADDER = [12, 18, 24, 36, 48, 60, 72, 84, 96, 120, 160, 240, 340];

// ---------------------------------------------------------------------------
// Synthetic artwork, matching bench-arrange-ladder.ts's corpus.
// ---------------------------------------------------------------------------

type ShapeKind = 'circle' | 'triangle' | 'lshape' | 'ring' | 'diagonal' | 'rect' | 'star' | 'blob';
const KINDS: ShapeKind[] = ['circle', 'triangle', 'lshape', 'ring', 'diagonal', 'rect', 'star', 'blob'];

function makeMask(kind: ShapeKind, wIn: number, hIn: number): NestMask {
  const cols = Math.max(1, Math.ceil(wIn / CELL - 1e-6));
  const rows = Math.max(1, Math.ceil(hIn / CELL - 1e-6));
  const bits = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const u = (c + 0.5) / cols;
      const v = (r + 0.5) / rows;
      const dx = u - 0.5, dy = v - 0.5;
      let ink = false;
      switch (kind) {
        case 'circle': ink = dx * dx + dy * dy <= 0.25; break;
        case 'triangle': ink = Math.abs(u - 0.5) <= v / 2; break;
        case 'lshape': ink = u <= 0.4 || v >= 0.6; break;
        case 'ring': { const d2 = dx * dx + dy * dy; ink = d2 <= 0.25 && d2 >= 0.09; break; }
        case 'diagonal': ink = Math.abs(u - v) <= 0.22; break;
        case 'star': { const a = Math.atan2(dy, dx); ink = Math.hypot(dx, dy) <= 0.5 * (0.55 + 0.45 * Math.cos(5 * a)); break; }
        case 'blob': { const a = Math.atan2(dy, dx); ink = Math.hypot(dx, dy) <= 0.5 * (0.72 + 0.16 * Math.sin(3 * a + 0.7) + 0.1 * Math.cos(5 * a)); break; }
        case 'rect': ink = true; break;
      }
      if (ink) bits[r * cols + c] = 1;
    }
  }
  return { cols, rows, bits };
}

/** Deterministic PRNG so two runs of the bench compare like for like. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

type Design = { id: string; w: number; h: number; fill: number; mask: NestMask; noRotate?: boolean };

function makeDesigns(n: number, seed = 7): Design[] {
  const rand = rng(seed);
  const out: Design[] = [];
  for (let i = 0; i < n; i++) {
    const kind = KINDS[i % KINDS.length];
    // Typical DTF mix: mostly 2-5", a few larger.
    const big = rand() < 0.15;
    const w = big ? 6 + rand() * 5 : 2 + rand() * 3;
    const h = big ? 6 + rand() * 5 : 2 + rand() * 3;
    const mask = makeMask(kind, w, h);
    let ink = 0;
    for (let k = 0; k < mask.bits.length; k++) if (mask.bits[k]) ink++;
    out.push({ id: `d${i}`, w, h, fill: ink / mask.bits.length, mask });
  }
  return out;
}

/** Where the designs sit before the arrange, laid out in rows like an un-arranged sheet. */
function makeCurrent(designs: Design[], sheetW: number) {
  const rects: Array<{ id: string; x: number; y: number; w: number; h: number; rotation: number; mask?: NestMask }> = [];
  let x = 0, y = 0, rowH = 0;
  for (const d of designs) {
    if (x + d.w > sheetW) { x = 0; y += rowH + GAP; rowH = 0; }
    rects.push({ id: d.id, x, y, w: d.w, h: d.h, rotation: 0, mask: d.mask });
    x += d.w + GAP;
    rowH = Math.max(rowH, d.h);
  }
  return rects;
}

function sheetFor(designs: Design[]): number {
  const area = designs.reduce((s, d) => s + d.w * d.h, 0);
  const need = (area / SHEET_W) * 1.6;
  return LADDER.find(h => h >= need) ?? LADDER[LADDER.length - 1];
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

function time(label: string, reps: number, fn: () => void): number {
  fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) fn();
  const ms = (performance.now() - t0) / reps;
  console.log(`  ${label.padEnd(38)} ${ms.toFixed(1).padStart(9)} ms`);
  return ms;
}

function baseInput(designs: Design[], sheetH: number): ArrangeInput {
  return {
    type: 'arrange',
    requestId: 0,
    items: designs,
    usableW: SHEET_W,
    usableH: sheetH,
    artboardWidth: SHEET_W,
    artboardHeight: sheetH,
    isAggressive: true,
    customGap: GAP,
    heightSteps: LADDER,
  };
}

for (const n of [10, 50, 100]) {
  const designs = makeDesigns(n);
  const sheetH = sheetFor(designs);
  const current = makeCurrent(designs, SHEET_W);
  const reps = n >= 100 ? 3 : n >= 50 ? 5 : 10;

  console.log(`\n=== ${n} designs, ${SHEET_W}" x ${sheetH}" sheet, gap ${GAP}", ${reps} reps ===`);

  // What the Auto-Arrange button does: fullRepack, so preferStable is false.
  const full = time('runArrange  fullRepack (button)', reps, () => {
    runArrange({ ...baseInput(designs, sheetH), current, preferStable: false });
  });

  // What a duplicate / copy-count change does: same call, preferStable true.
  time('runArrange  preferStable (duplicate)', reps, () => {
    runArrange({ ...baseInput(designs, sheetH), current, preferStable: true });
  });

  // No `current` at all — isolates the candidate sweep from the stability candidate.
  const noCurrent = time('runArrange  no `current`', reps, () => {
    runArrange(baseInput(designs, sheetH));
  });

  // No masks — the nester is skipped and `filmBottom` has no insets to look up, so this
  // is the rectangle sweep alone.
  const noMask = time('runArrange  no masks (rect sweep only)', reps, () => {
    runArrange({ ...baseInput(designs, sheetH), items: designs.map(d => ({ ...d, mask: undefined })) });
  });

  // Every item noRotate, i.e. the sheet is one big user group.
  time('runArrange  all noRotate (groups)', reps, () => {
    runArrange({ ...baseInput(designs, sheetH), items: designs.map(d => ({ ...d, noRotate: true })) });
  });

  const nestItems = designs.map(d => ({ id: d.id, w: d.w, h: d.h, mask: d.mask }));
  time('  nestPack  x1  (arrange runs 3)', reps, () => {
    nestPack(nestItems, SHEET_W, sheetH, SHEET_W, sheetH, GAP);
  });
  time('  keepPositionsNest  x1', reps, () => {
    keepPositionsNest(nestItems, current, SHEET_W, sheetH, SHEET_W, sheetH, GAP, undefined);
  });
  time('  packingHeightLowerBound  x1', reps, () => {
    packingHeightLowerBound(designs, SHEET_W);
  });

  console.log(`  --- derived ---`);
  console.log(`  nest+stability share of fullRepack   ${(100 * (full - noMask) / full).toFixed(0)}%`);
  console.log(`  stability candidate share            ${(100 * (full - noCurrent) / full).toFixed(0)}%`);

  // The auto-shrink path: one inkInset per design, then the arithmetic.
  const band = { minY: 0.4, maxY: sheetH * 0.7 };
  time('shrink: inkInset x N (warm silhouettes)', 20, () => {
    for (const d of designs) inkInset(d.mask, d.w, d.h, 0);
  });
  time('shrink: planSheetShrink x1', 200, () => {
    planSheetShrink({ band, currentHeight: sheetH, margin: GAP, heights: LADDER, manualFloor: null });
  });
}

// ---------------------------------------------------------------------------
// Tidiness: what adding one copy settles for, against what the button would give.
//
// The bench above starts from `makeCurrent`, an un-arranged sheet laid out in rows. That is
// the wrong starting point for this question: the reported complaint is about a sheet that
// has *already* been arranged, which is then handed one more copy. So each case here packs
// the sheet properly first, feeds the settled positions back in as `current`, and only then
// adds the copy — which is exactly what the editor does on a `+` click.
//
// Two things are being watched. Film height says whether the duplicate path now lands on the
// tidy layout instead of leaving visible slack, and billable height says whether that cost
// the customer anything: it must never come out above what pressing the button would bill,
// because a tidier sheet is not worth a penny more.
// ---------------------------------------------------------------------------

const billableOf = (h: number): number => LADDER.find(step => step >= h - 0.01) ?? h;

/** Settled placements, back in the footprint form `current` takes. */
function currentFromResult(
  designs: Design[],
  placed: Array<{ id: string; nx: number; ny: number; rotation: number }>,
  sheetH: number,
) {
  const byId = new Map(designs.map(d => [d.id, d]));
  return placed.flatMap(p => {
    const d = byId.get(p.id);
    if (!d) return [];
    const w = p.rotation === 90 ? d.h : d.w;
    const h = p.rotation === 90 ? d.w : d.h;
    return [{
      id: d.id,
      x: p.nx * SHEET_W - w / 2,
      y: p.ny * sheetH - h / 2,
      w, h,
      rotation: p.rotation,
      mask: d.mask,
    }];
  });
}

/** Share of `before` that ends up somewhere else in `after`, by the same measure arrange uses. */
function movedShare(
  before: Array<{ id: string; nx: number; ny: number; rotation: number }>,
  after: Array<{ id: string; nx: number; ny: number; rotation: number }>,
  sheetH: number,
): number {
  if (after.length === 0) return 0;
  const prev = new Map(before.map(p => [p.id, p]));
  let moved = 0;
  for (const p of after) {
    const q = prev.get(p.id);
    if (!q
      || q.rotation !== p.rotation
      || Math.abs(q.nx - p.nx) * SHEET_W > 0.05
      || Math.abs(q.ny - p.ny) * sheetH > 0.05) moved++;
  }
  return moved / after.length;
}

console.log(`\n=== copies added one at a time, the way a customer builds a sheet ===`);
for (const [startN, copies] of [[4, 12], [8, 24], [20, 20]] as Array<[number, number]>) {
  const base = makeDesigns(startN);
  const sheetH = 120;

  // Settle the starting artwork, then add copies one at a time, feeding each layout forward
  // as the next click's starting point. This is the part a single-copy measurement cannot
  // see: every copy inherits the previous incremental layout, so any tendency to stack them
  // down the film instead of across it compounds with every click.
  let designs = [...base];
  let placed = runArrange({
    ...baseInput(designs, sheetH),
    current: makeCurrent(designs, SHEET_W),
    preferStable: false,
  }).result;

  const t0 = performance.now();
  for (let i = 0; i < copies; i++) {
    const copy = { ...base[i % base.length], id: `copy${i}` };
    const current = currentFromResult(designs, placed, sheetH);
    // A new copy has no settled position yet, so it is seeded below the artwork the way
    // `seedCopyGrid` does rather than being handed to the packer already placed.
    const lowest = current.reduce((m, r) => Math.max(m, r.y + r.h), 0);
    current.push({ id: copy.id, x: 0, y: lowest + GAP, w: copy.w, h: copy.h, rotation: 0, mask: copy.mask });
    designs = [...designs, copy];
    placed = runArrange({ ...baseInput(designs, sheetH), current, preferStable: true }).result;
  }
  const incrementalMs = performance.now() - t0;

  const incremental = runArrange({
    ...baseInput(designs, sheetH),
    current: currentFromResult(designs, placed, sheetH),
    preferStable: true,
  });
  const button = runArrange({
    ...baseInput(designs, sheetH),
    current: currentFromResult(designs, placed, sheetH),
    preferStable: false,
  });
  const floor = packingHeightLowerBound(designs, SHEET_W);

  console.log(`\n  ${startN} designs, +${copies} copies one at a time (${designs.length} total), floor ${floor.toFixed(1)}"`);
  console.log(`    after the clicks   film ${incremental.filmHeight.toFixed(1)}"  bills ${billableOf(incremental.filmHeight)}"`);
  console.log(`    button afterwards  film ${button.filmHeight.toFixed(1)}"  bills ${billableOf(button.filmHeight)}"`);
  const costsMore = billableOf(incremental.filmHeight) > billableOf(button.filmHeight) + 0.01;
  console.log(`    the button would save the customer          ${costsMore ? `${billableOf(incremental.filmHeight) - billableOf(button.filmHeight)}" of film` : 'nothing'}`);
  console.log(`    ${copies} clicks cost                             ${incrementalMs.toFixed(0)} ms total, ${(incrementalMs / copies).toFixed(0)} ms per click`);
  if (costsMore) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// The ladder: what an overflowing arrange costs when it has to grow and repack.
// ---------------------------------------------------------------------------

console.log(`\n=== expansion ladder: 60 designs started on a sheet that is too short ===`);
{
  const designs = makeDesigns(60, 11);
  const current = makeCurrent(designs, SHEET_W);
  let h = 12;
  let packs = 0;
  const t0 = performance.now();
  for (let step = 0; step < LADDER.length + 2; step++) {
    const out = runArrange({ ...baseInput(designs, h), current, preferStable: false });
    packs++;
    if (!out.result.some(p => p.overflows)) break;
    const taller = LADDER.filter(x => x > h);
    if (taller.length === 0) break;
    h = taller.find(x => x >= (out.minRequiredHeight ?? 0)) ?? taller[taller.length - 1];
  }
  const ms = performance.now() - t0;
  console.log(`  settled at ${h}" after ${packs} runArrange call(s) — ${ms.toFixed(0)} ms total`);
}

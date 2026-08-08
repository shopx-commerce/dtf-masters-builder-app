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

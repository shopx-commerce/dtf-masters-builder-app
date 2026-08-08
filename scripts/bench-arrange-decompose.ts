/**
 * Where the milliseconds inside one `runArrange` actually go.
 *
 *   npx tsx scripts/bench-arrange-decompose.ts
 *
 * `bench-arrange-hotpath.ts` shows that supplying silhouettes takes a 100-design arrange from
 * ~20 ms to ~720 ms. Three `nestPack` calls do not account for all of it, so this pins the
 * rest down: it replays the exact sort orders `runArrange` builds, nests each one, and
 * separately times the ranking work (`filmBottom`'s per-placement `inkInset`, and the
 * `inkCentroidY` tiebreak the comparator calls) at the call volume a real arrange produces.
 *
 * Nothing here is a reimplementation of policy — it calls the same exported functions the
 * editor does. It only exists to attribute cost.
 */

import { nestPack, inkInset, NEST_CELL_INCHES, type NestMask } from '../client/src/lib/nest-core';
import { DEFAULT_SHEET_MARGIN } from '../client/src/lib/sheet-fit';

const CELL = NEST_CELL_INCHES;
const GAP = DEFAULT_SHEET_MARGIN;
const SHEET_W = 22;

type ShapeKind = 'circle' | 'triangle' | 'lshape' | 'ring' | 'diagonal' | 'rect' | 'star' | 'blob';
const KINDS: ShapeKind[] = ['circle', 'triangle', 'lshape', 'ring', 'diagonal', 'rect', 'star', 'blob'];

function makeMask(kind: ShapeKind, wIn: number, hIn: number): NestMask {
  const cols = Math.max(1, Math.ceil(wIn / CELL - 1e-6));
  const rows = Math.max(1, Math.ceil(hIn / CELL - 1e-6));
  const bits = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const u = (c + 0.5) / cols, v = (r + 0.5) / rows;
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

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

type Item = { id: string; w: number; h: number; fill: number; mask: NestMask };

function makeDesigns(n: number, seed = 7): Item[] {
  const rand = rng(seed);
  const out: Item[] = [];
  for (let i = 0; i < n; i++) {
    const big = rand() < 0.15;
    const w = big ? 6 + rand() * 5 : 2 + rand() * 3;
    const h = big ? 6 + rand() * 5 : 2 + rand() * 3;
    const mask = makeMask(KINDS[i % KINDS.length], w, h);
    let ink = 0;
    for (let k = 0; k < mask.bits.length; k++) if (mask.bits[k]) ink++;
    out.push({ id: `d${i}`, w, h, fill: ink / mask.bits.length, mask });
  }
  return out;
}

const N = 100;
const SHEET_H = 160;
const items = makeDesigns(N);

// The three orderings `runNestCandidates` uses, built exactly as `runArrange` builds them.
const byArea = [...items].sort((a, b) => (b.w * b.h) - (a.w * a.h));
const byPerimeter = [...items].sort((a, b) => (b.w + b.h) - (a.w + a.h));
const byLongestSide = [...items].sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || (b.w * b.h) - (a.w * a.h));

console.log(`\n=== ${N} designs on ${SHEET_W}" x ${SHEET_H}", gap ${GAP}" ===`);
console.log(`grid is ${Math.round(SHEET_W / CELL)} x ${Math.round(SHEET_H / CELL)} = ${(Math.round(SHEET_W / CELL) * Math.round(SHEET_H / CELL) / 1e6).toFixed(1)}M cells\n`);

function time(label: string, reps: number, fn: () => void) {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) fn();
  const ms = (performance.now() - t0) / reps;
  console.log(`  ${label.padEnd(40)} ${ms.toFixed(1).padStart(8)} ms`);
  return ms;
}

const toNest = (o: Item[]) => o.map(d => ({ id: d.id, w: d.w, h: d.h, mask: d.mask }));

let nestTotal = 0;
for (const [name, order] of [['longestSide', byLongestSide], ['area', byArea], ['perimeter', byPerimeter]] as const) {
  nestTotal += time(`nestPack  ${name}`, 3, () => { nestPack(toNest(order), SHEET_W, SHEET_H, SHEET_W, SHEET_H, GAP); });
}
console.log(`  ${'nestPack  all three (what arrange runs)'.padEnd(40)} ${nestTotal.toFixed(1).padStart(8)} ms\n`);

// Ranking work. `runArrange` builds 9 sort orders x 8 packers + 1 grid = 73 rectangle
// candidates, plus 3 nest candidates, and `evaluate` runs `filmBottom` over every placement
// of every one of them.
const CANDIDATES = 73 + 3;
const placements = items.map((d, i) => ({ id: d.id, rotation: i % 3 === 0 ? 90 : 0, ny: 0.3 }));
time(`filmBottom-equivalent x${CANDIDATES} candidates`, 3, () => {
  for (let c = 0; c < CANDIDATES; c++) {
    let bottom = 0;
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      const inset = inkInset(it.mask, it.w, it.h, placements[k].rotation);
      bottom = Math.max(bottom, placements[k].ny * SHEET_H + it.h / 2 - inset.bottom);
    }
  }
});

// The comparator's tiebreak. Only pairs that tie on film height pay it, but ties are the
// normal case when one tall design sets the length on its own.
const COMPARISONS = Math.ceil(CANDIDATES * Math.log2(CANDIDATES));
time(`inkCentroidY x${COMPARISONS * 2} (sort tiebreak, worst case)`, 3, () => {
  for (let c = 0; c < COMPARISONS * 2; c++) {
    let weight = 0, moment = 0;
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      const area = Math.max(it.w * it.h * (it.fill > 0 ? it.fill : 1), 1e-6);
      weight += area;
      moment += area * placements[k].ny * SHEET_H;
    }
    void (weight > 0 ? moment / weight : 0);
  }
});

// How the nester scales with sheet length at fixed item count — the grid is allocated and
// scanned over the whole sheet, so a taller rung costs more even for the same artwork.
console.log('');
for (const h of [24, 48, 96, 160, 340]) {
  time(`nestPack x1 on a ${String(h).padStart(3)}" sheet`, 3, () => {
    nestPack(toNest(byLongestSide), SHEET_W, h, SHEET_W, h, GAP);
  });
}

// Warm vs cold derived-mask caches.
//
// `silhouetteCache`, `testCache`, `dilateCache` and `rotateCache` are all WeakMaps keyed on
// the mask *object*. Inside one arrange the same objects are reused across all three nest
// orderings, so the second and third are warm. But the editor builds masks on the main
// thread and `postMessage`s them to the arrange worker, and structured clone hands the
// worker a brand-new Uint8Array — and therefore a brand-new mask object — on every single
// arrange. So the worker starts every operation with all four caches cold. This measures
// the difference by deep-copying the masks before each rep.
console.log('');
const cloneMasks = (o: Item[]) => o.map(d => ({
  id: d.id, w: d.w, h: d.h,
  mask: { cols: d.mask.cols, rows: d.mask.rows, bits: new Uint8Array(d.mask.bits) },
}));

time('nestPack x3  warm masks (same objects)', 3, () => {
  for (const o of [byLongestSide, byArea, byPerimeter]) nestPack(toNest(o), SHEET_W, SHEET_H, SHEET_W, SHEET_H, GAP);
});
time('nestPack x3  cold masks (post-clone)', 3, () => {
  const fresh = cloneMasks(byLongestSide);
  const freshByArea = fresh.map((_, i) => fresh[byArea.findIndex(x => x.id === byLongestSide[i].id)] ?? fresh[i]);
  for (const o of [fresh, freshByArea, fresh]) nestPack(o, SHEET_W, SHEET_H, SHEET_W, SHEET_H, GAP);
});

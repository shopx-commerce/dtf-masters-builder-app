/**
 * Automatic nesting keeps up with the Auto-Arrange button, and never costs more than it.
 *
 *   npx tsx scripts/verify-arrange-tidy.ts
 *
 * Arranges the customer did not ask for — adding a copy, duplicating, growing the sheet — run
 * `runArrange` with `preferStable`, which is now allowed to accept a tidier layout on a billing
 * tie instead of always keeping what was already settled. The complaint that prompted it was
 * that building a sheet one copy at a time left it visibly loose, and that pressing the button
 * afterwards tidied it, so what has to be shown is that pressing the button afterwards no
 * longer finds anything worth having.
 *
 * The sheet is therefore built the way a customer builds one — a copy at a time, each layout
 * feeding the next click — and then the button is offered the finished sheet. How much film it
 * can still recover is the measure that matters, because that is exactly the gap the customer
 * was seeing. It is also the measure with teeth: a sign error in the slack comparison, or the
 * churn budget set to zero, both show up here as sheets the button can still improve, while
 * neither shows up in the billing check below.
 *
 * That billing check earns its place too, but a narrower one. `preferStable` and a full repack
 * both settle on whichever of the two layouts bills less, so today they cannot disagree about
 * price and the assertion cannot fail. It is here for the edit that compares raw film height
 * instead of `billable` and starts charging for tidiness.
 *
 * Corpus and conventions follow `bench-arrange-hotpath.ts` so the two report on the same
 * artwork, and both import the real module rather than restating any of its logic.
 */

import { runArrange, type ArrangeInput } from '../client/src/lib/arrange-core';
import { NEST_CELL_INCHES, type NestMask } from '../client/src/lib/nest-core';
import { DEFAULT_SHEET_MARGIN } from '../client/src/lib/sheet-fit';

const CELL = NEST_CELL_INCHES;
const GAP = DEFAULT_SHEET_MARGIN;
const SHEET_W = 22;
const SHEET_H = 120;
const LADDER = [12, 18, 24, 36, 48, 60, 72, 84, 96, 120, 160, 240, 340];

const billable = (h: number): number => LADDER.find(step => step >= h - 0.01) ?? h;

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

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

type Design = { id: string; w: number; h: number; fill: number; mask: NestMask };

function makeDesigns(n: number, seed: number): Design[] {
  const rand = rng(seed);
  const out: Design[] = [];
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

function makeCurrent(designs: Design[]) {
  const rects: Array<{ id: string; x: number; y: number; w: number; h: number; rotation: number; mask?: NestMask }> = [];
  let x = 0, y = 0, rowH = 0;
  for (const d of designs) {
    if (x + d.w > SHEET_W) { x = 0; y += rowH + GAP; rowH = 0; }
    rects.push({ id: d.id, x, y, w: d.w, h: d.h, rotation: 0, mask: d.mask });
    x += d.w + GAP;
    rowH = Math.max(rowH, d.h);
  }
  return rects;
}

function currentFromResult(
  designs: Design[],
  placed: Array<{ id: string; nx: number; ny: number; rotation: number }>,
) {
  const byId = new Map(designs.map(d => [d.id, d]));
  return placed.flatMap(p => {
    const d = byId.get(p.id);
    if (!d) return [];
    const w = p.rotation === 90 ? d.h : d.w;
    const h = p.rotation === 90 ? d.w : d.h;
    return [{ id: d.id, x: p.nx * SHEET_W - w / 2, y: p.ny * SHEET_H - h / 2, w, h, rotation: p.rotation, mask: d.mask }];
  });
}

function baseInput(designs: Design[]): ArrangeInput {
  return {
    type: 'arrange',
    requestId: 0,
    items: designs,
    usableW: SHEET_W,
    usableH: SHEET_H,
    artboardWidth: SHEET_W,
    artboardHeight: SHEET_H,
    isAggressive: true,
    customGap: GAP,
    heightSteps: LADDER,
  };
}

/**
 * How many of the twelve sheets the button must find nothing left to do to.
 *
 * A count rather than a tolerance in inches, because the sheets that are still improvable are
 * improvable by a lot — three or four inches — and are declined not for being marginal but for
 * needing three quarters of the sheet moved. Capping the inches would therefore be asserting
 * against the churn budget itself. Counting how often the budget lets a tidier layout through
 * measures the thing that was actually built.
 *
 * Ten pass at the settings in `arrange-core`. Seven passed before the tie-break existed, and
 * seven pass with the churn budget at zero or the slack comparison inverted, so this floor sits
 * clear of every way the feature can silently stop working.
 */
const MIN_SHEETS_AS_TIGHT_AS_BUTTON = 9;
/** Same idea for the single-arrange sweep, which the tie-break barely moves either way. */
const MIN_SINGLE_ARRANGES_AS_TIGHT = 35;

/** Share of the designs that sit somewhere else in `after`, by the measure `runArrange` uses. */
function movedShare(
  before: Array<{ id: string; nx: number; ny: number; rotation: number }>,
  after: Array<{ id: string; nx: number; ny: number; rotation: number }>,
): number {
  if (after.length === 0) return 0;
  const prev = new Map(before.map(p => [p.id, p]));
  let moved = 0;
  for (const p of after) {
    const q = prev.get(p.id);
    if (!q || q.rotation !== p.rotation
      || Math.abs(q.nx - p.nx) * SHEET_W > 0.05
      || Math.abs(q.ny - p.ny) * SHEET_H > 0.05) moved++;
  }
  return moved / after.length;
}

let failures = 0;
const fail = (what: string) => { console.log(`  FAIL  ${what}`); failures++; };

/** Builds a sheet a copy at a time and returns the finished layout. */
function buildByClicking(seed: number) {
  const rand = rng(seed * 313);
  const base = makeDesigns(3 + Math.floor(rand() * 8), seed + 500);
  let designs = [...base];
  let placed = runArrange({ ...baseInput(designs), current: makeCurrent(designs), preferStable: false }).result;

  const copies = 6 + Math.floor(rand() * 16);
  for (let i = 0; i < copies; i++) {
    const copy = { ...base[i % base.length], id: `copy${i}` };
    const current = currentFromResult(designs, placed);
    // A new copy has no settled position, so it is seeded below the artwork the way the
    // editor's own copy grid does rather than handed to the packer already placed.
    const lowest = current.reduce((m, r) => Math.max(m, r.y + r.h), 0);
    current.push({ id: copy.id, x: 0, y: lowest + GAP, w: copy.w, h: copy.h, rotation: 0, mask: copy.mask });
    designs = [...designs, copy];
    placed = runArrange({ ...baseInput(designs), current, preferStable: true }).result;
  }
  return { designs, current: currentFromResult(designs, placed), copies };
}

// ---------------------------------------------------------------------------
// The sheet the customer ends up with, against what the button could still do to it.
// ---------------------------------------------------------------------------

console.log('sheets built a copy at a time, then offered to the button');
{
  let exact = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const { designs, current, copies } = buildByClicking(seed);
    const asBuilt = runArrange({ ...baseInput(designs), current, preferStable: true });
    const button = runArrange({ ...baseInput(designs), current, preferStable: false });

    const recoverable = asBuilt.filmHeight - button.filmHeight;
    if (recoverable <= 0.01) {
      exact++;
    } else {
      // Reported rather than failed: what matters is how much of the sheet the tidier layout
      // would have moved, which is the budget's whole subject.
      const moved = movedShare(asBuilt.result, button.result);
      console.log(`  seed ${seed}: ${designs.length} designs after ${copies} copies — the button recovers ${recoverable.toFixed(1)}" by moving ${(100 * moved).toFixed(0)}%`);
    }
    if (billable(asBuilt.filmHeight) > billable(button.filmHeight) + 0.01) {
      fail(`seed ${seed}: the sheet bills ${billable(asBuilt.filmHeight)}" where the button bills ${billable(button.filmHeight)}"`);
    }
  }
  console.log(`  ${exact} of 12 the button cannot improve at all, floor ${MIN_SHEETS_AS_TIGHT_AS_BUTTON}`);
  if (exact < MIN_SHEETS_AS_TIGHT_AS_BUTTON) {
    fail(`only ${exact} of 12 sheets came out as tight as the button`);
  }
}

// ---------------------------------------------------------------------------
// A single arrange, which is where the tie-break itself lives.
// ---------------------------------------------------------------------------

console.log('\na single arrange from an un-arranged sheet');
{
  let worst = 0, exact = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const rand = rng(seed * 977);
    const designs = makeDesigns(6 + Math.floor(rand() * 25), seed);
    const input = { ...baseInput(designs), current: makeCurrent(designs) };
    const dup = runArrange({ ...input, preferStable: true });
    const button = runArrange({ ...input, preferStable: false });

    const recoverable = dup.filmHeight - button.filmHeight;
    if (recoverable <= 0.01) exact++;
    if (recoverable > worst) worst = recoverable;
    if (billable(dup.filmHeight) > billable(button.filmHeight) + 0.01) {
      fail(`seed ${seed}: duplicate bills ${billable(dup.filmHeight)}" where the button bills ${billable(button.filmHeight)}"`);
    }
  }
  console.log(`  ${exact} of 40 the button cannot improve, worst recoverable ${worst.toFixed(1)}", floor ${MIN_SINGLE_ARRANGES_AS_TIGHT}`);
  if (exact < MIN_SINGLE_ARRANGES_AS_TIGHT) {
    fail(`only ${exact} of 40 single arranges came out as tight as the button`);
  }
}

console.log(failures === 0
  ? '\nautomatic nesting keeps up with the button, and never bills more'
  : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

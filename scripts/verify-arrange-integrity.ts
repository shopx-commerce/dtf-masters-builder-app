/**
 * Does an arrange ever hand the editor a layout that prints ink on top of ink, and does it
 * ever leave film on the sheet by standing a design up when lying it down would have been
 * shorter?
 *
 *   npx tsx scripts/verify-arrange-integrity.ts
 *
 * Both questions come from the same report:
 *
 *   "with a lot of designs, changing the margin leaves images overlapping, with the red
 *    boundaries on, until I click auto arrange"
 *   "at the bottom a 13x18 gets arranged vertically instead of horizontally, costing film"
 *
 * Everything below runs the real `runArrange`, and the overlap test rasterises each placement's
 * ink at the nester's own cell resolution — the same thing the preview's red outline reports,
 * which draws the artwork and looks for alpha over alpha, so only genuine ink collisions count.
 *
 * The one thing this file has to model rather than call is the commit rule. `runArrange`
 * reports a design it could not place as `overflows`, with a position folded back onto the
 * sheet's bottom edge, and the editor deliberately does not apply those: it leaves the design
 * where the customer had it and says the sheet is full. So the layout under test is the
 * placements the editor would actually commit. Keep `commit()` in step with `applyResult` in
 * `useImageEditorModelArrangeKeyboard.ts`.
 */

import {
  classifyArrangeLayout,
  runArrange,
  type ArrangeInput,
  type PlacedItem,
} from '../client/src/lib/arrange-core';
import { NEST_CELL_INCHES, nestPack, rotateMask90, type NestMask, type NestObstacle } from '../client/src/lib/nest-core';

const CELL = NEST_CELL_INCHES;
const SHEET_W = 22;
const LADDER = [12, 18, 24, 36, 48, 60, 72, 84, 96, 120, 160, 240, 340];
const EPS = 0.05;

/**
 * What the customer actually pays for: the next purchasable length at or above `h`.
 *
 * The film comparisons below are made on rungs rather than on raw inches, for the same reason
 * `runArrange` decides on rungs: an inch shaved off a layout that still bills at the same
 * length has bought nothing, and moving designs to collect it is disruption the customer can
 * see and a saving they cannot.
 */
const billable = (h: number): number => LADDER.find(step => step >= h - EPS) ?? h;

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ''}`);
}

console.log('\ncanvas edges do not consume the inter-design gap');
{
  const gap = 0.25;
  const edgeItems = [
    { id: 'left', w: 10, h: 12, fill: 1, noRotate: true },
    { id: 'right', w: 11.75, h: 12, fill: 1, noRotate: true },
  ];
  const out = runArrange({
    type: 'arrange',
    requestId: 0,
    items: edgeItems,
    usableW: SHEET_W,
    usableH: 12,
    artboardWidth: SHEET_W,
    artboardHeight: 12,
    customGap: gap,
    preferStable: false,
    heightSteps: [12, 18],
  });
  const placed = out.result.filter(item => !item.overflows);
  check(placed.length === 2, 'two designs use the full sheet width without a trailing edge gap', `${placed.length}/2 placed`);
  check(Math.abs(out.filmHeight - 12) < EPS, 'artwork may finish at the bottom edge', `${out.filmHeight.toFixed(3)}" film`);
  const rects = placed.map(item => {
    const source = edgeItems.find(candidate => candidate.id === item.id)!;
    return {
      left: item.nx * SHEET_W - source.w / 2,
      right: item.nx * SHEET_W + source.w / 2,
    };
  }).sort((a, b) => a.left - b.left);
  if (rects.length === 2) {
    check(Math.abs(rects[0].left) < EPS, 'first design may touch the left edge', `${rects[0].left.toFixed(3)}"`);
    check(Math.abs(rects[1].right - SHEET_W) < EPS, 'last design may touch the right edge', `${rects[1].right.toFixed(3)}"`);
    check(rects[1].left - rects[0].right >= gap - EPS, 'the requested gap remains between designs');
  }

  const overflow = runArrange({
    type: 'arrange',
    requestId: 1,
    items: [{ id: 'too-tall', w: 10, h: 13, fill: 1, noRotate: true }],
    usableW: SHEET_W,
    usableH: 12,
    artboardWidth: SHEET_W,
    artboardHeight: 12,
    customGap: gap,
    fixedRects: [{ id: 'fixed', x: 0, y: 0, w: 1, h: 1 }],
    preferStable: false,
    heightSteps: [12, 18],
  });
  check(overflow.result[0]?.overflows === true, 'fixed-obstacle MaxRects reports the oversized artwork as unplaced');
  check(Math.abs(overflow.packedExtent - 13) < EPS, 'overflow extent excludes a trailing bottom-edge gap', `${overflow.packedExtent.toFixed(3)}"`);
}

type ShapeKind = 'circle' | 'triangle' | 'lshape' | 'ring' | 'diagonal' | 'rect' | 'star' | 'blob';
const KINDS: ShapeKind[] = ['circle', 'triangle', 'lshape', 'ring', 'diagonal', 'rect', 'star', 'blob'];

function cellsFor(inches: number): number {
  return Math.max(1, Math.ceil(inches / CELL - 1e-6));
}

function makeMask(kind: ShapeKind, wIn: number, hIn: number): NestMask {
  const cols = cellsFor(wIn);
  const rows = cellsFor(hIn);
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

type Design = { id: string; w: number; h: number; fill: number; mask: NestMask; duplicateKey?: string; noRotate?: boolean };

function makeDesigns(n: number, seed = 7): Design[] {
  const rand = rng(seed);
  const out: Design[] = [];
  for (let i = 0; i < n; i++) {
    const kind = KINDS[i % KINDS.length];
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

function baseInput(items: Design[], sheetH: number, gap: number): ArrangeInput {
  return {
    type: 'arrange',
    requestId: 0,
    items,
    usableW: SHEET_W,
    usableH: sheetH,
    artboardWidth: SHEET_W,
    artboardHeight: sheetH,
    isAggressive: true,
    customGap: gap,
    heightSteps: LADDER,
  };
}

/** Ink footprint of one placement, in sheet cells. */
type Stamp = { id: string; mask: NestMask; col: number; row: number };

function stampFor(d: Design, p: PlacedItem, sheetH: number): Stamp {
  const quarters = ((Math.round(p.rotation / 90) % 4) + 4) % 4;
  let mask = d.mask;
  for (let i = 0; i < quarters; i++) mask = rotateMask90(mask);
  const w = quarters % 2 === 0 ? d.w : d.h;
  const h = quarters % 2 === 0 ? d.h : d.w;
  return {
    id: d.id, mask,
    col: Math.round((p.nx * SHEET_W - w / 2) / CELL),
    row: Math.round((p.ny * sheetH - h / 2) / CELL),
  };
}

/** Cells claimed by two designs at once — what the preview draws a red box around. */
function inkCollisions(stamps: Stamp[]): { cells: number; ids: Set<string> } {
  const owner = new Map<number, string>();
  let cells = 0;
  const ids = new Set<string>();
  for (const s of stamps) {
    for (let r = 0; r < s.mask.rows; r++) {
      const base = r * s.mask.cols;
      const gy = s.row + r;
      for (let c = 0; c < s.mask.cols; c++) {
        if (!s.mask.bits[base + c]) continue;
        const key = (gy + 4096) * 100000 + (s.col + c + 4096);
        const prev = owner.get(key);
        if (prev !== undefined && prev !== s.id) {
          cells++;
          ids.add(prev);
          ids.add(s.id);
        } else {
          owner.set(key, s.id);
        }
      }
    }
  }
  return { cells, ids };
}

/**
 * What the editor would put on the sheet: the placements it applies, and the designs it
 * leaves alone because the pack could not seat them.
 *
 * Mirrors `applyResult`. A design already off the sheet is the one exception there — a copy
 * seeded below the artwork, say — because somewhere overlapping beats nowhere visible; those
 * do not arise here, since every layout fed in is one a previous pack produced.
 */
function commit(placed: PlacedItem[]): { applied: PlacedItem[]; leftAlone: string[] } {
  return {
    applied: placed.filter(p => !p.overflows),
    leftAlone: placed.filter(p => p.overflows).map(p => p.id),
  };
}

function overlapOf(designs: Design[], placed: PlacedItem[], sheetH: number) {
  const byId = new Map(designs.map(d => [d.id, d]));
  const { applied, leftAlone } = commit(placed);
  const stamps = applied.flatMap(p => {
    const d = byId.get(p.id);
    return d ? [stampFor(d, p, sheetH)] : [];
  });
  return { ...inkCollisions(stamps), leftAlone };
}

const rectFor = (byId: Map<string, Design>) => (p: PlacedItem, sheetH: number) => {
  const d = byId.get(p.id)!;
  const quarters = ((Math.round(p.rotation / 90) % 4) + 4) % 4;
  const w = quarters % 2 === 0 ? d.w : d.h;
  const h = quarters % 2 === 0 ? d.h : d.w;
  return {
    id: p.id, x: p.nx * SHEET_W - w / 2, y: p.ny * sheetH - h / 2,
    w, h, rotation: p.rotation, mask: d.mask,
  };
};

// ---------------------------------------------------------------------------
// 1. Nothing the editor commits ever prints ink on ink.
//
// Deliberately includes sheets far too short for their artwork. Those are the ones that used
// to come back as a heap: the packer piles what it could not place into a row of its own and
// the row is folded onto the bottom edge, landing on top of the last row it did place.
// ---------------------------------------------------------------------------

console.log('no arrange commits ink on top of ink');
{
  let cases = 0, tight = 0, leftAloneTotal = 0;
  for (const seed of [3, 7, 11, 19]) {
    for (const n of [8, 20, 40]) {
      const designs = makeDesigns(n, seed);
      const byId = new Map(designs.map(d => [d.id, d]));
      const toRect = rectFor(byId);
      for (const sheetH of [18, 36, 60]) {
        for (const gap of [0.0625, 0.25, 0.5]) {
          for (const preferStable of [false, true]) {
            const out = runArrange({ ...baseInput(designs, sheetH, gap), preferStable });
            const first = overlapOf(designs, out.result, sheetH);
            check(first.cells === 0, `${n} designs, ${sheetH}" sheet, ${gap}" gap, ${preferStable ? 'stable' : 'repack'}`,
              `${first.cells} cells of ink on ink across ${first.ids.size} designs`);
            cases++;
            leftAloneTotal += first.leftAlone.length;
            if (out.result.some(p => p.overflows)) tight++;

            // Then the same layout offered back, which is what a margin change does: the
            // sheet is settled, and the spacing it was settled at is no longer the one asked
            // for. Whole-sheet, the way the controls now call it.
            const again = runArrange({
              ...baseInput(designs, sheetH, gap === 0.5 ? 0.25 : 0.5),
              current: out.result.map(p => toRect(p, sheetH)),
              preferStable,
            });
            const second = overlapOf(designs, again.result, sheetH);
            check(second.cells === 0, `margin change on a settled sheet of ${n}, ${sheetH}", ${preferStable ? 'stable' : 'repack'}`,
              `${second.cells} cells of ink on ink across ${second.ids.size} designs`);
            cases++;
            leftAloneTotal += second.leftAlone.length;
          }
        }
      }
    }
  }
  console.log(`  ${cases} layouts, ${tight} of them on a sheet too short for the artwork`);
  console.log(`  ${leftAloneTotal} designs the pack could not seat, left where they were rather than heaped`);
  // Without sheets that genuinely do not fit, the test never exercises the case that used to
  // fail, and passing would mean nothing.
  check(tight > 0, 'the corpus includes packs that do not fit');
  check(leftAloneTotal > 0, 'the corpus includes designs the packer could not seat');
}

// ---------------------------------------------------------------------------
// 2. The commit rule is what makes that true, not luck.
//
// The raw placements for an overflowing pack — bottom-edge heap and all — must still show the
// collision the editor is avoiding, or the check above is passing for the wrong reason.
// ---------------------------------------------------------------------------

console.log('\nthe heap the editor refuses to apply is a real one');
{
  const designs = makeDesigns(40);
  const byId = new Map(designs.map(d => [d.id, d]));
  const sheetH = 18;
  const out = runArrange({ ...baseInput(designs, sheetH, 0.25), preferStable: false });
  const raw = inkCollisions(out.result.flatMap(p => {
    const d = byId.get(p.id);
    return d ? [stampFor(d, p, sheetH)] : [];
  }));
  console.log(`  40 designs on 18" of film: ${out.result.filter(p => p.overflows).length} unplaced, ${raw.cells} cells of ink on ink if applied as reported`);
  check(raw.cells > 0, 'an overflowing pack really does report positions that collide');
}

// ---------------------------------------------------------------------------
// 3. A sheet-wide margin change reaches the whole sheet.
//
// The margin is a property of the sheet, so the controls pass `arrangeAll`. Handing the packer
// only the selection instead leaves the rest of the sheet as immovable obstacles at the old
// spacing, and — because obstacles cannot move — growing the film does not rescue the designs
// that no longer fit, so the climb never converges.
// ---------------------------------------------------------------------------

console.log('\nraising the margin on a snug sheet, following the height ladder');
{
  const designs = makeDesigns(40);
  const byId = new Map(designs.map(d => [d.id, d]));
  const toRect = rectFor(byId);
  const roomy = 48;
  const settled = runArrange({ ...baseInput(designs, roomy, 0.25), preferStable: false });
  const snug = LADDER.find(h => h >= settled.filmHeight) ?? roomy;
  const NEW_GAP = 0.5;
  // The six biggest, because the selection has to fit in the fragments the frozen designs
  // leave: a handful of small copies usually can, the sheet's largest work usually cannot.
  const selectedIds = new Set(
    [...designs].sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 6).map(d => d.id),
  );

  const outcomes = new Map<string, { sheetH: number; unplaced: number; cells: number; frozen: number }>();
  for (const mode of ['whole sheet', 'selection only'] as const) {
    let sheetH = snug;
    let placed = settled.result;
    let placedOn = roomy;
    let unplaced = 0;
    for (let step = 0; step < LADDER.length + 2; step++) {
      const current = placed.map(p => toRect(p, placedOn));
      const out = mode === 'whole sheet'
        ? runArrange({ ...baseInput(designs, sheetH, NEW_GAP), current, preferStable: false })
        : runArrange({
            ...baseInput(designs.filter(d => selectedIds.has(d.id)), sheetH, NEW_GAP),
            fixedRects: current.filter(c => !selectedIds.has(c.id)),
            current: current.filter(c => selectedIds.has(c.id)),
            preferStable: false,
          });
      const frozen = current.filter(c => !selectedIds.has(c.id)).map(c => ({
        id: c.id,
        nx: (c.x + c.w / 2) / SHEET_W,
        ny: (c.y + c.h / 2) / sheetH,
        rotation: c.rotation,
        overflows: false,
      }));
      placed = mode === 'whole sheet' ? out.result : [...frozen, ...out.result];
      placedOn = sheetH;
      unplaced = placed.filter(p => p.overflows).length;
      if (unplaced === 0) break;
      const taller = LADDER.filter(x => x > sheetH);
      if (taller.length === 0) break;
      sheetH = taller.find(x => x >= (out.minRequiredHeight ?? 0)) ?? taller[taller.length - 1];
    }
    const { cells } = overlapOf(designs, placed, sheetH);
    const frozenAtOldMargin = mode === 'whole sheet' ? 0 : designs.length - selectedIds.size;
    outcomes.set(mode, { sheetH, unplaced, cells, frozen: frozenAtOldMargin });
    console.log(`  ${mode}: ${snug}" -> ${sheetH}", ${unplaced} unplaced, ${cells} cells of ink on ink, ${frozenAtOldMargin} designs left at the old margin`);
  }

  const whole = outcomes.get('whole sheet')!;
  const partial = outcomes.get('selection only')!;
  check(whole.unplaced === 0, 'a sheet-wide margin change settles', `${whole.unplaced} designs still unplaced at ${whole.sheetH}"`);
  check(whole.cells === 0, 'a sheet-wide margin change leaves no overlap', `${whole.cells} cells`);
  check(whole.frozen === 0, 'a sheet-wide margin change reaches every design');
  // Not a requirement on the app — it is why the controls pass `arrangeAll`. If this ever
  // stops being the worse option, the reason for that flag has gone and the comment with it.
  check(partial.frozen > 0 || partial.unplaced > 0,
    'packing only the selection is still the worse way to change a sheet-wide margin');
}

// ---------------------------------------------------------------------------
// 4. Orientation never costs the customer a rung of film.
//
// The packers place designs one at a time, taking the topmost slot that fits, so a tall design
// that can squeeze into a notch is stood up there even when lying it below the work above
// would have finished higher up the film. Two things stop that reaching the sheet: the
// candidate sweep packs every ordering landscape and portrait as well as as-imported, and
// `reseatFilmBottom` takes a second look at whichever designs ended up setting the bottom edge
// once the layout is known. The sweep is what saves the rungs; the repair shaves the slack.
// ---------------------------------------------------------------------------

console.log('\na big design never stands up where lying down would be shorter');
{
  const bigMask = makeMask('rect', 13, 18);
  const big: Design = { id: 'big', w: 13, h: 18, fill: 1, mask: bigMask };
  const laidDown: Design = { id: 'big', w: 18, h: 13, fill: 1, mask: rotateMask90(bigMask) };
  const sheetH = 48;

  // (a) The whole sheet packed from scratch, and the same sheet with the big design forced
  // flat before packing. Whichever way up it lands, it may not cost more film than that.
  for (const seed of [11, 23]) {
    for (const n of [6, 10, 14]) {
      const small = makeDesigns(n, seed);
      const free = runArrange({ ...baseInput([...small, big], sheetH, 0.25), preferStable: false });
      const flat = runArrange({ ...baseInput([...small, laidDown], sheetH, 0.25), preferStable: false });
      const chose = free.result.find(r => r.id === 'big')!.rotation === 0 ? 'upright' : 'turned';
      check(billable(free.filmHeight) <= billable(flat.filmHeight),
        `${n} small designs + one 13x18 (seed ${seed})`,
        `landed ${chose} and bills ${billable(free.filmHeight)}" (${free.filmHeight.toFixed(1)}" of film) where flat would bill ${billable(flat.filmHeight)}" (${flat.filmHeight.toFixed(1)}")`);
      const { cells } = overlapOf([...small, big], free.result, sheetH);
      check(cells === 0, `${n} small designs + one 13x18 (seed ${seed}) overlap`, `${cells} cells`);
    }
  }

  // (b) The geometry the report describes, reduced to its bones: a settled band across the top
  // with a notch in it, and the big design the only thing left to place. The notch takes it
  // standing and is higher up the sheet; lying it below the band starts lower but ends sooner.
  const band: NestObstacle[] = [
    { x: 0, y: 0, w: 22, h: 6 },
    { x: 13.5, y: 6, w: 8.5, h: 2 },
  ];
  const upright = nestPack([{ id: 'big', w: 13, h: 18, mask: bigMask }], SHEET_W, sheetH, SHEET_W, sheetH, 0.25, band, false);
  const turned = nestPack([{ id: 'big', w: 18, h: 13, mask: rotateMask90(bigMask) }], SHEET_W, sheetH, SHEET_W, sheetH, 0.25, band, false);
  const best = Math.min(upright.maxHeight, turned.maxHeight);
  const greedy = nestPack([{ id: 'big', w: 13, h: 18, mask: bigMask }], SHEET_W, sheetH, SHEET_W, sheetH, 0.25, band);
  const whole = runArrange({
    ...baseInput([big], sheetH, 0.25),
    fixedRects: band.map(b => ({ ...b })),
    preferStable: false,
  });
  console.log(`  band with a 13.5" notch: standing ends at ${upright.maxHeight.toFixed(1)}", lying at ${turned.maxHeight.toFixed(1)}"`);
  console.log(`  the nester alone picks ${greedy.result[0].rotation === 0 ? 'standing' : 'lying'}; the whole arrange ends at ${whole.filmHeight.toFixed(1)}"`);
  check(whole.filmHeight <= best + EPS, 'the arrange takes the shorter orientation',
    `ended at ${whole.filmHeight.toFixed(1)}" against ${best.toFixed(1)}"`);
  // Documents the weakness the two mechanisms above exist to cover, rather than testing them:
  // the greedy per-item rule really does choose the taller orientation here. If this ever
  // starts passing, `nestInto`'s comment about not judging by the bottom edge is out of date.
  check(greedy.maxHeight > best + EPS,
    'the nester on its own still prefers the higher slot over the shorter finish');

  // (c) The big design arriving on a sheet that is already settled: an import, or a duplicate
  // on a busy sheet. Only the newcomer moves, which is the case the report calls "at the bottom".
  for (const n of [6, 10, 14]) {
    const small = makeDesigns(n, 11);
    const byId = new Map(small.map(d => [d.id, d]));
    const toRect = rectFor(byId);
    const settled = runArrange({ ...baseInput(small, sheetH, 0.25), preferStable: false }).result;
    const current = settled.map(p => toRect(p, sheetH));
    const free = runArrange({ ...baseInput([...small, big], sheetH, 0.25), current, preferStable: true });
    const flat = runArrange({ ...baseInput([...small, laidDown], sheetH, 0.25), current, preferStable: true });
    check(billable(free.filmHeight) <= billable(flat.filmHeight),
      `13x18 seated onto a settled sheet of ${n}`,
      `bills ${billable(free.filmHeight)}" (${free.filmHeight.toFixed(1)}" of film) against ${billable(flat.filmHeight)}" (${flat.filmHeight.toFixed(1)}") laid flat`);
    const { cells } = overlapOf([...small, big], free.result, sheetH);
    check(cells === 0, `13x18 seated onto a settled sheet of ${n}, overlap`, `${cells} cells`);
  }
}

// ---------------------------------------------------------------------------
// 5. The overlap detector itself, on artwork known to collide.
// ---------------------------------------------------------------------------

console.log('\nthe detector notices ink on ink when there is some');
{
  const d = makeDesigns(2, 5);
  const stacked: PlacedItem[] = d.map(x => ({ id: x.id, nx: 0.5, ny: 0.5, rotation: 0, overflows: false }));
  const { cells } = overlapOf(d, stacked, 36);
  check(cells > 0, 'two designs at the same spot are reported as colliding');
}

// ---------------------------------------------------------------------------
// 6. Duplicate-heavy mode expands the existing candidate search without changing price,
// overlap, item identity, or no-rotate guarantees.
// ---------------------------------------------------------------------------

console.log('\nduplicate-heavy sheets get a safe duplicate-aware search');
{
  const source = makeDesigns(1, 31)[0];
  const copies: Design[] = Array.from({ length: 18 }, (_, index) => ({
    ...source,
    id: `copy-${index}`,
    duplicateKey: 'same-artwork',
  }));
  const mixed = makeDesigns(8, 47).map((design, index) => ({
    ...design,
    id: `unique-${index}`,
    duplicateKey: `unique-artwork-${index}`,
  }));
  const repeated = [...copies, ...mixed];
  check(classifyArrangeLayout(repeated) === 'duplicate-heavy',
    'duplicate-heavy classification detects a dominant copy family');
  check(classifyArrangeLayout(mixed) === 'default',
    'mixed unique artwork stays on the legacy search');
  const keys = (values: string[]) => values.map((duplicateKey, index) => ({
    id: `classification-${index}`,
    duplicateKey,
  }));
  check(classifyArrangeLayout(keys(['a', 'a', 'b', 'c'])) === 'default',
    'one repeated pair on a four-item mixed sheet stays default');
  check(classifyArrangeLayout(keys(['a', 'a', 'a', 'b', 'c'])) === 'duplicate-heavy',
    'a family owning most of a five-item sheet is duplicate-heavy');
  check(classifyArrangeLayout(keys(['a', 'a', 'b', 'b', 'c', 'd', 'e', 'f'])) === 'default',
    'two isolated pairs on an eight-item mixed sheet stay default');
  check(classifyArrangeLayout(keys(['a', 'a', 'b', 'b', 'c', 'c', 'd', 'd'])) === 'duplicate-heavy',
    'an eight-item sheet made entirely of repeated families is duplicate-heavy');

  const input = baseInput(repeated, 120, 0.25);
  const legacy = runArrange({ ...input, layoutPreference: 'default', preferStable: false });
  const duplicateAware = runArrange({
    ...input,
    layoutPreference: 'duplicate-heavy',
    preferStable: false,
  });
  check(billable(duplicateAware.filmHeight) <= billable(legacy.filmHeight),
    'duplicate-aware search never costs a taller sheet',
    `${duplicateAware.filmHeight.toFixed(2)}" versus ${legacy.filmHeight.toFixed(2)}"`);
  const ids = new Set(duplicateAware.result.map(item => item.id));
  check(ids.size === repeated.length && duplicateAware.result.length === repeated.length,
    'duplicate-aware search keeps every physical copy separate');
  const overlap = overlapOf(repeated, duplicateAware.result, 120);
  check(overlap.cells === 0, 'duplicate-aware search leaves no ink overlap', `${overlap.cells} cells`);

  // Browser workers use structured clone, which preserves Uint8Array mask bits. JSON would
  // turn them into plain objects and test a transport the editor never uses.
  const workerRoundTrip = runArrange(structuredClone({
    ...input,
    layoutPreference: 'duplicate-heavy',
    preferStable: false,
  }) as ArrangeInput);
  check(
    JSON.stringify(workerRoundTrip.result) === JSON.stringify(duplicateAware.result)
      && Math.abs(workerRoundTrip.filmHeight - duplicateAware.filmHeight) < 1e-9
      && Math.abs(workerRoundTrip.packedExtent - duplicateAware.packedExtent) < 1e-9
      && Math.abs(workerRoundTrip.minRequiredHeight - duplicateAware.minRequiredHeight) < 1e-9,
    'duplicate-aware worker serialization matches the synchronous fallback');

  const byId = new Map(repeated.map(design => [design.id, design]));
  const stable = runArrange({
    ...input,
    current: duplicateAware.result.map(item => rectFor(byId)(item, 120)),
    layoutPreference: 'duplicate-heavy',
    preferStable: true,
  });
  check(billable(stable.filmHeight) <= billable(duplicateAware.filmHeight),
    'duplicate-aware stable arrange never costs a taller sheet');
  check(overlapOf(repeated, stable.result, 120).cells === 0,
    'duplicate-aware stable arrange leaves no ink overlap');

  const locked: Design[] = copies.slice(0, 6).map(copy => ({ ...copy, noRotate: true }));
  const lockedOut = runArrange({
    ...baseInput(locked, 60, 0.25),
    layoutPreference: 'duplicate-heavy',
    preferStable: false,
  });
  check(lockedOut.result.every(item => item.rotation === 0),
    'duplicate-aware search respects no-rotate items');
}

console.log(failures === 0
  ? '\nno arrange prints ink on ink, and none pays film for standing a design up'
  : `\n${failures} check(s) failed`);
if (failures > 0) process.exitCode = 1;

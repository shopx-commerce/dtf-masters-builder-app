/**
 * What skipping rungs of the height ladder costs, in ladder sizes.
 *
 *   npx tsx scripts/bench-arrange-ladder.ts
 *
 * When a pack overflows, the editor grows the sheet and packs again. It used to grow by one
 * rung at a time, learning nothing from the pack it had just thrown away, so artwork needing
 * several sizes more than it had paid for a full re-pack and composite rebuild at every rung
 * on the way. This bench exists to answer the only question that matters before shipping a
 * shortcut: does the shortcut ever land the customer on a *taller* sheet than the slow walk
 * would have?
 *
 * Three expansion policies run through the same simulated editor flow — pack, grow, repack
 * while anything overflows, then auto-shrink and re-seat — and are compared on the height
 * that actually gets purchased and on how many packs it took to get there:
 *
 *   loop    grow to `heights.find(h => h > current)`. Today's behaviour, the reference.
 *   bound   grow to the shortest rung a *lower bound* on the packing height allows. Skips
 *           only rungs that provably cannot hold the artwork, so it must agree with `loop`.
 *   extent  grow to the shortest rung that clears the overflowing pack's own measured
 *           extent plus two margins. The obvious shortcut, and the one under suspicion: an
 *           overflowing pack stacks everything it could not place one-per-row, so its extent
 *           is an over-estimate, and sizing off an over-estimate buys film.
 *
 * A single sheet where `bound` lands above `loop` fails the run.
 */

import { runArrange, packingHeightLowerBound } from '../client/src/lib/arrange-core';
import { inkInset, NEST_CELL_INCHES, type NestMask } from '../client/src/lib/nest-core';
import { DEFAULT_SHEET_MARGIN, planBandReseat, planLadderJump, planSheetShrink } from '../client/src/lib/sheet-fit';

const CELL = NEST_CELL_INCHES;
const GAP = DEFAULT_SHEET_MARGIN;
/** The production ladder, including the 18" rung the margin bench predates. */
const LADDER = [12, 18, 24, 36, 48, 60, 72, 84, 96, 120, 160, 240, 340];

// ---------------------------------------------------------------------------
// Synthetic artwork — same four shape families and three size bands the margin bench uses,
// so the two benches cover the same corpus and a regression in either is comparable.
// ---------------------------------------------------------------------------

type ShapeKind = 'circle' | 'triangle' | 'lshape' | 'ring' | 'diagonal' | 'rect' | 'star' | 'blob';

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
        case 'ring': {
          const d2 = dx * dx + dy * dy;
          ink = d2 <= 0.25 && d2 >= 0.09;
          break;
        }
        case 'diagonal': ink = Math.abs(u - v) <= 0.22; break;
        case 'star': {
          const ang = Math.atan2(dy, dx);
          ink = Math.hypot(dx, dy) <= 0.5 * (0.55 + 0.45 * Math.cos(5 * ang));
          break;
        }
        case 'blob': {
          const ang = Math.atan2(dy, dx);
          const rad = 0.5 * (0.72 + 0.16 * Math.sin(3 * ang + 0.7) + 0.1 * Math.cos(5 * ang));
          ink = Math.hypot(dx, dy) <= rad;
          break;
        }
        case 'rect': ink = true; break;
      }
      if (ink) bits[r * cols + c] = 1;
    }
  }
  return { cols, rows, bits };
}

function mulberry(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Design { id: string; w: number; h: number; mask: NestMask }

function makeDesigns(
  count: number, seed: number, kinds: ShapeKind[], minIn: number, maxIn: number, sheetW: number,
): Design[] {
  const rnd = mulberry(seed);
  const out: Design[] = [];
  for (let i = 0; i < count; i++) {
    const kind = kinds[Math.floor(rnd() * kinds.length)];
    const w = Math.min(sheetW, minIn + rnd() * (maxIn - minIn));
    const h = minIn + rnd() * (maxIn - minIn);
    out.push({ id: `d${i}`, w, h, mask: makeMask(kind, w, h) });
  }
  return out;
}

/** N identical solid squares — the shape of the case that produced the nine-pack climb. */
function uniformSquares(count: number, sizeIn: number): Design[] {
  const mask = makeMask('rect', sizeIn, sizeIn);
  return Array.from({ length: count }, (_, i) => ({ id: `u${i}`, w: sizeIn, h: sizeIn, mask }));
}

// ---------------------------------------------------------------------------
// Simulated editor flow
// ---------------------------------------------------------------------------

type Policy = 'loop' | 'bound' | 'extent';

interface Outcome {
  /** Height the customer ends up buying, after auto-shrink. */
  height: number;
  /** Height the expansion loop stopped at, before auto-shrink. */
  reachedHeight: number;
  /** Complete packs run, including the first one. */
  packs: number;
  /**
   * Time spent inside `runArrange`, summed over those packs.
   *
   * Wall-clock in the browser is the number the customer feels, but it is not measurable on a
   * shared machine — two runs of identical code differed by 50% while another agent's headless
   * Chrome was packing sheets against the same dev server. This is the same saving measured
   * where nothing else is competing for the CPU.
   */
  packMs: number;
  /** Every height the sheet passed through. */
  trace: number[];
  topGap: number;
  stillOverflowing: boolean;
}

function bandOf(
  placed: Array<{ id: string; nx: number; ny: number; rotation: number }>,
  byId: Map<string, Design>,
  abH: number,
): { minY: number; maxY: number } {
  let minY = Infinity, maxY = -Infinity;
  for (const p of placed) {
    const d = byId.get(p.id);
    if (!d) continue;
    const fh = p.rotation === 90 ? d.w : d.h;
    const cy = p.ny * abH;
    const inset = inkInset(d.mask, d.w, d.h, p.rotation);
    minY = Math.min(minY, cy - fh / 2 + inset.top);
    maxY = Math.max(maxY, cy + fh / 2 - inset.bottom);
  }
  return { minY, maxY };
}

function simulate(designs: Design[], policy: Policy, startHeight: number, sheetW: number): Outcome {
  const byId = new Map(designs.map(d => [d.id, d]));
  const items = designs.map(d => ({ id: d.id, w: d.w, h: d.h, fill: 1, mask: d.mask }));

  let height = startHeight;
  let packs = 0;
  let packMs = 0;
  const trace = [height];
  let band = { minY: 0, maxY: 0 };
  let stillOverflowing = false;

  // Mirrors `handleAutoArrange`: pack, and on overflow grow and pack again. The cap matches
  // the editor's own, which is one step per rung plus slack.
  for (let attempt = 0; attempt < LADDER.length + 2; attempt++) {
    const packStart = performance.now();
    const res = runArrange({
      type: 'arrange',
      requestId: 0,
      items,
      usableW: sheetW,
      usableH: height,
      artboardWidth: sheetW,
      artboardHeight: height,
      isAggressive: true,
      customGap: GAP,
      heightSteps: LADDER,
    });
    packMs += performance.now() - packStart;
    packs++;
    band = bandOf(res.result, byId, height);
    if (!res.result.some(p => p.overflows)) { stillOverflowing = false; break; }
    stillOverflowing = true;

    let next: number | null;
    if (policy === 'loop') {
      next = LADDER.find(h => h > height) ?? null;
    } else if (policy === 'bound') {
      next = planLadderJump({
        currentHeight: height,
        minRequiredHeight: res.minRequiredHeight,
        heights: LADDER,
      });
    } else {
      // The literal "jump to the packed extent" proposal, margins included.
      next = planLadderJump({
        currentHeight: height,
        minRequiredHeight: res.packedExtent + 2 * GAP,
        heights: LADDER,
      });
    }
    if (next === null || next === undefined) break;
    height = next;
    trace.push(height);
  }

  const reachedHeight = height;

  // Auto-shrink, then the re-seat that runs when there is no size to be saved.
  const plan = planSheetShrink({ band, currentHeight: height, margin: GAP, heights: LADDER });
  if (plan) {
    height = plan.height;
    band = { minY: band.minY - plan.shift, maxY: band.maxY - plan.shift };
  } else {
    const reseat = planBandReseat({ band, currentHeight: height, margin: GAP });
    if (reseat) band = { minY: band.minY - reseat.shift, maxY: band.maxY - reseat.shift };
  }

  return { height, reachedHeight, packs, packMs, trace, topGap: band.minY, stillOverflowing };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

interface Case { label: string; designs: Design[]; sheetW: number; start: number }

const cases: Case[] = [];
{
  const kindSets: Array<[string, ShapeKind[]]> = [
    ['irregular', ['blob', 'star', 'lshape', 'triangle']],
    ['round', ['circle', 'ring', 'blob']],
    ['mixed', ['circle', 'rect', 'star', 'blob', 'diagonal']],
    ['rects', ['rect']],
  ];
  const sizeBands: Array<[string, number, number]> = [
    ['small', 1.0, 3.0],
    ['medium', 2.5, 7.0],
    ['large', 6.0, 14.0],
  ];
  const counts = [1, 2, 3, 5, 8, 12, 20, 30, 45];
  let seed = 1000;
  for (const [kindLabel, kinds] of kindSets) {
    for (const [sizeLabel, min, max] of sizeBands) {
      for (const count of counts) {
        // 22" matches the margin bench's corpus exactly; 24.5" is the production width.
        for (const sheetW of [22, 24.5]) {
          cases.push({
            label: `${kindLabel}/${sizeLabel}/n=${count}/w=${sheetW}`,
            designs: makeDesigns(count, seed, kinds, min, max, sheetW),
            sheetW,
            start: LADDER[0],
          });
        }
        seed++;
      }
    }
  }

  // Uniform grids, which is where an overflowing pack's one-per-row spill over-states the
  // requirement worst: many items that really do share a row, none of which the pack could
  // place. The 14.22" row is the measured production case; the small sizes are the stress.
  for (const [n, size, start] of [
    [20, 14.22, 48], [20, 5, 12], [45, 3, 12], [30, 4, 12], [12, 8, 12], [8, 11, 18],
    [24, 6, 12], [16, 7.5, 24], [40, 2.5, 12], [6, 12, 12],
  ] as Array<[number, number, number]>) {
    cases.push({
      label: `uniform/n=${n}/${size}in`,
      designs: uniformSquares(n, size),
      sheetW: 24.5,
      start,
    });
  }
}

const rung = (h: number) => LADDER.indexOf(h);
const pad = (s: string, n: number) => s.padEnd(n);
const num = (v: number, n = 6, dp = 0) => v.toFixed(dp).padStart(n);

console.log('');
console.log(`Ladder-jump bench — margin ${GAP}", ladder ${LADDER.join(', ')}`);
console.log('');
console.log(pad('case', 34) + pad('loop', 18) + pad('bound', 18) + pad('extent', 18));
console.log(pad('', 34) + pad('height  packs', 18).repeat(3));
console.log('-'.repeat(88));

let boundTaller = 0;
let boundPacksSaved = 0;
let loopPacks = 0;
let boundPacks = 0;
let extentTaller = 0;
let extentTallerRungs = 0;
let boundOverflowLeft = 0;
let loopMs = 0;
let boundMs = 0;
const boundFailures: string[] = [];
const extentFailures: string[] = [];

for (const c of cases) {
  const loop = simulate(c.designs, 'loop', c.start, c.sheetW);
  const bound = simulate(c.designs, 'bound', c.start, c.sheetW);
  const extent = simulate(c.designs, 'extent', c.start, c.sheetW);

  loopPacks += loop.packs;
  boundPacks += bound.packs;
  boundPacksSaved += loop.packs - bound.packs;
  loopMs += loop.packMs;
  boundMs += bound.packMs;
  if (bound.height > loop.height) {
    boundTaller++;
    boundFailures.push(`${c.label}: loop ${loop.height}" -> bound ${bound.height}" (traces ${loop.trace.join('>')} vs ${bound.trace.join('>')})`);
  }
  if (bound.stillOverflowing && !loop.stillOverflowing) {
    boundOverflowLeft++;
    boundFailures.push(`${c.label}: bound left the sheet overflowing where loop did not`);
  }
  const extentDelta = rung(extent.height) - rung(loop.height);
  if (extentDelta > 0) {
    extentTaller++;
    extentTallerRungs += extentDelta;
    extentFailures.push(`${c.label}: loop ${loop.height}" -> extent ${extent.height}" (+${extentDelta} rung${extentDelta > 1 ? 's' : ''})`);
  }

  const flag = bound.height > loop.height ? '  BOUND TALLER' : (extentDelta > 0 ? `  extent +${extentDelta}` : '');
  console.log(
    pad(c.label, 34) +
    pad(`${num(loop.height)}${num(loop.packs, 7)}`, 18) +
    pad(`${num(bound.height)}${num(bound.packs, 7)}`, 18) +
    pad(`${num(extent.height)}${num(extent.packs, 7)}`, 18) +
    flag,
  );
}

console.log('');
console.log(`cases                                    : ${cases.length}`);
console.log(`packs, loop                              : ${loopPacks}`);
console.log(`packs, bound                             : ${boundPacks}  (${boundPacksSaved} fewer)`);
console.log(`packing time, loop                       : ${loopMs.toFixed(0)} ms`);
console.log(`packing time, bound                      : ${boundMs.toFixed(0)} ms  ` +
  `(${(100 * (1 - boundMs / loopMs)).toFixed(0)}% less)`);
console.log('');
console.log(`bound  — sheets landing on a taller rung  : ${boundTaller}`);
console.log(`bound  — sheets left overflowing          : ${boundOverflowLeft}`);
console.log(`extent — sheets landing on a taller rung  : ${extentTaller}  (${extentTallerRungs} rungs total)`);
if (extentFailures.length > 0) {
  console.log('');
  console.log('extent overshoots:');
  for (const f of extentFailures.slice(0, 20)) console.log(`  ${f}`);
  if (extentFailures.length > 20) console.log(`  ... and ${extentFailures.length - 20} more`);
}
if (boundFailures.length > 0) {
  console.log('');
  console.log('bound failures:');
  for (const f of boundFailures) console.log(`  ${f}`);
}
console.log('');
const ok = boundTaller === 0 && boundOverflowLeft === 0;
console.log(ok
  ? 'PASS - the bound-guided jump never buys a taller sheet than the one-rung walk'
  : `FAIL - the bound-guided jump changed the outcome on ${boundTaller + boundOverflowLeft} sheet(s)`);
console.log('');
process.exit(ok ? 0 : 1);

/**
 * What a top/bottom sheet margin would cost, in ladder sizes.
 *
 *   npx tsx scripts/bench-arrange-margin.ts
 *
 * Auto-arrange packs from y=0, so the top row lands flush against the sheet edge, while
 * every layout auto-shrink produces sits `margin` below it. Before making the two agree we
 * have to know what agreeing costs: sheet height is the thing the customer buys, so any
 * change that reserves vertical space can push an order onto the next rung of the ladder.
 *
 * Three policies are run through the same simulated editor flow — pack, grow a rung and
 * repack while anything overflows, then auto-shrink — and compared on the height that
 * actually gets purchased:
 *
 *   current  packer owns the whole sheet; shrink translates only when it also shrinks.
 *   inset    packer is handed `height - 2*margin` and every placement is pushed down by
 *            `margin`. The obvious fix, and the expensive one.
 *   reseat   packer still owns the whole sheet, but the band is slid down to `margin`
 *            afterwards whenever the sheet has the slack for it, and to half the slack when
 *            it does not. Never changes the height.
 */

import { runArrange } from '../client/src/lib/arrange-core';
import { inkInset, NEST_CELL_INCHES, type NestMask } from '../client/src/lib/nest-core';
import { DEFAULT_SHEET_MARGIN, planBandReseat, planSheetShrink } from '../client/src/lib/sheet-fit';

const CELL = NEST_CELL_INCHES;
const SHEET_W = 22;
const GAP = DEFAULT_SHEET_MARGIN;
const LADDER = [12, 24, 36, 48, 60, 72, 84, 96, 120, 160, 240, 340];

// ---------------------------------------------------------------------------
// Synthetic artwork. Irregular silhouettes are the ones that stress the ink-band
// measurement, so most cases lean on them rather than on plain rectangles.
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

interface Design {
  id: string;
  w: number;
  h: number;
  mask: NestMask;
}

function makeDesigns(count: number, seed: number, kinds: ShapeKind[], minIn: number, maxIn: number): Design[] {
  const rnd = mulberry(seed);
  const out: Design[] = [];
  for (let i = 0; i < count; i++) {
    const kind = kinds[Math.floor(rnd() * kinds.length)];
    const w = Math.min(SHEET_W, minIn + rnd() * (maxIn - minIn));
    const h = minIn + rnd() * (maxIn - minIn);
    out.push({ id: `d${i}`, w, h, mask: makeMask(kind, w, h) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Simulated editor flow
// ---------------------------------------------------------------------------

type Policy = 'current' | 'inset' | 'reseat';

interface Outcome {
  /** Height the customer ends up buying. */
  height: number;
  /** Clear film above the topmost ink. */
  topGap: number;
  /** Clear film below the lowest ink. */
  bottomGap: number;
  /** Sheet grew because the packer could not fit everything. */
  grewForOverflow: boolean;
}

/** Ink band of a set of placements, in inches from the sheet top. */
function bandOf(
  placed: Array<{ id: string; nx: number; ny: number; rotation: number }>,
  byId: Map<string, Design>,
  abH: number,
  yOffset: number,
): { minY: number; maxY: number } {
  let minY = Infinity, maxY = -Infinity;
  for (const p of placed) {
    const d = byId.get(p.id);
    if (!d) continue;
    const fh = p.rotation === 90 ? d.w : d.h;
    const cy = p.ny * abH + yOffset;
    const inset = inkInset(d.mask, d.w, d.h, p.rotation);
    minY = Math.min(minY, cy - fh / 2 + inset.top);
    maxY = Math.max(maxY, cy + fh / 2 - inset.bottom);
  }
  return { minY, maxY };
}

function simulate(designs: Design[], policy: Policy, startHeight: number): Outcome {
  const byId = new Map(designs.map(d => [d.id, d]));
  const items = designs.map(d => ({ id: d.id, w: d.w, h: d.h, fill: 1, mask: d.mask }));

  let height = startHeight;
  let grewForOverflow = false;
  let band = { minY: 0, maxY: 0 };

  // Pack, and grow a rung whenever anything overflows — the editor's expansion loop.
  for (let attempt = 0; attempt < LADDER.length; attempt++) {
    const packH = policy === 'inset' ? Math.max(1, height - GAP * 2) : height;
    const yOffset = policy === 'inset' ? GAP : 0;
    const res = runArrange({
      type: 'arrange',
      requestId: 0,
      items,
      usableW: SHEET_W,
      usableH: packH,
      artboardWidth: SHEET_W,
      artboardHeight: packH,
      isAggressive: true,
      customGap: GAP,
      heightSteps: LADDER,
    });
    band = bandOf(res.result, byId, packH, yOffset);
    if (!res.result.some(p => p.overflows)) break;
    const next = LADDER.find(h => h > height);
    if (next === undefined) break;
    height = next;
    grewForOverflow = true;
  }

  // Auto-shrink: drop to the smallest rung that still holds the band with margins.
  const plan = planSheetShrink({ band, currentHeight: height, margin: GAP, heights: LADDER });
  if (plan) {
    height = plan.height;
    band = { minY: band.minY - plan.shift, maxY: band.maxY - plan.shift };
  } else if (policy === 'reseat') {
    // No size to be saved, but the band may still be sitting on the sheet edge. Calls the
    // shipped function rather than restating it, so this bench cannot quietly go on
    // measuring a policy the editor has stopped using.
    const reseat = planBandReseat({ band, currentHeight: height, margin: GAP });
    if (reseat) band = { minY: band.minY - reseat.shift, maxY: band.maxY - reseat.shift };
  }

  return {
    height,
    topGap: band.minY,
    bottomGap: height - band.maxY,
    grewForOverflow,
  };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

interface Case {
  label: string;
  count: number;
  kinds: ShapeKind[];
  min: number;
  max: number;
  seed: number;
}

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
        cases.push({
          label: `${kindLabel}/${sizeLabel}/n=${count}`,
          count, kinds, min, max, seed: seed++,
        });
      }
    }
  }
}

const rung = (h: number) => LADDER.indexOf(h);
const pad = (s: string, n: number) => s.padEnd(n);
const num = (v: number, n = 7, dp = 2) => v.toFixed(dp).padStart(n);

console.log('');
console.log(`Top-margin cost bench — sheet ${SHEET_W}" wide, margin ${GAP}", ladder ${LADDER.join(', ')}`);
console.log('');
console.log(
  pad('case', 26) +
  pad('current', 22) +
  pad('inset', 22) +
  pad('reseat', 22),
);
console.log(pad('', 26) + pad('height  top  bottom', 22).repeat(3));
console.log('-'.repeat(92));

let insetCostSizes = 0;
let insetCostCases = 0;
let reseatCostCases = 0;
let flushCases = 0;
let reseatFixedCases = 0;
let reseatPartialCases = 0;
let reseatStillFlush = 0;
let heightMismatch = 0;

for (const c of cases) {
  const designs = makeDesigns(c.count, c.seed, c.kinds, c.min, c.max);
  // Every flow starts on the smallest rung and grows from there, which is what the editor
  // does for a fresh sheet.
  const cur = simulate(designs, 'current', LADDER[0]);
  const ins = simulate(designs, 'inset', LADDER[0]);
  const res = simulate(designs, 'reseat', LADDER[0]);

  const insDelta = rung(ins.height) - rung(cur.height);
  if (insDelta > 0) { insetCostCases++; insetCostSizes += insDelta; }
  if (res.height !== cur.height) { reseatCostCases++; heightMismatch++; }

  const wasFlush = cur.topGap < GAP - 1e-6;
  if (wasFlush) {
    flushCases++;
    if (res.topGap >= GAP - 1e-6) reseatFixedCases++;
    else if (res.topGap > 1e-6) reseatPartialCases++;
    else reseatStillFlush++;
  }

  console.log(
    pad(c.label, 26) +
    pad(`${num(cur.height, 6, 0)}${num(cur.topGap, 6)}${num(cur.bottomGap, 8)}`, 22) +
    pad(`${num(ins.height, 6, 0)}${num(ins.topGap, 6)}${num(ins.bottomGap, 8)}`, 22) +
    pad(`${num(res.height, 6, 0)}${num(res.topGap, 6)}${num(res.bottomGap, 8)}`, 22) +
    (insDelta > 0 ? `  inset +${insDelta} rung${insDelta > 1 ? 's' : ''}` : ''),
  );
}

console.log('');
console.log(`cases                                  : ${cases.length}`);
console.log(`  top row flush under current behaviour: ${flushCases}`);
console.log('');
console.log(`inset  — cases pushed up the ladder    : ${insetCostCases}  (${insetCostSizes} rungs total)`);
console.log(`reseat — cases pushed up the ladder    : ${reseatCostCases}`);
console.log(`reseat — flush cases given the margin  : ${reseatFixedCases}`);
console.log(`reseat — flush cases given half the slack: ${reseatPartialCases}`);
console.log(`reseat — flush cases left flush (no slack): ${reseatStillFlush}`);
console.log('');
console.log(heightMismatch === 0
  ? 'PASS - reseat never changes the purchased height'
  : `FAIL - reseat changed the height in ${heightMismatch} case(s)`);
console.log('');
process.exit(heightMismatch === 0 ? 0 : 1);

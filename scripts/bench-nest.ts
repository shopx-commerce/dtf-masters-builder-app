/**
 * Correctness and density bench for the bitmap nester.
 *
 * Verification is deliberately independent of `nest-core`'s internals: placements are
 * re-rasterised into an owner grid here, and spacing is measured by brute-force
 * neighbourhood search rather than by reusing the packer's own dilation.
 *
 *   npx tsx scripts/bench-nest.ts
 */

import {
  NEST_CELL_INCHES,
  nestPack,
  keepPositionsNest,
  type NestItem,
  type NestMask,
  type NestCurrent,
} from '../client/src/lib/nest-core';
import { runArrange } from '../client/src/lib/arrange-core';

const CELL = NEST_CELL_INCHES;
const SHEET_W = 22;
const SHEET_H = 120;
const GAP = 0.25;

// ---------------------------------------------------------------------------
// Synthetic artwork
// ---------------------------------------------------------------------------

type ShapeKind = 'circle' | 'triangle' | 'lshape' | 'ring' | 'diagonal' | 'rect' | 'star';

function makeMask(kind: ShapeKind, wIn: number, hIn: number): NestMask {
  const cols = Math.max(1, Math.ceil(wIn / CELL - 1e-6));
  const rows = Math.max(1, Math.ceil(hIn / CELL - 1e-6));
  const bits = new Uint8Array(cols * rows);
  const set = (c: number, r: number) => {
    if (c >= 0 && c < cols && r >= 0 && r < rows) bits[r * cols + c] = 1;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const u = (c + 0.5) / cols;
      const v = (r + 0.5) / rows;
      let ink = false;
      switch (kind) {
        case 'circle': {
          const dx = u - 0.5, dy = v - 0.5;
          ink = dx * dx + dy * dy <= 0.25;
          break;
        }
        case 'triangle':
          ink = Math.abs(u - 0.5) <= v / 2;
          break;
        case 'lshape':
          ink = u <= 0.4 || v >= 0.6;
          break;
        case 'ring': {
          const dx = u - 0.5, dy = v - 0.5;
          const d2 = dx * dx + dy * dy;
          ink = d2 <= 0.25 && d2 >= 0.09;
          break;
        }
        case 'diagonal':
          ink = Math.abs(u - v) <= 0.22;
          break;
        case 'star': {
          const dx = u - 0.5, dy = v - 0.5;
          const ang = Math.atan2(dy, dx);
          const rad = Math.hypot(dx, dy);
          ink = rad <= 0.5 * (0.55 + 0.45 * Math.cos(5 * ang));
          break;
        }
        case 'rect':
          ink = true;
          break;
      }
      if (ink) set(c, r);
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

interface Design extends NestItem {
  kind: ShapeKind;
}

function makeDesigns(count: number, seed: number, kinds: ShapeKind[]): Design[] {
  const rnd = mulberry(seed);
  const out: Design[] = [];
  for (let i = 0; i < count; i++) {
    const kind = kinds[Math.floor(rnd() * kinds.length)];
    const w = 1.5 + rnd() * 5.5;
    const h = 1.5 + rnd() * 5.5;
    out.push({ id: `d${i}`, w, h, kind, mask: makeMask(kind, w, h) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Independent verification
// ---------------------------------------------------------------------------

interface Placed {
  id: string;
  nx: number;
  ny: number;
  rotation: number;
  overflows: boolean;
  anchored?: boolean;
}

/** Rotates a mask clockwise `quarters` times, written out separately from the packer's copy. */
function rotate(mask: NestMask, quarters: number): NestMask {
  let cur = mask;
  for (let q = 0; q < ((quarters % 4) + 4) % 4; q++) {
    const out = new Uint8Array(cur.cols * cur.rows);
    for (let y = 0; y < cur.rows; y++) {
      for (let x = 0; x < cur.cols; x++) {
        if (cur.bits[y * cur.cols + x]) out[x * cur.rows + (cur.rows - 1 - y)] = 1;
      }
    }
    cur = { cols: cur.rows, rows: cur.cols, bits: out };
  }
  return cur;
}

interface Audit {
  overlapCells: number;
  minSeparation: number;
  offSheet: string[];
  inkBottom: number;
  inkArea: number;
}

function audit(placed: Placed[], designs: Design[], sheetW: number, sheetH: number, gap: number): Audit {
  const byId = new Map(designs.map(d => [d.id, d]));
  const cols = Math.round(sheetW / CELL);
  const rows = Math.round(sheetH / CELL) + 400; // slack so overflowed items are still measured
  const owner = new Int32Array(cols * rows).fill(-1);
  const offSheet: string[] = [];
  let overlapCells = 0;
  let inkBottom = 0;
  let inkArea = 0;

  placed.forEach((p, index) => {
    const d = byId.get(p.id);
    if (!d || !d.mask) return;
    const quarters = Math.round(p.rotation / 90);
    const mask = rotate(d.mask, quarters);
    const fw = quarters % 2 === 0 ? d.w : d.h;
    const fh = quarters % 2 === 0 ? d.h : d.w;
    const originC = Math.round((p.nx * sheetW - fw / 2) / CELL);
    const originR = Math.round((p.ny * sheetH - fh / 2) / CELL);
    let escaped = false;
    for (let r = 0; r < mask.rows; r++) {
      for (let c = 0; c < mask.cols; c++) {
        if (!mask.bits[r * mask.cols + c]) continue;
        const gc = originC + c;
        const gr = originR + r;
        inkArea += CELL * CELL;
        if (gc < 0 || gc >= cols || gr < 0) { escaped = true; continue; }
        if (gr >= rows) { escaped = true; continue; }
        if (gr * CELL + CELL > sheetH + 1e-6) escaped = true;
        inkBottom = Math.max(inkBottom, (gr + 1) * CELL);
        const cellIndex = gr * cols + gc;
        if (owner[cellIndex] !== -1 && owner[cellIndex] !== index) overlapCells++;
        else owner[cellIndex] = index;
      }
    }
    if (escaped) offSheet.push(p.id);
  });

  // Brute-force nearest-other-owner search over a neighbourhood the size of the gap.
  const radius = Math.round(gap / CELL);
  let minSeparation = Infinity;
  for (let gr = 0; gr < rows; gr++) {
    for (let gc = 0; gc < cols; gc++) {
      const me = owner[gr * cols + gc];
      if (me === -1) continue;
      for (let dr = -radius; dr <= radius; dr++) {
        const rr = gr + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -radius; dc <= radius; dc++) {
          const cc = gc + dc;
          if (cc < 0 || cc >= cols) continue;
          const other = owner[rr * cols + cc];
          if (other === -1 || other === me) continue;
          const dist = Math.max(Math.abs(dr), Math.abs(dc)) * CELL;
          if (dist < minSeparation) minSeparation = dist;
        }
      }
    }
  }
  return { overlapCells, minSeparation, offSheet, inkBottom, inkArea };
}

// ---------------------------------------------------------------------------
// Rectangle-packer baseline
// ---------------------------------------------------------------------------

function rectBaseline(designs: Design[], sheetH: number): { placed: Placed[]; height: number } {
  const { result } = runArrange({
    type: 'arrange',
    requestId: 0,
    items: designs.map(d => ({ id: d.id, w: d.w, h: d.h, fill: 1 })),
    usableW: SHEET_W,
    usableH: sheetH,
    artboardWidth: SHEET_W,
    artboardHeight: sheetH,
    isAggressive: true,
    customGap: GAP,
  });
  const byId = new Map(designs.map(d => [d.id, d]));
  let bottom = 0;
  for (const p of result) {
    const d = byId.get(p.id);
    if (!d) continue;
    const h = p.rotation === 90 ? d.w : d.h;
    bottom = Math.max(bottom, p.ny * sheetH + h / 2);
  }
  return { placed: result as Placed[], height: bottom };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const pad = (s: string, n: number) => s.padEnd(n);
const num = (v: number, n = 7, dp = 2) => v.toFixed(dp).padStart(n);

let failures = 0;
function check(label: string, ok: boolean, detail: string) {
  if (!ok) { failures++; console.log(`   FAIL  ${label}: ${detail}`); }
}

console.log('');
console.log('Bitmap nesting bench');
console.log(`sheet ${SHEET_W}" wide, gap ${GAP}", grid ${CELL}"/cell`);
console.log('');
console.log(pad('case', 26) + pad('n', 4) + '   rect H   nest H   saved   ms   overlap   min gap');
console.log('-'.repeat(84));

const cases: Array<{ label: string; count: number; kinds: ShapeKind[]; seed: number }> = [
  { label: 'circles', count: 24, kinds: ['circle'], seed: 11 },
  { label: 'triangles', count: 24, kinds: ['triangle'], seed: 12 },
  { label: 'rings', count: 20, kinds: ['ring'], seed: 13 },
  { label: 'diagonals', count: 20, kinds: ['diagonal'], seed: 14 },
  { label: 'stars', count: 20, kinds: ['star'], seed: 15 },
  { label: 'L-shapes', count: 20, kinds: ['lshape'], seed: 16 },
  { label: 'mixed irregular', count: 30, kinds: ['circle', 'triangle', 'star', 'lshape', 'diagonal'], seed: 17 },
  { label: 'mixed with rects', count: 30, kinds: ['circle', 'triangle', 'rect', 'star', 'rect'], seed: 18 },
  { label: 'solid rects only', count: 24, kinds: ['rect'], seed: 19 },
  { label: 'large mixed', count: 60, kinds: ['circle', 'triangle', 'star', 'lshape', 'ring'], seed: 20 },
];

for (const c of cases) {
  const designs = makeDesigns(c.count, c.seed, c.kinds);
  const baseline = rectBaseline(designs, SHEET_H);

  const order = [...designs].sort((a, b) =>
    Math.max(b.w, b.h) - Math.max(a.w, a.h) || (b.w * b.h) - (a.w * a.h));
  const t0 = performance.now();
  const nested = nestPack(order, SHEET_W, SHEET_H, SHEET_W, SHEET_H, GAP);
  const ms = performance.now() - t0;

  const a = audit(nested.result as Placed[], designs, SHEET_W, SHEET_H, GAP);
  const saved = baseline.height > 0 ? (1 - a.inkBottom / baseline.height) * 100 : 0;

  console.log(
    pad(c.label, 26) + pad(String(c.count), 4) +
    num(baseline.height) + num(a.inkBottom) +
    num(saved, 7, 1) + '%' +
    num(ms, 6, 1) +
    num(a.overlapCells, 9, 0) +
    num(a.minSeparation === Infinity ? GAP : a.minSeparation, 10, 3),
  );

  check(c.label, a.overlapCells === 0, `${a.overlapCells} overlapping ink cells`);
  check(c.label, a.offSheet.length === 0, `${a.offSheet.length} designs with ink off the sheet`);
  check(c.label, a.minSeparation === Infinity || a.minSeparation >= GAP - CELL - 1e-6,
    `closest ink pair ${a.minSeparation.toFixed(3)}" apart, gap is ${GAP}"`);
  check(c.label, !nested.result.some(p => p.overflows), 'some designs overflowed');
}

// ---------------------------------------------------------------------------
// Stability: add designs one at a time and require settled ones never to move
// ---------------------------------------------------------------------------

console.log('');
console.log('Incremental stability (one upload at a time, nothing settled may move)');
console.log('-'.repeat(84));

{
  const designs = makeDesigns(14, 77, ['circle', 'triangle', 'star', 'lshape']);
  let placements: Placed[] = [];
  let moved = 0;
  let worstMove = 0;

  for (let n = 1; n <= designs.length; n++) {
    const active = designs.slice(0, n);
    const byId = new Map(active.map(d => [d.id, d]));
    const current: NestCurrent[] = placements.map(p => {
      const d = byId.get(p.id)!;
      const quarters = Math.round(p.rotation / 90);
      const fw = quarters % 2 === 0 ? d.w : d.h;
      const fh = quarters % 2 === 0 ? d.h : d.w;
      return {
        id: p.id,
        x: p.nx * SHEET_W - fw / 2,
        y: p.ny * SHEET_H - fh / 2,
        w: fw,
        h: fh,
        rotation: p.rotation,
      };
    });

    const next = keepPositionsNest(
      active, current, SHEET_W, SHEET_H, SHEET_W, SHEET_H, GAP, undefined, false,
    );

    const before = new Map(placements.map(p => [p.id, p]));
    for (const p of next.result as Placed[]) {
      const prev = before.get(p.id);
      if (!prev) continue;
      const dx = Math.abs(prev.nx - p.nx) * SHEET_W;
      const dy = Math.abs(prev.ny - p.ny) * SHEET_H;
      if (dx > 0.001 || dy > 0.001) { moved++; worstMove = Math.max(worstMove, Math.hypot(dx, dy)); }
    }
    placements = next.result as Placed[];

    const a = audit(placements, designs, SHEET_W, SHEET_H, GAP);
    check(`incremental n=${n}`, a.overlapCells === 0, `${a.overlapCells} overlapping ink cells`);
    check(`incremental n=${n}`, a.offSheet.length === 0, `${a.offSheet.length} designs with ink off the sheet`);
    check(`incremental n=${n}`, a.minSeparation === Infinity || a.minSeparation >= GAP - CELL - 1e-6,
      `closest ink pair ${a.minSeparation.toFixed(3)}"`);
  }

  console.log(`  settled designs relocated : ${moved}`);
  console.log(`  worst relocation distance : ${worstMove.toFixed(3)}"`);
  check('stability', moved === 0, `${moved} settled designs were relocated`);
}

// ---------------------------------------------------------------------------
// Integration: runArrange must pick whichever packer actually wins
// ---------------------------------------------------------------------------

console.log('');
console.log('runArrange with silhouettes (must never be worse than without)');
console.log('-'.repeat(84));
console.log(pad('case', 26) + '  no masks   masks   change    ms');

for (const c of [
  { label: 'circles', count: 24, kinds: ['circle'] as ShapeKind[], seed: 11 },
  { label: 'diagonals', count: 20, kinds: ['diagonal'] as ShapeKind[], seed: 14 },
  { label: 'mixed irregular', count: 30, kinds: ['circle', 'triangle', 'star', 'lshape'] as ShapeKind[], seed: 17 },
  { label: 'solid rects only', count: 24, kinds: ['rect'] as ShapeKind[], seed: 19 },
]) {
  const designs = makeDesigns(c.count, c.seed, c.kinds);
  const base = rectBaseline(designs, SHEET_H);

  const t0 = performance.now();
  const withMasks = runArrange({
    type: 'arrange',
    requestId: 0,
    items: designs.map(d => ({ id: d.id, w: d.w, h: d.h, fill: 1, mask: d.mask })),
    usableW: SHEET_W,
    usableH: SHEET_H,
    artboardWidth: SHEET_W,
    artboardHeight: SHEET_H,
    isAggressive: true,
    customGap: GAP,
  });
  const ms = performance.now() - t0;

  const a = audit(withMasks.result as Placed[], designs, SHEET_W, SHEET_H, GAP);
  const change = base.height > 0 ? (1 - a.inkBottom / base.height) * 100 : 0;
  console.log(
    pad(c.label, 26) + num(base.height, 9) + num(a.inkBottom) +
    num(change, 8, 1) + '%' + num(ms, 6, 0),
  );

  check(`runArrange ${c.label}`, a.overlapCells === 0, `${a.overlapCells} overlapping ink cells`);
  check(`runArrange ${c.label}`, a.offSheet.length === 0, `${a.offSheet.length} designs with ink off the sheet`);
  check(`runArrange ${c.label}`, a.minSeparation === Infinity || a.minSeparation >= GAP - CELL - 1e-6,
    `closest ink pair ${a.minSeparation.toFixed(3)}"`);
  // Supplying silhouettes may only ever help: the nester competes with the rectangle
  // packers on the same yardstick rather than replacing them.
  check(`runArrange ${c.label}`, a.inkBottom <= base.height + 0.06,
    `masks made the sheet taller: ${a.inkBottom.toFixed(2)}" vs ${base.height.toFixed(2)}"`);
}

// ---------------------------------------------------------------------------
// Groups: a group is packed as one super-item, and the editor can only put that placement
// back on its members as a translation. So any rotation the packer chose for it would be
// silently discarded — which is how a group used to end up in a slot reserved for its
// *turned* footprint, overlapping whatever was beside it. These cases audit the layout the
// way the editor would apply it: with the group's rotation forced back to 0.
// ---------------------------------------------------------------------------

console.log('');
console.log('Groups packed as one un-rotatable super-item');
console.log('-'.repeat(84));
console.log(pad('case', 26) + '   group   ink H   rot   overlap   off-sheet');

for (const c of [
  { label: 'wide group', gw: 16.4, gh: 3.2, count: 18, seed: 41 },
  { label: 'tall group', gw: 3.4, gh: 15.7, count: 18, seed: 42 },
  { label: 'wide group, few others', gw: 19.1, gh: 2.4, count: 5, seed: 43 },
]) {
  const GROUP = 'group:g1';
  const others = makeDesigns(c.count, c.seed, ['circle', 'triangle', 'star', 'lshape']);
  // A group reserves its whole bounding box, so a solid mask is the honest silhouette.
  const group: Design = {
    id: GROUP, w: c.gw, h: c.gh, kind: 'rect', mask: makeMask('rect', c.gw, c.gh), noRotate: true,
  };
  const all = [...others, group];

  const res = runArrange({
    type: 'arrange',
    requestId: 0,
    items: all.map(d => ({ id: d.id, w: d.w, h: d.h, fill: 1, mask: d.mask, noRotate: d.noRotate })),
    usableW: SHEET_W,
    usableH: SHEET_H,
    artboardWidth: SHEET_W,
    artboardHeight: SHEET_H,
    isAggressive: true,
    customGap: GAP,
  });

  const groupPlacement = res.result.find(p => p.id === GROUP)!;
  // What the editor actually does with a group: keep the returned centre, drop the rotation.
  const asApplied = (res.result as Placed[]).map(p =>
    p.id === GROUP ? { ...p, rotation: 0 } : p);
  const a = audit(asApplied, all, SHEET_W, SHEET_H, GAP);

  console.log(
    pad(c.label, 26) + num(c.gw, 8, 1) + 'x' + c.gh.toFixed(1) +
    num(a.inkBottom, 7) + num(groupPlacement.rotation, 6, 0) +
    num(a.overlapCells, 10, 0) + num(a.offSheet.length, 12, 0),
  );

  check(`group ${c.label}`, groupPlacement.rotation === 0,
    `super-item came back rotated ${groupPlacement.rotation}deg, which the editor cannot apply`);
  check(`group ${c.label}`, a.overlapCells === 0, `${a.overlapCells} overlapping ink cells`);
  check(`group ${c.label}`, a.offSheet.length === 0, `${a.offSheet.join(', ')} has ink off the sheet`);
  check(`group ${c.label}`, a.minSeparation === Infinity || a.minSeparation >= GAP - CELL - 1e-6,
    `closest ink pair ${a.minSeparation.toFixed(3)}"`);
  check(`group ${c.label}`, !res.result.some(p => p.overflows), 'some designs overflowed');

  // Same guarantee on the incremental path, which is what runs when copies are added.
  const stable = keepPositionsNest(
    all.map(d => ({ id: d.id, w: d.w, h: d.h, mask: d.mask, noRotate: d.noRotate })),
    [], SHEET_W, SHEET_H, SHEET_W, SHEET_H, GAP, undefined, true,
  );
  const stableGroup = stable.result.find(p => p.id === GROUP)!;
  check(`group ${c.label} incremental`, stableGroup.rotation === 0,
    `super-item came back rotated ${stableGroup.rotation}deg from keepPositionsNest`);
}

// The trap. On a sheet narrower than the group is wide, turning the group is the only way it
// fits, so every packer wants to — which is exactly the case that used to hand the editor a
// rotation it could not carry out. `noRotate` must win over fitting: the honest answer is
// that the group overflows and the caller grows the sheet, not that it is quietly turned.
{
  const NARROW_W = 6;
  const GROUP = 'group:g1';
  const group: Design = {
    id: GROUP, w: 20, h: 4.5, kind: 'rect', mask: makeMask('rect', 20, 4.5), noRotate: true,
  };
  const others = makeDesigns(4, 44, ['circle']).map(d => ({ ...d, w: 2, h: 2, mask: makeMask(d.kind, 2, 2) }));
  const all = [...others, group];
  const items = all.map(d => ({ id: d.id, w: d.w, h: d.h, fill: 1, mask: d.mask, noRotate: d.noRotate }));

  const viaNest = nestPack(items, NARROW_W, 40, NARROW_W, 40, GAP);
  const viaArrange = runArrange({
    type: 'arrange', requestId: 0, items,
    usableW: NARROW_W, usableH: 40, artboardWidth: NARROW_W, artboardHeight: 40,
    isAggressive: true, customGap: GAP,
  });
  const viaStable = keepPositionsNest(items, [], NARROW_W, 40, NARROW_W, 40, GAP, undefined, true);

  const rotOf = (result: Array<{ id: string; rotation: number }>) =>
    result.find(p => p.id === GROUP)!.rotation;

  console.log(`  group wider than the sheet: nestPack ${rotOf(viaNest.result)}deg, ` +
    `runArrange ${rotOf(viaArrange.result)}deg, keepPositions ${rotOf(viaStable.result)}deg`);

  check('group must not be turned to fit', rotOf(viaNest.result) === 0, 'nestPack turned it');
  check('group must not be turned to fit', rotOf(viaArrange.result) === 0, 'runArrange turned it');
  check('group must not be turned to fit', rotOf(viaStable.result) === 0, 'keepPositionsNest turned it');
}

console.log('');
console.log(failures === 0 ? 'PASS - all checks clean' : `FAIL - ${failures} check(s) failed`);
console.log('');
process.exit(failures === 0 ? 0 : 1);

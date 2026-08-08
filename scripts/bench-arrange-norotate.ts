/**
 * Does `noRotate` on group super-items make the packer work harder?
 *
 *   npx tsx scripts/bench-arrange-norotate.ts
 *
 * The suspicion is that forbidding rotation on user-created groups costs packing efficiency,
 * which would show up as more overflows, more rungs of the height ladder, and therefore more
 * full re-packs per Auto-Arrange. This runs the same artwork through the same simulated
 * expansion loop twice — once with the group super-items free to turn, once with `noRotate`
 * set as the editor now sets it — and compares the height purchased, the number of
 * `runArrange` calls, and the wall clock.
 */

import { runArrange, type ArrangeInput } from '../client/src/lib/arrange-core';
import { NEST_CELL_INCHES, type NestMask } from '../client/src/lib/nest-core';
import { DEFAULT_SHEET_MARGIN } from '../client/src/lib/sheet-fit';

const CELL = NEST_CELL_INCHES;
const GAP = DEFAULT_SHEET_MARGIN;
const SHEET_W = 22;
const LADDER = [12, 18, 24, 36, 48, 60, 72, 84, 96, 120, 160, 240, 340];

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function blobMask(wIn: number, hIn: number, phase: number): NestMask {
  const cols = Math.max(1, Math.ceil(wIn / CELL - 1e-6));
  const rows = Math.max(1, Math.ceil(hIn / CELL - 1e-6));
  const bits = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const dx = (c + 0.5) / cols - 0.5, dy = (r + 0.5) / rows - 0.5;
      const a = Math.atan2(dy, dx);
      if (Math.hypot(dx, dy) <= 0.5 * (0.72 + 0.18 * Math.sin(3 * a + phase))) bits[r * cols + c] = 1;
    }
  }
  return { cols, rows, bits };
}

type Item = { id: string; w: number; h: number; fill: number; mask?: NestMask; noRotate?: boolean };

/**
 * A sheet of loose designs plus `groupCount` groups. A group is packed as one rectangular
 * super-item covering its members' bounding box — deliberately non-square, since a square
 * one could not tell the two policies apart.
 */
function makeSheet(loose: number, groupCount: number, seed: number): Item[] {
  const rand = rng(seed);
  const items: Item[] = [];
  for (let i = 0; i < loose; i++) {
    const w = 2 + rand() * 3.5;
    const h = 2 + rand() * 3.5;
    const mask = blobMask(w, h, i);
    let ink = 0;
    for (let k = 0; k < mask.bits.length; k++) if (mask.bits[k]) ink++;
    items.push({ id: `d${i}`, w, h, fill: ink / mask.bits.length, mask });
  }
  for (let g = 0; g < groupCount; g++) {
    // Wide-and-short group boxes: the shape rotation would most help with.
    items.push({ id: `group:${g}`, w: 8 + rand() * 8, h: 2 + rand() * 2, fill: 1.0 });
  }
  return items;
}

function ladderRun(items: Item[], noRotate: boolean) {
  const packItems = items.map(i =>
    i.id.startsWith('group:') ? { ...i, noRotate } : i);
  let h = LADDER[0];
  let packs = 0;
  const t0 = performance.now();
  let overflowed = true;
  for (let step = 0; step < LADDER.length + 2; step++) {
    const input: ArrangeInput = {
      type: 'arrange', requestId: 0, items: packItems,
      usableW: SHEET_W, usableH: h, artboardWidth: SHEET_W, artboardHeight: h,
      isAggressive: true, customGap: GAP, heightSteps: LADDER,
    };
    const out = runArrange(input);
    packs++;
    overflowed = out.result.some(p => p.overflows);
    if (!overflowed) break;
    const taller = LADDER.filter(x => x > h);
    if (taller.length === 0) break;
    h = taller.find(x => x >= (out.minRequiredHeight ?? 0)) ?? taller[taller.length - 1];
  }
  return { height: h, packs, ms: performance.now() - t0, overflowed };
}

console.log('\n  scenario                    | rotation |  height | runArrange calls |    ms');
console.log('  ----------------------------|----------|---------|------------------|--------');

for (const [label, loose, groups, seed] of [
  ['20 loose + 3 groups', 20, 3, 3],
  ['40 loose + 5 groups', 40, 5, 5],
  ['60 loose + 8 groups', 60, 8, 9],
] as const) {
  const items = makeSheet(loose, groups, seed);
  for (const noRotate of [false, true]) {
    const r = ladderRun(items, noRotate);
    console.log(
      `  ${label.padEnd(27)} | ${(noRotate ? 'noRotate' : 'free').padEnd(8)} | ${
        (r.height + '"').padStart(7)} | ${String(r.packs).padStart(16)} | ${r.ms.toFixed(0).padStart(6)}`,
    );
  }
}

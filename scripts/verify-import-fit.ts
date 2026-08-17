/**
 * Uploading designs buys the sheet the artwork needs, and only that sheet.
 *
 *   npx tsx scripts/verify-import-fit.ts
 *
 * Import used to be the one path into the editor that never touched the height ladder. A design
 * grew the sheet only if that single design was taller than the film; a design that simply had
 * nowhere to sit among existing work was stacked below everything else and left there, off the
 * bottom of the sheet, with nothing said about it. Multi-file drops made it worse from the other
 * direction: they bump the sheet to 48" up front so files have somewhere to land while the batch
 * decodes, and nothing ever gave that back — two four-inch designs left the customer looking at
 * a 48" sheet.
 *
 * The fix routes the end of a batch through the same ladder that copy-count changes use, exactly
 * once, and follows it with the shrink. Once, because the ladder is only trustworthy when it can
 * see the whole batch: `planLadderJump` sizes its jump from `packingHeightLowerBound`, a genuine
 * lower bound on the film ten designs need, and a per-file ladder would instead climb a rung at a
 * time on evidence that looked convincing from each partial sheet. That is how a drop that fits
 * on one rung ends up on a sheet several sizes taller.
 *
 * So the invariant under test is not "the sheet is big enough" — it is "the sheet is no bigger
 * than it has to be". For every case the ideal rung is computed independently, by packing the
 * same artwork from scratch on the tallest film available and asking what the result would
 * shrink to, and the import path has to land within one rung of it. The old behaviour is run
 * over the same cases as a control.
 */

import { runArrange, packingHeightLowerBound } from '../client/src/lib/arrange-core';
import { keepPositionsNest, NEST_CELL_INCHES, type NestMask } from '../client/src/lib/nest-core';
import { DEFAULT_SHEET_MARGIN, planBandReseat, planLadderJump, planSheetShrink } from '../client/src/lib/sheet-fit';

const CELL = NEST_CELL_INCHES;
const GAP = DEFAULT_SHEET_MARGIN;
const LADDER = [12, 18, 24, 36, 48, 60, 72, 84, 96, 120, 160, 240, 340];
const MAX_HEIGHT = LADDER[LADDER.length - 1];
/** What `handleBatchStart` bumps a multi-file drop to before the first file lands. */
const PREBUMP = 48;
const SHEET_W = 24.5;

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

// ---------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------

type ShapeKind = 'rect' | 'circle' | 'star';

function makeMask(kind: ShapeKind, wIn: number, hIn: number): NestMask {
  const cols = Math.max(1, Math.ceil(wIn / CELL - 1e-6));
  const rows = Math.max(1, Math.ceil(hIn / CELL - 1e-6));
  const bits = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const u = (c + 0.5) / cols;
      const v = (r + 0.5) / rows;
      const dx = u - 0.5, dy = v - 0.5;
      let ink = true;
      if (kind === 'circle') ink = dx * dx + dy * dy <= 0.25;
      else if (kind === 'star') {
        const ang = Math.atan2(dy, dx);
        ink = Math.hypot(dx, dy) <= 0.5 * (0.55 + 0.45 * Math.cos(5 * ang));
      }
      if (ink) bits[r * cols + c] = 1;
    }
  }
  return { cols, rows, bits };
}

/** A file waiting to be imported: its physical size before the sheet scales it down. */
interface File {
  id: string;
  w: number;
  h: number;
  kind: ShapeKind;
}

function files(count: number, w: number, h: number, kind: ShapeKind = 'rect', prefix = 'f'): File[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, w, h, kind }));
}

/** A design on the sheet: scaled footprint plus where it currently sits, in normalised coords. */
interface Placed {
  id: string;
  w: number;
  h: number;
  mask: NestMask;
  nx: number;
  ny: number;
}

const rectsOf = (designs: Placed[], sheetW: number, sheetH: number) => designs.map(d => ({
  id: d.id,
  x: d.nx * sheetW - d.w / 2,
  y: d.ny * sheetH - d.h / 2,
  w: d.w,
  h: d.h,
  rotation: 0,
}));

// ---------------------------------------------------------------------------
// The import path
// ---------------------------------------------------------------------------

interface ImportOutcome {
  /** Height the customer is left on. */
  height: number;
  /** Complete packs the settle pass ran. Zero when it only had to re-seat or shrink. */
  packs: number;
  /** True if anything is still hanging off the film at the end. */
  stranded: boolean;
  /** Highest rung the sheet passed through, which is what the customer sees flash by. */
  peak: number;
}

/**
 * One file arriving, as `applyImageDirectly` handles it: scale to the sheet, grow for a design
 * too tall to fit on its own, then ask the nester for a slot among the work already down.
 *
 * Returns the flag that the end of the batch reads — true when the design had to be stacked
 * below everything else because the nester found it nowhere to go.
 */
function importOne(
  file: File,
  designs: Placed[],
  sheetW: number,
  height: number,
  /** False reproduces the old fallback, which let the newcomer land below the film. */
  clampFallback: boolean,
): { height: number; needsArrange: boolean } {
  const widthScale = Math.min(1, sheetW / file.w);
  const fittedHeight = file.h * widthScale;
  let abH = height;
  if (fittedHeight > abH) {
    const rung = LADDER.find(h => h >= fittedHeight) ?? MAX_HEIGHT;
    if (rung > abH) {
      // Existing designs are rescaled so their absolute positions survive the growth.
      for (const d of designs) d.ny = (d.ny * abH) / rung;
      abH = rung;
    }
  }

  const s = Math.min(1, sheetW / file.w, abH / file.h);
  const w = file.w * s;
  const h = file.h * s;
  const mask = makeMask(file.kind, w, h);

  if (designs.length === 0) {
    designs.push({ id: file.id, w, h, mask, nx: (w / 2) / sheetW, ny: (h / 2) / abH });
    return { height: abH, needsArrange: false };
  }

  const INCOMING = '__incoming__';
  const current = rectsOf(designs, sheetW, height);
  const packed = keepPositionsNest(
    [
      ...designs.map(d => ({ id: d.id, w: d.w, h: d.h, mask: d.mask })),
      { id: INCOMING, w, h, mask },
    ],
    current,
    sheetW, abH, sheetW, abH,
    GAP, undefined,
    false,
  );
  const spot = packed.result.find(p => p.id === INCOMING);
  if (spot && !spot.overflows) {
    designs.push({ id: file.id, w, h, mask, nx: spot.nx, ny: spot.ny });
    return { height: abH, needsArrange: false };
  }

  // Nowhere to go. Stacked below the rest and clamped onto the film, where it is visible and
  // obviously temporary, rather than dropped off the bottom edge where it is neither.
  const maxBottom = Math.max(...current.map(r => r.y + r.h));
  const halfNy = (h / 2) / abH;
  const rawNy = (maxBottom + GAP + h / 2) / abH;
  designs.push({
    id: file.id, w, h, mask,
    nx: (w / 2) / sheetW,
    ny: clampFallback
      ? Math.min(Math.max(rawNy, halfNy), Math.max(halfNy, 1 - halfNy))
      : Math.max(rawNy, halfNy),
  });
  return { height: abH, needsArrange: true };
}

/** Where the ink sits, which is what the sizing decisions are made from. */
function bandOf(designs: Placed[], height: number): { minY: number; maxY: number } {
  let minY = Infinity, maxY = -Infinity;
  for (const d of designs) {
    const cy = d.ny * height;
    minY = Math.min(minY, cy - d.h / 2);
    maxY = Math.max(maxY, cy + d.h / 2);
  }
  return { minY, maxY };
}

function packAll(designs: Placed[], sheetW: number, height: number, fullRepack: boolean) {
  return runArrange({
    type: 'arrange',
    requestId: 0,
    items: designs.map(d => ({ id: d.id, w: d.w, h: d.h, fill: 1, mask: d.mask })),
    current: rectsOf(designs, sheetW, height),
    usableW: sheetW,
    usableH: height,
    artboardWidth: sheetW,
    artboardHeight: height,
    isAggressive: true,
    customGap: GAP,
    preferStable: !fullRepack,
    heightSteps: LADDER,
  });
}

/** Write a pack's placements back onto the designs. */
function commit(designs: Placed[], result: Array<{ id: string; nx: number; ny: number; rotation: number }>): void {
  const byId = new Map(result.map(p => [p.id, p]));
  for (const d of designs) {
    const p = byId.get(d.id);
    if (!p) continue;
    d.nx = p.nx;
    d.ny = p.ny;
    if (p.rotation === 90) { const t = d.w; d.w = d.h; d.h = t; }
  }
}

/**
 * The batch settling: pack once if anything was stranded, climbing the ladder only when a full
 * repack agrees the film is genuinely short, then hand back whatever is left over.
 */
function settle(
  designs: Placed[],
  sheetW: number,
  startHeight: number,
  needsArrange: boolean,
  policy: 'settle' | 'legacy',
): ImportOutcome {
  let height = startHeight;
  let peak = startHeight;
  let packs = 0;

  if (policy === 'legacy') {
    // What import used to do at the end of a batch: a rigid slide to keep ink off the top
    // edge, and nothing else. No pack, so a stranded design stays stranded; no shrink, so the
    // pre-bump stays bought.
    const band = bandOf(designs, height);
    const reseat = planBandReseat({ band, currentHeight: height, margin: GAP });
    if (reseat) for (const d of designs) d.ny = (d.ny * height - reseat.shift) / height;
    return { height, packs: 0, stranded: strandedIn(designs, height), peak };
  }

  if (needsArrange && designs.length >= 2) {
    let repackedOnce = false;
    for (let step = 0; step < LADDER.length + 2; step++) {
      const res = packAll(designs, sheetW, height, repackedOnce);
      packs++;
      if (!res.result.some(p => p.overflows)) {
        commit(designs, res.result);
        break;
      }
      if (!repackedOnce) {
        // Before buying film, pack properly. A stable-biased pack overflows far more readily
        // than a real repack, and growing on the strength of one is the needless expansion.
        repackedOnce = true;
        continue;
      }
      commit(designs, res.result);
      if (height >= MAX_HEIGHT) break;
      const next = planLadderJump({
        currentHeight: height,
        minRequiredHeight: res.minRequiredHeight,
        heights: LADDER,
      }) ?? MAX_HEIGHT;
      if (next <= height) break;
      for (const d of designs) d.ny = (d.ny * height) / next;
      height = next;
      peak = Math.max(peak, height);
    }
  }

  // Always, whether or not anything was packed: give back film the batch turned out not to
  // need. This is what undoes the 48" pre-bump.
  const band = bandOf(designs, height);
  const plan = planSheetShrink({ band, currentHeight: height, margin: GAP, heights: LADDER })
    ?? (() => {
      const reseat = planBandReseat({ band, currentHeight: height, margin: GAP });
      return reseat ? { height, shift: reseat.shift } : null;
    })();
  if (plan) {
    for (const d of designs) d.ny = (d.ny * height - plan.shift) / plan.height;
    height = plan.height;
  }

  return { height, packs, stranded: strandedIn(designs, height), peak };
}

function strandedIn(designs: Placed[], height: number): boolean {
  return designs.some(d => d.ny * height + d.h / 2 > height + 0.01 || d.ny * height - d.h / 2 < -0.01);
}

/**
 * The shortest rung this artwork could possibly settle on, worked out without reference to the
 * import path: pack it from scratch on the tallest film there is, then ask what that would
 * shrink to. Anything the import buys above this is film the customer did not need.
 */
function idealHeight(fileSet: File[], sheetW: number): number {
  const designs: Placed[] = fileSet.map(f => {
    const s = Math.min(1, sheetW / f.w, MAX_HEIGHT / f.h);
    const w = f.w * s;
    const h = f.h * s;
    return { id: f.id, w, h, mask: makeMask(f.kind, w, h), nx: 0.5, ny: 0.5 };
  });
  const res = runArrange({
    type: 'arrange',
    requestId: 0,
    items: designs.map(d => ({ id: d.id, w: d.w, h: d.h, fill: 1, mask: d.mask })),
    usableW: sheetW,
    usableH: MAX_HEIGHT,
    artboardWidth: sheetW,
    artboardHeight: MAX_HEIGHT,
    isAggressive: true,
    customGap: GAP,
    heightSteps: LADDER,
  });
  commit(designs, res.result);
  const band = bandOf(designs, MAX_HEIGHT);
  const needed = band.maxY - band.minY + 2 * GAP;
  return LADDER.find(h => h >= needed - 0.01) ?? MAX_HEIGHT;
}

const nextRung = (h: number) => LADDER.find(r => r > h) ?? MAX_HEIGHT;

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

interface Case {
  label: string;
  fileSet: File[];
  /** Where the customer's sheet starts, before the drop. */
  startHeight: number;
  /** Extra assertions for the cases the report named specifically. */
  expect?: (outcome: ImportOutcome, ideal: number, label: string) => void;
}

const CASES: Case[] = [
  {
    label: 'two small designs (the 48" pre-bump case)',
    fileSet: files(2, 4, 4),
    startHeight: 12,
    expect: (o, _ideal, label) => check(
      o.height < PREBUMP,
      `${label}: left the customer on ${o.height}" — the multi-file pre-bump was never given back`,
    ),
  },
  { label: 'ten small designs', fileSet: files(10, 5, 5, 'circle'), startHeight: 12 },
  { label: 'ten medium designs', fileSet: files(10, 11, 9), startHeight: 12 },
  { label: 'ten large designs', fileSet: files(10, 22, 16), startHeight: 12 },
  { label: 'ten awkward stars', fileSet: files(10, 9, 13, 'star'), startHeight: 12 },
  {
    label: 'twenty small designs',
    fileSet: files(20, 5, 6, 'circle'),
    startHeight: 12,
  },
  {
    label: 'mixed batch of fifteen',
    fileSet: [
      ...files(5, 12, 10, 'rect', 'a'),
      ...files(5, 6, 6, 'circle', 'b'),
      ...files(5, 3, 9, 'star', 'c'),
    ],
    startHeight: 12,
  },
  {
    label: 'one design taller than any small rung',
    fileSet: files(1, 20, 95),
    startHeight: 12,
    expect: (o, _ideal, label) => check(
      o.height >= 95,
      `${label}: settled at ${o.height}", which cannot hold a 95" design`,
    ),
  },
  {
    label: 'a batch that genuinely needs a tall sheet',
    fileSet: files(12, 23, 19),
    startHeight: 12,
    expect: (o, ideal, label) => check(
      o.height === ideal,
      `${label}: settled at ${o.height}" where ${ideal}" is enough`,
    ),
  },
  {
    label: 'dropped onto a sheet the customer already filled',
    fileSet: files(6, 12, 14),
    startHeight: 24,
  },
];

// ---------------------------------------------------------------------------

function runImport(c: Case, policy: 'settle' | 'legacy'): ImportOutcome {
  const designs: Placed[] = [];
  // `handleBatchStart`: a multi-file drop gets somewhere to land before the first file decodes.
  let height = c.fileSet.length > 1 ? Math.max(c.startHeight, PREBUMP) : c.startHeight;
  let peak = height;
  let needsArrange = false;
  for (const file of c.fileSet) {
    const step = importOne(file, designs, SHEET_W, height, policy === 'settle');
    height = step.height;
    peak = Math.max(peak, height);
    needsArrange ||= step.needsArrange;
  }
  const out = settle(designs, SHEET_W, height, needsArrange, policy);
  return { ...out, peak: Math.max(peak, out.peak) };
}

function main(): void {
  console.log('case                                          files  ideal  settled  peak   packs  legacy');
  console.log('-'.repeat(96));

  let legacyOverbought = 0;
  let legacyStranded = 0;

  for (const c of CASES) {
    const ideal = idealHeight(c.fileSet, SHEET_W);
    const settled = runImport(c, 'settle');
    const legacy = runImport(c, 'legacy');

    // The invariant. One rung of slack is allowed because the settle pass packs the layout the
    // files arrived in rather than from an empty sheet, and holding it to an exact match would
    // be asserting that those two always tie.
    check(
      settled.height <= nextRung(ideal),
      `${c.label}: settled at ${settled.height}" where ${ideal}" holds the artwork — more than one rung of film bought for nothing`,
    );
    check(
      settled.height >= ideal,
      `${c.label}: settled at ${settled.height}", below the ${ideal}" this artwork needs`,
    );
    // Nothing may be left hanging off the film, which is the failure the customer cannot see.
    check(!settled.stranded, `${c.label}: a design is still off the sheet after the batch settled`);
    // Growth is decided once, from the whole batch, so the sheet must never climb past where it
    // ends up and come back down — that flicker is the per-file ratchet this replaced.
    check(
      settled.peak <= Math.max(settled.height, c.fileSet.length > 1 ? PREBUMP : c.startHeight),
      `${c.label}: the sheet reached ${settled.peak}" on the way to ${settled.height}"`,
    );
    check(
      settled.packs <= 2 + LADDER.length,
      `${c.label}: ${settled.packs} packs to settle one batch`,
    );
    c.expect?.(settled, ideal, c.label);

    if (legacy.height > nextRung(ideal)) legacyOverbought++;
    if (legacy.stranded) legacyStranded++;

    console.log(
      `${c.label.padEnd(45)} ${String(c.fileSet.length).padStart(5)} ` +
      `${`${ideal}"`.padStart(6)} ${`${settled.height}"`.padStart(8)} ${`${settled.peak}"`.padStart(6)} ` +
      `${String(settled.packs).padStart(6)}  ${`${legacy.height}"`.padStart(6)}${legacy.stranded ? ' stranded' : ''}`,
    );
  }

  // Controls. Both of these are what the old import path did, and if neither shows up the cases
  // above are not exercising the paths the fix changed.
  check(
    legacyOverbought > 0,
    'the old path never over-bought film in this corpus, so the sizing assertions prove nothing',
  );
  check(
    legacyStranded > 0,
    'the old path never stranded a design in this corpus, so the off-sheet assertion proves nothing',
  );

  // The lower bound the ladder sizes its jumps from has to be a real lower bound, or a single
  // jump could overshoot the rung the artwork needs and the "decide once" design would buy the
  // over-estimate outright.
  for (const c of CASES) {
    const designs = c.fileSet.map(f => {
      const s = Math.min(1, SHEET_W / f.w, MAX_HEIGHT / f.h);
      return { id: f.id, w: f.w * s, h: f.h * s, fill: 1 };
    });
    const bound = packingHeightLowerBound(designs, SHEET_W, GAP);
    check(
      bound <= idealHeight(c.fileSet, SHEET_W) + 0.01,
      `${c.label}: the packing lower bound (${bound.toFixed(2)}") exceeds a height the artwork demonstrably fits in`,
    );
  }

  console.log('-'.repeat(96));
  if (failures.length > 0) {
    console.error(`\nFAIL — ${failures.length} problem(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    `\nPASS — ${CASES.length} import batches settled within one rung of the film they need, ` +
    `none stranded, none ratcheting. The old path over-bought in ${legacyOverbought} of them ` +
    `and stranded a design in ${legacyStranded}.`,
  );
}

main();

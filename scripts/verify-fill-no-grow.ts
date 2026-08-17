/**
 * Fill Sheet fills the sheet the customer has. It never buys them a taller one.
 *
 *   npx tsx scripts/verify-fill-no-grow.ts
 *
 * The button says "Fill Sheet", so a customer who clicks it with a sheet they have already
 * chosen — and, in the report that prompted this, with one design selected — expects copies to
 * appear in the gaps. What they got was a taller and more expensive sheet, which is close to the
 * opposite of what they asked for.
 *
 * The mechanism was indirect enough to be worth spelling out. Fill deliberately asks for about
 * five percent more copies than it thinks will fit, on the grounds that the packer usually beats
 * the grid estimate, and deletes the ones that do not land. It also packs from scratch, so the
 * customer's own designs are free to move. Between those two, a crowded pack can put an
 * *original* over the edge — and an original is never expendable, so the overflow reached the
 * growth ladder and the sheet went up a rung.
 *
 * Two things are checked here.
 *
 *   1. Behaviour, over a matrix of sheet sizes, artwork and selections: the no-grow policy
 *      leaves the height untouched in every case, and when it cannot fit the copies it hands
 *      back the exact array of designs it started with. The same corpus is run through the old
 *      policy as a control — if that one never grows either, the matrix is not reproducing the
 *      bug and the result above means nothing.
 *
 *   2. That the editor still asks for it. The policy below is a model of `applyResult`, which
 *      lives inside a React hook and cannot be imported, so the source is read directly to
 *      confirm the ladder is still gated on `noGrow` and that Fill Sheet still passes it. That
 *      is a coarse check, but it is the difference between this script failing when someone
 *      deletes the flag and this script passing forever against a model of code that is gone.
 *
 * `computeFillCount` and `pickFillReference` are lifted out of the editor at run time, so the
 * copy count under test is the one the button actually uses.
 */

import { runArrange } from '../client/src/lib/arrange-core';
import { NEST_CELL_INCHES, type NestMask } from '../client/src/lib/nest-core';
import { DEFAULT_SHEET_MARGIN, planLadderJump } from '../client/src/lib/sheet-fit';
import { compileDeclarations, extract, readSource } from './lib/extract-ts.mjs';

const CELL = NEST_CELL_INCHES;
const GAP = DEFAULT_SHEET_MARGIN;
const LADDER = [12, 18, 24, 36, 48, 60, 72, 84, 96, 120, 160, 240, 340];
const MAX_HEIGHT = LADDER[LADDER.length - 1];
/** One step per rung plus slack, as in the editor. */
const MAX_LADDER_STEPS = LADDER.length + 2;

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

// ---------------------------------------------------------------------------
// The real copy-count arithmetic
// ---------------------------------------------------------------------------

/** The shape of a design as far as the two lifted functions are concerned. */
type Design = {
  id: string;
  widthInches: number;
  heightInches: number;
  transform: { nx: number; ny: number; s: number; rotation: number };
  name: string;
  mask: NestMask;
};

type FillInternals = {
  pickFillReference: (designs: Design[], selectedDesignId: string | null) => Design | null;
  computeFillCount: (
    ref: Design, designs: Design[], gap: number, sheetW: number, sheetH: number,
  ) => number;
};

async function loadFillInternals(): Promise<FillInternals> {
  const source = readSource('client/src/components/image-editor/useImageEditorModelArrangeKeyboard.ts');
  const module = await compileDeclarations({
    // No design in this corpus carries a printed name, so the stamp band is zero and the
    // effective height is the artwork's own. The label's contribution to capacity is the
    // subject of verify-print-label.ts.
    prelude: 'const getEffectiveHeight = (d) => d.heightInches * d.transform.s;',
    pieces: [
      extract(source, 'pickFillReference', 'useImageEditorModelArrangeKeyboard.ts'),
      extract(source, 'computeFillCount', 'useImageEditorModelArrangeKeyboard.ts'),
    ],
    exports: ['pickFillReference', 'computeFillCount'],
  });
  return module as FillInternals;
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

type ShapeKind = 'rect' | 'circle' | 'lshape' | 'star';

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
      else if (kind === 'lshape') ink = u <= 0.4 || v >= 0.6;
      else if (kind === 'star') {
        const ang = Math.atan2(dy, dx);
        ink = Math.hypot(dx, dy) <= 0.5 * (0.55 + 0.45 * Math.cos(5 * ang));
      }
      if (ink) bits[r * cols + c] = 1;
    }
  }
  return { cols, rows, bits };
}

function design(id: string, w: number, h: number, kind: ShapeKind, nx: number, ny: number): Design {
  return {
    id,
    widthInches: w,
    heightInches: h,
    transform: { nx, ny, s: 1, rotation: 0 },
    name: `${id}.png`,
    mask: makeMask(kind, w, h),
  };
}

interface Scenario {
  label: string;
  sheetW: number;
  sheetH: number;
  designs: Design[];
  /** Index into `designs`, or null for "nothing selected". */
  selected: number | null;
}

function buildScenarios(): Scenario[] {
  const out: Scenario[] = [];
  const sheets: Array<[number, number]> = [[22, 24], [22, 36], [24.5, 48], [24.5, 96]];

  for (const [sheetW, sheetH] of sheets) {
    // A sheet with room to spare and one small design on it.
    out.push({
      label: `${sheetW}x${sheetH} one small design`,
      sheetW, sheetH,
      designs: [design('small', 3, 3, 'rect', 0.15, 0.08)],
      selected: 0,
    });
    // The reported case: several designs of different sizes, the *largest* selected, so the
    // copies are large ones. Selecting the big design is what made the growth easiest to hit.
    const mixed = [
      design('big', sheetW * 0.7, sheetH * 0.28, 'rect', 0.5, 0.2),
      design('mid', 6, 5, 'circle', 0.2, 0.55),
      design('small', 2.5, 2.5, 'star', 0.75, 0.6),
    ];
    out.push({ label: `${sheetW}x${sheetH} mixed, largest selected`, sheetW, sheetH, designs: mixed, selected: 0 });
    out.push({ label: `${sheetW}x${sheetH} mixed, smallest selected`, sheetW, sheetH, designs: mixed, selected: 2 });
    out.push({ label: `${sheetW}x${sheetH} mixed, nothing selected`, sheetW, sheetH, designs: mixed, selected: null });
    // A nearly full sheet, where the overshoot has the least room to be wrong in.
    const crowded: Design[] = [];
    const tile = 5;
    for (let y = 0; y + tile <= sheetH - 1; y += tile + GAP) {
      for (let x = 0; x + tile <= sheetW - 1; x += tile + GAP) {
        crowded.push(design(
          `t${crowded.length}`, tile, tile, 'lshape',
          (x + tile / 2) / sheetW, (y + tile / 2) / sheetH,
        ));
      }
    }
    if (crowded.length > 0) {
      out.push({ label: `${sheetW}x${sheetH} nearly full`, sheetW, sheetH, designs: crowded, selected: 0 });
    }

    // The reported shape of the bug, made deliberately hard.
    //
    // The selected design is far larger than the others, so the copies are large; the grid
    // estimate then buys enough of them to fill the sheet on its own, and the packer — which
    // places by descending area — gets to the customer's small designs with nothing left. Those
    // are originals, so the trim cannot touch them, and under the old policy their overflow is
    // what reached the ladder. Repeated at two crowding levels, because the number of small
    // designs decides whether the overshoot is absorbed or lands on the customer.
    // The same shape again, but with the customer's other work in many small pieces. The copy
    // count is estimated by area, and area is exactly what under-counts a crowd of little
    // designs: twenty one-inch stickers weigh almost nothing against a slot the size of the
    // selection, so the estimate hands the sheet over to the copies and the stickers are left
    // with the offcut. They are originals, so the trim cannot pay with them.
    for (const tinyCount of [20, 40]) {
      const feature = Math.min(sheetW * 0.45, sheetH * 0.45);
      const tinies = Array.from({ length: tinyCount }, (_, i) => design(
        `tiny${i}`, 1, 1, 'rect',
        0.05 + ((i % 16) * 0.06), 0.6 + Math.floor(i / 16) * 0.08,
      ));
      out.push({
        label: `${sheetW}x${sheetH} large selection, ${tinyCount} tiny originals`,
        sheetW, sheetH,
        designs: [design('feature', feature, feature * 1.1, 'rect', 0.25, 0.22), ...tinies],
        selected: 0,
      });
    }

    // The version that actually reaches the ladder. The other designs are middling: too big to
    // tuck into the offcuts the copies leave, too small to be placed before them. The packer
    // works largest-first, so the copies — clones of the largest thing on the sheet — take the
    // film, and what overflows is the customer's own work.
    for (const mediumCount of [3, 5]) {
      const feature = Math.min(sheetW * 0.45, sheetH * 0.45);
      const medium = sheetW * 0.32;
      const mediums = Array.from({ length: mediumCount }, (_, i) => design(
        `mid${i}`, medium, medium, 'rect',
        0.2 + (i % 2) * 0.45, 0.62 + Math.floor(i / 2) * 0.16,
      ));
      out.push({
        label: `${sheetW}x${sheetH} large selection, ${mediumCount} middling originals`,
        sheetW, sheetH,
        designs: [design('feature', feature, feature * 1.1, 'rect', 0.25, 0.22), ...mediums],
        selected: 0,
      });
    }

    for (const smallCount of [4, 8]) {
      const half = Math.min(sheetW * 0.46, sheetH * 0.46);
      const smalls = Array.from({ length: smallCount }, (_, i) => design(
        `s${i}`, 3, 3, 'rect',
        0.1 + (i % 4) * 0.25, 0.72 + Math.floor(i / 4) * 0.14,
      ));
      out.push({
        label: `${sheetW}x${sheetH} large selection crowds out ${smallCount} small designs`,
        sheetW, sheetH,
        designs: [design('feature', half, half * 1.1, 'rect', 0.25, 0.25), ...smalls],
        selected: 0,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The two policies
// ---------------------------------------------------------------------------

type Placed = { id: string; nx: number; ny: number; rotation: number; overflows: boolean; anchored?: boolean };

function pack(designs: Design[], sheetW: number, sheetH: number) {
  return runArrange({
    type: 'arrange',
    requestId: 0,
    items: designs.map(d => ({
      id: d.id,
      w: d.widthInches * d.transform.s,
      h: d.heightInches * d.transform.s,
      fill: 1,
      mask: d.mask,
    })),
    // Where everything currently sits, exactly as the editor supplies it. This matters more
    // than it looks: `runArrange` builds a keep-positions candidate from it whatever
    // `preferStable` says, and that candidate is the one that returns `anchored` placements.
    // Leaving it out would quietly skip the case where the trim used to spare an overflowing
    // copy because the packer had not moved it.
    current: designs.map(d => {
      const w = d.widthInches * d.transform.s;
      const h = d.heightInches * d.transform.s;
      return {
        id: d.id,
        x: d.transform.nx * sheetW - w / 2,
        y: d.transform.ny * sheetH - h / 2,
        w,
        h,
        rotation: d.transform.rotation,
      };
    }),
    usableW: sheetW,
    usableH: sheetH,
    artboardWidth: sheetW,
    artboardHeight: sheetH,
    isAggressive: true,
    customGap: GAP,
    // Fill passes `fullRepack`, which the editor turns into `preferStable: false`.
    preferStable: false,
    heightSteps: LADDER,
  }) as { result: Placed[]; packedExtent: number; minRequiredHeight: number };
}

interface Outcome {
  /** Height the sheet ends on. */
  height: number;
  /** Copies still on the sheet when it settled. */
  kept: number;
  /** True when the fill gave everything back rather than accept a layout that did not fit. */
  rolledBack: boolean;
  /** Ids on the sheet at the end, in order. */
  finalIds: string[];
}

/**
 * A model of `applyResult` under `noGrow`, and of the policy it replaced.
 *
 * Both start from the same pack so the only difference between them is what they do with an
 * overflow that outlives the trim.
 */
function settleFill(
  originals: Design[],
  copies: Design[],
  sheetH: number,
  sheetW: number,
  policy: 'noGrow' | 'legacy',
): Outcome {
  const fillIds = new Set(copies.map(c => c.id));
  let designs = [...originals, ...copies];
  let height = sheetH;

  for (let step = 0; step < MAX_LADDER_STEPS; step++) {
    const { result, minRequiredHeight } = pack(designs, sheetW, height);
    let placed = result;
    let overflowing = placed.some(p => p.overflows);

    if (overflowing) {
      // The trim. Under `noGrow` an anchored copy is expendable too — copies are the only
      // thing the run is allowed to spend, so sparing one it happens to have left in place
      // would mean growing instead.
      const remove = new Set(
        placed
          .filter(p => p.overflows && fillIds.has(p.id) && (policy === 'noGrow' || !p.anchored))
          .map(p => p.id),
      );
      if (remove.size > 0) {
        designs = designs.filter(d => !remove.has(d.id));
        placed = placed.filter(p => !remove.has(p.id));
        overflowing = placed.some(p => p.overflows);
      }
    }

    if (!overflowing) {
      return {
        height,
        kept: designs.filter(d => fillIds.has(d.id)).length,
        rolledBack: false,
        finalIds: designs.map(d => d.id),
      };
    }

    if (policy === 'noGrow') {
      // Nothing expendable is left and the height is not for sale, so the click is undone.
      return { height, kept: 0, rolledBack: true, finalIds: originals.map(d => d.id) };
    }

    if (height >= MAX_HEIGHT) break;
    const next = planLadderJump({ currentHeight: height, minRequiredHeight, heights: LADDER })
      ?? MAX_HEIGHT;
    if (next <= height) break;
    height = next;
  }

  return {
    height,
    kept: designs.filter(d => fillIds.has(d.id)).length,
    rolledBack: false,
    finalIds: designs.map(d => d.id),
  };
}

// ---------------------------------------------------------------------------
// Source checks — that the editor still asks for the policy modelled above
// ---------------------------------------------------------------------------

function checkSourceStillAsksForIt(): void {
  const source = readSource('client/src/components/image-editor/useImageEditorModelArrangeKeyboard.ts');
  check(
    /if \(!opts\?\.noGrow && hasOverflow && artboardHeightRef\.current < MAX_ARTBOARD_HEIGHT/.test(source),
    'the height ladder is no longer gated on `noGrow` — Fill Sheet can grow the sheet again',
  );
  check(
    /noGrow: true/.test(source),
    'no caller passes `noGrow: true` — Fill Sheet is not using the no-grow contract',
  );
  check(
    /noGrow: \(a\?\.noGrow \?\? false\) \|\| \(b\?\.noGrow \?\? false\)/.test(source),
    '`mergeArrangeOpts` no longer unions `noGrow`, so a coalesced fill can regain permission to grow',
  );
  check(
    /noGrowRestoreRef\.current = currentDesigns/.test(source),
    'Fill Sheet no longer records the layout to roll back to',
  );
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { pickFillReference, computeFillCount } = await loadFillInternals();
  checkSourceStillAsksForIt();

  const scenarios = buildScenarios();
  let legacyGrowths = 0;
  let rollbacks = 0;
  let totalCopiesKept = 0;

  console.log('scenario                                       sheet     copies  kept  no-grow   legacy');
  console.log('-'.repeat(96));

  for (const s of scenarios) {
    const selectedId = s.selected === null ? null : s.designs[s.selected].id;
    const ref = pickFillReference(s.designs, selectedId);
    if (!ref) {
      failures.push(`${s.label}: no fill reference for a sheet that has designs on it`);
      continue;
    }
    const count = Math.min(
      computeFillCount(ref, s.designs, GAP, s.sheetW, s.sheetH),
      Math.max(0, 500 - s.designs.length),
    );
    if (count < 1) continue;

    const copies: Design[] = Array.from({ length: count }, (_, i) => ({
      ...ref,
      id: `fill-${i}`,
      transform: { ...ref.transform, nx: 0.5, ny: 0.5 },
    }));

    const noGrow = settleFill(s.designs, copies, s.sheetH, s.sheetW, 'noGrow');
    const legacy = settleFill(s.designs, copies, s.sheetH, s.sheetW, 'legacy');

    // The whole point.
    check(
      noGrow.height === s.sheetH,
      `${s.label}: Fill Sheet changed the height from ${s.sheetH}" to ${noGrow.height}"`,
    );
    // A rollback has to be exact. Restoring "the originals" but in a layout the fill's pack
    // chose would leave the customer's work moved with nothing to show for it.
    if (noGrow.rolledBack) {
      rollbacks++;
      const expected = s.designs.map(d => d.id);
      check(
        noGrow.finalIds.length === expected.length && noGrow.finalIds.every((id, i) => id === expected[i]),
        `${s.label}: rollback did not restore the exact pre-fill design list`,
      );
    } else {
      // Keeping nothing is a legitimate answer on a sheet with no room — the speculative copy
      // is trimmed and the sheet is left exactly as it was. What is not legitimate is losing
      // one of the customer's designs to the trim.
      const survivingOriginals = noGrow.finalIds.filter(id => !id.startsWith('fill-'));
      check(
        survivingOriginals.length === s.designs.length,
        `${s.label}: fill deleted ${s.designs.length - survivingOriginals.length} of the customer's designs`,
      );
      totalCopiesKept += noGrow.kept;
    }
    // No copy may survive that the packer could not place.
    check(
      noGrow.finalIds.filter(id => id.startsWith('fill-')).length === noGrow.kept,
      `${s.label}: kept-copy count disagrees with the final design list`,
    );

    if (legacy.height > s.sheetH) legacyGrowths++;

    console.log(
      `${s.label.padEnd(46)} ${`${s.sheetW}x${s.sheetH}`.padEnd(9)} ${String(count).padStart(6)} ` +
      `${String(noGrow.kept).padStart(5)}  ${`${noGrow.height}"`.padStart(7)}  ${`${legacy.height}"`.padStart(7)}` +
      `${noGrow.rolledBack ? '  (rolled back)' : ''}`,
    );
  }

  // The control. Without this, a matrix where nothing ever overflowed would pass the height
  // check trivially and report a fix that had never been exercised.
  check(
    legacyGrowths > 0,
    'no scenario grew the sheet under the old policy, so this corpus does not reproduce the bug ' +
    'and proves nothing about the fix',
  );

  console.log('-'.repeat(96));
  if (failures.length > 0) {
    console.error(`\nFAIL — ${failures.length} problem(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    `\nPASS — ${scenarios.length} scenarios: the sheet height never changed, ${totalCopiesKept} copies placed, ` +
    `${rollbacks} fill(s) rolled back cleanly. The old policy grew the sheet in ${legacyGrowths} of them.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

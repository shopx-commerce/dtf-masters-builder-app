/**
 * The film reserved for a design's printed name is the film the label is drawn on.
 *
 *   npx tsx scripts/verify-print-label.ts
 *
 * The label is opaque ink that four separate paths draw (preview, export worker, main-thread
 * export fallback, PDF) and three separate paths reserve space for (the nest mask the packer
 * uses, overlap detection, the on-sheet clamps). They all read one layout now, but reading the
 * same numbers is not the same as agreeing about them: the layout is in inches from the artwork's
 * centre, the mask is in cells from the artwork's top-left, and a sign or rounding error between
 * those two frames is invisible on screen and shows up as a label printed over a neighbour.
 *
 * So the two things checked here are the two that cost money if they drift:
 *
 *   1. The label sits inside the footprint the nester reserved — artwork width by artwork height
 *      plus the band. Rotation turns footprint and label together, so proving containment in
 *      design-local space proves it at every angle; flips never move the label, because its
 *      coordinates are defined in the space the flips have already been undone in.
 *
 *   2. Every mask cell the drawn box touches is marked as ink. Cell coverage is worked out here
 *      from the drawn rectangle by intersecting it with the grid, deliberately *not* by calling
 *      the same `cellRange` the mask marks with — otherwise a mistake in that arithmetic would
 *      appear on both sides of the comparison and cancel.
 *
 * `cellRange` and `markLabel` are lifted out of `nest-mask.ts` at run time rather than copied,
 * so this cannot pass against a stale duplicate of code that has since changed.
 *
 * The corpus covers what the customer asked about: a solid square, which has nowhere to tuck a
 * label and must pay for a band; a design that is mostly empty, which must not pay; artwork small
 * enough that the legibility floor governs the size; and a name long enough that it has to be cut
 * rather than allowed to overhang.
 */

import {
  LABEL_GAP_INCHES,
  LABEL_MAX_FONT_INCHES,
  LABEL_MAX_LINES,
  LABEL_MIN_FONT_INCHES,
  LABEL_PAD_EMS,
  labelBoxHeight,
  labelReadsUpsideDown,
  labelTextFor,
  layoutPrintLabel,
  sharedLabelMeasure,
  type LabelRect,
  type PrintLabelLayout,
} from '../client/src/lib/print-label';
import { NEST_CELL_INCHES } from '../client/src/lib/nest-core';
import { compileDeclarations, extract, readSource } from './lib/extract-ts.mjs';

const CELL = NEST_CELL_INCHES;
const EPS = 1e-6;

/**
 * The inset `layoutPrintLabel` holds the box off the artwork's edges when it places it inside.
 *
 * Not exported by the module, and it does not need to be: it is used here only to reconstruct
 * roughly where an inside label would go, and `cornerIsClear` allows a two-cell margin either
 * side of its answer, which is far more slack than this number could be wrong by.
 */
const INSET_GUESS = 0.05;

type CellRange = { col0: number; col1: number; row0: number; row1: number };
type MaskInternals = {
  cellsFor: (inches: number) => number;
  cellRange: (rect: LabelRect, artW: number, artH: number, cols: number, rows: number) => CellRange;
  markLabel: (
    bits: Uint8Array,
    cols: number,
    rows: number,
    artW: number,
    artH: number,
    label: PrintLabelLayout,
  ) => void;
};

async function loadMaskInternals(): Promise<MaskInternals> {
  const source = readSource('client/src/lib/nest-mask.ts');
  const module = await compileDeclarations({
    prelude: `const NEST_CELL_INCHES = ${CELL};`,
    pieces: [
      extract(source, 'cellsFor', 'nest-mask.ts'),
      extract(source, 'cellRange', 'nest-mask.ts'),
      extract(source, 'markLabel', 'nest-mask.ts'),
    ],
    exports: ['cellsFor', 'cellRange', 'markLabel'],
  });
  return module as MaskInternals;
}

/** Ink at cell resolution, in the same orientation the design is drawn and printed in. */
type Artwork = {
  label: string;
  name: string;
  artW: number;
  artH: number;
  /** True where the artwork has ink, given the cell's centre in 0..1 of the footprint. */
  ink: (u: number, v: number) => boolean;
};

const CORPUS: Artwork[] = [
  {
    label: 'solid square',
    name: 'front-logo.png',
    artW: 6, artH: 6,
    ink: () => true,

  },
  {
    label: 'solid square, tiny',
    name: 'sm.png',
    artW: 1, artH: 1,
    ink: () => true,

  },
  {
    label: 'circle filling the footprint',
    name: 'badge_v2.png',
    artW: 5, artH: 5,
    ink: (u, v) => (u - 0.5) ** 2 + (v - 0.5) ** 2 <= 0.25,

  },
  {
    label: 'sparse: ink in the top-left only',
    name: 'sleeve-hit.png',
    artW: 8, artH: 8,
    ink: (u, v) => u < 0.45 && v < 0.45,

  },
  {
    label: 'tall text column down the left edge',
    name: 'vertical-wordmark.png',
    artW: 6, artH: 10,
    ink: (u) => u < 0.3,

  },
  {
    label: 'wide banner, ink along the top',
    name: 'banner.png',
    artW: 20, artH: 8,
    ink: (_u, v) => v < 0.4,

  },
  {
    label: 'long name on narrow artwork',
    name: 'customer-order-48221-left-chest-final-approved-v7.png',
    artW: 2, artH: 3,
    ink: () => true,

  },
  {
    label: 'ring with a clear centre but inked corners',
    name: 'ring.png',
    artW: 7, artH: 7,
    ink: (u, v) => {
      const d2 = (u - 0.5) ** 2 + (v - 0.5) ** 2;
      return d2 >= 0.09 && d2 <= 0.25 ? true : d2 > 0.25;
    },

  },
];

/** The artwork's ink as the mask builder would have it: one byte per cell, row-major. */
function buildArtBits(art: Artwork, cellsFor: (inches: number) => number, flipX: boolean, flipY: boolean) {
  const cols = cellsFor(art.artW);
  const rows = cellsFor(art.artH);
  const bits = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const u = (c + 0.5) / cols;
      const v = (r + 0.5) / rows;
      // Flips are applied to the artwork before the label is placed, exactly as the mask builder
      // draws the flipped image and then asks where the ink is.
      if (art.ink(flipX ? 1 - u : u, flipY ? 1 - v : v)) bits[r * cols + c] = 1;
    }
  }
  return { bits, cols, rows };
}

/** The cell's extent in label coordinates: inches from the artwork's centre, y down. */
function cellRect(col: number, row: number, artW: number, artH: number): LabelRect {
  return {
    x: -artW / 2 + col * CELL,
    y: -artH / 2 + row * CELL,
    width: CELL,
    height: CELL,
  };
}

/** Whether two rectangles share area, rather than merely touching along an edge. */
function overlaps(a: LabelRect, b: LabelRect): boolean {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > EPS && h > EPS;
}

/**
 * Whether a box of this size would sit over clear film in the artwork's bottom-right corner,
 * measured against the ink directly rather than by asking the mask.
 *
 * Answered with a margin either side of the mask builder's own moat, because the two disagree by
 * up to a cell at the boundary — the mask rounds cell coverage outwards, this intersects
 * rectangles. `null` means "close enough that either placement is defensible", and only the clear
 * and blocked answers are asserted on.
 */
function cornerIsClear(
  art: Artwork,
  bits: Uint8Array,
  cols: number,
  rows: number,
  box: LabelRect,
): boolean | null {
  const inked = (margin: number) => {
    const probe: LabelRect = {
      x: box.x - margin,
      y: box.y - margin,
      width: box.width + 2 * margin,
      height: box.height + 2 * margin,
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (bits[r * cols + c] && overlaps(cellRect(c, r, art.artW, art.artH), probe)) return true;
      }
    }
    return false;
  };
  if (!inked(2 * CELL)) return true;
  if (inked(0)) return false;
  return null;
}

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

/**
 * Cells the drawn box touches but the mask left blank, for one placed label.
 *
 * `mark` is a parameter so the same measurement can be pointed at a deliberately wrong marker in
 * the negative controls below.
 */
function unreservedCells(
  internals: MaskInternals,
  art: Artwork,
  layout: PrintLabelLayout,
  mark: MaskInternals['markLabel'],
): number {
  const cols = internals.cellsFor(art.artW);
  const rows = internals.cellsFor(art.artH + layout.bandInches);
  const bits = new Uint8Array(cols * rows);
  mark(bits, cols, rows, art.artW, art.artH, layout);
  let missing = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!overlaps(cellRect(c, r, art.artW, art.artH), layout.rect)) continue;
      if (!bits[r * cols + c]) missing++;
    }
  }
  return missing;
}

const placements = { inside: 0, below: 0 };

async function main(): Promise<void> {
  const internals = await loadMaskInternals();
  const measure = sharedLabelMeasure();

  console.log('design                                    flips   placement  band    font   text');
  console.log('-'.repeat(96));

  for (const art of CORPUS) {
    for (const [flipX, flipY] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      const { bits, cols, rows } = buildArtBits(art, internals.cellsFor, flipX, flipY);
      const layout = layoutPrintLabel(
        {
          name: art.name,
          artWidthInches: art.artW,
          artHeightInches: art.artH,
          isClearOfInk: (rect) => {
            const { col0, col1, row0, row1 } = internals.cellRange(rect, art.artW, art.artH, cols, rows);
            for (let r = row0; r < row1; r++) {
              for (let c = col0; c < col1; c++) if (bits[r * cols + c]) return false;
            }
            return true;
          },
        },
        measure,
      );
      const where = `${art.label} [${flipX ? 'x' : '-'}${flipY ? 'y' : '-'}]`;
      if (!layout) {
        failures.push(`${where}: no label produced for a design that has a name`);
        continue;
      }
      const { rect, bandInches: band } = layout;

      // 1. Inside the footprint the nester reserved. Every angle follows: rotation is a rigid
      //    transform applied to the footprint and the label alike.
      check(rect.x >= -art.artW / 2 - EPS, `${where}: label starts left of the artwork`);
      check(rect.x + rect.width <= art.artW / 2 + EPS, `${where}: label runs past the right edge`);
      check(rect.y >= -art.artH / 2 - EPS, `${where}: label starts above the artwork`);
      check(
        rect.y + rect.height <= art.artH / 2 + band + EPS,
        `${where}: label runs ${(rect.y + rect.height - art.artH / 2 - band).toFixed(4)}" past the reserved band`,
      );

      // 2. The band is the film the label actually needs, and nothing more.
      if (layout.placement === 'inside') {
        check(band === 0, `${where}: an inside label reserved ${band.toFixed(3)}" of film`);
        check(
          rect.y + rect.height <= art.artH / 2 + EPS,
          `${where}: an inside label hangs below the artwork`,
        );
        // The corner was taken on the promise that it was empty film.
        let overInk = 0;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            if (bits[r * cols + c] && overlaps(cellRect(c, r, art.artW, art.artH), rect)) overInk++;
          }
        }
        check(overInk === 0, `${where}: an inside label covers ${overInk} inked cells`);
      } else {
        check(
          Math.abs(band - (LABEL_GAP_INCHES + rect.height)) < EPS,
          `${where}: band ${band.toFixed(4)}" does not match gap plus box ${(LABEL_GAP_INCHES + rect.height).toFixed(4)}"`,
        );
        check(
          Math.abs(rect.y - (art.artH / 2 + LABEL_GAP_INCHES)) < EPS,
          `${where}: below-label does not start one gap under the artwork`,
        );
      }
      // The corner is taken when it is free and paid for when it is not. Checked against the ink
      // rather than against a per-case expectation, so it holds for the flipped variants too —
      // flipping a sparse design moves its empty corner, and the placement has to follow.
      const insideBox: LabelRect = {
        x: art.artW / 2 - rect.width - INSET_GUESS,
        y: art.artH / 2 - rect.height - INSET_GUESS,
        width: rect.width,
        height: rect.height,
      };
      const roomToTuck = rect.width + 2 * INSET_GUESS <= art.artW && rect.height + 2 * INSET_GUESS <= art.artH;
      const clear = roomToTuck ? cornerIsClear(art, bits, cols, rows, insideBox) : false;
      if (clear === true) {
        check(
          layout.placement === 'inside',
          `${where}: paid for a band although its bottom-right corner is empty film`,
        );
      } else if (clear === false) {
        check(
          layout.placement === 'below',
          `${where}: tucked the label into a corner that has ink in it`,
        );
      }
      placements[layout.placement]++;

      // 3. The mask reserves every cell the box is drawn on.
      const missing = unreservedCells(internals, art, layout, internals.markLabel);
      check(missing === 0, `${where}: ${missing} drawn cells were left blank in the nest mask`);
      check(
        internals.cellsFor(art.artH + band) * CELL >= art.artH + band - EPS,
        `${where}: the mask is shorter than the footprint it describes`,
      );

      // 4. Legibility and the hard width ceiling.
      check(
        layout.fontInches >= LABEL_MIN_FONT_INCHES - EPS,
        `${where}: font ${layout.fontInches.toFixed(3)}" is under the floor that survives the press`,
      );
      check(
        layout.fontInches <= LABEL_MAX_FONT_INCHES + EPS,
        `${where}: font ${layout.fontInches.toFixed(3)}" is over the ceiling`,
      );
      check(rect.width <= art.artW + EPS, `${where}: box is wider than the design`);

      // 5. Wrapping. Two rows is the ceiling, the box has to be tall enough for however many
      //    rows there are, and the reader has to be told when the name was cut short.
      check(
        layout.lines.length >= 1 && layout.lines.length <= LABEL_MAX_LINES,
        `${where}: wrapped onto ${layout.lines.length} rows, outside 1..${LABEL_MAX_LINES}`,
      );
      check(
        layout.lines.every(line => line.length > 0),
        `${where}: produced an empty row`,
      );
      check(
        Math.abs(rect.height - labelBoxHeight(layout.lines.length, layout.fontInches)) < EPS,
        `${where}: box height ${rect.height.toFixed(4)}" does not match ${layout.lines.length} rows at ${layout.fontInches.toFixed(4)}"`,
      );
      // Reading the rows back has to give the name, or a prefix of it ending in an ellipsis.
      // Both joins are accepted because the two wrap modes break in different places: word
      // wrap consumes the space it broke at, character wrap does not introduce one.
      const full = labelTextFor(art.name).replace(/\s+/g, ' ');
      const strip = (s: string) => (s.endsWith('…') ? s.slice(0, -1) : s);
      const rebuilt = strip(layout.lines.join(''));
      const rebuiltSpaced = strip(layout.lines.join(' '));
      check(
        full.startsWith(rebuilt) || full.startsWith(rebuiltSpaced),
        `${where}: printed rows "${layout.lines.join(' / ')}" do not read back as the name`,
      );
      // Each row has to fit the box it is drawn in, or wrapping has merely moved the overhang
      // from the end of one line to the end of two.
      const textWidth = Math.max(0, rect.width - 2 * LABEL_PAD_EMS * layout.fontInches);
      for (const line of layout.lines) {
        check(
          measure(line) * layout.fontInches <= textWidth + EPS,
          `${where}: row "${line}" is wider than the box it is drawn in`,
        );
      }

      if (!flipX && !flipY) {
        console.log(
          `${art.label.padEnd(41)} ${(flipX ? 'x' : '-') + (flipY ? 'y' : '-')}      ` +
          `${layout.placement.padEnd(10)} ${band.toFixed(3)}"  ${layout.fontInches.toFixed(3)}"  ${layout.lines.join(' / ')}`,
        );
      }
    }
  }

  // Readability at every angle the nester can turn a design to. The box does not move — only the
  // text inside it turns — which is what keeps the reserved space independent of rotation.
  for (const [rotation, expected] of [
    [0, false], [45, false], [90, false], [91, true], [135, true], [180, true],
    [225, true], [269, true], [270, false], [315, false], [360, false], [-90, false], [-135, true],
  ] as const) {
    check(
      labelReadsUpsideDown(rotation) === expected,
      `rotation ${rotation}°: readability flip should be ${expected}`,
    );
  }

  // Negative controls. Both of these are mistakes the checks above are meant to catch, so if they
  // pass silently the checks are not measuring what they claim to.
  const control = CORPUS[0];
  const controlLayout = layoutPrintLabel(
    { name: control.name, artWidthInches: control.artW, artHeightInches: control.artH },
    measure,
  )!;

  const roundedInwards: MaskInternals['markLabel'] = (bits, cols, rows, artW, artH, label) => {
    const toCol = (inches: number) => (inches + artW / 2) / CELL;
    const toRow = (inches: number) => (inches + artH / 2) / CELL;
    const col0 = Math.max(0, Math.ceil(toCol(label.rect.x)));
    const col1 = Math.min(cols, Math.floor(toCol(label.rect.x + label.rect.width)));
    const row0 = Math.max(0, Math.ceil(toRow(label.rect.y)));
    const row1 = Math.min(rows, Math.floor(toRow(label.rect.y + label.rect.height)));
    for (let r = row0; r < row1; r++) if (col1 > col0) bits.fill(1, r * cols + col0, r * cols + col1);
  };
  check(
    unreservedCells(internals, control, controlLayout, roundedInwards) > 0,
    'negative control: rounding the label box inwards left every drawn cell reserved, so the mask check is not measuring coverage',
  );

  const gapless: PrintLabelLayout = { ...controlLayout, bandInches: controlLayout.rect.height };
  check(
    gapless.rect.y + gapless.rect.height > control.artH / 2 + gapless.bandInches + EPS,
    'negative control: dropping the gap from the band still fit inside the footprint, so the containment check is slack',
  );

  // The reservation must not depend on how long the name is.
  //
  // This is the invariant the overlap bug came down to. Renaming a design does not re-pack the
  // sheet — it must not, or correcting a typo would move work the customer placed by hand — so
  // the space the nester set aside has to already cover every name the design might end up
  // with. When the reservation tracked the width of the text, a short name left free film
  // beside it, a neighbour was legitimately seated there, and the rename printed over it.
  //
  // Same design, same row count, wildly different names: the marked cells have to be identical
  // byte for byte.
  let comparedNames = 0;
  for (const art of CORPUS) {
    const names = ['a.png', 'mid-length-name.png', art.name, `${'x'.repeat(90)}.png`];
    const layouts = names
      .map(name => layoutPrintLabel(
        { name, artWidthInches: art.artW, artHeightInches: art.artH },
        measure,
      ))
      .filter((l): l is PrintLabelLayout => l != null);

    const reservationFor = (layout: PrintLabelLayout) => {
      const cols = internals.cellsFor(art.artW);
      const rows = internals.cellsFor(art.artH + layout.bandInches);
      const bits = new Uint8Array(cols * rows);
      internals.markLabel(bits, cols, rows, art.artW, art.artH, layout);
      return bits;
    };

    for (const a of layouts) {
      for (const b of layouts) {
        if (a === b) continue;
        if (a.lines.length !== b.lines.length || a.placement !== b.placement) continue;
        if (Math.abs(a.fontInches - b.fontInches) > EPS) continue;
        const bitsA = reservationFor(a);
        const bitsB = reservationFor(b);
        comparedNames++;
        check(
          bitsA.length === bitsB.length && bitsA.every((v, i) => v === bitsB[i]),
          `${art.label}: "${a.lines.join(' ')}" and "${b.lines.join(' ')}" reserve different cells ` +
          `despite the same ${a.lines.length}-row ${a.placement} placement — a rename between them would overlap a neighbour`,
        );
        check(
          Math.abs(a.bandInches - b.bandInches) < EPS,
          `${art.label}: same row count and placement, different band (${a.bandInches.toFixed(4)}" vs ${b.bandInches.toFixed(4)}")`,
        );
      }
    }
  }
  check(comparedNames > 0, 'no two names shared a row count, so the reservation was never compared across names');

  // Negative control for that comparison: the marker this replaced reserved only the box, which
  // is exactly the behaviour that let a rename widen a label over its neighbour.
  const boxOnly: MaskInternals['markLabel'] = (bits, cols, rows, artW, artH, label) => {
    const { col0, col1, row0, row1 } = internals.cellRange(label.rect, artW, artH, cols, rows);
    for (let r = row0; r < row1; r++) if (col1 > col0) bits.fill(1, r * cols + col0, r * cols + col1);
  };
  const wide = CORPUS.find(a => a.label === 'wide banner, ink along the top')!;
  const shortName = layoutPrintLabel({ name: 'a.png', artWidthInches: wide.artW, artHeightInches: wide.artH }, measure)!;
  const longName = layoutPrintLabel({ name: 'a-considerably-longer-name.png', artWidthInches: wide.artW, artHeightInches: wide.artH }, measure)!;
  const boxOnlyCells = (layout: PrintLabelLayout) => {
    const cols = internals.cellsFor(wide.artW);
    const rows = internals.cellsFor(wide.artH + layout.bandInches);
    const bits = new Uint8Array(cols * rows);
    boxOnly(bits, cols, rows, wide.artW, wide.artH, layout);
    return bits.reduce((n, v) => n + v, 0);
  };
  check(
    shortName.lines.length === longName.lines.length && boxOnlyCells(shortName) !== boxOnlyCells(longName),
    'negative control: marking only the label box reserved the same cells for a short and a long name, so the comparison above proves nothing',
  );

  // A corpus that had drifted to all-solid or all-sparse would still pass every check above
  // while testing only one half of the placement rule.
  check(placements.inside >= 4, `corpus exercises only ${placements.inside} inside placements`);
  check(placements.below >= 4, `corpus exercises only ${placements.below} band placements`);

  console.log('-'.repeat(96));
  if (failures.length > 0) {
    console.error(`\nFAIL — ${failures.length} problem(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    `\nPASS — ${CORPUS.length} designs x 4 flip combinations ` +
    `(${placements.inside} tucked into the artwork, ${placements.below} in a band): ` +
    `label drawn inside the reserved footprint, every drawn cell reserved in the nest mask.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

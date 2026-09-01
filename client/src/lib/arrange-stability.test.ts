import { describe, expect, it } from 'vitest';
import { runArrange, type CurrentRect } from './arrange-core';

/**
 * Two reports about arranges the customer did not ask for.
 *
 * Duplicating a design rebuilt the whole sheet, and pressing Auto-Arrange on a sheet with
 * red overlap outlines left them exactly where they were however many times it was pressed.
 * Both are decided here, in the packing core, by whether the caller asks for a stable layout
 * and by how much of the sheet it is allowed to touch.
 */

const MARGIN = 0.25;
const SHEET_W = 22;
const GAP = 0.25;

type Placed = {
  id: string;
  nx: number;
  ny: number;
  rotation: number;
  overflows: boolean;
  anchored?: boolean;
};

function arrange(opts: {
  items: Array<{ id: string; w: number; h: number; fill: number; duplicateKey?: string }>;
  artboardHeight: number;
  current?: CurrentRect[];
  preferStable?: boolean;
  fixedRects?: Array<{ x: number; y: number; w: number; h: number; rotation?: number }>;
}) {
  return runArrange({
    type: 'arrange',
    requestId: 1,
    isAggressive: false,
    customGap: GAP,
    usableW: SHEET_W - 2 * MARGIN,
    usableH: opts.artboardHeight - 2 * MARGIN,
    artboardWidth: SHEET_W,
    artboardHeight: opts.artboardHeight,
    heightSteps: [12, 24, 36, 48, 60, 72, 96, 120, 240],
    items: opts.items,
    current: opts.current,
    preferStable: opts.preferStable,
    fixedRects: opts.fixedRects,
  } as Parameters<typeof runArrange>[0]);
}

/** Four designs sitting together at the top of a sheet with plenty of film to spare. */
function fourTogether(size: number) {
  const items = Array.from({ length: 4 }, (_, i) => ({
    id: `o${i}`,
    w: size,
    h: size,
    fill: 1,
    duplicateKey: 'same-artwork',
  }));
  const current: CurrentRect[] = items.map((d, i) => ({
    id: d.id,
    x: MARGIN + i * (size + GAP),
    y: MARGIN,
    w: size,
    h: size,
    rotation: 0,
  }));
  return { items, current };
}

/** Copies as the editor seeds them: one source offset to the right, overlapping their source. */
function seedCopies(size: number, current: CurrentRect[], count: number) {
  const items = Array.from({ length: count }, (_, i) => ({
    id: `c${i}`,
    w: size,
    h: size,
    fill: 1,
    duplicateKey: 'same-artwork',
  }));
  items.forEach((c, i) => current.push({
    id: c.id,
    x: MARGIN + i * (size + GAP) + 0.03,
    y: MARGIN,
    w: size,
    h: size,
    rotation: 0,
  }));
  return items;
}

const centre = (p: Placed, abH: number) => ({ x: p.nx * SHEET_W, y: p.ny * abH });

describe('duplicating absorbs the copy instead of rebuilding the sheet', () => {
  const SIZE = 4;
  const ABH = 60;

  it('leaves every settled design exactly where it was', () => {
    const { items, current } = fourTogether(SIZE);
    const copies = seedCopies(SIZE, current, 4);

    const out = arrange({ items: [...items, ...copies], artboardHeight: ABH, current, preferStable: true });
    const placed = out.result as Placed[];

    for (const original of items) {
      const p = placed.find(r => r.id === original.id)!;
      const was = current.find(c => c.id === original.id)!;
      expect(p.anchored).toBe(true);
      expect(centre(p, ABH).x).toBeCloseTo(was.x + SIZE / 2, 6);
      expect(centre(p, ABH).y).toBeCloseTo(was.y + SIZE / 2, 6);
    }
  });

  it('seats the copies beside the work they came from, not down the film', () => {
    const { items, current } = fourTogether(SIZE);
    const copies = seedCopies(SIZE, current, 4);

    const out = arrange({ items: [...items, ...copies], artboardHeight: ABH, current, preferStable: true });
    const placed = out.result as Placed[];

    // The originals occupy the first 4.25 inches of film. Everything the pack added has to
    // come to rest against them rather than being scattered over a 60 inch sheet.
    for (const copy of copies) {
      const p = placed.find(r => r.id === copy.id)!;
      expect(p.overflows).toBe(false);
      expect(centre(p, ABH).y).toBeLessThan(MARGIN + 2 * (SIZE + GAP));
    }
    expect(out.filmHeight).toBeLessThan(2 * (SIZE + GAP) + MARGIN);
  });

  it('still takes a from-scratch layout when the caller asks for one', () => {
    const { items, current } = fourTogether(SIZE);
    const copies = seedCopies(SIZE, current, 4);
    const all = [...items, ...copies];

    const stable = arrange({ items: all, artboardHeight: ABH, current, preferStable: true });
    const repack = arrange({ items: all, artboardHeight: ABH, current, preferStable: false });

    // The contrast is the whole point of the flag: a full repack is free to move settled
    // work, and does. Anything that reintroduces it on the duplicate path brings the
    // "everything jumped around when I pressed Duplicate" report back with it.
    expect((repack.result as Placed[]).filter(p => p.anchored).length).toBe(0);
    expect((stable.result as Placed[]).filter(p => p.anchored).length).toBe(items.length);
    // And it is allowed to be tighter — stability is declined when it costs a rung, not
    // when it costs a fraction of an inch.
    expect(repack.filmHeight).toBeLessThanOrEqual(stable.filmHeight);
  });

  it('does not strand a copy that only fits once the sheet is rebuilt', () => {
    // Eight designs on a sheet that can hold them all, but not without moving what is
    // already there. The stable pass is entitled to report the overflow; what matters is
    // that a from-scratch pack of the same artwork finds room, which is what the arrange
    // path retries when it sees one.
    const SZ = 9;
    const ABH = 30;
    const { items, current } = (() => {
      const staggered = [
        { x: MARGIN + 0, y: MARGIN + 0 },
        { x: MARGIN + 11, y: MARGIN + 5 },
        { x: MARGIN + 0, y: MARGIN + 10 },
        { x: MARGIN + 11, y: MARGIN + 16 },
      ];
      const its = staggered.map((_, i) => ({ id: `f${i}`, w: SZ, h: SZ, fill: 1 }));
      const cur: CurrentRect[] = staggered.map((p, i) => ({
        id: `f${i}`, x: p.x, y: p.y, w: SZ, h: SZ, rotation: 0,
      }));
      return { items: its, current: cur };
    })();
    const copies = seedCopies(SZ, current, 2);

    const repack = arrange({ items: [...items, ...copies], artboardHeight: ABH, current, preferStable: false });
    expect((repack.result as Placed[]).filter(p => p.overflows).length).toBe(0);
  });
});

describe('a selected-only pack is not the last word on whether the film is full', () => {
  const SZ = 9;
  const ABH = 30;
  const staggered = [
    { x: MARGIN + 0, y: MARGIN + 0 },
    { x: MARGIN + 11, y: MARGIN + 5 },
    { x: MARGIN + 0, y: MARGIN + 10 },
    { x: MARGIN + 11, y: MARGIN + 16 },
  ];

  it('overflows against fixed obstacles where a whole-sheet repack fits everything', () => {
    const obstacles = staggered.map(p => ({ x: p.x, y: p.y, w: SZ, h: SZ, rotation: 0 }));
    const selected = [
      { id: 's0', w: SZ, h: SZ, fill: 1 },
      { id: 's1', w: SZ, h: SZ, fill: 1 },
    ];
    const selectedCurrent: CurrentRect[] = selected.map((s, i) => ({
      id: s.id, x: MARGIN + i * 0.3, y: MARGIN + 20, w: SZ, h: SZ, rotation: 0,
    }));

    // What pressing Auto-Arrange does while the copies are still selected: pack those two
    // into the gaps the other four happen to have left, and conclude there is no room.
    const selectedOnly = arrange({
      items: selected,
      artboardHeight: ABH,
      current: selectedCurrent,
      fixedRects: obstacles,
      preferStable: false,
    });
    expect((selectedOnly.result as Placed[]).some(p => p.overflows)).toBe(true);

    // The same six designs, packed together, fit with room to spare. An overflow from the
    // pass above therefore says nothing about the film, only about the obstacles — which is
    // why the arrange path widens the retry to the whole sheet before it believes one.
    const everything = [
      ...staggered.map((_, i) => ({ id: `f${i}`, w: SZ, h: SZ, fill: 1 })),
      ...selected,
    ];
    const wholeSheet = arrange({
      items: everything,
      artboardHeight: ABH,
      current: [
        ...staggered.map((p, i) => ({ id: `f${i}`, x: p.x, y: p.y, w: SZ, h: SZ, rotation: 0 })),
        ...selectedCurrent,
      ],
      preferStable: false,
    });
    expect((wholeSheet.result as Placed[]).filter(p => p.overflows).length).toBe(0);
    expect(wholeSheet.filmHeight).toBeLessThanOrEqual(ABH - 2 * MARGIN);
  });
});

/**
 * The third report: asking for far more copies than the film can hold produced a knot of red
 * overlap outlines that no amount of Auto-Arrange would clear.
 *
 * The packer is not at fault, and these pin why. A design the packer cannot place is reported
 * in a column of its own *below* the sheet, so every leftover normalises onto the same spot on
 * the bottom edge. Applying those positions is what builds the heap — and once built it is
 * self-sealing, because the heaped copies are now on the sheet and every later arrange counts
 * them as settled and leaves them alone. The commit path therefore takes such copies back
 * instead of placing them, which is only correct while the two facts below hold.
 */
describe('more copies than the film can hold', () => {
  const SZ = 6;
  /** Comfortably more than a 24" sheet can take, comfortably less than a 240" one. */
  const COUNT = 30;
  const copies = Array.from({ length: COUNT }, (_, i) => ({
    id: `c${i}`,
    w: SZ,
    h: SZ,
    fill: 1,
    duplicateKey: 'same-artwork',
  }));

  it('reports the leftovers stacked below the sheet, all on one spot once folded back', () => {
    const short = arrange({ items: copies, artboardHeight: 24 });
    const placed = short.result as Placed[];
    const overflowing = placed.filter(p => p.overflows);
    expect(overflowing.length).toBeGreaterThan(0);

    // Every leftover is reported at or past the bottom edge, on a sheet that is already
    // packed to it. That is the packer saying "nowhere", not "here" — a position which,
    // taken literally, lands on artwork that did fit.
    for (const p of overflowing) {
      expect(p.ny * 24 + SZ / 2).toBeGreaterThanOrEqual(24);
    }

    // And clamping them back onto the sheet, as committing them would, collapses them onto a
    // single position: the heap the customer sees as overlapping designs.
    const clamped = new Set(overflowing.map(p => Math.min(p.ny * 24, 24 - SZ / 2).toFixed(4)));
    expect(clamped.size).toBe(1);
  });

  it('fits every copy once the sheet is long enough, so the shortage is real and not a packing failure', () => {
    const tall = arrange({ items: copies, artboardHeight: 240 });
    expect((tall.result as Placed[]).filter(p => p.overflows).length).toBe(0);
  });
});

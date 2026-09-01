import { describe, it, expect } from 'vitest';
import { planUnitClamp, type ClampMember } from './clamp-units';

const SHEET_W = 22;
const SHEET_H = 60;

/**
 * A member positioned by its centre, with a box of the given size around it. Mirrors what the
 * editor hands in: normalised centre plus absolute ink bounds.
 */
function member(
  id: string,
  cxInches: number,
  cyInches: number,
  w: number,
  h: number,
  groupId?: string,
): ClampMember {
  return {
    id,
    groupId,
    nx: cxInches / SHEET_W,
    ny: cyInches / SHEET_H,
    box: {
      minX: cxInches - w / 2,
      maxX: cxInches + w / 2,
      minY: cyInches - h / 2,
      maxY: cyInches + h / 2,
    },
  };
}

/** Distance between two members' centres, in inches, after applying a clamp result. */
function spacing(
  moves: Map<string, { nx: number; ny: number }>,
  a: ClampMember,
  b: ClampMember,
): { dx: number; dy: number } {
  const at = moves.get(a.id) ?? { nx: a.nx, ny: a.ny };
  const bt = moves.get(b.id) ?? { nx: b.nx, ny: b.ny };
  return {
    dx: (bt.nx - at.nx) * SHEET_W,
    dy: (bt.ny - at.ny) * SHEET_H,
  };
}

describe('planUnitClamp', () => {
  it('leaves designs already on the sheet alone', () => {
    const moves = planUnitClamp(
      [member('a', 5, 5, 4, 4), member('b', 15, 30, 4, 4)],
      SHEET_W,
      SHEET_H,
    );
    expect(moves.size).toBe(0);
  });

  it('pulls a lone design back over the right edge', () => {
    const d = member('a', 21, 10, 4, 4); // spans 19..23 on a 22" sheet
    const moves = planUnitClamp([d], SHEET_W, SHEET_H);
    expect(moves.get('a')!.nx * SHEET_W).toBeCloseTo(20, 6);
  });

  it('pulls a lone design back over the top edge', () => {
    const d = member('a', 1, 1, 4, 4); // spans -1..3 vertically
    const moves = planUnitClamp([d], SHEET_W, SHEET_H);
    expect(moves.get('a')!.ny * SHEET_H).toBeCloseTo(2, 6);
  });

  it('does not move a design too large for the sheet', () => {
    // Shoving an oversized design against an edge does not make it fit, it only chooses which
    // side gets cut off — and it would fight the customer on every nudge.
    const moves = planUnitClamp([member('a', 11, 30, 30, 4)], SHEET_W, SHEET_H);
    expect(moves.size).toBe(0);
  });

  describe('groups', () => {
    it('moves every member by the same shift when one hangs off the edge', () => {
      // Two members 6" apart horizontally; the right one runs off the sheet.
      const left = member('l', 15, 10, 4, 4, 'g1');
      const right = member('r', 21, 10, 4, 4, 'g1');
      const moves = planUnitClamp([left, right], SHEET_W, SHEET_H);

      // The offender was the only one out of bounds, but both must move.
      expect(moves.has('l')).toBe(true);
      expect(moves.has('r')).toBe(true);
      expect(spacing(moves, left, right)).toEqual({
        dx: expect.closeTo(6, 6),
        dy: expect.closeTo(0, 6),
      });
      // And the group is now inside: right member spans 18..22.
      expect(moves.get('r')!.nx * SHEET_W).toBeCloseTo(20, 6);
    });

    it('preserves vertical spacing when a group is pushed off the bottom', () => {
      const top = member('t', 10, 50, 6, 6, 'g1');
      const bottom = member('b', 10, 58, 6, 6, 'g1'); // spans 55..61 on a 60" sheet
      const moves = planUnitClamp([top, bottom], SHEET_W, SHEET_H);

      expect(spacing(moves, top, bottom).dy).toBeCloseTo(8, 6);
      expect(moves.get('b')!.ny * SHEET_H).toBeCloseTo(57, 6);
    });

    it('is a no-op for a group already inside, even with a member near the edge', () => {
      const a = member('a', 3, 10, 4, 4, 'g1');
      const b = member('b', 20, 10, 4, 4, 'g1'); // spans 18..22 — touching, not past
      expect(planUnitClamp([a, b], SHEET_W, SHEET_H).size).toBe(0);
    });

    it('does not move a group wider than the sheet', () => {
      const a = member('a', 2, 10, 4, 4, 'g1');
      const b = member('b', 25, 10, 4, 4, 'g1');
      expect(planUnitClamp([a, b], SHEET_W, SHEET_H).size).toBe(0);
    });

    it('clamps two groups independently of each other', () => {
      const g1a = member('g1a', 21, 10, 4, 4, 'g1'); // off the right edge
      const g1b = member('g1b', 15, 10, 4, 4, 'g1');
      const g2a = member('g2a', 5, 30, 4, 4, 'g2'); // comfortably inside
      const g2b = member('g2b', 11, 30, 4, 4, 'g2');

      const moves = planUnitClamp([g1a, g1b, g2a, g2b], SHEET_W, SHEET_H);
      expect(moves.has('g1a')).toBe(true);
      expect(moves.has('g1b')).toBe(true);
      expect(moves.has('g2a')).toBe(false);
      expect(moves.has('g2b')).toBe(false);
    });

    it('does not let an ungrouped neighbour drag a group along', () => {
      const solo = member('solo', 21, 40, 4, 4); // off the edge, ungrouped
      const ga = member('ga', 5, 10, 4, 4, 'g1');
      const gb = member('gb', 11, 10, 4, 4, 'g1');

      const moves = planUnitClamp([solo, ga, gb], SHEET_W, SHEET_H);
      expect(moves.has('solo')).toBe(true);
      expect(moves.has('ga')).toBe(false);
      expect(moves.has('gb')).toBe(false);
    });

    it('matches the single-design result for a group of one', () => {
      const solo = member('a', 21, 10, 4, 4);
      const grouped = member('a', 21, 10, 4, 4, 'g1');
      expect(planUnitClamp([grouped], SHEET_W, SHEET_H).get('a'))
        .toEqual(planUnitClamp([solo], SHEET_W, SHEET_H).get('a'));
    });

    it('keeps a diagonal group rigid when it overruns two edges at once', () => {
      const a = member('a', 20, 55, 5, 5, 'g1'); // over the right edge
      const b = member('b', 14, 59, 5, 5, 'g1'); // over the bottom edge
      const moves = planUnitClamp([a, b], SHEET_W, SHEET_H);

      const gap = spacing(moves, a, b);
      expect(gap.dx).toBeCloseTo(-6, 6);
      expect(gap.dy).toBeCloseTo(4, 6);
      // Union spans x 11.5..22.5 and y 52.5..61.5, so it needs -0.5 in x and -1.5 in y.
      expect(moves.get('a')!.nx * SHEET_W).toBeCloseTo(19.5, 6);
      expect(moves.get('a')!.ny * SHEET_H).toBeCloseTo(53.5, 6);
    });
  });

  it('returns nothing for a degenerate artboard', () => {
    expect(planUnitClamp([member('a', 5, 5, 4, 4)], 0, SHEET_H).size).toBe(0);
    expect(planUnitClamp([member('a', 5, 5, 4, 4)], SHEET_W, 0).size).toBe(0);
  });
});

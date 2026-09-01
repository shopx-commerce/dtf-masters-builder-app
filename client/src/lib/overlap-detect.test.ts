import { describe, it, expect } from 'vitest';
import {
  OVERLAP_PX_PER_INCH,
  findAabbPairs,
  findOutOfBounds,
  intersectionTiles,
  overlapDetectionSize,
  overlapEdgeTolerancePx,
} from './overlap-detect';

/**
 * The bug these cover: the overlap test used to rasterise at a fraction of the preview
 * canvas, so its resolution depended on how large the sheet happened to be drawn. A long
 * gang sheet is fitted into the same preview as a short one, which left a 240" sheet at
 * roughly two pixels to the inch — finer than the margin between designs, so copies that
 * never touched were reported as overlapping, and the same sheet read differently in the
 * workspace and in the storefront.
 */
describe('overlap detection resolution', () => {
  it('resolves the smallest margin the editor offers', () => {
    // 1/16" is the tightest margin available. It has to survive resampling, so it needs
    // more than a pixel of clear sheet between neighbours.
    const gapPx = (1 / 16) * OVERLAP_PX_PER_INCH;
    expect(gapPx).toBeGreaterThanOrEqual(3);
  });

  it('scales with the sheet, not with how it is displayed', () => {
    const short = overlapDetectionSize(22, 24);
    const long = overlapDetectionSize(22, 240);
    // Ten times the film, ten times the detection pixels: an inch is the same number of
    // pixels on both, which is what stops a long sheet being tested more coarsely.
    expect(long.sh / short.sh).toBeCloseTo(10, 5);
    expect(long.sw).toBe(short.sw);
    expect(short.sh / 24).toBeCloseTo(OVERLAP_PX_PER_INCH, 5);
    expect(long.sh / 240).toBeCloseTo(OVERLAP_PX_PER_INCH, 5);
  });

  it('keeps a tiny sheet above the floor', () => {
    const { sw, sh } = overlapDetectionSize(0.1, 0.1);
    expect(sw).toBeGreaterThanOrEqual(60);
    expect(sh).toBeGreaterThanOrEqual(30);
  });
});

describe('findOutOfBounds', () => {
  const sheet = overlapDetectionSize(22, 120);
  const at = (id: string, left: number, top: number, right: number, bottom: number) =>
    ({ id, left, top, right, bottom });

  it('leaves ink flush with the edge alone', () => {
    const flagged = findOutOfBounds(
      [at('a', 0, 0, 100, 100), at('b', sheet.sw - 100, sheet.sh - 100, sheet.sw, sheet.sh)],
      sheet.sw, sheet.sh,
    );
    expect(flagged.size).toBe(0);
  });

  it('forgives rounding slack but not a design off the sheet', () => {
    const tol = overlapEdgeTolerancePx();
    const flagged = findOutOfBounds(
      [
        at('rounding', -tol / 2, 0, 100, 100),
        at('off-bottom', 0, sheet.sh + 10 * tol, 100, sheet.sh + 10 * tol + 100),
      ],
      sheet.sw, sheet.sh,
    );
    expect(Array.from(flagged)).toEqual(['off-bottom']);
  });
});

describe('findAabbPairs', () => {
  it('pairs only designs whose ink bounds meet', () => {
    const designs = [
      { left: 0, top: 0, right: 10, bottom: 10 },
      { left: 5, top: 5, right: 15, bottom: 15 },
      { left: 100, top: 100, right: 110, bottom: 110 },
    ];
    expect(findAabbPairs(designs)).toEqual([[0, 1]]);
  });

  it('does not pair designs that merely touch', () => {
    expect(findAabbPairs([
      { left: 0, top: 0, right: 10, bottom: 10 },
      { left: 10, top: 0, right: 20, bottom: 10 },
    ])).toEqual([]);
  });
});

describe('intersectionTiles', () => {
  it('covers a small shared area in one tile', () => {
    expect(intersectionTiles(
      { left: 0, top: 0, right: 100, bottom: 200 },
      { left: 40, top: 50, right: 300, bottom: 400 },
    )).toEqual([{ rx: 40, ry: 50, rw: 60, rh: 150 }]);
  });

  it('tiles an oversized area at full scale instead of shrinking it', () => {
    // Two earlier behaviours are ruled out here. Cropping tested only the top-left corner
    // of a large intersection, and downscaling to fit resampled thin collisions away —
    // both report a clean sheet for designs that really do collide.
    const maxTile = 2048;
    const tiles = intersectionTiles(
      { left: 0, top: 0, right: 9000, bottom: 5000 },
      { left: 0, top: 0, right: 9000, bottom: 5000 },
      maxTile,
    );
    expect(tiles.length).toBeGreaterThan(1);
    for (const t of tiles) {
      expect(t.rw).toBeGreaterThan(0);
      expect(t.rh).toBeGreaterThan(0);
      expect(t.rw).toBeLessThanOrEqual(maxTile);
      expect(t.rh).toBeLessThanOrEqual(maxTile);
    }
    // The tiles account for every pixel of the intersection exactly once: their areas sum
    // to the whole, and no two of them overlap.
    const area = tiles.reduce((sum, t) => sum + t.rw * t.rh, 0);
    expect(area).toBe(9000 * 5000);
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        const a = tiles[i], b = tiles[j];
        const meets = a.rx < b.rx + b.rw && a.rx + a.rw > b.rx &&
                      a.ry < b.ry + b.rh && a.ry + a.rh > b.ry;
        expect(meets).toBe(false);
      }
    }
    expect(Math.min(...tiles.map(t => t.rx))).toBe(0);
    expect(Math.max(...tiles.map(t => t.rx + t.rw))).toBe(9000);
    expect(Math.max(...tiles.map(t => t.ry + t.rh))).toBe(5000);
  });

  it('rounds fractional bounds outwards so no edge pixel goes untested', () => {
    // Rounding each bound to nearest would give [1,10) here and drop the strip from 10 to
    // 10.4. Ink bounds are fractional in practice, and a collision thin enough to live in
    // that strip is the kind this test exists to catch.
    const [tile] = intersectionTiles(
      { left: 0.6, top: 0.6, right: 10.4, bottom: 10.4 },
      { left: -5, top: -5, right: 50, bottom: 50 },
    );
    expect(tile).toEqual({ rx: 0, ry: 0, rw: 11, rh: 11 });
  });

  it('reports nothing when the bounds do not meet', () => {
    expect(intersectionTiles(
      { left: 0, top: 0, right: 10, bottom: 10 },
      { left: 20, top: 20, right: 30, bottom: 30 },
    )).toEqual([]);
  });
});

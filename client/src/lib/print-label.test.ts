import { describe, it, expect } from 'vitest';
import { artworkCentreFromFootprint, layoutPrintLabel, type LabelRect, type LabelMeasure } from './print-label';

/**
 * A stand-in for canvas text measurement: every character is 0.6 em wide. The real measure is a
 * canvas probe, but the layout only ever multiplies its result by the em size, so a linear
 * measure exercises the same arithmetic without a DOM.
 */
const measure: LabelMeasure = (text: string) => text.length * 0.6;

/** Rectangles of ink in design-local inches — origin at the artwork's centre, y down. */
type InkRect = { x: number; y: number; width: number; height: number };

function inkTester(rects: InkRect[]) {
  return (probe: LabelRect): boolean => !rects.some(r => (
    probe.x < r.x + r.width
    && probe.x + probe.width > r.x
    && probe.y < r.y + r.height
    && probe.y + probe.height > r.y
  ));
}

const NAME = 'sunset.png';

function layoutOn(artW: number, artH: number, ink: InkRect[] | null) {
  return layoutPrintLabel(
    {
      name: NAME,
      artWidthInches: artW,
      artHeightInches: artH,
      isClearOfInk: ink ? inkTester(ink) : undefined,
    },
    measure,
  );
}

describe('layoutPrintLabel placement', () => {
  it('uses the band below when no ink information is available', () => {
    // Every path without a mask must get the safe answer rather than a guess.
    expect(layoutOn(10, 10, null)!.placement).toBe('below');
  });

  it('reserves film for the band it places below', () => {
    const layout = layoutOn(10, 10, null)!;
    expect(layout.bandInches).toBeGreaterThan(0);
    expect(layout.rect.y).toBeGreaterThanOrEqual(10 / 2);
  });

  it('sits inside a completely empty footprint', () => {
    const layout = layoutOn(10, 10, [])!;
    expect(layout.placement).toBe('inside');
    expect(layout.bandInches).toBe(0);
  });

  it('goes below when the artwork is solid', () => {
    const solid = [{ x: -5, y: -5, width: 10, height: 10 }];
    expect(layoutOn(10, 10, solid)!.placement).toBe('below');
  });

  it('sits inside an open corner under a line of artwork', () => {
    // Ink only across the top half, so the bottom-right corner is open all the way out to both
    // edges — the film-saving case that is worth keeping.
    const topHalf = [{ x: -5, y: -5, width: 10, height: 5 }];
    const layout = layoutOn(10, 10, topHalf)!;
    expect(layout.placement).toBe('inside');
    // Bottom-right, inside the footprint.
    expect(layout.rect.x + layout.rect.width).toBeLessThanOrEqual(5);
    expect(layout.rect.y + layout.rect.height).toBeLessThanOrEqual(5);
  });

  describe('interior pockets', () => {
    it('refuses a hole surrounded by artwork', () => {
      // A ring of ink with a clear middle: a box dropped in the hole never touches ink, and
      // still prints the file name across the middle of the design. This is the reported bug.
      const ring = [
        { x: -5, y: -5, width: 10, height: 2 },   // top
        { x: -5, y: 3, width: 10, height: 2 },    // bottom
        { x: -5, y: -5, width: 2, height: 10 },   // left
        { x: 3, y: -5, width: 2, height: 10 },    // right
      ];
      expect(layoutOn(10, 10, ring)!.placement).toBe('below');
    });

    it('refuses a corner blocked only by ink below it', () => {
      // Clear to the right, ink underneath. The old moat test passed this whenever the ink sat
      // more than a mask cell away.
      const floor = [{ x: -5, y: 4.2, width: 10, height: 0.8 }];
      expect(layoutOn(10, 10, floor)!.placement).toBe('below');
    });

    it('refuses a corner blocked only by ink to its right', () => {
      const wall = [{ x: 4.2, y: -5, width: 0.8, height: 10 }];
      expect(layoutOn(10, 10, wall)!.placement).toBe('below');
    });
  });

  describe('clearance', () => {
    it('refuses a corner with ink inside the moat', () => {
      const layout = layoutOn(10, 10, [])!;
      // Park a speck of ink just above the label box — clear of it, but well within the moat.
      const speck = [{
        x: layout.rect.x,
        y: layout.rect.y - 0.1,
        width: 0.05,
        height: 0.05,
      }];
      expect(layoutOn(10, 10, speck)!.placement).toBe('below');
    });

    it('accepts a corner with ink beyond the moat', () => {
      const layout = layoutOn(10, 10, [])!;
      const distant = [{
        x: -5,
        y: -5,
        width: 10,
        height: layout.rect.y - 0.3 + 5,
      }];
      expect(layoutOn(10, 10, distant)!.placement).toBe('inside');
    });
  });

  it('goes below when the label cannot fit inside the footprint at all', () => {
    // A design narrower than its own name has no corner to offer.
    expect(layoutOn(0.6, 0.6, [])!.placement).toBe('below');
  });

  it('returns null for a nameless or degenerate design', () => {
    expect(layoutPrintLabel({ name: '', artWidthInches: 10, artHeightInches: 10 }, measure)).toBeNull();
    expect(layoutPrintLabel({ name: NAME, artWidthInches: 0, artHeightInches: 10 }, measure)).toBeNull();
  });

  it('never lets the label exceed the artwork width', () => {
    const layout = layoutPrintLabel(
      { name: 'a-really-quite-long-design-file-name-here.png', artWidthInches: 4, artHeightInches: 4 },
      measure,
    )!;
    expect(layout.rect.width).toBeLessThanOrEqual(4 + 1e-9);
  });
});

describe('artworkCentreFromFootprint', () => {
  const BAND = 0.4;

  /**
   * Where the band actually ends up, derived independently of the function under test: take
   * the artwork centre it returns, step half a band along the design's local "down" once
   * rotated, and the result has to land back on the footprint centre the packer chose.
   */
  function footprintCentreOf(x: number, y: number, rotationDegrees: number) {
    const rad = (rotationDegrees * Math.PI) / 180;
    // Local (0, +BAND/2) through the y-down rotation the canvas and bounds both use.
    return {
      x: x - (BAND / 2) * Math.sin(rad),
      y: y + (BAND / 2) * Math.cos(rad),
    };
  }

  it.each([0, 90, 180, 270, 45, -90, 360])('round-trips at %i degrees', (rotation) => {
    const centre = artworkCentreFromFootprint(10, 20, BAND, rotation);
    const back = footprintCentreOf(centre.x, centre.y, rotation);
    expect(back.x).toBeCloseTo(10, 9);
    expect(back.y).toBeCloseTo(20, 9);
  });

  it('lifts the artwork straight up when the design is not turned', () => {
    const centre = artworkCentreFromFootprint(10, 20, BAND, 0);
    expect(centre.x).toBeCloseTo(10, 9);
    expect(centre.y).toBeCloseTo(20 - BAND / 2, 9);
  });

  it('puts the band to the left at a quarter turn', () => {
    // A quarter turn clockwise sends local "down" to screen left, so the artwork sits to the
    // right of the footprint centre. Getting this sign backwards displaces a labelled design
    // by a whole band width from the film the nester reserved for it.
    const centre = artworkCentreFromFootprint(10, 20, BAND, 90);
    expect(centre.x).toBeCloseTo(10 + BAND / 2, 9);
    expect(centre.y).toBeCloseTo(20, 9);
  });

  it('puts the band to the right at three quarters', () => {
    const centre = artworkCentreFromFootprint(10, 20, BAND, 270);
    expect(centre.x).toBeCloseTo(10 - BAND / 2, 9);
    expect(centre.y).toBeCloseTo(20, 9);
  });

  it('drops the artwork below the centre at a half turn', () => {
    const centre = artworkCentreFromFootprint(10, 20, BAND, 180);
    expect(centre.x).toBeCloseTo(10, 9);
    expect(centre.y).toBeCloseTo(20 + BAND / 2, 9);
  });

  it('leaves an unlabelled design exactly where it was packed', () => {
    expect(artworkCentreFromFootprint(10, 20, 0, 90)).toEqual({ x: 10, y: 20 });
  });
});

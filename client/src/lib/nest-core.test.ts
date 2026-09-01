import { describe, it, expect } from 'vitest';
import { nestPack, type NestItem, type NestMask } from './nest-core';

/**
 * A right triangle filling the lower-left half of its footprint: row `r` is inked from
 * column 0 through column `r`. Two of these tile a rectangle when one is turned upside
 * down, and at no other pair of angles — which is the case the nester used to miss.
 */
function lowerLeftTriangle(n: number): NestMask {
  const bits = new Uint8Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c <= r; c++) bits[r * n + c] = 1;
  }
  return { cols: n, rows: n, bits };
}

/** A footprint that is entirely ink, which is what an ordinary photo upload looks like. */
function solid(n: number): NestMask {
  return { cols: n, rows: n, bits: new Uint8Array(n * n).fill(1) };
}

const SHEET_W = 4.5;
const SHEET_H = 30;

function pack(items: NestItem[], allowRotation = true) {
  return nestPack(items, SHEET_W, SHEET_H, SHEET_W, SHEET_H, 0, undefined, allowRotation);
}

describe('nestPack orientations', () => {
  it('interlocks two square triangles that no quarter turn could nest', () => {
    // 4x4 each, so the footprints are square and the old `|w - h| > 0.1` test offered no
    // rotation at all. Stacked they need 8 inches of film; interlocked, a little over 4.
    const mask = lowerLeftTriangle(40);
    const items: NestItem[] = [
      { id: 'a', w: 4, h: 4, mask },
      { id: 'b', w: 4, h: 4, mask },
    ];
    const packed = pack(items);
    expect(packed.result).toHaveLength(2);
    expect(packed.result.every(p => !p.overflows)).toBe(true);
    expect(packed.maxHeight).toBeLessThan(6);
  });

  it('turns the second triangle rather than the first', () => {
    const mask = lowerLeftTriangle(40);
    const packed = pack([
      { id: 'a', w: 4, h: 4, mask },
      { id: 'b', w: 4, h: 4, mask },
    ]);
    const byId = new Map(packed.result.map(p => [p.id, p]));
    expect(byId.get('a')!.rotation).toBe(0);
    expect(byId.get('b')!.rotation).not.toBe(0);
  });

  it('keeps every triangle on the sheet', () => {
    const mask = lowerLeftTriangle(40);
    const items: NestItem[] = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`, w: 4, h: 4, mask,
    }));
    const packed = pack(items);
    expect(packed.result).toHaveLength(6);
    expect(packed.result.every(p => !p.overflows)).toBe(true);
    // Six stacked would be 24 inches. Three interlocked pairs is nearer nine.
    expect(packed.maxHeight).toBeLessThan(16);
  });

  it('leaves a square solid design upright', () => {
    // Nothing to gain from turning a filled square, and the extra orientations must not be
    // spent on one.
    const packed = pack([
      { id: 'a', w: 4, h: 4, mask: solid(40) },
      { id: 'b', w: 4, h: 4, mask: solid(40) },
    ]);
    expect(packed.result.every(p => p.rotation === 0)).toBe(true);
  });

  it('honours noRotate on a shaped design', () => {
    const mask = lowerLeftTriangle(40);
    const packed = pack([
      { id: 'a', w: 4, h: 4, mask, noRotate: true },
      { id: 'b', w: 4, h: 4, mask, noRotate: true },
    ]);
    expect(packed.result.every(p => p.rotation === 0)).toBe(true);
  });

  it('honours the global rotation switch', () => {
    const mask = lowerLeftTriangle(40);
    const packed = pack([
      { id: 'a', w: 4, h: 4, mask },
      { id: 'b', w: 4, h: 4, mask },
    ], false);
    expect(packed.result.every(p => p.rotation === 0)).toBe(true);
  });

  it('still turns an oblong solid design', () => {
    // The footprint test that predates shaped orientations has to keep working.
    const packed = nestPack(
      [{ id: 'a', w: 6, h: 2, mask: undefined }],
      3, SHEET_H, 3, SHEET_H, 0, undefined, true,
    );
    expect(packed.result[0].rotation).toBe(90);
  });
});

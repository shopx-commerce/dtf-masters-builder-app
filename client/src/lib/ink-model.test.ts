import { describe, expect, it } from "vitest";
import {
  accumulateInkPixel,
  createInkStats,
  inkCoverage,
  resolveInkModel,
  type InkStats,
} from "./ink-model";

/**
 * The shapes real customer artwork arrives in.
 *
 * Every case here is a file the strict single-RGB rule refused: a white design
 * whose semi-transparent pixels were stored darkened, low-resolution line art
 * that is mostly anti-aliased edges, greyscale shading. What is being asserted
 * is not just that they are accepted, but which reading they get — the
 * difference between "half-strength white ink" and "half coverage" is the
 * difference between a print at the right density and one at a quarter of it.
 */

interface Pixel { r: number; g: number; b: number; a: number; n?: number }

function statsOf(pixels: Pixel[]): InkStats {
  const stats = createInkStats();
  for (const pixel of pixels) {
    for (let i = 0; i < (pixel.n ?? 1); i++) accumulateInkPixel(stats, pixel.r, pixel.g, pixel.b, pixel.a);
  }
  return stats;
}

function grey(value: number, alpha = 255, n = 1): Pixel {
  return { r: value, g: value, b: value, a: alpha, n };
}

function resolve(pixels: Pixel[]) {
  return resolveInkModel(statsOf(pixels), 64, 64);
}

describe("ink model", () => {
  it("reports nothing to recolor when every pixel is transparent", () => {
    expect(resolve([{ r: 12, g: 34, b: 56, a: 0, n: 100 }])).toMatchObject({
      ok: false,
      reason: "no-visible-pixels",
    });
  });

  it("keeps artwork that is already one exact color on the alpha-preserving path", () => {
    // Soft alpha, constant RGB: the case that already worked, and the only one
    // whose output must stay byte for byte identical.
    const result = resolve([grey(255, 255, 50), grey(255, 128, 20), grey(255, 7, 5)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.kind).toBe("uniform");
    expect(result.model.ink).toEqual({ r: 255, g: 255, b: 255 });
    expect(result.model.dominance).toBe(1);
    expect(inkCoverage(result.model, 255, 255, 255)).toBe(1);
  });

  it("treats encoder noise as one color rather than as shading", () => {
    const pixels: Pixel[] = [];
    for (let value = 248; value <= 255; value++) pixels.push(grey(value, 255, 10));
    const result = resolve(pixels);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.kind).toBe("uniform");
    expect(result.model.ink.r).toBeGreaterThanOrEqual(250);
    expect(result.model.dominance).toBe(1);
  });

  it("reads a white design whose color was darkened by its own transparency", () => {
    // The failing file: flattened over black, so a half-transparent white pixel
    // is stored as mid-grey. The ink is white and alpha already carries the
    // softness, so coverage must stay at 1.
    const pixels: Pixel[] = [];
    for (let alpha = 16; alpha <= 255; alpha += 8) pixels.push(grey(alpha, alpha, 4));
    const result = resolve(pixels);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.kind).toBe("premultiplied");
    expect(result.model.ink.r).toBeGreaterThanOrEqual(250);
    expect(inkCoverage(result.model, 128, 128, 128)).toBe(1);
  });

  it("reads anti-aliased black line art as coverage against white paper", () => {
    // A solid body with a thin tail of edge greys — what a low-resolution logo
    // looks like once the background is keyed out.
    const pixels: Pixel[] = [grey(0, 255, 400)];
    for (let value = 8; value <= 232; value += 8) pixels.push(grey(value, 255, 2));
    const result = resolve(pixels);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.kind).toBe("blend");
    expect(result.model.ink.r).toBeLessThan(20);
    expect(result.model.paper).toEqual({ r: 255, g: 255, b: 255 });
    // A mid-grey edge pixel is half of the new colour, not a second colour.
    expect(inkCoverage(result.model, 128, 128, 128)).toBeCloseTo(0.5, 1);
    expect(inkCoverage(result.model, 0, 0, 0)).toBe(1);
  });

  it("reads anti-aliased white line art as coverage against black paper", () => {
    const pixels: Pixel[] = [grey(255, 255, 400)];
    for (let value = 8; value <= 232; value += 8) pixels.push(grey(value, 255, 2));
    const result = resolve(pixels);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.kind).toBe("blend");
    expect(result.model.ink.r).toBeGreaterThan(235);
    expect(result.model.paper).toEqual({ r: 0, g: 0, b: 0 });
    expect(inkCoverage(result.model, 128, 128, 128)).toBeCloseTo(0.5, 1);
    expect(inkCoverage(result.model, 255, 255, 255)).toBe(1);
  });

  it("keeps shading as lighter amounts of the one ink", () => {
    // Tonal artwork: a solid body plus a large mid-tone region. Both are the
    // same ink at different strengths, and the mid-tones must survive as
    // roughly half coverage rather than being flattened or dropped.
    const result = resolve([grey(0, 255, 300), grey(96, 255, 200), grey(160, 255, 100)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.kind).toBe("blend");
    expect(inkCoverage(result.model, 96, 96, 96)).toBeCloseTo(0.62, 1);
    expect(inkCoverage(result.model, 160, 160, 160)).toBeCloseTo(0.37, 1);
  });

  it("carries a colored ink with soft edges", () => {
    // A red mark anti-aliased against white: the edges are pale reds, not a
    // second ink.
    const pixels: Pixel[] = [{ r: 200, g: 30, b: 40, a: 255, n: 300 }];
    for (let t = 1; t <= 9; t++) {
      pixels.push({
        r: Math.round(255 + (200 - 255) * (t / 10)),
        g: Math.round(255 + (30 - 255) * (t / 10)),
        b: Math.round(255 + (40 - 255) * (t / 10)),
        a: 255,
        n: 3,
      });
    }
    const result = resolve(pixels);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.ink.r).toBeGreaterThan(180);
    expect(result.model.ink.g).toBeLessThan(70);
    expect(result.model.paper).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("lets a trace of contamination through, and reports how much", () => {
    // One stray pixel in a thousand is dust, not a design decision. It gets
    // swept into the new colour, and the dialog is told the share so it can say
    // so.
    const result = resolve([grey(0, 255, 1000), { r: 255, g: 0, b: 0, a: 255, n: 3 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.dominance).toBeGreaterThan(0.99);
    expect(result.model.dominance).toBeLessThan(1);
  });

  it("refuses artwork that is genuinely two colors, with the measured share", () => {
    const result = resolve([grey(0, 255, 700), { r: 220, g: 20, b: 20, a: 255, n: 300 }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("multiple-visible-colors");
    expect(result.dominance).toBeGreaterThan(0.6);
    expect(result.dominance).toBeLessThan(0.8);
  });

  it("refuses black-and-white two-tone artwork instead of erasing the white", () => {
    // Both ends of the same segment are solid ink here. Read as coverage, the
    // white half would come out at zero coverage and vanish.
    const result = resolve([grey(0, 255, 500), grey(255, 255, 400)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("multiple-visible-colors");
  });

  it("refuses a continuous-tone photograph", () => {
    const pixels: Pixel[] = [];
    for (let value = 0; value <= 255; value += 4) pixels.push(grey(value, 255, 10));
    expect(resolve(pixels)).toMatchObject({ ok: false, reason: "multiple-visible-colors" });
  });

  it("does not count soft edges twice", () => {
    // The trap the whole design turns on: the same pixel is full-strength ink
    // at half opacity in one file and half coverage in another, and only the
    // population it sits in says which.
    const premultiplied = resolve([grey(255, 255, 200), grey(128, 128, 100), grey(64, 64, 50)]);
    const opaque = resolve([grey(255, 255, 200), grey(128, 255, 100), grey(64, 255, 50)]);
    expect(premultiplied.ok && premultiplied.model.kind).toBe("premultiplied");
    expect(opaque.ok && opaque.model.kind).toBe("blend");
    if (!premultiplied.ok || !opaque.ok) return;
    expect(inkCoverage(premultiplied.model, 128, 128, 128)).toBe(1);
    expect(inkCoverage(opaque.model, 128, 128, 128)).toBeCloseTo(0.5, 1);
  });
});

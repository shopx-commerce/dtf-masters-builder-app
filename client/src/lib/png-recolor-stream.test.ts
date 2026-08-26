import { decode } from "fast-png";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { canStreamRecolor, streamAnalyzePng, streamRecolorPng } from "./png-recolor-stream";

/**
 * The streaming recolour rewrites the customer's print file, so these tests are
 * about output bytes, not about bookkeeping: every case decodes the result and
 * compares it pixel by pixel against what the recolour promised — alpha copied
 * exactly, one flat ink, nothing else touched.
 *
 * The fixtures are hand-built rather than produced by an encoder so that the
 * awkward parts of the format are actually exercised: all five row filters, the
 * three colour types this path reads, IDAT split across chunks, and a pHYs
 * chunk that has to survive the trip.
 */

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Forward row filter, so a fixture can force a specific predictor. */
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array, bpp: number): Uint8Array {
  const out = new Uint8Array(cur.length);
  for (let i = 0; i < cur.length; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    switch (type) {
      case 0: out[i] = cur[i]; break;
      case 1: out[i] = (cur[i] - a) & 0xff; break;
      case 2: out[i] = (cur[i] - b) & 0xff; break;
      case 3: out[i] = (cur[i] - ((a + b) >> 1)) & 0xff; break;
      default: out[i] = (cur[i] - paeth(a, b, c)) & 0xff; break;
    }
  }
  return out;
}

interface FixtureOptions {
  width: number;
  height: number;
  colorType: number;
  /** Unfiltered scanline samples, row-major, no filter bytes. */
  samples: Uint8Array;
  /** Filter applied to each row; defaults to cycling through all five. */
  filterFor?: (y: number) => number;
  palette?: Uint8Array;
  transparency?: Uint8Array;
  physical?: Uint8Array;
  /** Split the compressed stream across this many IDAT chunks. */
  idatChunks?: number;
  interlace?: boolean;
  /** Damage the compressed stream after the scanlines are in it. */
  mangleCompressed?: (bytes: Uint8Array) => Uint8Array;
  /** Append bytes to the uncompressed payload, past the declared last row. */
  extraRawBytes?: number;
  /** Leave off the IEND chunk. */
  omitEnd?: boolean;
  /** Override the declared dimensions without changing the pixel data. */
  declaredWidth?: number;
  declaredHeight?: number;
}

function bytesPerPixel(colorType: number): number {
  return colorType === 6 ? 4 : colorType === 4 ? 2 : 1;
}

function buildPng(options: FixtureOptions): Blob {
  const { width, height, colorType, samples } = options;
  const bpp = bytesPerPixel(colorType);
  const rowBytes = width * bpp;
  const filterFor = options.filterFor ?? ((y: number) => y % 5);

  const raw = new Uint8Array((rowBytes + 1) * height + (options.extraRawBytes ?? 0));
  let previous = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const current = samples.subarray(y * rowBytes, (y + 1) * rowBytes);
    const type = filterFor(y);
    raw[y * (rowBytes + 1)] = type;
    raw.set(filterRow(type, current, previous, bpp), y * (rowBytes + 1) + 1);
    previous = current.slice();
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, options.declaredWidth ?? width);
  view.setUint32(4, options.declaredHeight ?? height);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[12] = options.interlace ? 1 : 0;

  const parts: Uint8Array[] = [PNG_SIGNATURE, chunk("IHDR", ihdr)];
  if (options.palette) parts.push(chunk("PLTE", options.palette));
  if (options.transparency) parts.push(chunk("tRNS", options.transparency));
  if (options.physical) parts.push(chunk("pHYs", options.physical));

  let compressed = new Uint8Array(deflateSync(raw));
  if (options.mangleCompressed) compressed = options.mangleCompressed(compressed);
  const pieces = Math.max(1, options.idatChunks ?? 1);
  const size = Math.ceil(compressed.length / pieces);
  for (let offset = 0; offset < compressed.length; offset += size) {
    parts.push(chunk("IDAT", compressed.subarray(offset, Math.min(compressed.length, offset + size))));
  }
  if (!options.omitEnd) parts.push(chunk("IEND", new Uint8Array(0)));
  return new Blob(parts as BlobPart[], { type: "image/png" });
}

/** A 300 DPI pHYs payload: 11811 pixels per metre, both axes. */
function physicalChunk(): Uint8Array {
  const body = new Uint8Array(9);
  const view = new DataView(body.buffer);
  view.setUint32(0, 11811);
  view.setUint32(4, 11811);
  body[8] = 1; // unit: metre
  return body;
}

/** Single-ink RGBA artwork with a soft edge, so alpha varies across pixels. */
function inkSamples(width: number, height: number, ink: [number, number, number]): Uint8Array {
  const samples = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const alpha = (x + y) % 5 === 0 ? 0 : ((x * 37 + y * 11) % 255) + 1;
      samples[at] = alpha === 0 ? 9 : ink[0];
      samples[at + 1] = alpha === 0 ? 8 : ink[1];
      samples[at + 2] = alpha === 0 ? 7 : ink[2];
      samples[at + 3] = alpha;
    }
  }
  return samples;
}

async function decodeBlob(blob: Blob) {
  return decode(new Uint8Array(await blob.arrayBuffer()));
}

const TARGET = { r: 0xff, g: 0x33, b: 0x00 };

describe("streaming PNG recolor", () => {
  it("is available in this environment", () => {
    expect(canStreamRecolor()).toBe(true);
  });

  it("repaints every visible pixel and copies alpha byte for byte", async () => {
    const width = 37, height = 23;
    const samples = inkSamples(width, height, [0x12, 0x34, 0x56]);
    const png = buildPng({ width, height, colorType: 6, samples });

    const result = await streamRecolorPng(png, TARGET);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.sourceColor).toEqual({ r: 0x12, g: 0x34, b: 0x56 });
    expect([result.width, result.height]).toEqual([width, height]);

    const decoded = await decodeBlob(result.blob);
    expect([decoded.width, decoded.height]).toEqual([width, height]);
    const pixels = decoded.data as Uint8Array;
    for (let i = 0; i < width * height; i++) {
      const at = i * 4;
      expect(pixels[at + 3]).toBe(samples[at + 3]);
      if (samples[at + 3] === 0) {
        // Untouched: an invisible pixel's stored colour is the artwork's own.
        expect([pixels[at], pixels[at + 1], pixels[at + 2]]).toEqual([9, 8, 7]);
      } else {
        expect([pixels[at], pixels[at + 1], pixels[at + 2]]).toEqual([TARGET.r, TARGET.g, TARGET.b]);
      }
    }
  });

  it("reverses every row filter", async () => {
    // Each of the five predictors reads different neighbours, so a fixture that
    // used only one would leave four ways to corrupt a file untested.
    const width = 16, height = 20;
    const samples = inkSamples(width, height, [200, 100, 50]);
    for (let type = 0; type < 5; type++) {
      const png = buildPng({ width, height, colorType: 6, samples, filterFor: () => type });
      const result = await streamRecolorPng(png, TARGET);
      expect(result?.ok, `filter ${type}`).toBe(true);
      if (!result?.ok) continue;
      expect(result.sourceColor, `filter ${type}`).toEqual({ r: 200, g: 100, b: 50 });
      const pixels = (await decodeBlob(result.blob)).data as Uint8Array;
      for (let i = 0; i < width * height; i++) {
        expect(pixels[i * 4 + 3], `filter ${type} pixel ${i}`).toBe(samples[i * 4 + 3]);
      }
    }
  });

  it("reads a stream split across many IDAT chunks", async () => {
    const width = 24, height = 24;
    const samples = inkSamples(width, height, [0, 0, 0]);
    const png = buildPng({ width, height, colorType: 6, samples, idatChunks: 9 });
    const result = await streamRecolorPng(png, TARGET);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect((await decodeBlob(result.blob)).width).toBe(width);
  });

  it("carries the source's print resolution into the recolored file", async () => {
    const png = buildPng({
      width: 8,
      height: 8,
      colorType: 6,
      samples: inkSamples(8, 8, [10, 20, 30]),
      physical: physicalChunk(),
    });
    const result = await streamRecolorPng(png, TARGET);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    // A recoloured file that forgot its DPI would print at the wrong size.
    const decoded = await decodeBlob(result.blob);
    expect(decoded.resolution).toEqual({ x: 11811, y: 11811, unit: 1 });
  });

  it("refuses artwork with a second visible ink", async () => {
    const width = 12, height = 12;
    const samples = inkSamples(width, height, [0, 0, 0]);
    // One stray opaque pixel of another colour is enough to make the recolour
    // ambiguous, which is the whole premise of the feature.
    const stray = (7 * width + 5) * 4;
    samples[stray] = 255; samples[stray + 1] = 0; samples[stray + 2] = 0; samples[stray + 3] = 255;
    const png = buildPng({ width, height, colorType: 6, samples });

    await expect(streamAnalyzePng(png)).resolves.toMatchObject({
      eligible: false,
      reason: "multiple-visible-colors",
    });
    await expect(streamRecolorPng(png, TARGET)).resolves.toMatchObject({
      ok: false,
      reason: "multiple-visible-colors",
    });
  });

  it("judges only the cropped region", async () => {
    const width = 20, height = 20;
    const samples = inkSamples(width, height, [0x11, 0x22, 0x33]);
    // A second ink outside the crop must not block a recolour of the crop, and
    // the output must be the crop's size — the crop is what gets printed.
    for (let x = 0; x < width; x++) {
      const at = (18 * width + x) * 4;
      samples[at] = 0; samples[at + 1] = 255; samples[at + 2] = 0; samples[at + 3] = 255;
    }
    const png = buildPng({ width, height, colorType: 6, samples });
    const crop = { x: 2, y: 3, width: 9, height: 7 };

    const result = await streamRecolorPng(png, TARGET, crop);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect([result.width, result.height]).toEqual([crop.width, crop.height]);
    expect(result.sourceColor).toEqual({ r: 0x11, g: 0x22, b: 0x33 });

    const decoded = await decodeBlob(result.blob);
    expect([decoded.width, decoded.height]).toEqual([crop.width, crop.height]);
    const pixels = decoded.data as Uint8Array;
    for (let y = 0; y < crop.height; y++) {
      for (let x = 0; x < crop.width; x++) {
        const from = ((y + crop.y) * width + (x + crop.x)) * 4;
        const to = (y * crop.width + x) * 4;
        expect(pixels[to + 3]).toBe(samples[from + 3]);
      }
    }
  });

  it("recolors grey-plus-alpha artwork", async () => {
    const width = 10, height = 10;
    const samples = new Uint8Array(width * height * 2);
    for (let i = 0; i < width * height; i++) {
      samples[i * 2] = 40;
      samples[i * 2 + 1] = i % 3 === 0 ? 0 : 200;
    }
    const png = buildPng({ width, height, colorType: 4, samples });
    const result = await streamRecolorPng(png, TARGET);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.sourceColor).toEqual({ r: 40, g: 40, b: 40 });
    const pixels = (await decodeBlob(result.blob)).data as Uint8Array;
    for (let i = 0; i < width * height; i++) {
      expect(pixels[i * 4 + 3]).toBe(samples[i * 2 + 1]);
      if (samples[i * 2 + 1] !== 0) expect(pixels[i * 4]).toBe(TARGET.r);
    }
  });

  it("recolors indexed artwork through its palette", async () => {
    const width = 9, height = 9;
    const samples = new Uint8Array(width * height);
    for (let i = 0; i < samples.length; i++) samples[i] = i % 2 === 0 ? 1 : 0;
    const png = buildPng({
      width,
      height,
      colorType: 3,
      samples,
      palette: Uint8Array.from([0, 0, 0, 90, 60, 30]),
      transparency: Uint8Array.from([0, 255]),
    });
    const result = await streamRecolorPng(png, TARGET);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.sourceColor).toEqual({ r: 90, g: 60, b: 30 });
    const pixels = (await decodeBlob(result.blob)).data as Uint8Array;
    for (let i = 0; i < samples.length; i++) {
      const visible = samples[i] === 1;
      expect(pixels[i * 4 + 3]).toBe(visible ? 255 : 0);
      if (visible) expect([pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]]).toEqual([TARGET.r, TARGET.g, TARGET.b]);
    }
  });

  it("rejects an indexed source with no transparency", async () => {
    const png = buildPng({
      width: 4,
      height: 4,
      colorType: 3,
      samples: new Uint8Array(16),
      palette: Uint8Array.from([1, 2, 3]),
    });
    await expect(streamAnalyzePng(png)).resolves.toMatchObject({ eligible: false, reason: "no-alpha-channel" });
  });

  it("reports fully transparent artwork rather than inventing an ink", async () => {
    const png = buildPng({ width: 6, height: 6, colorType: 6, samples: new Uint8Array(6 * 6 * 4) });
    await expect(streamAnalyzePng(png)).resolves.toMatchObject({ eligible: false, reason: "no-visible-pixels" });
  });

  it("hands interlaced files back to the whole-image decoder", async () => {
    const png = buildPng({
      width: 8,
      height: 8,
      colorType: 6,
      samples: inkSamples(8, 8, [1, 2, 3]),
      interlace: true,
    });
    // Null is the signal to fall back, not a failure the customer should see.
    await expect(streamAnalyzePng(png)).resolves.toBeNull();
    await expect(streamRecolorPng(png, TARGET)).resolves.toBeNull();
  });

  it("rejects files that are not PNGs, and truncated ones", async () => {
    await expect(streamAnalyzePng(new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])])))
      .resolves.toMatchObject({ eligible: false, reason: "not-png" });
    await expect(streamAnalyzePng(new Blob([]))).resolves.toMatchObject({ eligible: false, reason: "empty-input" });

    const png = buildPng({ width: 12, height: 12, colorType: 6, samples: inkSamples(12, 12, [5, 5, 5]) });
    const truncated = png.slice(0, png.size - 40);
    await expect(streamAnalyzePng(truncated)).resolves.toMatchObject({ eligible: false, reason: "invalid-png" });
  });

  it("rejects a source whose pixel data is complete but whose stream is not", async () => {
    // The dangerous shape: every scanline is present, so a reader that stops at
    // the last row it needs sees a perfectly good image and hands back a new
    // print file built from bytes the codec never got to verify.
    const width = 16, height = 16;
    const samples = inkSamples(width, height, [4, 4, 4]);
    const truncated = buildPng({
      width, height, colorType: 6, samples,
      mangleCompressed: bytes => bytes.slice(0, bytes.length - 4),
    });
    await expect(streamRecolorPng(truncated, TARGET)).resolves.toMatchObject({ ok: false, reason: "invalid-png" });

    const corruptTrailer = buildPng({
      width, height, colorType: 6, samples,
      mangleCompressed: bytes => {
        const copy = bytes.slice();
        copy[copy.length - 1] ^= 0xff;
        return copy;
      },
    });
    await expect(streamRecolorPng(corruptTrailer, TARGET)).resolves.toMatchObject({ ok: false, reason: "invalid-png" });
  });

  it("rejects pixel data that outlasts the declared image", async () => {
    // The header and the payload disagree; nothing valid produces this.
    const width = 8, height = 8;
    const png = buildPng({
      width, height, colorType: 6, samples: inkSamples(width, height, [9, 9, 9]),
      extraRawBytes: width * 4 + 1,
    });
    await expect(streamRecolorPng(png, TARGET)).resolves.toMatchObject({ ok: false, reason: "invalid-png" });
  });

  it("rejects a palette index with no entry behind it", async () => {
    // Reading past the palette used to produce `undefined`, which a typed array
    // stores as black — a malformed file quietly printed in the wrong colour.
    const width = 4, height = 4;
    const samples = new Uint8Array(width * height);
    samples[5] = 7;
    await expect(streamAnalyzePng(buildPng({
      width, height, colorType: 3, samples,
      palette: Uint8Array.from([0, 0, 0, 10, 20, 30]),
      transparency: Uint8Array.from([0, 255]),
    }))).resolves.toMatchObject({ eligible: false, reason: "invalid-png" });
  });

  it("refuses a header whose rows would not fit in memory", async () => {
    // 400,000,000 x 1 satisfies a total-pixel budget and then asks for a 1.6 GB
    // row buffer.
    const png = buildPng({
      width: 4, height: 4, colorType: 6, samples: inkSamples(4, 4, [1, 1, 1]),
      declaredWidth: 400_000_000, declaredHeight: 1,
    });
    await expect(streamAnalyzePng(png)).resolves.toMatchObject({ eligible: false, reason: "image-too-large" });
  });

  it("matches the whole-image decoder pixel for pixel", async () => {
    // The two engines must agree, or which one ran becomes visible in the
    // customer's print file.
    const { recolorPng } = await import("./color-change-core");
    const width = 29, height = 17;
    const samples = inkSamples(width, height, [0x2c, 0x88, 0x14]);
    const png = buildPng({ width, height, colorType: 6, samples });

    const streamed = await streamRecolorPng(png, TARGET);
    const legacy = recolorPng(new Uint8Array(await png.arrayBuffer()), TARGET);
    expect(streamed?.ok).toBe(true);
    expect(legacy.ok).toBe(true);
    if (!streamed?.ok || !legacy.ok) return;
    expect(streamed.sourceColor).toEqual(legacy.sourceColor);

    const fromStream = (await decodeBlob(streamed.blob)).data as Uint8Array;
    const fromLegacy = decode(legacy.png).data as Uint8Array;
    expect(Array.from(fromStream)).toEqual(Array.from(fromLegacy));
  });

  it("reports progress and finishes at one", async () => {
    const width = 32, height = 200;
    const png = buildPng({ width, height, colorType: 6, samples: inkSamples(width, height, [3, 3, 3]) });
    const seen: number[] = [];
    const result = await streamRecolorPng(png, TARGET, undefined, { onProgress: fraction => seen.push(fraction) });
    expect(result?.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen.every((value, index) => index === 0 || value >= seen[index - 1])).toBe(true);
  });

  it("stops when the caller aborts", async () => {
    const width = 32, height = 400;
    const png = buildPng({ width, height, colorType: 6, samples: inkSamples(width, height, [3, 3, 3]) });
    const controller = new AbortController();
    const pending = streamRecolorPng(png, TARGET, undefined, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

/**
 * The parts of PNG assembly shared by the export worker and the parallel
 * coordinator.
 *
 * These live together deliberately. A gangsheet PNG can be rendered by several
 * workers at once, and every one of them has to agree on where the strip
 * boundaries fall and how a chunk is framed. A disagreement about either does
 * not throw — it produces a file that decodes to the wrong image, or does not
 * decode at all.
 */

import { SAFARI_MAX_CANVAS_AREA } from "./image-budget";

/**
 * Keep temporary export canvases bounded for tall sheets. This only changes
 * internal batching; output dimensions, DPI, placement, and pixel quality are
 * unchanged.
 */
const MAX_STRIP_HEIGHT = 4096;

/**
 * Floor on the strip height, so a pathological sheet width cannot reduce this
 * to a handful of rows and spend all its time on per-strip overhead.
 */
const MIN_STRIP_HEIGHT = 256;

/**
 * How tall a strip may be for a sheet of this width.
 *
 * Strips bound the height of the temporary canvas, but nothing bounded its
 * width, which is the full sheet at export DPI. At a fixed 4096 that made the
 * area *worse* the wider the sheet: a 22 inch sheet at 300 DPI is 6600 px
 * across, so the strip was 27 MP against Safari's 16.8 MP ceiling — over the
 * limit for every sheet width sold, and only ever safe below 13.65 inches.
 *
 * Deriving the height from the width holds the area under the cap instead:
 * 2542 rows at 22 inches, 2282 at 24.5, and the full 4096 for anything narrow
 * enough to afford it. Output is unaffected — strips are tiles of the same
 * render, so this changes only how many passes it takes.
 */
export function stripHeightFor(outW: number): number {
  const byArea = Math.floor(SAFARI_MAX_CANVAS_AREA / Math.max(1, outW));
  return Math.max(MIN_STRIP_HEIGHT, Math.min(MAX_STRIP_HEIGHT, byArea));
}

/** The strips a sheet is cut into, in top-to-bottom order. */
export function stripRangesFor(outW: number, outH: number): Array<{ y: number; height: number }> {
  const stripHeight = stripHeightFor(outW);
  const ranges: Array<{ y: number; height: number }> = [];
  for (let y = 0; y < outH; y += stripHeight) {
    ranges.push({ y, height: Math.min(stripHeight, outH - y) });
  }
  return ranges.length > 0 ? ranges : [{ y: 0, height: outH }];
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  chunk[4] = type.charCodeAt(0);
  chunk[5] = type.charCodeAt(1);
  chunk[6] = type.charCodeAt(2);
  chunk[7] = type.charCodeAt(3);
  chunk.set(data, 8);
  dv.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/**
 * Signature, IHDR and pHYs for an 8-bit RGBA sheet.
 *
 * pHYs is what tells a RIP the sheet is 300 DPI rather than a very large image,
 * so it is not optional decoration.
 */
export function pngHeaderParts(outW: number, outH: number, exportDpi: number): Uint8Array[] {
  const ihdrData = new Uint8Array(13);
  const ihdrDv = new DataView(ihdrData.buffer);
  ihdrDv.setUint32(0, outW);
  ihdrDv.setUint32(4, outH);
  ihdrData[8] = 8;   // bit depth
  ihdrData[9] = 6;   // colour type: truecolour with alpha
  ihdrData[10] = 0;  // deflate
  ihdrData[11] = 0;  // adaptive filtering
  ihdrData[12] = 0;  // no interlace

  const ppm = Math.round(exportDpi / 0.0254);
  const physData = new Uint8Array(9);
  const physDv = new DataView(physData.buffer);
  physDv.setUint32(0, ppm);
  physDv.setUint32(4, ppm);
  physData[8] = 1;   // unit: metres

  return [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    makePngChunk("IHDR", ihdrData),
    makePngChunk("pHYs", physData),
  ];
}

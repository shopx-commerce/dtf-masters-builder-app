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

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p >= a ? p - a : a - p;
  const pb = p >= b ? p - b : b - p;
  const pc = p >= c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Distance between scored bytes when choosing a row's filter.
 *
 * Coprime with the 4-byte pixel on purpose, so consecutive samples land on
 * different channels. A multiple of 4 scores red and never looks at alpha,
 * which is where most of the structure in cutout artwork lives: on halftone
 * art a stride of 16 came out 1.2% smaller than scoring everything while 17
 * came out level, but on gradients 16 cost 3% and 17 cost 1%.
 */
const FILTER_SCORE_STRIDE = 17;

/**
 * Pick a PNG row filter (None/Sub/Up/Average/Paeth) and write the filtered row.
 *
 * The five predictors are scored on a sample of the row rather than on every
 * byte, and only the winner is then computed in full. Scoring all five for
 * every byte of a 67 MB strip was two thirds of the export worker's
 * non-compression time; sampling measured 2.6-2.9x faster on sheet-sized strips
 * for 0.1-1% more compressed bytes.
 *
 * Sampling cannot change a single output pixel. The filter type is per-row
 * metadata and the decoder reverses whichever one it finds, so a worse guess
 * costs bytes, never fidelity.
 *
 * Shared rather than copied: the export worker and the recolour stream both
 * emit RGBA rows, and a filter bug reproduced in two places is a corrupt file
 * in whichever one was not fixed.
 */
export function filterRowAdaptive(
  cur: Uint8Array | Uint8ClampedArray,
  prev: Uint8Array,
  bpp: number,
  rowBytes: number,
  out: Uint8Array,
  outOff: number,
) {
  let sNone = 0, sSub = 0, sUp = 0, sAvg = 0, sPaeth = 0;
  for (let i = 0; i < rowBytes; i += FILTER_SCORE_STRIDE) {
    const x = cur[i];
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;

    sNone += x < 128 ? x : 256 - x;

    const vs = (x - a) & 0xff; sSub += vs < 128 ? vs : 256 - vs;
    const vu = (x - b) & 0xff; sUp += vu < 128 ? vu : 256 - vu;
    const vg = (x - ((a + b) >> 1)) & 0xff; sAvg += vg < 128 ? vg : 256 - vg;
    const vp = (x - paethPredictor(a, b, c)) & 0xff; sPaeth += vp < 128 ? vp : 256 - vp;
  }

  let best = 0, bestSum = sNone;
  if (sSub < bestSum) { best = 1; bestSum = sSub; }
  if (sUp < bestSum) { best = 2; bestSum = sUp; }
  if (sAvg < bestSum) { best = 3; bestSum = sAvg; }
  if (sPaeth < bestSum) { best = 4; }

  out[outOff] = best;
  const d = outOff + 1;
  switch (best) {
    case 0:
      out.set(cur, d);
      break;
    case 1:
      for (let i = 0; i < rowBytes; i++) {
        out[d + i] = (cur[i] - (i >= bpp ? cur[i - bpp] : 0)) & 0xff;
      }
      break;
    case 2:
      for (let i = 0; i < rowBytes; i++) {
        out[d + i] = (cur[i] - prev[i]) & 0xff;
      }
      break;
    case 3:
      for (let i = 0; i < rowBytes; i++) {
        out[d + i] = (cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 0xff;
      }
      break;
    default:
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const c = i >= bpp ? prev[i - bpp] : 0;
        out[d + i] = (cur[i] - paethPredictor(a, prev[i], c)) & 0xff;
      }
      break;
  }
}

/**
 * Reverse a PNG row filter in place, given the previous *unfiltered* row.
 *
 * The inverse of `filterRowAdaptive`, and the reason a PNG cannot be decoded
 * from the middle: every predictor but None reads bytes to the left, above, or
 * both, so row N is only recoverable once row N-1 is.
 */
export function unfilterRow(
  filterType: number,
  row: Uint8Array,
  prev: Uint8Array,
  bpp: number,
): boolean {
  const length = row.length;
  switch (filterType) {
    case 0:
      return true;
    case 1:
      for (let i = bpp; i < length; i++) row[i] = (row[i] + row[i - bpp]) & 0xff;
      return true;
    case 2:
      for (let i = 0; i < length; i++) row[i] = (row[i] + prev[i]) & 0xff;
      return true;
    case 3:
      for (let i = 0; i < length; i++) {
        const left = i >= bpp ? row[i - bpp] : 0;
        row[i] = (row[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
      return true;
    case 4:
      for (let i = 0; i < length; i++) {
        const left = i >= bpp ? row[i - bpp] : 0;
        const upLeft = i >= bpp ? prev[i - bpp] : 0;
        row[i] = (row[i] + paethPredictor(left, prev[i], upLeft)) & 0xff;
      }
      return true;
    default:
      return false;
  }
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

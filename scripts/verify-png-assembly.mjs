/**
 * Proof that the export worker's PNG assembly is lossless, and that a sheet
 * rendered as parallel bands is byte-for-byte the sheet rendered serially.
 *
 * Two claims are checked, both about a file a print shop prints:
 *
 *  1. Chunked IDATs folded into a Blob decode to exactly the pixels that went
 *     in, at the right size and DPI. That is legal PNG — a decoder concatenates
 *     IDAT contents — but "legal" is not "identical".
 *  2. Filtering a strip as a band, using the row above it as the "up" reference,
 *     produces the same bytes as filtering it inline in one continuous pass.
 *     This is the whole reason a band renders one extra row: without it the
 *     first row of every band would have to fall back to None/Sub and the file
 *     would differ. A difference here would not throw anywhere — it would just
 *     be a slightly different, still-valid file, so it has to be measured.
 *
 * The functions under test are lifted out of the real sources at run time and
 * compiled, rather than copied into this file. An earlier version of this script
 * kept verbatim copies and they went stale the moment the worker's filter
 * changed, which meant it was proving something about itself.
 *
 *   node scripts/verify-png-assembly.mjs
 */

import sharp from "sharp";
import { compileDeclarations, extract, readSource as read } from "./lib/extract-ts.mjs";

/** Compile the real declarations into a module this script can call. */
async function loadWorkerInternals() {
  const budget = read("client/src/lib/image-budget.ts");
  const stream = read("client/src/lib/png-stream.ts");
  const worker = read("client/src/lib/export-worker.ts");

  const pieces = [
    extract(budget, "IOS_SAFE_CANVAS_DIM", "image-budget.ts"),
    extract(budget, "SAFARI_MAX_CANVAS_AREA", "image-budget.ts"),
    extract(stream, "MAX_STRIP_HEIGHT", "png-stream.ts"),
    extract(stream, "MIN_STRIP_HEIGHT", "png-stream.ts"),
    extract(stream, "stripHeightFor", "png-stream.ts"),
    extract(stream, "stripRangesFor", "png-stream.ts"),
    extract(stream, "CRC32_TABLE", "png-stream.ts"),
    extract(stream, "crc32", "png-stream.ts"),
    extract(stream, "makePngChunk", "png-stream.ts"),
    extract(stream, "pngHeaderParts", "png-stream.ts"),
    extract(worker, "BATCH_ROWS", "export-worker.ts"),
    extract(worker, "IDAT_FOLD_BYTES", "export-worker.ts"),
    extract(worker, "paethPredictor", "export-worker.ts"),
    extract(worker, "FILTER_SCORE_STRIDE", "export-worker.ts"),
    extract(worker, "filterRowAdaptive", "export-worker.ts"),
    extract(worker, "isRowAllZero", "export-worker.ts"),
    extract(worker, "writeEmptyRows", "export-worker.ts"),
    extract(worker, "writeStripRows", "export-worker.ts"),
    extract(worker, "PngSink", "export-worker.ts"),
    extract(worker, "filterBandToBuffer", "export-worker.ts"),
  ];

  return compileDeclarations({
    prelude: "interface FilteredRowSink { write(bytes: Uint8Array): Promise<void>; }",
    pieces,
    exports: [
      "stripRangesFor", "stripHeightFor", "makePngChunk", "pngHeaderParts",
      "filterRowAdaptive", "isRowAllZero", "writeEmptyRows", "writeStripRows",
      "filterBandToBuffer", "PngSink", "BATCH_ROWS", "IDAT_FOLD_BYTES",
      "FILTER_SCORE_STRIDE",
    ],
  });
}

const W = {};

/** Collects everything written to it, so filtered bytes can be compared. */
class CollectingSink {
  constructor() { this.parts = []; }
  async write(bytes) { this.parts.push(Uint8Array.from(bytes)); }
  bytes() {
    let total = 0;
    for (const p of this.parts) total += p.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of this.parts) { out.set(p, pos); pos += p.length; }
    return out;
  }
}

// ── synthetic sheets ─────────────────────────────────────────────────────────

/** Full-colour art with hard edges and fully blank rows scattered through it. */
function artwork(w, h, seed) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    // Exercises the zero-row fast path inside a content strip, and the "up"
    // reference continuity either side of it.
    if (y % 5 === 4) continue;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      px[i] = (x * 7 + y * 13 + seed) & 0xff;
      px[i + 1] = (x * 3 + seed) & 0xff;
      px[i + 2] = (y * 5 + seed) & 0xff;
      px[i + 3] = 255;
    }
  }
  return px;
}

/** Incompressible content, so deflate emits many small output chunks. */
function noise(w, h, seed) {
  const px = new Uint8ClampedArray(w * h * 4);
  let s = seed | 1;
  for (let i = 0; i < px.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    px[i] = s & 0xff;
    px[i + 1] = (s >>> 8) & 0xff;
    px[i + 2] = (s >>> 16) & 0xff;
    px[i + 3] = 255;
  }
  return px;
}

/** Cutout artwork: sparse blobs on transparency, the common gangsheet shape. */
function cutouts(w, h, seed) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = ((x + seed) % 97) < 40 && ((y + seed) % 61) < 25;
      if (!inside) continue;
      const i = (y * w + x) * 4;
      px[i] = (x * 11 + seed) & 0xff;
      px[i + 1] = (y * 17) & 0xff;
      px[i + 2] = 200;
      px[i + 3] = 255;
    }
  }
  return px;
}

/** Vertically concatenate row blocks into one sheet. */
function stack(w, blocks) {
  let total = 0;
  for (const b of blocks) total += b.length;
  const out = new Uint8ClampedArray(total);
  let pos = 0;
  for (const b of blocks) { out.set(b, pos); pos += b.length; }
  return out;
}

// ── the two paths ────────────────────────────────────────────────────────────

/**
 * The serial path: one continuous filter pass, strip by strip, carrying the
 * "up" reference across strip boundaries. Mirrors `buildPngStreaming`.
 */
async function filterSerial(sink, pixels, outW, strips, emptyStrips) {
  const rowBytes = outW * 4;
  const filteredRowLen = 1 + rowBytes;
  const emptyRow = new Uint8Array(filteredRowLen);
  const prevRow = new Uint8Array(rowBytes);
  let sawInk = false;
  for (let i = 0; i < strips.length; i++) {
    const { y, height } = strips[i];
    if (emptyStrips.has(i)) {
      await W.writeEmptyRows(sink, outW, height, emptyRow, filteredRowLen);
      prevRow.fill(0);
      continue;
    }
    const slice = pixels.subarray(y * rowBytes, (y + height) * rowBytes);
    if (await W.writeStripRows(sink, slice, height, filteredRowLen, rowBytes, 4, prevRow)) {
      sawInk = true;
    }
  }
  return sawInk;
}

/**
 * The band path: each strip filtered independently, given the one row above it
 * that the band renderer draws and discards.
 */
function filterBands(pixels, outW, strips, emptyStrips, dropContextRow = false) {
  const rowBytes = outW * 4;
  const out = [];
  let sawInk = false;
  for (let i = 0; i < strips.length; i++) {
    const { y, height } = strips[i];
    if (emptyStrips.has(i)) {
      out.push(new Uint8Array(height * (1 + rowBytes)));
      continue;
    }
    const contextRow = y > 0 && !dropContextRow ? 1 : 0;
    const renderY = y - contextRow;
    const renderH = height + contextRow;
    const rendered = pixels.subarray(renderY * rowBytes, (renderY + renderH) * rowBytes);
    const band = W.filterBandToBuffer(rendered, contextRow, height, rowBytes, 4);
    if (band.sawInk) sawInk = true;
    out.push(band.filtered);
  }
  let total = 0;
  for (const p of out) total += p.length;
  const joined = new Uint8Array(total);
  let pos = 0;
  for (const p of out) { joined.set(p, pos); pos += p.length; }
  return { filtered: joined, sawInk };
}

/** Compress an already-filtered row stream through the real PngSink. */
async function assemble(filtered, outW, outH, dpi) {
  const sink = new W.PngSink(outW, outH, dpi);
  // Fed in pieces, because that is how both real paths feed it.
  const step = 1 << 16;
  for (let off = 0; off < filtered.length; off += step) {
    await sink.write(filtered.subarray(off, Math.min(off + step, filtered.length)));
  }
  return sink.finish();
}

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

// ── cases ────────────────────────────────────────────────────────────────────

async function runCase(label, { outW, blocks, emptyStripIndices = [], dpi = 300, stripHeight }) {
  const pixels = stack(outW, blocks);
  const rowBytes = outW * 4;
  const outH = pixels.length / rowBytes;

  // Fixed strip height so a small test sheet still crosses several boundaries;
  // the real geometry comes from stripRangesFor and is checked separately.
  const strips = [];
  for (let y = 0; y < outH; y += stripHeight) {
    strips.push({ y, height: Math.min(stripHeight, outH - y) });
  }
  const emptyStrips = new Set(emptyStripIndices);

  const serialSink = new CollectingSink();
  const serialSawInk = await filterSerial(serialSink, pixels, outW, strips, emptyStrips);
  const serialFiltered = serialSink.bytes();
  const banded = filterBands(pixels, outW, strips, emptyStrips);

  const problems = [];

  // The blank-sheet guard refuses to upload a print file that came out empty.
  // The parallel path aggregates this across bands, so it has to reach the same
  // verdict as one continuous pass or a blank sheet ships.
  if (banded.sawInk !== serialSawInk) {
    problems.push(`blank guard disagrees: serial saw ink ${serialSawInk}, bands ${banded.sawInk}`);
  }

  const diff = firstDifference(serialFiltered, banded.filtered);
  if (diff !== -1) {
    const row = Math.floor(diff / (1 + rowBytes));
    problems.push(
      `filtered bytes diverge at ${diff} (row ${row}): serial ${serialFiltered[diff]}, ` +
        `band ${banded.filtered[diff]}`,
    );
  }

  const serialBlob = await assemble(serialFiltered, outW, outH, dpi);
  const bandBlob = await assemble(banded.filtered, outW, outH, dpi);
  const serialBytes = Buffer.from(await serialBlob.arrayBuffer());
  const bandBytes = Buffer.from(await bandBlob.arrayBuffer());
  if (!serialBytes.equals(bandBytes)) {
    problems.push(`assembled files differ (${serialBytes.length} vs ${bandBytes.length} bytes)`);
  }

  const image = sharp(serialBytes);
  const meta = await image.metadata();
  const decoded = await image.ensureAlpha().raw().toBuffer();
  if (meta.width !== outW || meta.height !== outH) {
    problems.push(`size ${meta.width}x${meta.height}, expected ${outW}x${outH}`);
  }
  const expectedPpm = Math.round(dpi / 0.0254);
  const gotPpm = Math.round((meta.density ?? 0) / 0.0254);
  if (Math.abs(gotPpm - expectedPpm) > 1) {
    problems.push(`density ${meta.density} dpi (pHYs ${gotPpm} vs ${expectedPpm} ppm)`);
  }

  // Empty strips are transparent in the file but carry pixels in `blocks`;
  // blank them in the reference so the comparison is against what was encoded.
  const expected = Uint8ClampedArray.from(pixels);
  for (const i of emptyStripIndices) {
    const { y, height } = strips[i];
    expected.fill(0, y * rowBytes, (y + height) * rowBytes);
  }
  if (decoded.length !== expected.length) {
    problems.push(`pixel length ${decoded.length}, expected ${expected.length}`);
  } else {
    const px = firstDifference(decoded, expected);
    if (px !== -1) {
      const p = Math.floor(px / 4);
      problems.push(
        `pixel mismatch at byte ${px} (pixel ${p % outW},${Math.floor(p / outW)}): ` +
          `got ${decoded[px]}, expected ${expected[px]}`,
      );
    }
  }

  const ok = problems.length === 0;
  const detail =
    `${outW}x${outH}, ${strips.length} strip(s), ${serialBytes.length} bytes` +
    `, ink ${banded.sawInk ? "yes" : "no"}`;
  console.log(`${ok ? "pass" : "FAIL"}  ${label.padEnd(36)} ${detail}`);
  for (const p of problems) console.error(`        ${p}`);
  return ok;
}

/**
 * The comparison has to be capable of failing.
 *
 * Every case above passes whether or not the context row is doing anything, if
 * the two paths are secretly the same code. Filtering the same sheet with the
 * context row withheld must therefore produce different bytes — if it does not,
 * these tests prove nothing.
 */
async function checkNegativeControl() {
  const outW = 320;
  // Structured art at a strip height that puts the boundaries on inked rows.
  // Noise is useless here: every predictor scores about the same on random
  // bytes, so None wins each row whatever sits above it, and dropping the
  // context row changes nothing.
  const pixels = artwork(outW, 287, 11);
  const outH = pixels.length / (outW * 4);
  const strips = [];
  for (let y = 0; y < outH; y += 128) strips.push({ y, height: Math.min(128, outH - y) });

  const serialSink = new CollectingSink();
  await filterSerial(serialSink, pixels, outW, strips, new Set());
  const serial = serialSink.bytes();
  const withoutContext = filterBands(pixels, outW, strips, new Set(), true).filtered;

  const diff = firstDifference(serial, withoutContext);
  const ok = diff !== -1;
  console.log(
    `${ok ? "pass" : "FAIL"}  ${"negative control".padEnd(36)} ` +
      (ok ? `dropping the context row diverges at byte ${diff}` : "no divergence — test is vacuous"),
  );
  return ok;
}

/** The geometry both halves must agree on, checked on real sheet sizes. */
function checkGeometry() {
  const cases = [
    { inches: 22, height: 120 },
    { inches: 24.5, height: 60 },
    { inches: 11, height: 240 },
  ];
  let ok = true;
  for (const { inches, height } of cases) {
    const outW = Math.round(inches * 300);
    const outH = Math.round(height * 300);
    const strips = W.stripRangesFor(outW, outH);
    const covered = strips.reduce((sum, s) => sum + s.height, 0);
    const contiguous = strips.every((s, i) => (i === 0 ? s.y === 0 : s.y === strips[i - 1].y + strips[i - 1].height));
    const area = outW * strips[0].height;
    const good = covered === outH && contiguous && area <= 16_777_216;
    if (!good) ok = false;
    console.log(
      `${good ? "pass" : "FAIL"}  ${`geometry ${inches}x${height}in`.padEnd(36)} ` +
        `${strips.length} strips of ${strips[0].height} rows, ${(area / 1e6).toFixed(1)} MP each`,
    );
  }
  return ok;
}

async function main() {
  if (typeof CompressionStream !== "function") {
    console.error("This Node build has no CompressionStream; cannot mirror the worker.");
    process.exit(2);
  }

  Object.assign(W, await loadWorkerInternals());
  console.log(`filter score stride: ${W.FILTER_SCORE_STRIDE}, batch rows: ${W.BATCH_ROWS}\n`);

  const results = [];
  results.push(checkGeometry());
  results.push(await checkNegativeControl());
  console.log("");

  // 128 rather than a round 100: `artwork` blanks every fifth row, and a strip
  // height divisible by 5 lands every boundary on a blank row, which is exactly
  // the case where the context row makes no difference.
  results.push(await runCase("full-colour art across strips", {
    outW: 320,
    stripHeight: 128,
    blocks: [artwork(320, 150, 11), artwork(320, 137, 77)],
  }));

  results.push(await runCase("cutout art, sparse coverage", {
    outW: 256,
    stripHeight: 64,
    blocks: [cutouts(256, 300, 3)],
  }));

  // Strips 3 and 4 fall entirely inside the blank block, so they take the
  // geometric "no designs here" path the serial exporter uses.
  results.push(await runCase("blank gap between designs", {
    outW: 320,
    stripHeight: 64,
    emptyStripIndices: [3, 4],
    blocks: [artwork(320, 150, 11), new Uint8ClampedArray(320 * 200 * 4), artwork(320, 90, 77)],
  }));

  results.push(await runCase("noise, many deflate chunks", {
    outW: 512,
    stripHeight: 128,
    blocks: [noise(512, 400, 1234), artwork(512, 120, 9), noise(512, 260, 99)],
  }));

  results.push(await runCase("strip straddles batch boundary", {
    outW: 200,
    stripHeight: 1024,
    blocks: [artwork(200, 1024, 3), artwork(200, 7, 4)],
  }));

  results.push(await runCase("band boundary lands on blank row", {
    // Strip height 5 puts every boundary on the `y % 5 === 4` transparent row,
    // so every band's context row is fully zero — the case where a wrong "up"
    // reference would be hardest to notice.
    outW: 128,
    stripHeight: 5,
    blocks: [artwork(128, 60, 42)],
  }));

  // Designs that draw nothing: the strips are not geometrically empty, so both
  // paths filter real rows and both must report no ink.
  results.push(await runCase("sheet renders nothing", {
    outW: 128,
    stripHeight: 64,
    blocks: [new Uint8ClampedArray(128 * 200 * 4)],
  }));

  results.push(await runCase("single strip, no context row", {
    outW: 320,
    stripHeight: 4096,
    blocks: [artwork(320, 233, 5)],
  }));

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log(
      "Bands filter to the same bytes as one serial pass, and the assembled PNG " +
        "decodes to the pixels that went in.",
    );
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

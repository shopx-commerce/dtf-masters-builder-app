/**
 * Proof that the export worker's PNG assembly is lossless.
 *
 * The worker used to accumulate the whole compressed stream, concatenate it,
 * re-chunk it into IDATs, and concatenate again — four full-size copies of a file
 * that can be 150 MB. It now wraps each compressed chunk in its own IDAT as it
 * arrives and folds them into a Blob periodically. That is legal PNG (a decoder
 * concatenates IDAT contents), but "legal" is not "identical", and this is the
 * file a print shop prints, so it gets checked rather than reasoned about.
 *
 * The pure functions below are copied verbatim from
 * `client/src/lib/export-worker.ts`. Anything reimplemented here would prove
 * something about this file rather than about the worker — so if the worker's
 * filter or chunking changes, re-copy them rather than adapting them.
 *
 *   node scripts/verify-png-assembly.mjs
 */

import sharp from "sharp";

// ── verbatim from export-worker.ts ────────────────────────────────────────────

const BATCH_ROWS = 1024;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makePngChunk(type, data) {
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

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = p >= a ? p - a : a - p;
  const pb = p >= b ? p - b : b - p;
  const pc = p >= c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function filterRowAdaptive(cur, prev, bpp, rowBytes, scratch, out, outOff) {
  const { sub, up, avg, paeth } = scratch;
  let sNone = 0, sSub = 0, sUp = 0, sAvg = 0, sPaeth = 0;
  for (let i = 0; i < rowBytes; i++) {
    const x = cur[i];
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;

    sNone += x < 128 ? x : 256 - x;

    const vs = (x - a) & 0xff; sub[i] = vs; sSub += vs < 128 ? vs : 256 - vs;
    const vu = (x - b) & 0xff; up[i] = vu; sUp += vu < 128 ? vu : 256 - vu;
    const vg = (x - ((a + b) >> 1)) & 0xff; avg[i] = vg; sAvg += vg < 128 ? vg : 256 - vg;
    const vp = (x - paethPredictor(a, b, c)) & 0xff; paeth[i] = vp; sPaeth += vp < 128 ? vp : 256 - vp;
  }

  let best = 0, bestSum = sNone;
  if (sSub < bestSum) { best = 1; bestSum = sSub; }
  if (sUp < bestSum) { best = 2; bestSum = sUp; }
  if (sAvg < bestSum) { best = 3; bestSum = sAvg; }
  if (sPaeth < bestSum) { best = 4; }

  out[outOff] = best;
  const d = outOff + 1;
  switch (best) {
    case 0: out.set(cur, d); break;
    case 1: out.set(sub, d); break;
    case 2: out.set(up, d); break;
    case 3: out.set(avg, d); break;
    default: out.set(paeth, d); break;
  }
}

async function writeEmptyRows(writer, _outW, rowCount, _emptyRow, filteredRowLen) {
  for (let startRow = 0; startRow < rowCount; startRow += BATCH_ROWS) {
    const batchCount = Math.min(BATCH_ROWS, rowCount - startRow);
    const batch = new Uint8Array(batchCount * filteredRowLen);
    await writer.write(batch);
  }
}

function isRowAllZero(pixels, offset, length) {
  const end = offset + length;
  let i = offset;
  for (; i + 8 <= end; i += 8) {
    if (
      pixels[i] | pixels[i + 1] | pixels[i + 2] | pixels[i + 3] |
      pixels[i + 4] | pixels[i + 5] | pixels[i + 6] | pixels[i + 7]
    ) return false;
  }
  for (; i < end; i++) {
    if (pixels[i]) return false;
  }
  return true;
}

async function writeStripRows(writer, pixels, stripH, filteredRowLen, rowBytes, bpp, prevRow, scratch) {
  let sawInk = false;
  for (let startRow = 0; startRow < stripH; startRow += BATCH_ROWS) {
    const endRow = Math.min(startRow + BATCH_ROWS, stripH);
    const batchCount = endRow - startRow;
    const batch = new Uint8Array(batchCount * filteredRowLen);
    for (let r = 0; r < batchCount; r++) {
      const rowIdx = startRow + r;
      const rowStart = rowIdx * rowBytes;
      const cur = pixels.subarray(rowStart, rowStart + rowBytes);
      if (isRowAllZero(pixels, rowStart, rowBytes)) {
        prevRow.fill(0);
      } else {
        sawInk = true;
        filterRowAdaptive(cur, prevRow, bpp, rowBytes, scratch, batch, r * filteredRowLen);
        prevRow.set(cur);
      }
    }
    await writer.write(batch);
  }
  return sawInk;
}

// ── the assembly under test, mirroring buildPngStreaming ──────────────────────

/**
 * `strips` mirrors the worker's per-strip decision: an `empty` strip takes the
 * `writeEmptyRows` path (what a region of the sheet with no designs in it does),
 * a `pixels` strip goes through `writeStripRows`.
 */
async function buildPng({ outW, outH, dpi, strips, foldBytes }) {
  const ppm = Math.round(dpi / 0.0254);
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = new Uint8Array(13);
  const ihdrDv = new DataView(ihdrData.buffer);
  ihdrDv.setUint32(0, outW);
  ihdrDv.setUint32(4, outH);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  const ihdrChunk = makePngChunk("IHDR", ihdrData);

  const physData = new Uint8Array(9);
  const physDv = new DataView(physData.buffer);
  physDv.setUint32(0, ppm);
  physDv.setUint32(4, ppm);
  physData[8] = 1;
  const physChunk = makePngChunk("pHYs", physData);

  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();

  const fileParts = [signature, ihdrChunk, physChunk];
  let pending = [];
  let pendingBytes = 0;
  let idatCount = 0;
  let foldCount = 0;
  const foldPendingIntoBlob = () => {
    if (pending.length === 0) return;
    fileParts.push(new Blob(pending));
    pending = [];
    pendingBytes = 0;
    foldCount++;
  };

  const reader = cs.readable.getReader();
  const readPromise = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      const chunk = makePngChunk("IDAT", value);
      idatCount++;
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes >= foldBytes) foldPendingIntoBlob();
    }
  })();

  const rowBytes = outW * 4;
  const filteredRowLen = 1 + rowBytes;
  const emptyRow = new Uint8Array(filteredRowLen);
  const bpp = 4;
  const prevRow = new Uint8Array(rowBytes);
  const scratch = {
    sub: new Uint8Array(rowBytes),
    up: new Uint8Array(rowBytes),
    avg: new Uint8Array(rowBytes),
    paeth: new Uint8Array(rowBytes),
  };

  for (const strip of strips) {
    if (strip.kind === "empty") {
      await writeEmptyRows(writer, outW, strip.rows, emptyRow, filteredRowLen);
      prevRow.fill(0);
    } else {
      await writeStripRows(writer, strip.px, strip.rows, filteredRowLen, rowBytes, bpp, prevRow, scratch);
    }
  }

  await writer.close();
  await readPromise;

  pending.push(makePngChunk("IEND", new Uint8Array(0)));
  foldPendingIntoBlob();
  const blob = new Blob(fileParts, { type: "image/png" });
  return { blob, idatCount, foldCount };
}

// ── test cases ───────────────────────────────────────────────────────────────

const empty = (rows) => ({ kind: "empty", rows });
const pixels = (px, w) => ({ kind: "pixels", px, rows: px.length / (w * 4) });

function rgba(w, h) {
  return new Uint8ClampedArray(w * h * 4);
}

/** A strip with content, some fully blank rows inside it, and hard edges. */
function contentStrip(w, h, seed) {
  const px = rgba(w, h);
  for (let y = 0; y < h; y++) {
    // Every 5th row left fully transparent, exercising the zero-row fast path
    // *inside* a content strip and the filter's "up" reference continuity.
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
function noiseStrip(w, h, seed) {
  const px = rgba(w, h);
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

/** The reference image: the concatenation of every strip's pixels. */
function expectedPixels(outW, strips) {
  const parts = strips.map((strip) =>
    strip.kind === "empty" ? new Uint8ClampedArray(strip.rows * outW * 4) : strip.px,
  );
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8ClampedArray(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

async function runCase(label, { outW, strips, dpi, foldBytes }) {
  const outH = strips.reduce((sum, s) => sum + s.rows, 0);

  const { blob, idatCount, foldCount } = await buildPng({ outW, outH, dpi, strips, foldBytes });
  const bytes = Buffer.from(await blob.arrayBuffer());

  const image = sharp(bytes);
  const meta = await image.metadata();
  const decoded = await image.ensureAlpha().raw().toBuffer();

  const expected = expectedPixels(outW, strips);

  const problems = [];
  if (meta.width !== outW || meta.height !== outH) {
    problems.push(`size ${meta.width}x${meta.height}, expected ${outW}x${outH}`);
  }
  const expectedPpm = Math.round(dpi / 0.0254);
  // sharp reports density in DPI, rounded from the pHYs pixels-per-metre.
  const gotPpm = Math.round((meta.density ?? 0) / 0.0254);
  if (Math.abs(gotPpm - expectedPpm) > 1) {
    problems.push(`density ${meta.density} dpi (pHYs ${gotPpm} vs ${expectedPpm} ppm)`);
  }
  if (decoded.length !== expected.length) {
    problems.push(`pixel length ${decoded.length}, expected ${expected.length}`);
  } else {
    let firstDiff = -1;
    for (let i = 0; i < decoded.length; i++) {
      if (decoded[i] !== expected[i]) { firstDiff = i; break; }
    }
    if (firstDiff >= 0) {
      const px = Math.floor(firstDiff / 4);
      problems.push(
        `pixel mismatch at byte ${firstDiff} (pixel ${px % outW},${Math.floor(px / outW)}): ` +
          `got ${decoded[firstDiff]}, expected ${expected[firstDiff]}`,
      );
    }
  }

  const ok = problems.length === 0;
  const detail = `${outW}x${outH}, ${idatCount} IDAT chunk(s), ${foldCount} blob fold(s), ${bytes.length} bytes`;
  console.log(`${ok ? "pass" : "FAIL"}  ${label.padEnd(34)} ${detail}`);
  for (const p of problems) console.error(`        ${p}`);
  return ok;
}

async function main() {
  if (typeof CompressionStream !== "function") {
    console.error("This Node build has no CompressionStream; cannot mirror the worker.");
    process.exit(2);
  }

  const results = [];
  const W = 320;
  const BIG_FOLD = 16 * 1024 * 1024;

  // Content, empty, content. The empty strip is where filter continuity across a
  // strip boundary can break, since it resets the "up" reference.
  results.push(await runCase("content / empty / content", {
    outW: W,
    dpi: 300,
    foldBytes: BIG_FOLD,
    strips: [pixels(contentStrip(W, 150, 11), W), empty(200), pixels(contentStrip(W, 90, 77), W)],
  }));

  results.push(await runCase("single content strip", {
    outW: W,
    dpi: 300,
    foldBytes: BIG_FOLD,
    strips: [pixels(contentStrip(W, 233, 5), W)],
  }));

  results.push(await runCase("entirely empty sheet", {
    outW: W,
    dpi: 150,
    foldBytes: BIG_FOLD,
    strips: [empty(1100)],
  }));

  results.push(await runCase("empty strips at both ends", {
    outW: W,
    dpi: 300,
    foldBytes: BIG_FOLD,
    strips: [empty(64), pixels(contentStrip(W, 40, 21), W), empty(64), pixels(contentStrip(W, 33, 22), W), empty(7)],
  }));

  // The ordering risk: many IDAT chunks and many folds. A tiny threshold plus
  // incompressible noise forces both.
  results.push(await runCase("many IDATs, many folds", {
    outW: 512,
    dpi: 300,
    foldBytes: 4096,
    strips: [
      pixels(noiseStrip(512, 400, 1234), 512),
      pixels(contentStrip(512, 120, 9), 512),
      pixels(noiseStrip(512, 260, 99), 512),
    ],
  }));

  // A height that straddles BATCH_ROWS, plus a ragged final batch.
  results.push(await runCase("straddles batch boundary", {
    outW: 200,
    dpi: 300,
    foldBytes: 8192,
    strips: [pixels(contentStrip(200, 1024, 3), 200), pixels(contentStrip(200, 7, 4), 200)],
  }));

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("PNG assembly is byte-exact: chunked IDATs + blob folding decode to identical pixels.");
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

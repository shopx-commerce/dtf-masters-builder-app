interface DesignExportData {
  widthInches: number;
  heightInches: number;
  nx: number;
  ny: number;
  s: number;
  rotation: number;
  flipX?: boolean;
  flipY?: boolean;
  bitmap: ImageBitmap;
  alphaThresholded?: boolean;
  printFileName?: boolean;
  name?: string;
}

interface ExportInput {
  type: 'export';
  requestId: number;
  designs: DesignExportData[];
  outW: number;
  outH: number;
  exportDpi: number;
}

interface PrerenderedDesign {
  bitmap: ImageBitmap;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

const STRIP_HEIGHT = 8192;
const BATCH_ROWS = 1024;
const MAX_IDAT_BYTES = 2 * 1024 * 1024;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
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

function designDrawSize(d: DesignExportData, exportDpi: number) {
  return {
    drawW: Math.max(1, Math.round(d.widthInches * d.s * exportDpi)),
    drawH: Math.max(1, Math.round(d.heightInches * d.s * exportDpi)),
  };
}

function designAabb(d: DesignExportData, outW: number, outH: number, exportDpi: number) {
  const { drawW, drawH } = designDrawSize(d, exportDpi);
  const centerX = d.nx * outW;
  const centerY = d.ny * outH;
  const rad = (d.rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const aabbW = Math.max(1, Math.ceil(drawW * cos + drawH * sin));
  const aabbH = Math.max(1, Math.ceil(drawW * sin + drawH * cos));
  return {
    drawW,
    drawH,
    centerX,
    centerY,
    aabbW,
    aabbH,
    left: centerX - aabbW / 2,
    right: centerX + aabbW / 2,
    top: centerY - aabbH / 2,
    bottom: centerY + aabbH / 2,
  };
}

async function prerenderDesigns(
  designs: DesignExportData[],
  outW: number,
  outH: number,
  exportDpi: number,
): Promise<PrerenderedDesign[]> {
  return Promise.all(designs.map(async (d) => {
    const bounds = designAabb(d, outW, outH, exportDpi);
    const canvas = new OffscreenCanvas(bounds.aabbW, bounds.aabbH);
    const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: false });
    if (!ctx) throw new Error('Failed to get prerender canvas context');
    ctx.clearRect(0, 0, bounds.aabbW, bounds.aabbH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (d.alphaThresholded) ctx.imageSmoothingEnabled = false;
    ctx.save();
    ctx.translate(bounds.aabbW / 2, bounds.aabbH / 2);
    ctx.rotate((d.rotation * Math.PI) / 180);
    ctx.scale(d.flipX ? -1 : 1, d.flipY ? -1 : 1);
    ctx.drawImage(d.bitmap, -bounds.drawW / 2, -bounds.drawH / 2, bounds.drawW, bounds.drawH);
    if (d.printFileName && d.name) {
      ctx.scale(d.flipX ? -1 : 1, d.flipY ? -1 : 1);
      const marginPx = 0.1 * exportDpi;
      const fontSize = Math.max(8, Math.round(bounds.drawH * 0.045));
      ctx.font = `bold ${fontSize}px sans-serif`;
      const displayName = d.name.replace(/\.[^/.]+$/, '');
      ctx.fillStyle = '#000000';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(displayName, bounds.drawW / 2, bounds.drawH / 2 + marginPx);
      ctx.scale(d.flipX ? -1 : 1, d.flipY ? -1 : 1);
    }
    ctx.restore();
    if (d.alphaThresholded) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    }
    const bitmap = canvas.transferToImageBitmap();
    canvas.width = 0;
    canvas.height = 0;
    try { d.bitmap.close(); } catch {}
    return {
      bitmap,
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom,
      width: bounds.aabbW,
      height: bounds.aabbH,
    };
  }));
}

function stripHasContent(prerendered: PrerenderedDesign[], stripY: number, stripH: number): boolean {
  const stripBottom = stripY + stripH;
  for (const p of prerendered) {
    if (p.bottom >= stripY && p.top <= stripBottom) return true;
  }
  return false;
}

function drawPrerenderedOnStrip(
  ctx: OffscreenCanvasRenderingContext2D,
  prerendered: PrerenderedDesign[],
  stripY: number,
  stripH: number,
) {
  const stripBottom = stripY + stripH;
  for (const p of prerendered) {
    if (p.bottom < stripY || p.top > stripBottom) continue;
    ctx.drawImage(p.bitmap, Math.round(p.left), Math.round(p.top - stripY));
  }
}

type FilterScratch = { sub: Uint8Array; up: Uint8Array; avg: Uint8Array; paeth: Uint8Array };

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p >= a ? p - a : a - p;
  const pb = p >= b ? p - b : b - p;
  const pc = p >= c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Picks the PNG filter (None/Sub/Up/Average/Paeth) that compresses smallest for this row — lossless.
function filterRowAdaptive(
  cur: Uint8ClampedArray,
  prev: Uint8Array,
  bpp: number,
  rowBytes: number,
  scratch: FilterScratch,
  out: Uint8Array,
  outOff: number,
) {
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

async function writeEmptyRows(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  outW: number,
  rowCount: number,
  emptyRow: Uint8Array,
  filteredRowLen: number,
) {
  for (let startRow = 0; startRow < rowCount; startRow += BATCH_ROWS) {
    const batchCount = Math.min(BATCH_ROWS, rowCount - startRow);
    const batch = new Uint8Array(batchCount * filteredRowLen);
    for (let r = 0; r < batchCount; r++) {
      batch.set(emptyRow, r * filteredRowLen);
    }
    await writer.write(batch);
  }
}

async function writeStripRows(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  pixels: Uint8ClampedArray,
  stripH: number,
  filteredRowLen: number,
  rowBytes: number,
  bpp: number,
  prevRow: Uint8Array,
  scratch: FilterScratch,
) {
  for (let startRow = 0; startRow < stripH; startRow += BATCH_ROWS) {
    const endRow = Math.min(startRow + BATCH_ROWS, stripH);
    const batchCount = endRow - startRow;
    const batch = new Uint8Array(batchCount * filteredRowLen);
    for (let r = 0; r < batchCount; r++) {
      const rowIdx = startRow + r;
      const cur = pixels.subarray(rowIdx * rowBytes, (rowIdx + 1) * rowBytes);
      filterRowAdaptive(cur, prevRow, bpp, rowBytes, scratch, batch, r * filteredRowLen);
      prevRow.set(cur); // this row is the "up" reference for the next
    }
    await writer.write(batch);
  }
}

async function buildPngStreaming(input: ExportInput): Promise<Uint8Array> {
  const { designs, outW, outH, exportDpi } = input;
  const ppm = Math.round(exportDpi / 0.0254);
  const prerendered = await prerenderDesigns(designs, outW, outH, exportDpi);

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = new Uint8Array(13);
  const ihdrDv = new DataView(ihdrData.buffer);
  ihdrDv.setUint32(0, outW);
  ihdrDv.setUint32(4, outH);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdrChunk = makePngChunk('IHDR', ihdrData);

  const physData = new Uint8Array(9);
  const physDv = new DataView(physData.buffer);
  physDv.setUint32(0, ppm);
  physDv.setUint32(4, ppm);
  physData[8] = 1;
  const physChunk = makePngChunk('pHYs', physData);

  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();

  const compressedParts: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  const readPromise = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      compressedParts.push(new Uint8Array(value));
    }
  })();

  const rowBytes = outW * 4;
  const filteredRowLen = 1 + rowBytes;
  const emptyRow = new Uint8Array(filteredRowLen);

  // Adaptive-filter state, reused across all rows/strips to avoid per-row allocation.
  const bpp = 4; // RGBA, 8-bit
  const prevRow = new Uint8Array(rowBytes); // "up" reference; starts as zeros (transparent)
  const scratch: FilterScratch = {
    sub: new Uint8Array(rowBytes),
    up: new Uint8Array(rowBytes),
    avg: new Uint8Array(rowBytes),
    paeth: new Uint8Array(rowBytes),
  };

  let stripCanvas: OffscreenCanvas | null = null;
  let stripCtx: OffscreenCanvasRenderingContext2D | null = null;

  for (let stripY = 0; stripY < outH; stripY += STRIP_HEIGHT) {
    const stripH = Math.min(STRIP_HEIGHT, outH - stripY);

    if (!stripHasContent(prerendered, stripY, stripH)) {
      await writeEmptyRows(writer, outW, stripH, emptyRow, filteredRowLen);
      prevRow.fill(0); // the rows just written are fully transparent (zero)
      continue;
    }

    if (!stripCanvas || stripCanvas.width !== outW || stripCanvas.height !== stripH) {
      stripCanvas = new OffscreenCanvas(outW, stripH);
      stripCtx = stripCanvas.getContext('2d', { alpha: true, willReadFrequently: true });
      if (!stripCtx) throw new Error('Failed to get strip canvas context');
    }
    const ctx = stripCtx!;
    ctx.clearRect(0, 0, outW, stripH);
    drawPrerenderedOnStrip(ctx, prerendered, stripY, stripH);

    const imageData = ctx.getImageData(0, 0, outW, stripH);
    await writeStripRows(writer, imageData.data, stripH, filteredRowLen, rowBytes, bpp, prevRow, scratch);
  }

  if (stripCanvas) {
    stripCanvas.width = 0;
    stripCanvas.height = 0;
  }

  await writer.close();
  await readPromise;

  let totalCompressed = 0;
  for (const p of compressedParts) totalCompressed += p.length;
  const compressed = new Uint8Array(totalCompressed);
  let pos = 0;
  for (const p of compressedParts) {
    compressed.set(p, pos);
    pos += p.length;
  }

  const idatChunks: Uint8Array[] = [];
  for (let i = 0; i < compressed.length; i += MAX_IDAT_BYTES) {
    idatChunks.push(makePngChunk('IDAT', compressed.subarray(i, Math.min(i + MAX_IDAT_BYTES, compressed.length))));
  }

  const iendChunk = makePngChunk('IEND', new Uint8Array(0));

  for (const p of prerendered) {
    try { p.bitmap.close(); } catch {}
  }

  const parts = [signature, ihdrChunk, physChunk, ...idatChunks, iendChunk];
  const totalLen = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(totalLen);
  pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

async function runExportLegacy(input: ExportInput): Promise<Uint8Array> {
  const { designs, outW, outH, exportDpi } = input;

  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get OffscreenCanvas context');

  ctx.clearRect(0, 0, outW, outH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  for (const design of designs) {
    const { drawW, drawH } = designDrawSize(design, exportDpi);
    const centerX = design.nx * outW;
    const centerY = design.ny * outH;

    if (design.alphaThresholded) ctx.imageSmoothingEnabled = false;
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate((design.rotation * Math.PI) / 180);
    ctx.scale(design.flipX ? -1 : 1, design.flipY ? -1 : 1);
    ctx.drawImage(design.bitmap, -drawW / 2, -drawH / 2, drawW, drawH);
    if (design.printFileName && design.name) {
      ctx.scale(design.flipX ? -1 : 1, design.flipY ? -1 : 1);
      const marginPx = 0.1 * exportDpi;
      const fontSize = Math.max(8, Math.round(drawH * 0.045));
      ctx.font = `bold ${fontSize}px sans-serif`;
      const displayName = design.name.replace(/\.[^/.]+$/, '');
      ctx.fillStyle = '#000000';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(displayName, drawW / 2, drawH / 2 + marginPx);
      ctx.scale(design.flipX ? -1 : 1, design.flipY ? -1 : 1);
    }
    ctx.restore();
    if (design.alphaThresholded) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    }
  }

  const rawBlob = await canvas.convertToBlob({ type: 'image/png' });
  const rawBuf = new Uint8Array(await rawBlob.arrayBuffer());

  const ppm = Math.round(exportDpi / 0.0254);
  const physData = new Uint8Array(9);
  const physDv = new DataView(physData.buffer);
  physDv.setUint32(0, ppm);
  physDv.setUint32(4, ppm);
  physData[8] = 1;
  const physChunk = makePngChunk('pHYs', physData);

  const parts: Uint8Array[] = [];
  parts.push(rawBuf.slice(0, 8));
  const ihdrDataLen = ((rawBuf[8] << 24) | (rawBuf[9] << 16) | (rawBuf[10] << 8) | rawBuf[11]) >>> 0;
  const ihdrTotal = 12 + ihdrDataLen;
  parts.push(rawBuf.slice(8, 8 + ihdrTotal));
  parts.push(physChunk);
  let offset = 8 + ihdrTotal;
  while (offset + 12 <= rawBuf.length) {
    const dataLen = ((rawBuf[offset] << 24) | (rawBuf[offset + 1] << 16) | (rawBuf[offset + 2] << 8) | rawBuf[offset + 3]) >>> 0;
    const chunkTotal = 12 + dataLen;
    const isPHYs = rawBuf[offset + 4] === 0x70 && rawBuf[offset + 5] === 0x48 &&
                   rawBuf[offset + 6] === 0x59 && rawBuf[offset + 7] === 0x73;
    if (!isPHYs) parts.push(rawBuf.slice(offset, offset + chunkTotal));
    offset += chunkTotal;
  }

  canvas.width = 0;
  canvas.height = 0;
  for (const d of designs) {
    try { d.bitmap.close(); } catch {}
  }

  const totalLen = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(totalLen);
  let writePos = 0;
  for (const part of parts) {
    out.set(part, writePos);
    writePos += part.length;
  }
  return out;
}

const hasStreaming = typeof CompressionStream !== 'undefined';

type R2PartMeta = { partNumber: number; url: string };
type R2UploadMeta = {
  singlePut?: boolean;
  putUrl?: string;
  putHeaders?: Record<string, string>;
  parts?: R2PartMeta[];
  partSize?: number;
  totalParts?: number;
  parallelism?: number;
};

async function uploadBufferToPreparedR2(
  buffer: ArrayBuffer,
  meta: R2UploadMeta,
  requestId: string,
): Promise<Array<{ partNumber: number; etag: string }>> {
  const total = buffer.byteLength;
  if (meta.singlePut && meta.putUrl) {
    const putHeaders = meta.putHeaders || { 'Content-Type': 'image/png' };
    const putRes = await fetch(String(meta.putUrl), { method: 'PUT', body: buffer, headers: putHeaders });
    if (!putRes.ok) throw new Error(`Cloud upload failed: ${putRes.status}`);
    return [];
  }
  const parts = Array.isArray(meta.parts) ? meta.parts : [];
  if (!parts.length) throw new Error('Upload prepare incomplete');
  const bytes = new Uint8Array(buffer);
  const partSize = Number(meta.partSize) || 64 * 1024 * 1024;
  const totalParts = Number(meta.totalParts) || parts.length;
  const parallelism = Math.max(1, Math.min(Number(meta.parallelism) || 16, totalParts));
  const sorted = parts.slice().sort((a, b) => Number(a.partNumber) - Number(b.partNumber));
  let nextIndex = 0;
  const uploadedParts: Array<{ partNumber: number; etag: string }> = [];

  async function uploadPart(part: R2PartMeta) {
    const pn = Number(part.partNumber);
    const start = (pn - 1) * partSize;
    const end = Math.min(start + partSize, total);
    self.postMessage({ type: 'r2-upload-progress', requestId, message: `Uploading part ${pn} of ${totalParts}...` });
    const chunk = bytes.subarray(start, end);
    const res = await fetch(String(part.url), { method: 'PUT', body: chunk });
    if (!res.ok) throw new Error(`Cloud upload part ${pn} failed: ${res.status}`);
    const etag = res.headers.get('etag') || res.headers.get('ETag');
    if (etag) uploadedParts.push({ partNumber: pn, etag });
  }

  async function worker() {
    while (nextIndex < sorted.length) {
      const part = sorted[nextIndex++];
      await uploadPart(part);
    }
  }

  await Promise.all(Array.from({ length: parallelism }, () => worker()));
  return uploadedParts;
}

self.onmessage = async function(e: MessageEvent) {
  if (e.data.type === 'r2-upload') {
    try {
      const buffer = e.data.buffer as ArrayBuffer | undefined;
      if (!buffer || !buffer.byteLength) throw new Error('Empty design image');
      const meta = e.data.meta as R2UploadMeta;
      const requestId = String(e.data.requestId || '');
      const uploadedParts = await uploadBufferToPreparedR2(buffer, meta, requestId);
      self.postMessage({ type: 'r2-upload-done', requestId, uploadedParts });
    } catch (err: any) {
      self.postMessage({
        type: 'error',
        requestId: e.data.requestId,
        error: err?.message || 'R2 upload failed',
      });
    }
    return;
  }
  if (e.data.type === 'export') {
    const designs = e.data.designs as ExportInput['designs'] | undefined;
    try {
      const bytes = hasStreaming
        ? await buildPngStreaming(e.data)
        : await runExportLegacy(e.data);
      const buffer = bytes.buffer as ArrayBuffer;
      (self as unknown as Worker).postMessage(
        { type: 'result', requestId: e.data.requestId, buffer, byteLength: bytes.byteLength },
        [buffer],
      );
    } catch (err: any) {
      if (designs) for (const d of designs) { try { d.bitmap.close(); } catch {} }
      self.postMessage({ type: 'error', requestId: e.data.requestId, error: err?.message || 'Export failed' });
    }
  }
};

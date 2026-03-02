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

const STRIP_HEIGHT = 4096;
const BATCH_ROWS = 512;
const MAX_IDAT_BYTES = 2 * 1024 * 1024;

function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
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

const bitmapOverlapCache = new Map<string, boolean>();

function checkBitmapNameOverlap(bitmap: ImageBitmap, flipX: boolean, flipY: boolean): boolean {
  const key = `${bitmap.width}x${bitmap.height}_${flipX}_${flipY}`;
  const cached = bitmapOverlapCache.get(key);
  if (cached !== undefined) return cached;

  const sw = bitmap.width;
  const sh = bitmap.height;
  const regionW = Math.min(Math.round(sw * 0.4), sw);
  const regionH = Math.min(Math.round(sh * 0.12), sh);
  const rx = flipX ? 0 : sw - regionW;
  const ry = flipY ? 0 : sh - regionH;

  const oc = new OffscreenCanvas(regionW, regionH);
  const octx = oc.getContext('2d');
  if (!octx) { bitmapOverlapCache.set(key, false); return false; }
  octx.drawImage(bitmap, rx, ry, regionW, regionH, 0, 0, regionW, regionH);
  const data = octx.getImageData(0, 0, regionW, regionH).data;

  let opaqueCount = 0;
  const total = regionW * regionH;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 20) opaqueCount++;
  }
  const result = opaqueCount / total > 0.4;
  bitmapOverlapCache.set(key, result);
  return result;
}

function drawDesignsOnCtx(
  ctx: OffscreenCanvasRenderingContext2D,
  drawInfos: Array<{ design: DesignExportData; drawW: number; drawH: number; centerX: number; centerY: number; radius: number; exportDpi: number }>,
  stripY: number,
  stripH: number,
) {
  for (const info of drawInfos) {
    if (info.centerY + info.radius < stripY || info.centerY - info.radius > stripY + stripH) continue;

    const d = info.design;
    if (d.alphaThresholded) ctx.imageSmoothingEnabled = false;
    ctx.save();
    ctx.translate(info.centerX, info.centerY - stripY);
    ctx.rotate((d.rotation * Math.PI) / 180);
    ctx.scale(d.flipX ? -1 : 1, d.flipY ? -1 : 1);
    ctx.drawImage(d.bitmap, -info.drawW / 2, -info.drawH / 2, info.drawW, info.drawH);
    if (d.printFileName && d.name) {
      ctx.scale(d.flipX ? -1 : 1, d.flipY ? -1 : 1);
      const fontSize = Math.max(8, Math.round(info.drawH * 0.045));
      ctx.font = `bold ${fontSize}px sans-serif`;
      const margin = Math.round(fontSize * 0.3);
      const displayName = d.name.replace(/\.[^/.]+$/, '');
      const overlap = checkBitmapNameOverlap(d.bitmap, !!d.flipX, !!d.flipY);
      if (overlap) {
        const gap = fontSize * 0.6;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = Math.max(2, fontSize * 0.25);
        ctx.lineJoin = 'round';
        ctx.strokeText(displayName, 0, info.drawH / 2 + gap);
        ctx.fillStyle = '#000000';
        ctx.fillText(displayName, 0, info.drawH / 2 + gap);
      } else {
        ctx.fillStyle = '#000000';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(displayName, info.drawW / 2 - margin, info.drawH / 2 - margin);
      }
      ctx.scale(d.flipX ? -1 : 1, d.flipY ? -1 : 1);
    }
    ctx.restore();
    if (d.alphaThresholded) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    }
  }
}

async function buildPngStreaming(input: ExportInput): Promise<Blob> {
  const { designs, outW, outH, exportDpi } = input;

  const ppm = Math.round(exportDpi / 0.0254);

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = new Uint8Array(13);
  const ihdrDv = new DataView(ihdrData.buffer);
  ihdrDv.setUint32(0, outW);
  ihdrDv.setUint32(4, outH);
  ihdrData[8] = 8;   // bit depth
  ihdrData[9] = 6;   // color type RGBA
  ihdrData[10] = 0;  // compression
  ihdrData[11] = 0;  // filter
  ihdrData[12] = 0;  // interlace
  const ihdrChunk = makePngChunk('IHDR', ihdrData);

  const physData = new Uint8Array(9);
  const physDv = new DataView(physData.buffer);
  physDv.setUint32(0, ppm);
  physDv.setUint32(4, ppm);
  physData[8] = 1;
  const physChunk = makePngChunk('pHYs', physData);

  const drawInfos = designs.map(d => {
    const drawW = Math.max(1, Math.round(d.widthInches * d.s * exportDpi));
    const drawH = Math.max(1, Math.round(d.heightInches * d.s * exportDpi));
    const centerX = d.nx * outW;
    const centerY = d.ny * outH;
    const radius = Math.sqrt(drawW * drawW + drawH * drawH) / 2;
    return { design: d, drawW, drawH, centerX, centerY, radius, exportDpi };
  });

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

  for (let stripY = 0; stripY < outH; stripY += STRIP_HEIGHT) {
    const stripH = Math.min(STRIP_HEIGHT, outH - stripY);

    const canvas = new OffscreenCanvas(outW, stripH);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get strip canvas context');

    ctx.clearRect(0, 0, outW, stripH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    drawDesignsOnCtx(ctx, drawInfos, stripY, stripH);

    const imageData = ctx.getImageData(0, 0, outW, stripH);
    const pixels = imageData.data;

    for (let startRow = 0; startRow < stripH; startRow += BATCH_ROWS) {
      const endRow = Math.min(startRow + BATCH_ROWS, stripH);
      const batchCount = endRow - startRow;
      const batch = new Uint8Array(batchCount * filteredRowLen);
      for (let r = 0; r < batchCount; r++) {
        const off = r * filteredRowLen;
        batch[off] = 0; // PNG filter type None
        batch.set(
          pixels.subarray((startRow + r) * rowBytes, (startRow + r + 1) * rowBytes),
          off + 1,
        );
      }
      await writer.write(batch);
    }

    canvas.width = 0;
    canvas.height = 0;
  }

  await writer.close();
  await readPromise;

  let totalCompressed = 0;
  for (const p of compressedParts) totalCompressed += p.length;
  const compressed = new Uint8Array(totalCompressed);
  let pos = 0;
  for (const p of compressedParts) { compressed.set(p, pos); pos += p.length; }

  const idatChunks: Uint8Array[] = [];
  for (let i = 0; i < compressed.length; i += MAX_IDAT_BYTES) {
    idatChunks.push(makePngChunk('IDAT', compressed.subarray(i, Math.min(i + MAX_IDAT_BYTES, compressed.length))));
  }

  const iendChunk = makePngChunk('IEND', new Uint8Array(0));

  for (const d of designs) d.bitmap.close();

  return new Blob([signature, ihdrChunk, physChunk, ...idatChunks, iendChunk], { type: 'image/png' });
}

// Legacy single-canvas export for browsers without CompressionStream
async function runExportLegacy(input: ExportInput): Promise<Blob> {
  const { designs, outW, outH, exportDpi } = input;

  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get OffscreenCanvas context');

  ctx.clearRect(0, 0, outW, outH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  for (const design of designs) {
    const drawW = Math.max(1, Math.round(design.widthInches * design.s * exportDpi));
    const drawH = Math.max(1, Math.round(design.heightInches * design.s * exportDpi));
    const centerX = design.nx * outW;
    const centerY = design.ny * outH;

    if (design.alphaThresholded) ctx.imageSmoothingEnabled = false;
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate((design.rotation * Math.PI) / 180);
    ctx.scale(design.flipX ? -1 : 1, design.flipY ? -1 : 1);
    ctx.drawImage(design.bitmap, -drawW / 2, -drawH / 2, drawW, drawH);
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
  for (const d of designs) d.bitmap.close();

  return new Blob(parts, { type: 'image/png' });
}

const hasStreaming = typeof CompressionStream !== 'undefined';

self.onmessage = async function(e: MessageEvent) {
  if (e.data.type === 'export') {
    const designs = e.data.designs as ExportInput['designs'] | undefined;
    try {
      const blob = hasStreaming
        ? await buildPngStreaming(e.data)
        : await runExportLegacy(e.data);
      self.postMessage({ type: 'result', requestId: e.data.requestId, blob });
    } catch (err: any) {
      if (designs) for (const d of designs) { try { d.bitmap.close(); } catch {} }
      self.postMessage({ type: 'error', requestId: e.data.requestId, error: err?.message || 'Export failed' });
    }
  }
};

/**
 * Single-ink PNG recolouring that never holds the image.
 *
 * The straightforward way to recolour a PNG is to decode it, walk the pixels
 * and encode it again — which is what `color-change-core` does, and why it has
 * to refuse anything large. A decoded pixel is four bytes, so a 6600 x 9000
 * print source (22 x 30 inches at 300 DPI, an ordinary DTF design) is 238 MB of
 * RGBA, and the recolour needs a second copy to write into plus whatever the
 * encoder allocates. Three quarters of a gigabyte for one tap is not something
 * a phone survives, hence the ceiling — and hence customers with genuinely
 * ordinary artwork being told their file is too large.
 *
 * A PNG does not have to be held to be rewritten. Its pixels are stored as
 * filtered rows in one zlib stream, and a row only depends on the row above it,
 * so the file can be walked a row at a time: inflate a little, unfilter one
 * row, recolour it, filter it, deflate it, forget it. Peak memory becomes a
 * handful of rows plus whatever the two codecs buffer — a few megabytes for any
 * image, no matter how large — and both codecs are the browser's own, running
 * in a worker.
 *
 * What is *not* traded away for that: the recolour is still exact. Alpha bytes
 * are copied, never recomputed; RGB under transparent pixels is left as the
 * artwork stored it; the source's pHYs chunk is carried across so the file
 * still declares its print resolution; and the single-ink rule is still proven
 * against every visible pixel — the check simply happens as the rows go past
 * rather than in one sweep at the end.
 */

import type { ColorChangeReason, RgbColor, SourceCrop } from "./color-change-core";
import {
  accumulateInkPixel,
  createInkStats,
  greyCoverageTable,
  inkCoverage,
  inkModelFits,
  resolveInkModel,
  type InkModel,
  type InkStats,
} from "./ink-model";
import { filterRowAdaptive, makePngChunk, unfilterRow } from "./png-stream";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Source bytes pulled from the blob per read. */
const READ_WINDOW = 1 << 20;

/**
 * Filtered rows buffered before they are handed to the compressor.
 *
 * One `write` per row would be one promise per row — 9000 of them on a tall
 * design, each a trip through the stream queue. Batching amortises that without
 * holding anything: half a megabyte is a few dozen rows of a wide sheet.
 */
const WRITE_BATCH_BYTES = 512 * 1024;

/** Compressed output held as loose chunks before folding into a Blob part. */
const IDAT_FOLD_BYTES = 8 * 1024 * 1024;

/** Rows between progress reports and abort checks. */
const PROGRESS_ROW_INTERVAL = 64;

/**
 * Sanity ceilings, not memory ceilings.
 *
 * Nothing here scales with the image, so these only exist to stop a corrupt or
 * hostile IHDR from putting the worker in a loop that runs for an hour. 400
 * megapixels is a 66 x 66 inch sheet at 300 DPI — far beyond any DTF roll — and
 * the app itself refuses anything over 150 MP at upload.
 */
export const STREAM_MAX_PIXELS = 400_000_000;
export const STREAM_MAX_SOURCE_BYTES = 1024 * 1024 * 1024;

/**
 * Per-axis ceiling, because the pixel budget alone does not bound a row.
 *
 * Row buffers are the one allocation that scales with the image, so a header
 * claiming 400,000,000 x 1 would satisfy the pixel budget and then ask for
 * multi-gigabyte rows. 200,000 pixels is 55 feet of print at 300 DPI.
 */
export const STREAM_MAX_DIMENSION = 200_000;

export interface StreamOptions {
  signal?: AbortSignal;
  /** Fraction of the rows processed, from 0 to 1. */
  onProgress?: (fraction: number) => void;
}

export type StreamRecolorResult =
  | { ok: true; blob: Blob; sourceColor: RgbColor; width: number; height: number }
  | { ok: false; reason: ColorChangeReason };

export type StreamAnalysis =
  | { eligible: true; sourceColor: RgbColor; model: InkModel; width: number; height: number }
  | {
      eligible: false;
      reason: ColorChangeReason;
      /** Share of the artwork that was one ink, when that is what refused it. */
      dominance?: number;
      width?: number;
      height?: number;
    };

/**
 * Whether this browser can stream at all.
 *
 * Both codecs shipped together in every engine (Chrome 80, Firefox 113, Safari
 * 16.4), so in practice this is only false on a browser old enough that the
 * whole-image path's ceiling is the least of its problems.
 */
export function canStreamRecolor(): boolean {
  return typeof DecompressionStream !== "undefined" && typeof CompressionStream !== "undefined";
}

function abortError(): Error {
  const error = new Error("Color change aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * Sequential reader over a Blob.
 *
 * Sequential is the whole point: the bytes are pulled a window at a time and
 * dropped once consumed, so a 300 MB source is read without ever being a 300 MB
 * allocation. `slice` is used rather than `stream()` because it is the older,
 * more widely implemented of the two and the access pattern here is the same.
 */
class BlobByteReader {
  private buffer = new Uint8Array(0);
  private cursor = 0;
  private offset = 0;

  constructor(private readonly blob: Blob) {}

  private get available(): number {
    return this.buffer.length - this.cursor;
  }

  private async fill(min: number): Promise<boolean> {
    while (this.available < min) {
      if (this.offset >= this.blob.size) return false;
      const end = Math.min(this.blob.size, this.offset + Math.max(READ_WINDOW, min));
      const next = new Uint8Array(await this.blob.slice(this.offset, end).arrayBuffer());
      if (next.length === 0) return false;
      this.offset = end;
      if (this.available === 0) {
        this.buffer = next;
        this.cursor = 0;
      } else {
        const merged = new Uint8Array(this.available + next.length);
        merged.set(this.buffer.subarray(this.cursor));
        merged.set(next, this.available);
        this.buffer = merged;
        this.cursor = 0;
      }
    }
    return true;
  }

  /** Exactly `n` bytes. The view is only valid until the next read. */
  async read(n: number): Promise<Uint8Array | null> {
    if (!(await this.fill(n))) return null;
    const view = this.buffer.subarray(this.cursor, this.cursor + n);
    this.cursor += n;
    return view;
  }

  /**
   * Hand `n` bytes to `sink` in bounded pieces.
   *
   * An encoder is free to put the entire image in one IDAT, so "read the chunk,
   * then process it" is how a streaming reader quietly becomes a whole-file
   * one. Each piece is copied because the sink keeps it past the next read.
   */
  async pipe(n: number, sink: (piece: Uint8Array) => Promise<void>): Promise<boolean> {
    let left = n;
    while (left > 0) {
      if (!(await this.fill(1))) return false;
      const take = Math.min(left, this.available);
      const piece = this.buffer.slice(this.cursor, this.cursor + take);
      this.cursor += take;
      left -= take;
      await sink(piece);
    }
    return true;
  }

  async skip(n: number): Promise<boolean> {
    const buffered = Math.min(n, this.available);
    this.cursor += buffered;
    const remaining = n - buffered;
    if (remaining === 0) return true;
    if (this.offset + remaining > this.blob.size) return false;
    this.offset += remaining;
    return true;
  }
}

/**
 * Assembles the recoloured file as its compressed bytes arrive.
 *
 * Every IDAT chunk that comes out of the compressor is framed and pushed
 * straight into a Blob part, so the finished PNG is a list of blobs the browser
 * can page to disk rather than one buffer in the worker's heap. A PNG may carry
 * any number of IDAT chunks and a decoder concatenates them, so this is the
 * same file either way, about 12 bytes per chunk larger.
 */
class RecoloredPngSink {
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly drained: Promise<void>;
  private readonly parts: BlobPart[];
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;

  constructor(width: number, height: number, physical?: Uint8Array) {
    const compressor = new CompressionStream("deflate");
    const reader = compressor.readable.getReader();
    this.writer = compressor.writable.getWriter();
    this.reader = reader;

    const ihdr = new Uint8Array(13);
    const view = new DataView(ihdr.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // colour type: truecolour with alpha
    ihdr[10] = 0; // deflate
    ihdr[11] = 0; // adaptive filtering
    ihdr[12] = 0; // no interlace

    this.parts = [new Uint8Array(PNG_SIGNATURE), makePngChunk("IHDR", ihdr)];
    // Carried over from the source, re-framed rather than spliced: a recoloured
    // file that forgot its DPI is a design that prints at the wrong size.
    if (physical && physical.length === 9) this.parts.push(makePngChunk("pHYs", physical));

    this.drained = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        const chunk = makePngChunk("IDAT", value);
        this.pending.push(chunk);
        this.pendingBytes += chunk.length;
        if (this.pendingBytes >= IDAT_FOLD_BYTES) this.fold();
      }
    })();
  }

  /** Backpressure for the whole pipeline: rows stop being produced until the
   *  compressor has taken the last batch. */
  write(bytes: Uint8Array): Promise<void> {
    return this.writer.write(bytes);
  }

  private fold(): void {
    if (this.pending.length === 0) return;
    this.parts.push(new Blob(this.pending));
    this.pending = [];
    this.pendingBytes = 0;
  }

  async finish(): Promise<Blob> {
    await this.writer.close();
    await this.drained;
    this.pending.push(makePngChunk("IEND", new Uint8Array(0)));
    this.fold();
    return new Blob(this.parts, { type: "image/png" });
  }

  async abort(reason?: unknown): Promise<void> {
    try { await this.writer.abort(reason); } catch { /* already closed or errored */ }
    try { await this.reader.cancel(); } catch { /* already done */ }
    await this.drained.catch(() => {});
    this.pending = [];
    this.pendingBytes = 0;
    this.parts.length = 0;
  }
}

interface PngMeta {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  interlaced: boolean;
  animated: boolean;
  palette?: Uint8Array;
  transparency?: Uint8Array;
  physical?: Uint8Array;
}

/** Bytes per pixel at depth 8, or 0 for a colour type this path does not read. */
function bytesPerPixel(colorType: number): number {
  if (colorType === 6) return 4; // RGBA
  if (colorType === 4) return 2; // grey + alpha
  if (colorType === 3) return 1; // palette index
  return 0;
}

function cropIsValid(crop: SourceCrop, width: number, height: number): boolean {
  return (
    Number.isInteger(crop.x) && Number.isInteger(crop.y) &&
    Number.isInteger(crop.width) && Number.isInteger(crop.height) &&
    crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0 &&
    crop.x + crop.width <= width && crop.y + crop.height <= height
  );
}

const ROW_OK = 0;
/** A palette index with no entry behind it — the file is malformed. */
const ROW_INVALID = 2;

type RowProcessor = (row: Uint8Array, out: Uint8Array | null) => number;

/** What the walk is for: measuring the artwork, or rewriting it. */
type StreamMode =
  | { kind: "analyze"; stats: InkStats }
  | { kind: "apply"; target: RgbColor; model: InkModel };

/** Palette expanded to a fixed 256 entries, with a validity flag per index. */
interface ExpandedPalette {
  rgb: Uint8Array;
  alpha: Uint8Array;
  /**
   * An index with no palette entry behind it would otherwise read `undefined`
   * and be written as black, turning a malformed file into a silently wrong
   * print rather than a rejected one.
   */
  defined: Uint8Array;
}

function expandPalette(meta: PngMeta): ExpandedPalette {
  const sourcePalette = meta.palette ?? new Uint8Array(0);
  const sourceTransparency = meta.transparency ?? new Uint8Array(0);
  const entries = Math.min(256, Math.floor(sourcePalette.length / 3));
  const rgb = new Uint8Array(256 * 3);
  const alpha = new Uint8Array(256);
  const defined = new Uint8Array(256);
  for (let i = 0; i < entries; i++) {
    rgb[i * 3] = sourcePalette[i * 3];
    rgb[i * 3 + 1] = sourcePalette[i * 3 + 1];
    rgb[i * 3 + 2] = sourcePalette[i * 3 + 2];
    alpha[i] = i < sourceTransparency.length ? sourceTransparency[i] : 255;
    defined[i] = 1;
  }
  return { rgb, alpha, defined };
}

/**
 * Builds the per-row pixel walk for this colour type and this job.
 *
 * One specialised loop per case rather than one loop with switches inside it:
 * this runs once per pixel of a print-resolution image, so a branch here is
 * tens of millions of branches per recolour. The two jobs are genuinely
 * different work — measuring reads and accumulates, rewriting reads and
 * writes — so they get their own loops rather than one loop doing both badly.
 */
function makeRowProcessor(meta: PngMeta, crop: SourceCrop, mode: StreamMode): RowProcessor {
  const x0 = crop.x;
  const x1 = crop.x + crop.width;

  if (mode.kind === "analyze") {
    const stats = mode.stats;
    if (meta.colorType === 6) {
      return row => {
        for (let x = x0; x < x1; x++) {
          const s = x * 4;
          const a = row[s + 3];
          if (a !== 0) accumulateInkPixel(stats, row[s], row[s + 1], row[s + 2], a);
        }
        return ROW_OK;
      };
    }
    if (meta.colorType === 4) {
      return row => {
        for (let x = x0; x < x1; x++) {
          const s = x * 2;
          const a = row[s + 1];
          if (a !== 0) accumulateInkPixel(stats, row[s], row[s], row[s], a);
        }
        return ROW_OK;
      };
    }
    const palette = expandPalette(meta);
    return row => {
      for (let x = x0; x < x1; x++) {
        const index = row[x];
        if (!palette.defined[index]) return ROW_INVALID;
        const a = palette.alpha[index];
        if (a !== 0) {
          const p = index * 3;
          accumulateInkPixel(stats, palette.rgb[p], palette.rgb[p + 1], palette.rgb[p + 2], a);
        }
      }
      return ROW_OK;
    };
  }

  const { target, model } = mode;
  const tr = target.r, tg = target.g, tb = target.b;
  // A point model means every visible pixel is full coverage, so alpha is not
  // recomputed at all — it is copied, and the artwork that already worked comes
  // out byte for byte identical.
  const flat = model.kind !== "blend";
  const cr = model.cr, cg = model.cg, cb = model.cb, c0 = model.c0;

  if (meta.colorType === 6) {
    if (flat) {
      return (row, out) => {
        for (let x = x0, o = 0; x < x1; x++, o += 4) {
          const s = x * 4;
          const a = row[s + 3];
          if (a !== 0) {
            if (out) { out[o] = tr; out[o + 1] = tg; out[o + 2] = tb; out[o + 3] = a; }
          } else if (out) {
            // Invisible pixels keep the RGB the artwork stored under them,
            // which is what makes this a recolour of the ink rather than a
            // rewrite of the file.
            out[o] = row[s]; out[o + 1] = row[s + 1]; out[o + 2] = row[s + 2]; out[o + 3] = 0;
          }
        }
        return ROW_OK;
      };
    }
    return (row, out) => {
      for (let x = x0, o = 0; x < x1; x++, o += 4) {
        const s = x * 4;
        const a = row[s + 3];
        if (a !== 0) {
          let c = cr * row[s] + cg * row[s + 1] + cb * row[s + 2] + c0;
          if (c < 0) c = 0; else if (c > 1) c = 1;
          if (out) { out[o] = tr; out[o + 1] = tg; out[o + 2] = tb; out[o + 3] = Math.round(a * c); }
        } else if (out) {
          out[o] = row[s]; out[o + 1] = row[s + 1]; out[o + 2] = row[s + 2]; out[o + 3] = 0;
        }
      }
      return ROW_OK;
    };
  }

  if (meta.colorType === 4) {
    // Coverage depends only on the grey level here, so all 256 answers are
    // worked out once instead of per pixel.
    const coverage = flat ? null : greyCoverageTable(model);
    return (row, out) => {
      for (let x = x0, o = 0; x < x1; x++, o += 4) {
        const s = x * 2;
        const grey = row[s];
        const a = row[s + 1];
        if (a !== 0) {
          if (out) {
            out[o] = tr; out[o + 1] = tg; out[o + 2] = tb;
            out[o + 3] = coverage ? Math.round(a * coverage[grey]) : a;
          }
        } else if (out) {
          out[o] = grey; out[o + 1] = grey; out[o + 2] = grey; out[o + 3] = 0;
        }
      }
      return ROW_OK;
    };
  }

  // Indexed artwork has at most 256 distinct output pixels, so the whole
  // recolour is decided once and the row loop becomes a table copy.
  const palette = expandPalette(meta);
  const out256 = new Uint8Array(256 * 4);
  for (let index = 0; index < 256; index++) {
    const p = index * 3;
    const r = palette.rgb[p], g = palette.rgb[p + 1], b = palette.rgb[p + 2];
    const a = palette.alpha[index];
    const o = index * 4;
    if (a !== 0) {
      out256[o] = tr; out256[o + 1] = tg; out256[o + 2] = tb;
      out256[o + 3] = flat ? a : Math.round(a * inkCoverage(model, r, g, b));
    } else {
      out256[o] = r; out256[o + 1] = g; out256[o + 2] = b; out256[o + 3] = 0;
    }
  }
  return (row, out) => {
    for (let x = x0, o = 0; x < x1; x++, o += 4) {
      const index = row[x];
      if (!palette.defined[index]) return ROW_INVALID;
      if (out) out.set(out256.subarray(index * 4, index * 4 + 4), o);
    }
    return ROW_OK;
  };
}

type StreamOutcome =
  | {
      ok: true;
      sourceColor: RgbColor;
      /** Present on an analysis pass; the apply pass was given one already. */
      model: InkModel | null;
      width: number;
      height: number;
      blob: Blob | null;
    }
  | { ok: false; reason: ColorChangeReason; dominance?: number; width?: number; height?: number }
  /** This file needs the whole-image decoder — interlaced, or otherwise not a
   *  format that can be walked row by row. */
  | null;

/**
 * Walks the file once: measuring the artwork, or rewriting it against a model
 * that has already been measured.
 *
 * The two cannot be one pass any more. Deciding which ink an image is made of
 * is a question about the whole population of its pixels, and the first row
 * cannot be written until it has been answered — so a recolour reads the source
 * twice, once to decide and once to write, and still never holds more than a
 * few rows of it.
 */
async function runStream(
  blob: Blob,
  mode: StreamMode,
  requestedCrop: SourceCrop | undefined,
  options: StreamOptions | undefined,
): Promise<StreamOutcome> {
  const signal = options?.signal;
  if (signal?.aborted) throw abortError();
  if (blob.size === 0) return { ok: false, reason: "empty-input" };
  if (blob.size > STREAM_MAX_SOURCE_BYTES) return { ok: false, reason: "image-too-large" };

  const reader = new BlobByteReader(blob);
  const signature = await reader.read(8);
  if (!signature || PNG_SIGNATURE.some((value, index) => signature[index] !== value)) {
    return { ok: false, reason: "not-png" };
  }

  let meta: PngMeta | null = null;
  let sink: RecoloredPngSink | null = null;
  let inflateWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let rowsSettled: Promise<StreamOutcome> | null = null;
  /** Set by the row consumer when it needs no more bytes. */
  let consumerDone = false;

  const failWith = async (reason: ColorChangeReason): Promise<StreamOutcome> => {
    consumerDone = true;
    try { await inflateWriter?.abort(reason); } catch { /* already errored */ }
    await rowsSettled?.catch(() => {});
    await sink?.abort(reason);
    return { ok: false, reason, width: meta?.width, height: meta?.height };
  };

  try {
    for (;;) {
      // The consumer stops as soon as it has the last row it needs, which on a
      // cropped design is well before the end of the file. Nothing after that
      // can change the answer, so the walk ends here rather than reading out
      // the remaining chunks.
      if (consumerDone && rowsSettled) break;

      const header = await reader.read(8);
      if (!header) break;
      const length = (
        (header[0] * 0x1000000) + ((header[1] << 16) | (header[2] << 8) | header[3])
      ) >>> 0;
      const type = String.fromCharCode(header[4], header[5], header[6], header[7]);

      if (type === "IHDR") {
        if (length !== 13 || meta) return failWith("invalid-png");
        const ihdr = await reader.read(13);
        if (!ihdr) return failWith("invalid-png");
        const width = ((ihdr[0] * 0x1000000) + ((ihdr[1] << 16) | (ihdr[2] << 8) | ihdr[3])) >>> 0;
        const height = ((ihdr[4] * 0x1000000) + ((ihdr[5] << 16) | (ihdr[6] << 8) | ihdr[7])) >>> 0;
        meta = {
          width,
          height,
          depth: ihdr[8],
          colorType: ihdr[9],
          interlaced: ihdr[12] !== 0,
          animated: false,
        };
        if (!width || !height) return failWith("invalid-png");
        // Compression and filter method are the only values the format defines;
        // anything else means the rest of the header cannot be trusted either.
        if (ihdr[10] !== 0 || ihdr[11] !== 0) return failWith("invalid-png");
        if (width > STREAM_MAX_DIMENSION || height > STREAM_MAX_DIMENSION) return failWith("image-too-large");
        if (width * height > STREAM_MAX_PIXELS) return failWith("image-too-large");
      } else if (type === "PLTE") {
        const payload = await reader.read(length);
        if (!payload) return failWith("invalid-png");
        if (length === 0 || length % 3 !== 0 || length > 768) return failWith("invalid-png");
        if (meta) meta.palette = payload.slice();
      } else if (type === "tRNS") {
        const payload = await reader.read(length);
        if (!payload) return failWith("invalid-png");
        if (meta) meta.transparency = payload.slice();
      } else if (type === "pHYs") {
        const payload = await reader.read(length);
        if (!payload) return failWith("invalid-png");
        if (meta && length === 9) meta.physical = payload.slice();
      } else if (type === "acTL") {
        if (meta) meta.animated = true;
        if (!(await reader.skip(length))) return failWith("invalid-png");
      } else if (type === "IDAT") {
        if (!meta) return failWith("invalid-png");

        // First IDAT: everything needed to decide whether this file can be
        // streamed has now been seen, so validate before starting the codecs.
        if (!rowsSettled) {
          if (meta.animated) return failWith("animated-png");
          // Adam7 stores the image as seven interleaved passes rather than
          // plain rows. Nothing here can walk that, and such files are both
          // rare and small, so they go to the whole-image decoder instead.
          if (meta.interlaced) return null;
          if (meta.depth !== 8) return failWith("unsupported-bit-depth");
          const bpp = bytesPerPixel(meta.colorType);
          if (bpp === 0) {
            return failWith(
              meta.colorType === 0 || meta.colorType === 2 ? "no-alpha-channel" : "unsupported-format",
            );
          }
          if (meta.colorType === 3 && (!meta.palette || !meta.transparency)) {
            return failWith(meta.palette ? "no-alpha-channel" : "invalid-png");
          }
          const crop = requestedCrop ?? { x: 0, y: 0, width: meta.width, height: meta.height };
          if (!cropIsValid(crop, meta.width, meta.height)) return failWith("invalid-crop");

          const decompressor = new DecompressionStream("deflate");
          inflateWriter = decompressor.writable.getWriter();
          sink = mode.kind === "apply"
            ? new RecoloredPngSink(crop.width, crop.height, meta.physical)
            : null;
          const activeSink = sink;
          // Stopping at the last row the crop needs skips the rest of the file,
          // but it also skips the codec's own end-of-stream check. That is a
          // fair trade only when there is real work to skip: when the crop runs
          // to the bottom row, the stream is drained instead, so a source that
          // was truncated or corrupted after its last scanline is caught rather
          // than silently recoloured into a new print file.
          const drainToEnd = crop.y + crop.height >= meta.height;
          rowsSettled = consumeRows(
            decompressor.readable,
            meta,
            crop,
            mode,
            activeSink,
            options,
            () => { consumerDone = true; },
            drainToEnd,
          );
        }

        if (consumerDone) {
          if (!(await reader.skip(length))) break;
        } else {
          const writer = inflateWriter!;
          const piped = await reader.pipe(length, async piece => {
            if (consumerDone) return;
            await writer.write(piece);
          });
          if (!piped) break;
        }
      } else if (type === "IEND") {
        break;
      } else if (!(await reader.skip(length))) {
        return failWith("invalid-png");
      }

      // Chunk CRCs are not verified: a corrupt stream fails in the inflater a
      // moment later, and re-reading every byte to checksum it would double the
      // cost of the one thing this path exists to make cheap.
      if (!(await reader.skip(4))) break;
    }

    if (!meta) return { ok: false, reason: "invalid-png" };
    if (!rowsSettled) {
      // No IDAT at all, so nothing was validated on the way past.
      if (meta.animated) return { ok: false, reason: "animated-png" };
      if (meta.interlaced) return null;
      return { ok: false, reason: "invalid-png", width: meta.width, height: meta.height };
    }

    if (!consumerDone) {
      try { await inflateWriter?.close(); } catch { /* consumer already stopped reading */ }
    }
    return await rowsSettled;
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    consumerDone = true;
    try { await inflateWriter?.abort(error); } catch { /* already errored */ }
    if (!aborted && rowsSettled) {
      // Cancelling the inflater from the consumer side is how an early finish
      // reaches the producer: whatever write it was waiting on rejects, and it
      // lands here. The consumer's verdict is the real one — treating its own
      // shutdown as a decode failure would throw away a finished recolour.
      const settled = await rowsSettled.catch(() => undefined);
      if (settled) return settled;
    } else {
      await rowsSettled?.catch(() => {});
    }
    await sink?.abort(error);
    if (aborted) throw error;
    // A malformed zlib stream surfaces here as a TypeError from the codec.
    return { ok: false, reason: "invalid-png", width: meta?.width, height: meta?.height };
  }
}

/**
 * Turns inflated bytes into rows, and rows into a verdict (and, when
 * recolouring, into compressed output).
 *
 * Runs concurrently with the producer above: the producer awaits its writes and
 * this awaits the compressor, so the two codecs throttle each other and neither
 * side can run ahead and pile up rows in memory.
 */
async function consumeRows(
  readable: ReadableStream<Uint8Array>,
  meta: PngMeta,
  crop: SourceCrop,
  mode: StreamMode,
  sink: RecoloredPngSink | null,
  options: StreamOptions | undefined,
  onDone: () => void,
  /** Read the inflate stream to its end instead of stopping at the last row. */
  drainToEnd: boolean,
): Promise<StreamOutcome> {
  const reader = readable.getReader();
  const bpp = bytesPerPixel(meta.colorType);
  const rowBytes = meta.width * bpp;
  const processRow = makeRowProcessor(meta, crop, mode);

  let current = new Uint8Array(rowBytes);
  let previous = new Uint8Array(rowBytes);
  let filled = 0;
  let filterType = -1;
  let y = 0;

  const lastNeededRow = crop.y + crop.height - 1;
  const outRowBytes = crop.width * 4;
  const outRow = sink ? new Uint8Array(outRowBytes) : null;
  const previousOut = sink ? new Uint8Array(outRowBytes) : null;
  const filteredRow = sink ? new Uint8Array(outRowBytes + 1) : null;
  const batchRows = sink ? Math.max(1, Math.floor(WRITE_BATCH_BYTES / (outRowBytes + 1))) : 0;
  const batch = sink ? new Uint8Array(batchRows * (outRowBytes + 1)) : null;
  let batchFill = 0;

  const finish = async (outcome: StreamOutcome): Promise<StreamOutcome> => {
    onDone();
    try { await reader.cancel(); } catch { /* already done */ }
    return outcome;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (y > lastNeededRow) {
        // Only reachable while draining, where the image is complete: a valid
        // stream has nothing left to inflate, so more pixel data means the
        // header and the payload disagree about the image.
        return await finish({ ok: false, reason: "invalid-png", width: meta.width, height: meta.height });
      }

      let index = 0;
      while (index < value.length) {
        if (filterType < 0) {
          filterType = value[index++];
          continue;
        }
        const take = Math.min(rowBytes - filled, value.length - index);
        current.set(value.subarray(index, index + take), filled);
        filled += take;
        index += take;
        if (filled < rowBytes) break;

        if (!unfilterRow(filterType, current, previous, bpp)) {
          return await finish({ ok: false, reason: "invalid-png", width: meta.width, height: meta.height });
        }

        // Every row in the crop, on both passes. Measuring a sample of rows
        // would be cheaper, but a second ink confined to the rows that were
        // skipped would be reported as no second ink at all and then painted
        // over — and the memory bound comes from the fixed-size histogram, not
        // from how many rows feed it.
        if (y >= crop.y && y <= lastNeededRow) {
          const code = processRow(current, outRow);
          if (code === ROW_INVALID) {
            return await finish({ ok: false, reason: "invalid-png", width: meta.width, height: meta.height });
          }
          if (sink && outRow && previousOut && filteredRow && batch) {
            filterRowAdaptive(outRow, previousOut, 4, outRowBytes, filteredRow, 0);
            batch.set(filteredRow, batchFill);
            batchFill += filteredRow.length;
            previousOut.set(outRow);
            if (batchFill + filteredRow.length > batch.length) {
              await sink.write(batch.subarray(0, batchFill).slice());
              batchFill = 0;
            }
          }
        }

        const swap = previous;
        previous = current;
        current = swap;
        filled = 0;
        filterType = -1;
        y++;

        if (y % PROGRESS_ROW_INTERVAL === 0) {
          if (options?.signal?.aborted) throw abortError();
          options?.onProgress?.(Math.min(1, y / (lastNeededRow + 1)));
        }

        // Rows below the crop cannot change the verdict and are not written, so
        // the rest of the file — which on a tall design is most of it — is never
        // inflated at all. When the crop reaches the bottom there is nothing to
        // skip, and the remaining bytes are read purely so the codec verifies
        // the stream ended intact.
        if (y > lastNeededRow) {
          if (drainToEnd && index < value.length) {
            return await finish({ ok: false, reason: "invalid-png", width: meta.width, height: meta.height });
          }
          index = value.length;
          break;
        }
      }
      if (y > lastNeededRow && !drainToEnd) break;
    }

    if (y <= lastNeededRow) {
      // The zlib stream ended before the image did.
      return await finish({ ok: false, reason: "invalid-png", width: meta.width, height: meta.height });
    }
    if (mode.kind === "analyze") {
      const resolved = resolveInkModel(mode.stats, crop.width, crop.height);
      options?.onProgress?.(1);
      if (!resolved.ok) {
        return await finish({
          ok: false,
          reason: resolved.reason,
          dominance: resolved.dominance,
          width: crop.width,
          height: crop.height,
        });
      }
      return await finish({
        ok: true,
        sourceColor: resolved.model.ink,
        model: resolved.model,
        width: crop.width,
        height: crop.height,
        blob: null,
      });
    }

    if (sink && batch && batchFill > 0) await sink.write(batch.subarray(0, batchFill).slice());
    options?.onProgress?.(1);
    const blob = sink ? await sink.finish() : null;
    return await finish({
      ok: true,
      sourceColor: mode.model.ink,
      model: null,
      width: crop.width,
      height: crop.height,
      blob,
    });
  } catch (error) {
    onDone();
    try { await reader.cancel(); } catch { /* already done */ }
    throw error;
  }
}

/** Works out which single ink the artwork is made of, without holding it. */
export async function streamAnalyzePng(
  blob: Blob,
  crop?: SourceCrop,
  options?: StreamOptions,
): Promise<StreamAnalysis | null> {
  const outcome = await runStream(blob, { kind: "analyze", stats: createInkStats() }, crop, options);
  if (outcome === null) return null;
  if (!outcome.ok) {
    return {
      eligible: false,
      reason: outcome.reason,
      dominance: outcome.dominance,
      width: outcome.width,
      height: outcome.height,
    };
  }
  if (!outcome.model) return { eligible: false, reason: "unsupported-format" };
  return {
    eligible: true,
    sourceColor: outcome.sourceColor,
    model: outcome.model,
    width: outcome.width,
    height: outcome.height,
  };
}

/**
 * Reads the image's dimensions without decoding it.
 *
 * A model the caller already resolved can only be reused on the image it was
 * measured from, and this is the cheapest possible way to check: 33 bytes off
 * the front of the blob, versus a second full pass over a print-resolution
 * source.
 */
async function readPngSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  if (blob.size < 33) return null;
  const head = new Uint8Array(await blob.slice(0, 33).arrayBuffer());
  if (PNG_SIGNATURE.some((value, index) => head[index] !== value)) return null;
  if (String.fromCharCode(head[12], head[13], head[14], head[15]) !== "IHDR") return null;
  const view = new DataView(head.buffer, head.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Rewrites every visible pixel to `target`, keeping each pixel's coverage.
 *
 * The model can be supplied by a caller that has already analysed this exact
 * source — the dialog always has — which halves the work. It is only trusted
 * when it was measured at the dimensions this recolour is about to produce;
 * otherwise the artwork is measured again from scratch.
 */
export async function streamRecolorPng(
  blob: Blob,
  target: RgbColor,
  crop?: SourceCrop,
  options?: StreamOptions,
  knownModel?: InkModel,
): Promise<StreamRecolorResult | null> {
  if (![target.r, target.g, target.b].every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
    throw new RangeError("Target color channels must be integers from 0 through 255.");
  }

  let model = knownModel;
  if (model) {
    const output = crop ?? (await readPngSize(blob));
    if (!output || !inkModelFits(model, output.width, output.height)) model = undefined;
  }
  if (!model) {
    // Two passes, so progress has to span both. The measuring pass is the
    // cheaper of the two — it samples rows and writes nothing — so it takes the
    // smaller share of the bar.
    const analysis = await runStream(
      blob,
      { kind: "analyze", stats: createInkStats() },
      crop,
      { ...options, onProgress: fraction => options?.onProgress?.(fraction * 0.3) },
    );
    if (analysis === null) return null;
    if (!analysis.ok) return { ok: false, reason: analysis.reason };
    if (!analysis.model) return { ok: false, reason: "unsupported-format" };
    model = analysis.model;
    const resolved = model;
    const outcome = await runStream(
      blob,
      { kind: "apply", target, model: resolved },
      crop,
      { ...options, onProgress: fraction => options?.onProgress?.(0.3 + fraction * 0.7) },
    );
    return finishRecolor(outcome);
  }

  const outcome = await runStream(blob, { kind: "apply", target, model }, crop, options);
  return finishRecolor(outcome);
}

function finishRecolor(outcome: StreamOutcome): StreamRecolorResult | null {
  if (outcome === null) return null;
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  if (!outcome.blob) return { ok: false, reason: "unsupported-format" };
  return {
    ok: true,
    blob: outcome.blob,
    sourceColor: outcome.sourceColor,
    width: outcome.width,
    height: outcome.height,
  };
}

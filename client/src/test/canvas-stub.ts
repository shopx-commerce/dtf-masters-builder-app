import { deflateSync } from "node:zlib";

/**
 * A canvas jsdom can run.
 *
 * jsdom implements `<canvas>` as far as the element and then throws
 * "Not implemented" from `getContext`, and it has no `ImageData` at all — so
 * every editor path that resizes, reads or re-encodes pixels dies on import
 * rather than on anything a test wrote. Installing the real `canvas` package
 * would drag a native build into CI for tests that never inspect a pixel.
 *
 * This stub keeps a real RGBA buffer per canvas, so `putImageData` /
 * `getImageData` round-trip truthfully, and encodes that buffer as a genuine
 * PNG on `toBlob` so decoding it yields the canvas's actual dimensions. What it
 * cannot do is rasterise: `drawImage` records the call and leaves the buffer
 * transparent, because there is no renderer behind it. Tests that assert on
 * drawn pixels must not use it — it is here for bookkeeping, not for imaging.
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

/** Encodes 8-bit RGBA pixels as an uncompressed-filter PNG. */
export function encodePng(pixels: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const idat = new Uint8Array(deflateSync(raw));
  const chunks = [PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = chunks.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

class StubImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly colorSpace = "srgb";

  constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight: number, height?: number) {
    if (typeof dataOrWidth === "number") {
      this.width = dataOrWidth;
      this.height = widthOrHeight;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    } else {
      this.data = dataOrWidth;
      this.width = widthOrHeight;
      this.height = height ?? dataOrWidth.length / 4 / widthOrHeight;
    }
  }
}

class StubCanvasContext2D {
  imageSmoothingEnabled = false;
  imageSmoothingQuality: "low" | "medium" | "high" = "low";
  fillStyle: unknown = "#000000";
  globalCompositeOperation = "source-over";
  /** Every `drawImage` argument list, in order — the only record of a draw. */
  readonly drawCalls: unknown[][] = [];
  private buffer: Uint8ClampedArray;
  private bufferWidth: number;
  private bufferHeight: number;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.bufferWidth = canvas.width;
    this.bufferHeight = canvas.height;
    this.buffer = new Uint8ClampedArray(Math.max(0, canvas.width * canvas.height * 4));
  }

  /** Canvas pixels are dropped when width/height change; match that. */
  private sync() {
    if (this.canvas.width === this.bufferWidth && this.canvas.height === this.bufferHeight) return;
    this.bufferWidth = this.canvas.width;
    this.bufferHeight = this.canvas.height;
    this.buffer = new Uint8ClampedArray(Math.max(0, this.bufferWidth * this.bufferHeight * 4));
  }

  drawImage(...args: unknown[]) {
    this.sync();
    this.drawCalls.push(args);
  }

  clearRect() {
    this.sync();
    this.buffer.fill(0);
  }

  fillRect() {
    this.sync();
  }

  getImageData(x: number, y: number, width: number, height: number) {
    this.sync();
    const out = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) {
      const from = ((y + row) * this.bufferWidth + x) * 4;
      out.set(this.buffer.subarray(from, from + width * 4), row * width * 4);
    }
    return new StubImageData(out, width, height) as unknown as ImageData;
  }

  putImageData(image: ImageData, x: number, y: number) {
    this.sync();
    for (let row = 0; row < image.height; row++) {
      const to = ((y + row) * this.bufferWidth + x) * 4;
      this.buffer.set(image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4), to);
    }
  }

  /** Current pixels, for `toBlob`. */
  snapshot(): Uint8ClampedArray {
    this.sync();
    return this.buffer;
  }
}

const contexts = new WeakMap<HTMLCanvasElement, StubCanvasContext2D>();

/** The stub context behind a canvas, for asserting on recorded draws. */
export function canvasContext(canvas: HTMLCanvasElement): StubCanvasContext2D | undefined {
  return contexts.get(canvas);
}

export function installCanvasStub() {
  if (typeof globalThis.ImageData === "undefined") {
    Object.defineProperty(globalThis, "ImageData", { value: StubImageData, writable: true, configurable: true });
  }

  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement, kind: string) {
    if (kind !== "2d") return null;
    let context = contexts.get(this);
    if (!context) {
      context = new StubCanvasContext2D(this);
      contexts.set(this, context);
    }
    return context as unknown as CanvasRenderingContext2D;
  } as HTMLCanvasElement["getContext"];

  HTMLCanvasElement.prototype.toBlob = function toBlob(this: HTMLCanvasElement, callback: BlobCallback) {
    const context = contexts.get(this) ?? new StubCanvasContext2D(this);
    contexts.set(this, context);
    const png = encodePng(context.snapshot(), this.width, this.height);
    queueMicrotask(() => callback(new Blob([png], { type: "image/png" })));
  } as HTMLCanvasElement["toBlob"];

  HTMLCanvasElement.prototype.toDataURL = function toDataURL(this: HTMLCanvasElement) {
    const context = contexts.get(this) ?? new StubCanvasContext2D(this);
    contexts.set(this, context);
    const png = encodePng(context.snapshot(), this.width, this.height);
    return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  } as HTMLCanvasElement["toDataURL"];
}

import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * Browser APIs jsdom does not implement, stubbed just far enough for the
 * editor's image plumbing to run — and no further.
 *
 * jsdom has no blob URL store and never loads an `<img>`, so any code path that
 * decodes a Blob into an `HTMLImageElement` would hang forever waiting for an
 * `onload` that cannot fire. Rather than resolving every decode blindly (which
 * would let a test "decode" arbitrary bytes and quietly bless invalid output),
 * object URLs keep their Blob and the image stub reads the PNG header out of
 * it: valid PNG bytes load with their real dimensions, anything else raises
 * `onerror` the way a browser would. Error paths stay testable, and a test that
 * feeds in junk still fails.
 */

/**
 * jsdom ships its own `Blob` and it predates `arrayBuffer()`, so any code that
 * reads bytes back out of a Blob throws "not a function" in tests while working
 * fine in every real browser. `FileReader` is implemented, so route through it.
 */
if (typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function readAsArrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

let objectUrlSeq = 0;
const blobsByUrl = new Map<string, Blob>();

URL.createObjectURL = vi.fn((blob: Blob) => {
  const url = `blob:vitest/${++objectUrlSeq}`;
  blobsByUrl.set(url, blob);
  return url;
});
URL.revokeObjectURL = vi.fn((url: string) => {
  blobsByUrl.delete(url);
});

/** Object URLs still outstanding — lets a test assert that previews are freed. */
export function outstandingObjectUrls(): ReadonlySet<string> {
  return new Set(blobsByUrl.keys());
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Reads IHDR, the only part of a PNG the stub needs to answer honestly. */
function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

class StubImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  width = 0;
  height = 0;
  private value = "";

  get src(): string {
    return this.value;
  }

  set src(next: string) {
    this.value = next;
    const blob = blobsByUrl.get(next);
    if (!blob) {
      queueMicrotask(() => this.onerror?.());
      return;
    }
    void blob.arrayBuffer().then(buffer => {
      const size = readPngSize(new Uint8Array(buffer));
      if (!size) {
        this.onerror?.();
        return;
      }
      this.naturalWidth = this.width = size.width;
      this.naturalHeight = this.height = size.height;
      this.onload?.();
    });
  }
}

vi.stubGlobal("Image", StubImage);

afterEach(() => {
  cleanup();
  blobsByUrl.clear();
});

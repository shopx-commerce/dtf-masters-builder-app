/**
 * Encodes finished pixels to PNG off the main thread.
 *
 * `canvas.toBlob` is asynchronous but not free of the main thread, and it is
 * the single most expensive step in every pixel edit: measured on a 4096 x 4096
 * print source, the PNG encode alone was 2.2s of a 3.6s magic-wand tap. The
 * same encode in a worker took roughly a third as long and left the main thread
 * idle, so the editor keeps painting while it runs.
 *
 * The caller transfers an `ImageBitmap`, which moves the pixels rather than
 * copying them.
 */

export interface PngEncodeRequest {
  id: number;
  bitmap: ImageBitmap;
}

export interface PngEncodeResponse {
  id: number;
  blob?: Blob;
  error?: string;
}

self.onmessage = async (event: MessageEvent<PngEncodeRequest>) => {
  const { id, bitmap } = event.data;
  let canvas: OffscreenCanvas | null = null;
  try {
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2D unavailable");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const response: PngEncodeResponse = { id, blob };
    self.postMessage(response);
  } catch (err) {
    try { bitmap.close(); } catch { /* already transferred or closed */ }
    const response: PngEncodeResponse = { id, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(response);
  } finally {
    // Drop the backing store immediately; these are tens of megabytes and the
    // worker outlives the request.
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
};

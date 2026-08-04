interface ThumbnailRequest {
  type: "thumbnail";
  requestId: number;
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

self.onmessage = (event: MessageEvent<ThumbnailRequest>) => {
  const request = event.data;
  if (!request || request.type !== "thumbnail") return;

  try {
    if (typeof OffscreenCanvas === "undefined") {
      throw new Error("OffscreenCanvas is not supported");
    }

    const canvas = new OffscreenCanvas(request.width, request.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create thumbnail canvas");

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(request.bitmap, 0, 0, request.width, request.height);
    request.bitmap.close();

    canvas.convertToBlob({ type: "image/png" }).then(blob => {
      self.postMessage({ type: "result", requestId: request.requestId, blob });
    }).catch(error => {
      self.postMessage({
        type: "error",
        requestId: request.requestId,
        error: String(error),
      });
    });
  } catch (error) {
    request.bitmap?.close();
    self.postMessage({
      type: "error",
      requestId: request.requestId,
      error: String(error),
    });
  }
};
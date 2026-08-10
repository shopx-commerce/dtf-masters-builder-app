import { applyHalftoneScreen, type HalftoneStrength } from "./halftone-core";

interface HalftoneRequest {
  type: "halftone";
  requestId: number;
  pixelBuffer: ArrayBuffer;
  procW: number;
  procH: number;
  printWidthInches: number;
  tr: number;
  tg: number;
  tb: number;
  strength: HalftoneStrength;
}

self.onmessage = (event: MessageEvent<HalftoneRequest>) => {
  const request = event.data;
  if (!request || request.type !== "halftone") return;

  try {
    const pixels = new Uint8ClampedArray(request.pixelBuffer);
    applyHalftoneScreen({
      data: pixels,
      procW: request.procW,
      procH: request.procH,
      printWidthInches: request.printWidthInches,
      tr: request.tr,
      tg: request.tg,
      tb: request.tb,
      strength: request.strength,
    });
    const out = pixels.buffer;
    (self as unknown as Worker).postMessage(
      { type: "result", requestId: request.requestId, pixelBuffer: out },
      [out],
    );
  } catch (error) {
    (self as unknown as Worker).postMessage({
      type: "error",
      requestId: request.requestId,
      error: String(error),
    });
  }
};

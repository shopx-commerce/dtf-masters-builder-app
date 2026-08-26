import {
  analyzeColorChangePng,
  recolorPng,
  type RgbColor,
  type SourceCrop,
} from "./color-change-core";

export type ColorChangeWorkerRequest =
  | { id: number; kind: "analyze"; bytes: Uint8Array; crop?: SourceCrop }
  | { id: number; kind: "recolor"; bytes: Uint8Array; crop?: SourceCrop; target: RgbColor };

export type ColorChangeWorkerResponse =
  | { id: number; kind: "analyze"; result: ReturnType<typeof analyzeColorChangePng> }
  | { id: number; kind: "recolor"; result: ReturnType<typeof recolorPng> }
  | { id: number; kind: "error"; message: string };

self.onmessage = (event: MessageEvent<ColorChangeWorkerRequest>) => {
  const request = event.data;
  try {
    if (request.kind === "analyze") {
      const response: ColorChangeWorkerResponse = {
        id: request.id,
        kind: "analyze",
        result: analyzeColorChangePng(request.bytes, request.crop),
      };
      self.postMessage(response);
      return;
    }

    const result = recolorPng(request.bytes, request.target, request.crop);
    const response: ColorChangeWorkerResponse = {
      id: request.id,
      kind: "recolor",
      result,
    };
    if (result.ok) self.postMessage(response, { transfer: [result.png.buffer] });
    else self.postMessage(response);
  } catch (error) {
    const response: ColorChangeWorkerResponse = {
      id: request.id,
      kind: "error",
      message: error instanceof Error ? error.message : "Color change failed.",
    };
    self.postMessage(response);
  }
};
import {
  runColorChangeAnalyze,
  runColorChangeRecolor,
  type ColorChangeRecolorResult,
} from "./color-change-run";
import type { ColorChangeAnalysis, RgbColor, SourceCrop } from "./color-change-core";
import type { InkModel } from "./ink-model";

/**
 * The request carries the source as a Blob, not as bytes.
 *
 * A Blob crosses to the worker by reference — the browser hands over the
 * backing store rather than copying or transferring an array — so posting a
 * 200 MB print source costs nothing, and the worker reads it a window at a time
 * instead of receiving it whole.
 */
export type ColorChangeWorkerRequest =
  | { id: number; kind: "analyze"; blob: Blob; crop?: SourceCrop }
  | {
      id: number;
      kind: "recolor";
      blob: Blob;
      crop?: SourceCrop;
      target: RgbColor;
      /**
       * What the analysis pass already worked out about this exact source.
       * Plain data, so it survives the trip. Passing it back saves reading a
       * print-resolution file a second time; it is re-derived if it does not
       * match what the recolour is about to produce.
       */
      model?: InkModel;
    };

export type ColorChangeWorkerResponse =
  | { id: number; kind: "analyze"; result: ColorChangeAnalysis }
  | { id: number; kind: "recolor"; result: ColorChangeRecolorResult }
  /** Rows processed so far, as a fraction — also the client's liveness signal. */
  | { id: number; kind: "progress"; fraction: number }
  | { id: number; kind: "error"; message: string };

self.onmessage = (event: MessageEvent<ColorChangeWorkerRequest>) => {
  const request = event.data;
  const onProgress = (fraction: number) => {
    const message: ColorChangeWorkerResponse = { id: request.id, kind: "progress", fraction };
    self.postMessage(message);
  };

  void (async () => {
    try {
      const response: ColorChangeWorkerResponse = request.kind === "analyze"
        ? {
            id: request.id,
            kind: "analyze",
            result: await runColorChangeAnalyze(request.blob, request.crop, { onProgress }),
          }
        : {
            id: request.id,
            kind: "recolor",
            result: await runColorChangeRecolor(
              request.blob,
              request.target,
              request.crop,
              { onProgress },
              request.model,
            ),
          };
      self.postMessage(response);
    } catch (error) {
      const response: ColorChangeWorkerResponse = {
        id: request.id,
        kind: "error",
        message: error instanceof Error ? error.message : "Color change failed.",
      };
      self.postMessage(response);
    }
  })();
};

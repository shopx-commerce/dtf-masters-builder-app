/// <reference lib="webworker" />

import type {
  SelectedDetailWorkerRequest,
  SelectedDetailWorkerResponse,
} from "./selected-detail-preview";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (
  event: MessageEvent<SelectedDetailWorkerRequest>,
) => {
  const request = event.data;
  if (request.type !== "decode") return;

  try {
    const options: ImageBitmapOptions = {
      imageOrientation: "from-image",
      resizeWidth: request.width,
      resizeHeight: request.height,
      resizeQuality: "high",
    };
    const crop = request.crop;
    const bitmap = crop
      ? await createImageBitmap(
          request.blob,
          crop.x,
          crop.y,
          crop.width,
          crop.height,
          options,
        )
      : await createImageBitmap(request.blob, options);

    const response: SelectedDetailWorkerResponse = {
      type: "result",
      requestId: request.requestId,
      bitmap,
      width: bitmap.width,
      height: bitmap.height,
    };
    workerScope.postMessage(response, [bitmap]);
  } catch (error) {
    const response: SelectedDetailWorkerResponse = {
      type: "error",
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error),
    };
    workerScope.postMessage(response);
  }
};

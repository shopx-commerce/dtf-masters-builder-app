export const SELECTED_DETAIL_MAX_AREA = 4_000_000;
export const SELECTED_DETAIL_MAX_EDGE = 4096;
export const SELECTED_DETAIL_SIZE_STEP = 256;

export interface SelectedDetailRasterInput {
  cssWidth: number;
  cssHeight: number;
  zoom: number;
  devicePixelRatio: number;
  sourceWidth: number;
  sourceHeight: number;
  workingWidth: number;
  workingHeight: number;
  canvasPixelsPerCssPixel: number;
  maxSourceMegapixels: number;
}

export interface SelectedDetailRasterPlan {
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}

export interface SelectedDetailReadyState {
  designId: string;
  source: Blob;
  requestKey: string;
}

export interface SelectedDetailCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SelectedDetailWorkerRequest = {
  type: "decode";
  requestId: number;
  blob: Blob;
  crop?: SelectedDetailCrop;
  width: number;
  height: number;
};

export type SelectedDetailWorkerResponse =
  | {
      type: "result";
      requestId: number;
      bitmap: ImageBitmap;
      width: number;
      height: number;
    }
  | {
      type: "error";
      requestId: number;
      error: string;
    };

export function isSelectedDetailReady(
  ready: SelectedDetailReadyState | null,
  current: {
    eligible: boolean;
    designId: string | null | undefined;
    source: Blob | null | undefined;
    requestKey: string | null | undefined;
  },
): boolean {
  return Boolean(
    current.eligible &&
      ready &&
      ready.designId === current.designId &&
      ready.source === current.source &&
      ready.requestKey === current.requestKey,
  );
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Plans only the pixels a selected design can visibly use. Returning null
 * means the normal sheet preview is already as detailed as the screen can
 * show, or decoding the retained source would exceed this device's budget.
 */
export function planSelectedDetailRaster(
  input: SelectedDetailRasterInput,
): SelectedDetailRasterPlan | null {
  const {
    cssWidth,
    cssHeight,
    zoom,
    devicePixelRatio,
    sourceWidth,
    sourceHeight,
    workingWidth,
    workingHeight,
    canvasPixelsPerCssPixel,
    maxSourceMegapixels,
  } = input;
  if (
    !finitePositive(cssWidth) ||
    !finitePositive(cssHeight) ||
    !finitePositive(zoom) ||
    !finitePositive(devicePixelRatio) ||
    !finitePositive(sourceWidth) ||
    !finitePositive(sourceHeight) ||
    !finitePositive(maxSourceMegapixels)
  ) {
    return null;
  }

  if ((sourceWidth * sourceHeight) / 1_000_000 > maxSourceMegapixels) {
    return null;
  }

  const rawWidth = cssWidth * zoom * devicePixelRatio;
  const rawHeight = cssHeight * zoom * devicePixelRatio;
  const rawLongest = Math.max(rawWidth, rawHeight);
  if (!finitePositive(rawLongest)) return null;

  // Quantise by the longest edge so wheel/pinch updates inside one bucket do
  // not repeatedly decode near-identical bitmaps.
  const bucketLongest =
    Math.ceil(rawLongest / SELECTED_DETAIL_SIZE_STEP) *
    SELECTED_DETAIL_SIZE_STEP;
  let width = rawWidth * (bucketLongest / rawLongest);
  let height = rawHeight * (bucketLongest / rawLongest);

  const capScale = Math.min(
    1,
    SELECTED_DETAIL_MAX_EDGE / Math.max(width, height),
    Math.sqrt(SELECTED_DETAIL_MAX_AREA / (width * height)),
    sourceWidth / width,
    sourceHeight / height,
  );
  width = Math.max(1, Math.round(width * capScale));
  height = Math.max(1, Math.round(height * capScale));

  const baseScale = finitePositive(canvasPixelsPerCssPixel)
    ? canvasPixelsPerCssPixel
    : 1;
  const baselineWidth = Math.min(
    finitePositive(workingWidth) ? workingWidth : sourceWidth,
    cssWidth * baseScale,
  );
  const baselineHeight = Math.min(
    finitePositive(workingHeight) ? workingHeight : sourceHeight,
    cssHeight * baseScale,
  );

  // A small dead-band prevents allocating an overlay when it cannot produce
  // a visible gain over the existing working image and sheet canvas.
  if (
    width <= baselineWidth * 1.1 &&
    height <= baselineHeight * 1.1
  ) {
    return null;
  }

  return { width, height, sourceWidth, sourceHeight };
}

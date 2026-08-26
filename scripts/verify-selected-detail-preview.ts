import {
  SELECTED_DETAIL_MAX_AREA,
  SELECTED_DETAIL_MAX_EDGE,
  isSelectedDetailReady,
  planSelectedDetailRaster,
} from "../client/src/lib/selected-detail-preview";

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) return;
  failures++;
  console.error(`FAIL: ${message}`);
}

const base = {
  cssWidth: 600,
  cssHeight: 300,
  zoom: 4,
  devicePixelRatio: 2,
  sourceWidth: 6000,
  sourceHeight: 3000,
  workingWidth: 2000,
  workingHeight: 1000,
  canvasPixelsPerCssPixel: 4,
  maxSourceMegapixels: 40,
};

const visible = planSelectedDetailRaster(base);
check(Boolean(visible), "large selected art gets a detail plan");
if (visible) {
  check(
    visible.width * visible.height <= SELECTED_DETAIL_MAX_AREA,
    "target area stays bounded",
  );
  check(
    Math.max(visible.width, visible.height) <= SELECTED_DETAIL_MAX_EDGE,
    "target edge stays bounded",
  );
  check(visible.width <= base.sourceWidth, "target never upscales source width");
  check(visible.height <= base.sourceHeight, "target never upscales source height");
}

check(
  planSelectedDetailRaster({
    ...base,
    zoom: 1,
    devicePixelRatio: 1,
    canvasPixelsPerCssPixel: 2,
  }) === null,
  "normal preview remains in use when it already satisfies the screen",
);

check(
  planSelectedDetailRaster({
    ...base,
    sourceWidth: 12_000,
    sourceHeight: 8_000,
    maxSourceMegapixels: 60,
  }) === null,
  "source decode over the device budget is refused",
);

const smallSource = planSelectedDetailRaster({
  ...base,
  sourceWidth: 900,
  sourceHeight: 450,
  workingWidth: 500,
  workingHeight: 250,
});
check(
  Boolean(
    smallSource &&
      smallSource.width <= 900 &&
      smallSource.height <= 450,
  ),
  "small originals are never enlarged beyond their real pixels",
);

const bucketA = planSelectedDetailRaster({ ...base, zoom: 4 });
const bucketB = planSelectedDetailRaster({ ...base, zoom: 4.01 });
check(
  bucketA?.width === bucketB?.width && bucketA?.height === bucketB?.height,
  "tiny zoom changes reuse the same quantized target",
);

const source = new Blob(["source"], { type: "image/png" });
const ready = { designId: "one", source, requestKey: "crop-a:2048x1024" };
check(
  isSelectedDetailReady(ready, {
    eligible: true,
    designId: "one",
    source,
    requestKey: "crop-a:2048x1024",
  }),
  "the exact selected source and request may display",
);
check(
  !isSelectedDetailReady(ready, {
    eligible: true,
    designId: "one",
    source,
    requestKey: "crop-b:2048x1024",
  }),
  "a pending crop replacement falls back instead of showing stale detail",
);
check(
  !isSelectedDetailReady(ready, {
    eligible: false,
    designId: "one",
    source,
    requestKey: "crop-a:2048x1024",
  }),
  "mobile, multi-select, and active gestures suppress retained detail",
);
check(
  !isSelectedDetailReady(ready, {
    eligible: true,
    designId: "two",
    source,
    requestKey: "crop-a:2048x1024",
  }),
  "rapid selection never flashes the previous design",
);

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log("selected full-detail preview budgets and sizing are bounded");
}

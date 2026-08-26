import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignItem, ImageInfo } from "@/lib/types";
import type { ImageEditorBagAfterArrange } from "./image-editor-hook-bag.types";
import { useImageEditorModelUploadCrop } from "./useImageEditorModelUploadCrop";

/**
 * Only the upscale path of this hook is under test, and only its job
 * bookkeeping: one click starts one model run, and a result may not be
 * committed onto artwork that changed while the model was running.
 *
 * The model itself is a WebGPU session over a print-resolution canvas, and the
 * print-source helpers decode and re-encode real images, so both are replaced
 * with promises the test resolves by hand.
 */
const upscale = vi.fn();
const cancel = vi.fn();
const applyEditAtPrintResolution = vi.fn();
const applyEditToPreviewSource = vi.fn();

vi.mock("@/lib/upscale-manager", () => ({
  getUpscaleManager: () => ({
    upscale: (...args: unknown[]) => upscale(...args),
    cancel: () => cancel(),
    isFastEnough: async () => true,
  }),
  resolveUpscaleScale: () => 2,
}));

/** The capability probe would open a real GPU session; the button is on in these tests. */
vi.mock("@/lib/upscale-support", () => ({
  detectUpscaleSupport: async () => ({ available: true }),
}));

vi.mock("@/lib/print-source-edit", () => ({
  applyEditAtPrintResolution: (...args: unknown[]) => applyEditAtPrintResolution(...args),
  applyEditToPreviewSource: (...args: unknown[]) => applyEditToPreviewSource(...args),
  printSourceFieldsAfterEdit: () => ({}),
}));

/** Row-identity stamping has its own rules and its own tests. */
vi.mock("@/lib/edit-split", () => ({
  stampEditSplit: (designs: unknown) => designs,
}));

vi.mock("@/lib/contour-worker-manager", () => ({
  clearContourCacheIfActive: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const DESIGN_ID = "design-1";

function makeImageInfo(): ImageInfo {
  return {
    file: new File([new Uint8Array([137, 80, 78, 71])], "art.png", { type: "image/png" }),
    image: { src: "blob:vitest/original", naturalWidth: 600, naturalHeight: 600 } as unknown as HTMLImageElement,
    originalWidth: 600,
    originalHeight: 600,
    dpi: 150,
  } as unknown as ImageInfo;
}

function makeDesign(imageInfo = makeImageInfo()): DesignItem {
  return {
    id: DESIGN_ID,
    name: "art.png",
    imageInfo,
    transform: { nx: 0, ny: 0, s: 1, rotation: 0 },
    widthInches: 4,
    heightInches: 4,
    originalDPI: 150,
  } as unknown as DesignItem;
}

/** What the print-source helper hands back after the model has run. */
function upscaled() {
  return { sourceWidth: 1200, sourceHeight: 1200 };
}

/**
 * Exactly the bag members this hook consumes, typed against the real bag so an
 * upstream rename breaks this file at compile time instead of silently drifting.
 */
type UploadCropBag = Pick<
  ImageEditorBagAfterArrange,
  | "toast"
  | "t"
  | "isMobile"
  | "imageInfo"
  | "setImageInfo"
  | "resizeSettings"
  | "setResizeSettings"
  | "setIsUploading"
  | "setUploadProgress"
  | "artboardWidth"
  | "artboardHeight"
  | "setArtboardHeight"
  | "designs"
  | "setDesigns"
  | "selectedDesignId"
  | "selectedDesignIds"
  | "headerUploadInputRef"
  | "saveSnapshot"
  | "selectedDesign"
  | "GANGSHEET_HEIGHTS"
  | "artboardWidthRef"
  | "artboardHeightRef"
  | "applyImageDirectly"
  | "thumbnailCacheRef"
  | "contentFillCacheRef"
  | "assetDataUrlCacheRef"
  | "restoredLayerAssetRef"
>;

function setup(design = makeDesign()) {
  let designs = [design];
  const setDesigns: UploadCropBag["setDesigns"] = vi.fn(update => {
    designs = typeof update === "function" ? update(designs) : update;
  });
  const fixture: UploadCropBag = {
    toast: vi.fn(),
    t: (key: string) => key,
    isMobile: false,
    imageInfo: design.imageInfo,
    setImageInfo: vi.fn(),
    resizeSettings: { widthInches: 4, heightInches: 4, maintainAspectRatio: true, outputDPI: 300 },
    setResizeSettings: vi.fn(),
    setIsUploading: vi.fn(),
    setUploadProgress: vi.fn(),
    artboardWidth: 22,
    artboardHeight: 60,
    setArtboardHeight: vi.fn(),
    designs,
    setDesigns,
    selectedDesignId: DESIGN_ID,
    selectedDesignIds: new Set([DESIGN_ID]),
    headerUploadInputRef: { current: null },
    saveSnapshot: vi.fn(),
    selectedDesign: design,
    GANGSHEET_HEIGHTS: [60],
    artboardWidthRef: { current: 22 },
    artboardHeightRef: { current: 60 },
    applyImageDirectly: vi.fn(),
    thumbnailCacheRef: { current: new Map() },
    contentFillCacheRef: { current: new Map() },
    assetDataUrlCacheRef: { current: new Map() },
    restoredLayerAssetRef: { current: new Map() },
  };

  const view = renderHook((bag: UploadCropBag) => useImageEditorModelUploadCrop(bag as unknown as ImageEditorBagAfterArrange), {
    initialProps: fixture,
  });
  return { bag: fixture, design, view, currentDesigns: () => designs };
}

beforeEach(() => {
  upscale.mockReset();
  applyEditAtPrintResolution.mockReset();
  applyEditToPreviewSource.mockReset();
});

describe("upscale job bookkeeping", () => {
  it("runs the model once when the button is double-clicked", async () => {
    const { view } = setup();
    const first = deferred<ReturnType<typeof upscaled>>();
    applyEditAtPrintResolution.mockReturnValueOnce(first.promise);

    await act(async () => {
      void view.result.current.handleIncreaseQuality(2);
      void view.result.current.handleIncreaseQuality(2);
    });

    // `isUpscaling` is state: both clicks in one tick read the same stale
    // `false`, so only a synchronous guard keeps the second run from starting.
    expect(applyEditAtPrintResolution).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(upscaled());
    });
  });

  it("accepts a new upscale once the previous one has finished", async () => {
    const { view } = setup();
    applyEditAtPrintResolution.mockResolvedValue(upscaled());

    await act(async () => {
      await view.result.current.handleIncreaseQuality(2);
    });
    await act(async () => {
      await view.result.current.handleIncreaseQuality(2);
    });

    // The guard must release, or the tool is dead for the rest of the session.
    expect(applyEditAtPrintResolution).toHaveBeenCalledTimes(2);
  });

  it("discards a result whose design changed while the model ran", async () => {
    const design = makeDesign();
    const { view, bag } = setup(design);
    const job = deferred<ReturnType<typeof upscaled>>();
    applyEditAtPrintResolution.mockReturnValueOnce(job.promise);

    await act(async () => {
      void view.result.current.handleIncreaseQuality(2);
    });

    // A crop or colour change lands mid-upscale: same design, new print source.
    view.rerender({ ...bag, designs: [makeDesign()] });

    await act(async () => {
      job.resolve(upscaled());
      await Promise.resolve();
    });

    await waitFor(() => expect(bag.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "toast.upscaleSourceChangedDesc" }),
    ));
    // Committing would have put the pre-edit pixels back under the new artwork.
    expect(bag.setDesigns).not.toHaveBeenCalled();
    expect(bag.saveSnapshot).not.toHaveBeenCalled();
  });

  it("does not commit into an editor that was unmounted mid-run", async () => {
    const { view, bag } = setup();
    const job = deferred<ReturnType<typeof upscaled>>();
    applyEditAtPrintResolution.mockReturnValueOnce(job.promise);

    await act(async () => {
      void view.result.current.handleIncreaseQuality(2);
    });

    // Cancelling the session only asks the model to stop; a run already past
    // its last checkpoint still resolves after the editor is gone.
    view.unmount();

    await act(async () => {
      job.resolve(upscaled());
      await Promise.resolve();
    });

    expect(bag.setDesigns).not.toHaveBeenCalled();
    expect(bag.saveSnapshot).not.toHaveBeenCalled();
    expect(bag.setImageInfo).not.toHaveBeenCalled();
  });

  it("commits the upscaled print source when nothing changed underneath it", async () => {
    const { view, bag, currentDesigns } = setup();
    applyEditAtPrintResolution.mockResolvedValue(upscaled());

    await act(async () => {
      await view.result.current.handleIncreaseQuality(2);
    });

    expect(bag.saveSnapshot).toHaveBeenCalledTimes(1);
    const committed = currentDesigns()[0];
    expect(committed.imageInfo.originalWidth).toBe(1200);
    // 1200 px over a 4 inch design.
    expect(committed.originalDPI).toBe(300);
    // A screen built from the old pixels no longer describes these.
    expect(committed.halftoned).toBe(false);
    expect(committed.halftoneSettings).toBeUndefined();
  });
});

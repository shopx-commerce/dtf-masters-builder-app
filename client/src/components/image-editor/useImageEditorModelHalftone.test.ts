import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignItem, ImageInfo } from "@/lib/types";
import type { ImageEditorBagAfterUploadCrop } from "./image-editor-hook-bag.types";
import { useImageEditorModelHalftone } from "./useImageEditorModelHalftone";

/**
 * The screening math itself is not under test here — the hook's job
 * bookkeeping is: which of two overlapping screens is allowed to commit, how
 * many undo steps one gesture costs, and whether a screen may still land on
 * artwork that was replaced while it ran.
 *
 * `runHalftone` owns a Web Worker, so it is replaced with promises the test
 * resolves by hand; the main-thread fallback is stubbed so a rejection is a
 * clean "worker unavailable" rather than real pixel work.
 */
const runHalftone = vi.fn();
const applyHalftoneScreen = vi.fn();
const measureContentBox = vi.fn();

vi.mock("@/lib/halftone", () => ({
  runHalftone: (...args: unknown[]) => runHalftone(...args),
}));

vi.mock("@/lib/halftone-core", () => ({
  applyHalftoneScreen: (...args: unknown[]) => applyHalftoneScreen(...args),
}));

/** Content measurement reads real pixels; the trim path is covered elsewhere. */
vi.mock("@/lib/content-bounds", () => ({
  measureContentBox: (...args: unknown[]) => measureContentBox(...args),
}));

/** Row-identity stamping has its own rules and its own tests; keep it out of the way. */
vi.mock("@/lib/edit-split", () => ({
  stampEditSplit: (designs: unknown) => designs,
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

/** Screened pixels the worker "returns" — size must match the processed canvas. */
function screenedBuffer(width: number, height: number): ArrayBuffer {
  return new Uint8ClampedArray(width * height * 4).buffer;
}

function makeSourceImage(): HTMLImageElement {
  return {
    src: "blob:vitest/source",
    naturalWidth: 600,
    naturalHeight: 600,
    width: 600,
    height: 600,
  } as unknown as HTMLImageElement;
}

function makeDesign(image = makeSourceImage()): DesignItem {
  const imageInfo = {
    file: new File([new Uint8Array([137, 80, 78, 71])], "art.png", { type: "image/png" }),
    image,
    originalWidth: 600,
    originalHeight: 600,
    dpi: 300,
  } as unknown as ImageInfo;
  return {
    id: DESIGN_ID,
    name: "art.png",
    imageInfo,
    transform: { nx: 0, ny: 0, s: 1, rotation: 0 },
    widthInches: 2,
    heightInches: 2,
    originalDPI: 300,
  } as unknown as DesignItem;
}

/**
 * Exactly the bag members this hook consumes, typed against the real bag so an
 * upstream rename breaks this file at compile time instead of silently drifting.
 */
type HalftoneBag = Pick<
  ImageEditorBagAfterUploadCrop,
  | "designs"
  | "designsRef"
  | "selectedDesignId"
  | "selectedDesignIds"
  | "setDesigns"
  | "setImageInfo"
  | "setResizeSettings"
  | "saveSnapshot"
  | "artboardWidthRef"
  | "artboardHeightRef"
>;

function setup() {
  const design = makeDesign();
  const designsRef: HalftoneBag["designsRef"] = { current: [design] };
  const setDesigns: HalftoneBag["setDesigns"] = vi.fn(update => {
    designsRef.current = typeof update === "function" ? update(designsRef.current) : update;
  });
  const fixture: HalftoneBag = {
    designs: [design],
    designsRef,
    selectedDesignId: DESIGN_ID,
    selectedDesignIds: new Set([DESIGN_ID]),
    setDesigns,
    setImageInfo: vi.fn(),
    setResizeSettings: vi.fn(),
    saveSnapshot: vi.fn(),
    artboardWidthRef: { current: 22 },
    artboardHeightRef: { current: 60 },
  };
  const bag = fixture as unknown as ImageEditorBagAfterUploadCrop;

  const view = renderHook(() => useImageEditorModelHalftone(bag));
  return { bag: fixture, design, designsRef, setDesigns, view };
}

/** One screen gesture: 300 DPI over a 2 inch design is a 600 px canvas. */
const PROCESSED = 600;

function applyOnce(view: ReturnType<typeof setup>["view"]) {
  view.result.current.handleApplyHalftone(DESIGN_ID, 0, 0, 0, "balanced");
}

beforeEach(() => {
  runHalftone.mockReset();
  applyHalftoneScreen.mockReset();
  measureContentBox.mockReset();
  // No trim: the frame keeps its bounds, so geometry stays out of these tests.
  measureContentBox.mockResolvedValue(null);
});

describe("halftone job bookkeeping", () => {
  it("costs one undo step when the swatch is double-clicked", async () => {
    const { view, bag } = setup();
    const first = deferred<ArrayBuffer>();
    const second = deferred<ArrayBuffer>();
    runHalftone.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    await act(async () => {
      applyOnce(view);
      applyOnce(view);
    });

    // Both clicks start a screen — the second supersedes the first by token —
    // but the state they would undo to is the same one, captured once.
    expect(runHalftone).toHaveBeenCalledTimes(2);
    expect(bag.saveSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(screenedBuffer(PROCESSED, PROCESSED));
      second.resolve(screenedBuffer(PROCESSED, PROCESSED));
      await Promise.resolve();
    });
  });

  it("lets only the last of two overlapping screens commit", async () => {
    const { view, setDesigns } = setup();
    const first = deferred<ArrayBuffer>();
    const second = deferred<ArrayBuffer>();
    runHalftone.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    await act(async () => {
      applyOnce(view);
      applyOnce(view);
    });

    await act(async () => {
      second.resolve(screenedBuffer(PROCESSED, PROCESSED));
    });
    await vi.waitFor(() => expect(setDesigns).toHaveBeenCalledTimes(1));

    // The superseded job finishes late — after the winner has already landed.
    await act(async () => {
      first.resolve(screenedBuffer(PROCESSED, PROCESSED));
      await Promise.resolve();
    });
    expect(setDesigns).toHaveBeenCalledTimes(1);
  });

  it("takes a fresh undo step for a screen started after the previous one landed", async () => {
    const { view, bag, setDesigns } = setup();
    runHalftone.mockResolvedValue(screenedBuffer(PROCESSED, PROCESSED));

    await act(async () => {
      applyOnce(view);
    });
    await vi.waitFor(() => expect(setDesigns).toHaveBeenCalledTimes(1));

    await act(async () => {
      applyOnce(view);
    });
    // The in-flight guard must release on completion, or every later screen
    // becomes un-undoable.
    expect(bag.saveSnapshot).toHaveBeenCalledTimes(2);
  });

  it("still records an undo step when a click overlaps a resize rebuild", async () => {
    const { view, bag, setDesigns } = setup();
    const rebuild = deferred<ArrayBuffer>();
    const click = deferred<ArrayBuffer>();
    runHalftone.mockReturnValueOnce(rebuild.promise).mockReturnValueOnce(click.promise);

    await act(async () => {
      // A resize rebuild re-screens at the new size; it is maintenance work and
      // deliberately takes no snapshot.
      view.result.current.handleApplyHalftone(DESIGN_ID, 0, 0, 0, "balanced", { skipSnapshot: true });
      applyOnce(view);
    });

    // The in-flight job took no snapshot, so the customer's click must still
    // record one — tracking "a job is running" instead of "a snapshot was
    // taken" would leave this screen impossible to undo.
    expect(bag.saveSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      rebuild.resolve(screenedBuffer(PROCESSED, PROCESSED));
      click.resolve(screenedBuffer(PROCESSED, PROCESSED));
    });
    // Only the click commits; the rebuild it superseded finishes without one.
    await vi.waitFor(() => expect(setDesigns).toHaveBeenCalledTimes(1));

    // The superseded rebuild finishing must not release the click's bookkeeping.
    const later = deferred<ArrayBuffer>();
    runHalftone.mockReturnValueOnce(later.promise);
    await act(async () => {
      applyOnce(view);
    });
    expect(bag.saveSnapshot).toHaveBeenCalledTimes(2);
  });

  it("does not screen over artwork that was replaced while it ran", async () => {
    const { view, designsRef, setDesigns } = setup();
    const job = deferred<ArrayBuffer>();
    runHalftone.mockReturnValueOnce(job.promise);

    await act(async () => {
      applyOnce(view);
    });

    // A crop, upscale or colour change lands mid-screen: same design, new pixels.
    designsRef.current = [makeDesign()];

    await act(async () => {
      job.resolve(screenedBuffer(PROCESSED, PROCESSED));
      await Promise.resolve();
    });

    expect(setDesigns).not.toHaveBeenCalled();
  });
});

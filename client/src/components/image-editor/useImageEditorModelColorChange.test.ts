import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignItem, ImageInfo } from "@/lib/types";
import type { ImageEditorBagAfterHalftone } from "./image-editor-hook-bag.types";
import { useImageEditorModelColorChange } from "./useImageEditorModelColorChange";

/**
 * The color-change client owns a Web Worker (imported with Vite's `?worker`
 * suffix) and does print-resolution pixel work. Neither belongs in a unit test:
 * what is under test here is the *hook's* job bookkeeping — which result is
 * allowed to win, which source may be rewritten, and when a second click is
 * allowed to start work — so the two entry points are replaced with promises
 * the test resolves by hand. `isColorChangeAbort` keeps the real rule (an
 * `AbortError` by name) so a change to that contract still surfaces here.
 */
const analyzeColorChangeBlob = vi.fn();
const recolorPngBlob = vi.fn();

vi.mock("@/lib/color-change-client", () => ({
  analyzeColorChangeBlob: (...args: unknown[]) => analyzeColorChangeBlob(...args),
  recolorPngBlob: (...args: unknown[]) => recolorPngBlob(...args),
  isColorChangeAbort: (error: unknown) => error instanceof Error && error.name === "AbortError",
}));

/** Downscaling a preview needs a real canvas; the hook only cares which image comes back. */
vi.mock("@/lib/draft-preview-cap", () => ({
  capRestoredPreview: vi.fn(async (image: HTMLImageElement) => ({ image, scale: 1 })),
}));

class AbortLikeError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SOURCE_COLOR = { r: 0x12, g: 0x34, b: 0x56 };

/**
 * Flat artwork: one ink, full coverage everywhere. The bookkeeping under test
 * is the same whatever the artwork turns out to be, and this is the shape that
 * needs no canvas — a soft-edged model would send the hook off to build a
 * coverage mask, which jsdom cannot rasterise.
 */
const FLAT_MODEL = {
  kind: "uniform" as const,
  ink: SOURCE_COLOR,
  paper: null,
  dominance: 1,
  width: 64,
  height: 64,
  cr: 0, cg: 0, cb: 0, c0: 1,
};

/**
 * A real 1x1 PNG. The commit path decodes what the recolor returns, and the
 * image stub reads the PNG header for its dimensions, so handing it plausible
 * junk would have the test bless bytes no browser could display.
 */
const ONE_PIXEL_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
  character => character.charCodeAt(0),
);

function makeImageInfo(): ImageInfo {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  return {
    file: new File([bytes], "art.png", { type: "image/png" }),
    image: { src: "blob:vitest/original" } as unknown as HTMLImageElement,
    exportBlob: new Blob([bytes], { type: "image/png" }),
    originalWidth: 64,
    originalHeight: 64,
  } as unknown as ImageInfo;
}

function makeDesign(): DesignItem {
  return {
    id: "design-1",
    imageInfo: makeImageInfo(),
    transform: { x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    widthInches: 4,
    heightInches: 4,
    name: "art.png",
    originalDPI: 300,
  } as unknown as DesignItem;
}

/**
 * Exactly the bag members this hook consumes, typed against the real bag.
 *
 * The fixture is checked field-by-field against the editor's own types, so a
 * rename or signature change upstream fails this file at compile time instead
 * of leaving a test that passes against a shape the app no longer has. Only the
 * final widening to the full bag is a cast — the hook takes the whole bag, and
 * reproducing its hundred-odd unrelated members would prove nothing.
 */
type ColorChangeBag = Pick<
  ImageEditorBagAfterHalftone,
  | "selectedDesignId"
  | "selectedDesignIds"
  | "designsRef"
  | "setDesigns"
  | "setImageInfo"
  | "saveSnapshot"
  | "thumbnailCacheRef"
  | "contentFillCacheRef"
  | "assetDataUrlCacheRef"
  | "toast"
  | "t"
>;

function setup() {
  const design = makeDesign();
  const designsRef: ColorChangeBag["designsRef"] = { current: [design] };
  const setDesigns: ColorChangeBag["setDesigns"] = vi.fn(update => {
    designsRef.current = typeof update === "function" ? update(designsRef.current) : update;
  });
  const fixture: ColorChangeBag = {
    selectedDesignId: design.id,
    selectedDesignIds: new Set([design.id]),
    designsRef,
    setDesigns,
    setImageInfo: vi.fn(),
    saveSnapshot: vi.fn(),
    thumbnailCacheRef: { current: new Map<string, string>() },
    contentFillCacheRef: { current: new Map() },
    assetDataUrlCacheRef: { current: new Map() },
    toast: vi.fn(),
    t: (key: string) => key,
  };
  const bag = fixture as unknown as ImageEditorBagAfterHalftone;

  const view = renderHook(() => useImageEditorModelColorChange(bag));
  return { bag: fixture, design, designsRef, setDesigns, view };
}

/** Drives the dialog to Ready with an eligible single-ink analysis. */
async function openToReady(view: ReturnType<typeof setup>["view"]) {
  const analysis = deferred<unknown>();
  analyzeColorChangeBlob.mockReturnValueOnce(analysis.promise);
  await act(async () => {
    void view.result.current.openColorChange();
  });
  await act(async () => {
    analysis.resolve({ eligible: true, sourceColor: SOURCE_COLOR, model: FLAT_MODEL });
  });
  await waitFor(() => expect(view.result.current.colorChangeState.status).toBe("ready"));
}

beforeEach(() => {
  analyzeColorChangeBlob.mockReset();
  recolorPngBlob.mockReset();
});

describe("color change job bookkeeping", () => {
  it("opens the swatch on the artwork's own ink", async () => {
    const { view } = setup();
    await openToReady(view);
    // Regression: the dialog used to open on a hardcoded pink, so a single
    // stray click committed a full recolor to a colour nobody chose.
    expect(view.result.current.colorChangeState.targetHex).toBe("#123456");
    expect(view.result.current.colorChangeState.sourceColor).toEqual(SOURCE_COLOR);
  });

  it("aborts the analysis worker when the dialog is closed mid-check", async () => {
    const { view } = setup();
    const analysis = deferred<unknown>();
    analyzeColorChangeBlob.mockReturnValueOnce(analysis.promise);

    await act(async () => {
      void view.result.current.openColorChange();
    });
    expect(view.result.current.colorChangeState.status).toBe("checking");

    act(() => view.result.current.closeColorChange());

    const signal = analyzeColorChangeBlob.mock.calls[0][2] as AbortSignal;
    expect(signal.aborted).toBe(true);
    expect(view.result.current.colorChangeState.status).toBe("closed");

    // A late result from the abandoned job must not reopen the dialog.
    await act(async () => {
      analysis.resolve({ eligible: true, sourceColor: SOURCE_COLOR });
    });
    expect(view.result.current.colorChangeState.status).toBe("closed");
  });

  it("refuses to recolor a print source that changed after it was analyzed", async () => {
    const { view, designsRef } = setup();
    await openToReady(view);
    act(() => view.result.current.setColorChangeTarget("#ff0000"));

    // An upscale, background removal, or crop landing between Ready and Apply
    // replaces `imageInfo` — the analysis no longer describes these pixels.
    designsRef.current = [{ ...designsRef.current[0], imageInfo: makeImageInfo() }];

    await act(async () => {
      await view.result.current.applyColorChange();
    });

    expect(view.result.current.colorChangeState.status).toBe("error");
    expect(view.result.current.colorChangeState.message).toBe("editor.colorChangeSourceChanged");
    // The point of the pre-flight check: no print-resolution work was started.
    expect(recolorPngBlob).not.toHaveBeenCalled();
  });

  it("closes instead of re-encoding when the target equals the current ink", async () => {
    const { view } = setup();
    await openToReady(view);

    await act(async () => {
      await view.result.current.applyColorChange();
    });

    expect(recolorPngBlob).not.toHaveBeenCalled();
    expect(view.result.current.colorChangeState.status).toBe("closed");
  });

  it("starts one job when Apply is double-clicked", async () => {
    const { view } = setup();
    await openToReady(view);
    act(() => view.result.current.setColorChangeTarget("#ff0000"));

    const recolor = deferred<unknown>();
    recolorPngBlob.mockReturnValueOnce(recolor.promise);

    await act(async () => {
      void view.result.current.applyColorChange();
      void view.result.current.applyColorChange();
    });

    // The status check alone reads a render-old value, so the in-flight guard
    // is what keeps the second click from starting a duplicate decode/encode.
    expect(recolorPngBlob).toHaveBeenCalledTimes(1);
  });

  it("does not let an abandoned job unlock the job that replaced it", async () => {
    const { view } = setup();
    await openToReady(view);
    act(() => view.result.current.setColorChangeTarget("#ff0000"));

    const first = deferred<unknown>();
    recolorPngBlob.mockReturnValueOnce(first.promise);
    await act(async () => {
      void view.result.current.applyColorChange();
    });
    expect(recolorPngBlob).toHaveBeenCalledTimes(1);

    // Customer changes their mind, reopens, and applies a different colour.
    act(() => view.result.current.closeColorChange());
    await openToReady(view);
    act(() => view.result.current.setColorChangeTarget("#00ff00"));

    const second = deferred<unknown>();
    recolorPngBlob.mockReturnValueOnce(second.promise);
    await act(async () => {
      void view.result.current.applyColorChange();
    });
    expect(recolorPngBlob).toHaveBeenCalledTimes(2);

    // The first job only now notices it was aborted. Its cleanup must leave the
    // guard the second job owns alone.
    await act(async () => {
      first.reject(new AbortLikeError());
      await Promise.resolve();
    });

    await act(async () => {
      void view.result.current.applyColorChange();
    });
    expect(recolorPngBlob).toHaveBeenCalledTimes(2);
    expect(view.result.current.colorChangeState.status).toBe("applying");
  });

  it("commits the recolored PNG as the design's new print source", async () => {
    const { view, designsRef, bag } = setup();
    await openToReady(view);
    act(() => view.result.current.setColorChangeTarget("#ff0000"));

    recolorPngBlob.mockResolvedValueOnce({
      ok: true,
      blob: new Blob([ONE_PIXEL_PNG], { type: "image/png" }),
      width: 1,
      height: 1,
    });

    await act(async () => {
      await view.result.current.applyColorChange();
    });

    await waitFor(() => expect(view.result.current.colorChangeState.status).toBe("closed"));
    const committed = designsRef.current[0].imageInfo;
    expect(committed.exportBlob).toBeInstanceOf(Blob);
    expect(committed.file.name).toBe("art-color.png");
    // A stale crop would re-clip the already-cropped recolored bytes at export.
    expect(committed.exportCrop).toBeUndefined();
    expect(bag.saveSnapshot).toHaveBeenCalledTimes(1);
    expect(bag.setImageInfo).toHaveBeenCalledWith(committed);
  });
});

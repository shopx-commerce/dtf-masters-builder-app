import { useState, useCallback, useEffect, useRef } from "react";
import type { ImageInfo, HalftoneSettings, HalftoneStrength } from "@/lib/types";
import { applyHalftoneScreen } from "@/lib/halftone-core";
import { runHalftone } from "@/lib/halftone";
import { stampEditSplit } from "@/lib/edit-split";
import { measureContentBox } from "@/lib/content-bounds";
import {
  cropSourceToBox,
  geometryAfterTrim,
  mapContentBox,
  type TrimResult,
} from "@/lib/trim-after-edit";
import type { ImageEditorBagAfterUploadCrop } from "./image-editor-hook-bag.types";

interface CanvasPngAsset {
  blob: Blob;
  image: HTMLImageElement;
}

function canvasToPngAsset(canvas: HTMLCanvasElement): Promise<CanvasPngAsset | null> {
  return new Promise(resolve => {
    canvas.toBlob(blob => {
      if (!blob) {
        resolve(null);
        return;
      }
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve({ blob, image });
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      image.src = url;
    }, "image/png");
  });
}

/** Apply 1-bit alpha threshold to an ImageInfo, returning a cleaned copy.
 *  Used by handleApplyHalftone to eliminate semi-transparent pixels that can
 *  be reintroduced by the canvas premultiplied-alpha round-trip. */
export function thresholdImageInfo(info: ImageInfo): Promise<ImageInfo | null> {
  return new Promise(resolve => {
    try {
      const src = info.image;
      const w = src.naturalWidth || src.width;
      const h = src.naturalHeight || src.height;
      if (!w || !h) { resolve(null); return; }
      const cvs = document.createElement('canvas');
      cvs.width = w; cvs.height = h;
      const ctx = cvs.getContext('2d', { willReadFrequently: true });
      if (!ctx) { resolve(null); return; }
      ctx.drawImage(src, 0, 0);
      const imgData = ctx.getImageData(0, 0, w, h);
      const data = imgData.data;
      for (let i = 3; i < data.length; i += 4) {
        data[i] = data[i] >= 128 ? 255 : 0;
      }
      ctx.putImageData(imgData, 0, 0);
      cvs.toBlob(blob => {
        if (!blob) { resolve(null); return; }
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve({ ...info, image: img }); };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
      }, 'image/png');
    } catch { resolve(null); }
  });
}

export function useImageEditorModelHalftone(bag: ImageEditorBagAfterUploadCrop) {
  const {
    designs,
    designsRef,
    selectedDesignId,
    selectedDesignIds,
    setDesigns,
    setImageInfo,
    setResizeSettings,
    saveSnapshot,
    artboardWidthRef,
    artboardHeightRef,
  } = bag;

  const [halftoneStrength, setHalftoneStrength] = useState<HalftoneStrength>('balanced');
  const [halftoneMenuOpen, setHalftoneMenuOpen] = useState(false);
  const [halftoneTopColors, setHalftoneTopColors] = useState<
    Array<{ r: number; g: number; b: number; hex: string; name?: string }>
  >([]);
  const halftoneJobRef = useRef(new Map<string, number>());
  const halftoneSizeSignatureRef = useRef('');

  /**
   * Apply AM halftone screen to a design, matching the reference app at
   * https://buywitheze-droid.github.io/Halftone/
   *
   * Pipeline:
   *  1. Resize to 300 DPI on the main thread (needs HTMLImageElement + canvas)
   *  2. Read the resized pixels and hand the buffer off to `halftone-worker`
   *     which computes tone/screen/composite/1-bit threshold on a background
   *     thread. A main-thread fallback runs if the worker is unavailable so
   *     the pipeline is identical either way.
   *  3. `putImageData` and re-read to eliminate ±1 drift from canvas
   *     premultiplied-alpha round-trip
   *  4. Encode PNG blob → HTMLImageElement and swap into the design
   */
  const handleApplyHalftone = useCallback((
    designId: string,
    tr: number, tg: number, tb: number,
    strength: HalftoneStrength = 'balanced',
    options?: { skipSnapshot?: boolean },
  ) => {
    const design = designs.find(d => d.id === designId);
    if (!design) return;
    // Always rebuild from the original pixels. Once a design has been
    // halftoned, imageInfo.image is the screened raster and must never become
    // the input to another screen when the design is resized.
    const src = design.halftoneSourceImage ?? design.imageInfo.image;
    const w = src.naturalWidth || src.width;
    const h = src.naturalHeight || src.height;
    if (!w || !h) return;
    const job = (halftoneJobRef.current.get(designId) ?? 0) + 1;
    halftoneJobRef.current.set(designId, job);

    // The screen is based on the final physical size, including the transform
    // scale. Otherwise resizing with the corner handle changes the printed dot
    // pitch even though the source artwork has not changed.
    const printWidthInches = Math.max(0.01, design.widthInches * Math.abs(design.transform.s || 1));

    // ── 1. Resize to the final printed resolution then read pixels ─────────────
    // The halftone raster must represent the size that will actually be printed.
    // Downscaling AFTER the halftone runs would blur the dot pattern; upscaling
    // AFTER would produce ragged dots. Sizing the source here keeps the dot
    // pitch at 35 LPI regardless of subsequent transform.
    const TARGET_DPI = 300;
    let procW: number, procH: number;
    if (printWidthInches > 0) {
      procW = Math.min(w, Math.max(1, Math.round(printWidthInches * TARGET_DPI)));
      procH = Math.min(h, Math.max(1, Math.round(procW * h / w)));
    } else {
      const scale = Math.min(1, 2000 / Math.max(w, h));
      procW = Math.max(1, Math.round(w * scale));
      procH = Math.max(1, Math.round(h * scale));
    }

    const cvs = document.createElement('canvas');
    cvs.width = procW; cvs.height = procH;
    const ctx = cvs.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    // High-quality step-down resize (matches reference app's highQualityResize)
    if (procW < w || procH < h) {
      let cur: HTMLCanvasElement | HTMLImageElement = src;
      let cw = w, ch = h;
      while (cw / 2 >= procW && ch / 2 >= procH) {
        const half = document.createElement('canvas');
        half.width  = Math.max(procW, Math.floor(cw / 2));
        half.height = Math.max(procH, Math.floor(ch / 2));
        const hctx = half.getContext('2d')!;
        hctx.imageSmoothingEnabled = true;
        hctx.imageSmoothingQuality = 'high';
        hctx.drawImage(cur, 0, 0, half.width, half.height);
        cur = half; cw = half.width; ch = half.height;
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(cur, 0, 0, procW, procH);
    } else {
      ctx.drawImage(src, 0, 0, procW, procH);
    }

    // Snapshot the pre-halftone design state now so an undo issued while the
    // worker is running still walks back through the pre-halftone state.
    if (!options?.skipSnapshot) saveSnapshot();

    const imgData = ctx.getImageData(0, 0, procW, procH);
    // Transfer the getImageData buffer into the worker. `imgData` becomes
    // detached after transfer, but we don't read it again — the transformed
    // pixels come back as a new ArrayBuffer.
    const transferBuffer = imgData.data.buffer;

    const finish = async () => {
      let outBuffer: ArrayBuffer;
      try {
        outBuffer = await runHalftone({
          buffer: transferBuffer,
          procW,
          procH,
          printWidthInches,
          tr, tg, tb,
          strength,
        });
      } catch {
        // Worker crashed or timed out mid-request. The canvas still holds
        // the pre-halftone pixels, so re-read and run the identical math on
        // the main thread. Same result, just a visible stall for this call.
        const fallback = ctx.getImageData(0, 0, procW, procH);
        applyHalftoneScreen({
          data: fallback.data,
          procW,
          procH,
          printWidthInches,
          tr, tg, tb,
          strength,
        });
        outBuffer = fallback.data.buffer;
      }

      if (halftoneJobRef.current.get(designId) !== job) return;

      const outPixels = new Uint8ClampedArray(outBuffer);
      const outImageData = new ImageData(outPixels, procW, procH);
      ctx.putImageData(outImageData, 0, 0);

      // Canvas stores pixels as premultiplied alpha; the straight→premult→
      // straight round-trip can leave ±1 drift on boundary pixels. One extra
      // pass fixes it. Both the worker and main-thread path produce 1-bit
      // alpha before this write, so drift is the only source of non-{0,255}.
      const verify = ctx.getImageData(0, 0, procW, procH);
      let dirty = false;
      for (let i = 3; i < verify.data.length; i += 4) {
        const a = verify.data[i];
        if (a !== 0 && a !== 255) { dirty = true; break; }
      }
      if (dirty) {
        for (let i = 3; i < verify.data.length; i += 4) {
          verify.data[i] = verify.data[i] >= 128 ? 255 : 0;
        }
        ctx.putImageData(verify, 0, 0);
      }

      let screenedCanvas = cvs;
      let croppedSourceCanvas: HTMLCanvasElement | null = null;
      let trim: TrimResult | null = null;

      // A user-triggered halftone can remove the last opaque pixels from the
      // outside of a frame. Re-run the same exact alpha-bounds scan used after
      // other destructive pixel edits so the size fields describe the visible
      // dots, not transparent padding. Resize-driven rebuilds deliberately skip
      // this: they are maintenance work, not a new crop/undo gesture.
      if (!options?.skipSnapshot) {
        const box = await measureContentBox(cvs, { minContentFraction: 0 }).catch(error => {
          console.warn("[halftone] could not measure screened content bounds", error);
          return null;
        });
        if (halftoneJobRef.current.get(designId) !== job) return;

        if (box) {
          const sourceBox = mapContentBox(box, procW, procH, w, h);
          const croppedScreen = cropSourceToBox(cvs, box);
          const croppedSource = sourceBox ? cropSourceToBox(src, sourceBox) : null;
          if (croppedScreen && croppedSource) {
            screenedCanvas = croppedScreen;
            croppedSourceCanvas = croppedSource;
            trim = { sourceWidth: procW, sourceHeight: procH, box };
          }
        }
      }

      let [img, croppedSourceImage] = await Promise.all([
        canvasToPngAsset(screenedCanvas),
        croppedSourceCanvas ? canvasToPngAsset(croppedSourceCanvas) : Promise.resolve(null),
      ]);
      if (halftoneJobRef.current.get(designId) !== job) return;

      // A matching un-screened crop is required for future 300-DPI rebuilds.
      // If either crop failed to encode, keep the successful halftone but leave
      // its frame untouched rather than pairing mismatched source/result bounds.
      if (!img || (trim && !croppedSourceImage)) {
        trim = null;
        croppedSourceImage = null;
        img = await canvasToPngAsset(cvs);
      }
      if (!img || halftoneJobRef.current.get(designId) !== job) return;

      const halftoneSettings: HalftoneSettings = {
        color: { r: tr, g: tg, b: tb },
        strength,
      };
      // The design is read live rather than from the `design` this call closed
      // over. A screen takes long enough for the artwork to change underneath
      // it — a crop, most obviously — and committing stale imageInfo would put
      // the pre-crop pixels and print source back.
      const current = designsRef.current.find(d => d.id === designId);
      if (!current || (current.halftoneSourceImage ?? current.imageInfo.image) !== src) return;

      const geometry = trim
        ? geometryAfterTrim(current, trim, artboardWidthRef.current, artboardHeightRef.current)
        : null;
      const committedWidth = geometry?.widthInches ?? current.widthInches;
      const committedHeight = geometry?.heightInches ?? current.heightInches;
      const committedScale = Math.max(0.0001, Math.abs(geometry?.transform.s ?? current.transform.s));
      const actualDpi = Math.max(1, Math.round(Math.min(
        img.image.naturalWidth / Math.max(0.01, committedWidth * committedScale),
        img.image.naturalHeight / Math.max(0.01, committedHeight * committedScale),
      )));

      // Draft recovery persists `imageInfo.file`, not the in-memory
      // `halftoneSourceImage`. Once the frame is trimmed, promote that matching
      // un-screened crop to the durable print source. A reload can then decode
      // it and run the normal restored-halftone rebuild without stretching the
      // old full frame into the new tight geometry.
      let sourceFields: Partial<ImageInfo> = {};
      if (trim && croppedSourceImage) {
        const originalName = current.imageInfo.file.name || current.name || "design.png";
        const sourceName = `${originalName.replace(/\.[^/.]+$/, "") || "design"}-halftone-source.png`;
        const sourceFile = new File([croppedSourceImage.blob], sourceName, {
          type: "image/png",
          lastModified: Date.now(),
        });
        sourceFields = {
          file: sourceFile,
          exportBlob: croppedSourceImage.blob,
          exportCrop: undefined,
          svgSource: undefined,
          originalPdfData: undefined,
          vectorInkBox: undefined,
          isPDF: false,
          originalWidth: croppedSourceImage.image.naturalWidth,
          originalHeight: croppedSourceImage.image.naturalHeight,
        };
      }
      const newInfo: ImageInfo = {
        ...current.imageInfo,
        ...sourceFields,
        image: img.image,
        dpi: actualDpi,
      };

      setDesigns(prev => {
        const next = prev.map(d => {
          if (d.id !== designId) return d;
          if ((d.halftoneSourceImage ?? d.imageInfo.image) !== src) return d;
          return {
            ...d,
            ...(geometry ? {
              widthInches: geometry.widthInches,
              heightInches: geometry.heightInches,
              transform: geometry.transform,
            } : {}),
            imageInfo: { ...d.imageInfo, ...sourceFields, image: img.image, dpi: actualDpi },
            originalDPI: actualDpi,
            halftoned: true,
            halftoneSettings,
            halftoneSourceImage: croppedSourceImage?.image ?? src,
            alphaThresholded: true,
          };
        });
        // A rebuild (`skipSnapshot`) re-screens a look this design already has —
        // only a customer-initiated screen splits a copy away from its row of
        // identical siblings. Without that guard, resizing a row of duplicated
        // halftoned copies would shatter it into one row per copy.
        return options?.skipSnapshot ? next : stampEditSplit(next, new Set([designId]), "halftone");
      });
      if (selectedDesignId === designId) {
        setImageInfo(newInfo);
        if (geometry) {
          setResizeSettings(previous => ({
            ...previous,
            widthInches: geometry.widthInches,
            heightInches: geometry.heightInches,
          }));
        }
      }
    };

    void finish();
  }, [
    designs,
    designsRef,
    selectedDesignId,
    saveSnapshot,
    setDesigns,
    setImageInfo,
    setResizeSettings,
    artboardWidthRef,
    artboardHeightRef,
  ]);

  // The editor stores physical size separately from the pixels. Rebuild the
  // screen after a resize so the dot pitch remains 35 LPI at the new printed
  // size instead of stretching the old 300-DPI raster. A short debounce keeps
  // corner-drag resizing responsive and the job token prevents stale results
  // from winning if the user changes size again while processing.
  useEffect(() => {
    const halftoned = designs.filter(d => d.halftoned && d.halftoneSettings);
    if (halftoned.length === 0) {
      halftoneSizeSignatureRef.current = '';
      return;
    }
    const signature = halftoned
      .map(d => `${d.id}:${d.widthInches}:${d.heightInches}:${d.transform.s}`)
      .join('|');
    const hasRestoredSource = halftoned.some(d => !d.halftoneSourceImage);
    const changed = signature !== halftoneSizeSignatureRef.current;
    halftoneSizeSignatureRef.current = signature;
    if (!changed && !hasRestoredSource) return;

    const timer = window.setTimeout(() => {
      for (const d of halftoned) {
        const settings = d.halftoneSettings;
        if (!settings) continue;
        handleApplyHalftone(
          d.id,
          settings.color.r,
          settings.color.g,
          settings.color.b,
          settings.strength,
          { skipSnapshot: true },
        );
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [designs, handleApplyHalftone]);

  /**
   * Toggle the halftone colour-picker dropdown, filling in the design's top colours.
   *
   * This is the only place the colour extractor runs outside the fluorescent product — the
   * halftone screen needs a palette to tint by, and halftone is offered on hot peel too. It
   * goes through the worker for the same reason the fluorescent picker does: matching every
   * pixel of a 512px sample against the hundred-odd palette entries is tens of millions of
   * distance calculations, and on the main thread that lands as a visible stall between the
   * click and the menu appearing.
   */
  const halftoneMenuJobRef = useRef(0);
  const handleOpenHalftoneMenu = useCallback(async () => {
    // Closing needs no palette. Extracting first meant every dismissal paid full price for
    // colours that were on their way off screen.
    if (halftoneMenuOpen) {
      halftoneMenuJobRef.current++;
      setHalftoneMenuOpen(false);
      return;
    }
    const id = selectedDesignId;
    if (!id) return;
    const design = designs.find(d => d.id === id);
    if (!design) return;
    setHalftoneMenuOpen(true);

    const job = ++halftoneMenuJobRef.current;
    const { extractColorsFromImageAsync, extractColorsFromImage } = await import('@/lib/color-extractor');
    let extracted = await extractColorsFromImageAsync(design.imageInfo.image, 8).catch(() => []);
    if (extracted.length === 0) {
      try { extracted = extractColorsFromImage(design.imageInfo.image, 8); } catch { extracted = []; }
    }
    // The menu may have been closed, or another design selected, while the worker ran.
    if (job !== halftoneMenuJobRef.current) return;
    setHalftoneTopColors(extracted.slice(0, 4).map(c => ({
      r: c.rgb.r, g: c.rgb.g, b: c.rgb.b, hex: c.hex, name: c.name,
    })));
  }, [selectedDesignId, designs, halftoneMenuOpen]);

  return {
    ...bag,
    halftoneStrength,
    setHalftoneStrength,
    halftoneMenuOpen,
    setHalftoneMenuOpen,
    halftoneTopColors,
    handleApplyHalftone,
    handleOpenHalftoneMenu,
  };
}

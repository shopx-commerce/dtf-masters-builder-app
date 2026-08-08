import { useState, useCallback, useEffect, useRef } from "react";
import type { ImageInfo, HalftoneSettings, HalftoneStrength } from "@/lib/types";
import { applyHalftoneScreen } from "@/lib/halftone-core";
import { runHalftone } from "@/lib/halftone";
import type { ImageEditorBagAfterUploadCrop } from "./image-editor-hook-bag.types";

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
    saveSnapshot,
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

      await new Promise<void>((resolve) => {
        cvs.toBlob(blob => {
          if (!blob) { resolve(); return; }
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(url);
            if (halftoneJobRef.current.get(designId) === job) {
              const halftoneSettings: HalftoneSettings = {
                color: { r: tr, g: tg, b: tb },
                strength,
              };
              // The design is read live rather than from the `design` this call
              // closed over. A screen takes long enough for the artwork to change
              // underneath it — a crop, most obviously — and committing the stale
              // `imageInfo` put the pre-crop pixels and print source back, so the
              // crop silently reverted and the sheet printed uncropped.
              const current = designsRef.current.find(d => d.id === designId);
              // Screened from artwork this design no longer has. Whatever
              // replaced it triggers its own rebuild, so drop this result rather
              // than screen the sheet from stale pixels.
              if (!current || (current.halftoneSourceImage ?? current.imageInfo.image) !== src) {
                resolve();
                return;
              }
              const newInfo: ImageInfo = { ...current.imageInfo, image: img };
              // halftoned: true  → export pipeline pre-cleans before drawing
              // alphaThresholded → nearest-neighbour scaling in export so
              //   bilinear interpolation cannot reintroduce semi-transparent
              //   edge pixels
              setDesigns(prev => prev.map(d => {
                if (d.id !== designId) return d;
                if ((d.halftoneSourceImage ?? d.imageInfo.image) !== src) return d;
                return {
                  ...d,
                  imageInfo: { ...d.imageInfo, image: img },
                  halftoned: true,
                  halftoneSettings,
                  halftoneSourceImage: src,
                  alphaThresholded: true,
                };
              }));
              if (selectedDesignId === designId) setImageInfo(newInfo);
            }
            resolve();
          };
          img.onerror = () => { URL.revokeObjectURL(url); resolve(); };
          img.src = url;
        }, 'image/png');
      });
    };

    void finish();
  }, [designs, designsRef, selectedDesignId, saveSnapshot, setDesigns, setImageInfo]);

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

  /** Open the halftone colour-picker dropdown, pre-loading top colours. */
  const handleOpenHalftoneMenu = useCallback(async () => {
    const id = selectedDesignId;
    if (!id) return;
    const design = designs.find(d => d.id === id);
    if (!design) return;
    const { extractColorsFromImage } = await import('@/lib/color-extractor');
    const extracted = extractColorsFromImage(design.imageInfo.image, 8);
    const top4 = extracted.slice(0, 4).map(c => ({
      r: c.rgb.r, g: c.rgb.g, b: c.rgb.b, hex: c.hex, name: c.name,
    }));
    setHalftoneTopColors(top4);
    setHalftoneMenuOpen(prev => !prev);
  }, [selectedDesignId, designs]);

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

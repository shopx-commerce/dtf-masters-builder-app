import { useState, useRef, useCallback, useEffect } from "react";
import { cropImageToContent, cropImageToContentAsync, isOpaqueRasterUpload } from "@/lib/image-crop";
// `pdf-parser` and `svg-parser` are imported for their types only, and loaded
// with `await import` at the point a vector file is actually parsed. They carry
// the pdf.js engine and DOMPurify at module scope, which is roughly a third of
// the main bundle, and a session that only ever uploads PNGs never needs either.
// `vector-file` holds the cheap half — the file-kind predicates and the typed
// rejection — so the upload path can recognise and reject a vector eagerly.
import type { ParsedPDFData } from "@/lib/pdf-parser";
import type { ParsedSVGData } from "@/lib/svg-parser";
import { isSVGFile, isEPSFile, SvgTooComplexError } from "@/lib/vector-file";
import { SvgRasterTimeoutError } from "@/lib/svg-raster";
import { trimVectorImport } from "@/lib/vector-trim";
import { runWithConcurrency, resolveUploadConcurrency } from "@/lib/upload-queue";
import { checkFileSizeBudget, checkPixelBudget, VectorFileTooLargeError } from "@/lib/image-budget";
import {
  describeBudgetRejection,
  importRasterForEditor,
  prepareRasterUpload,
  type PreparedRaster,
  PrepareNetworkError,
} from "@/lib/prepare-raster-upload";
import {
  LOW_RES_EFFECTIVE_DPI_THRESHOLD,
  MAX_STORED_IMAGE_DIMENSION,
  RASTER_DPI_FALLBACK,
  UPLOAD_PROGRESS_HIDE_DELAY_MS,
} from "./constants";
import {
  clampDesignToArtboard,
  decodePrintSourceAtSize,
  fetchImageDpi,
  imageHasCleanAlpha,
  isPngWithoutEmbeddedDpi,
  inchesFromPixelsPair,
  normalizeRasterDpiForInches,
} from "./utils";
import {
  applyEditAtPrintResolution,
  applyEditToPreviewSource,
  printSourceFieldsAfterEdit,
} from "@/lib/print-source-edit";
import { createVectorPrintSourceResolver, hasVectorPrintSource } from "@/lib/vector-print-source";
import { VECTOR_TARGET_DPI, vectorPrintDpi } from "@/lib/vector-raster-limits";
import { getUpscaleManager, resolveUpscaleScale } from "@/lib/upscale-manager";
import { getContourWorkerManager } from "@/lib/contour-worker-manager";
import { revokeThumbnailCacheEntry } from "@/lib/thumbnail-cache";
import { saveUploadToLibrary } from "@/lib/uploads-library";
import { detectUpscaleSupport } from "@/lib/upscale-support";
import type { DesignItem, ImageInfo, ResizeSettings } from "@/lib/types";
import type { ImageEditorBagAfterArrange } from "./image-editor-hook-bag.types";
import { useUiActions, getUiSnapshot } from "@/state/ui-store";

/**
 * Name for a PNG re-encode of an upload. Only used when the re-encode replaces
 * the original as `imageInfo.file`, so the extension keeps describing the bytes
 * — the same rename the sidebar's JPEG→PNG conversion already performs.
 */
function pngUploadName(name: string): string {
  return /\.png$/i.test(name) ? name : `${name.replace(/\.[^.]+$/, "")}.png`;
}

/**
 * Toast content for a vector import that was refused for a reason the customer
 * can do something about.
 *
 * `parseSVG` and `parsePDF` throw typed errors that carry both the message keys
 * and the numbers that make the message specific — how many shapes the file
 * asked for, how many seconds we waited. All of them used to be flattened into
 * "Failed to parse SVG", so the one rejection a customer could actually act on
 * read exactly like a corrupt file.
 *
 * Returns null for anything unrecognised so the caller keeps its generic
 * message rather than inventing a specific one it cannot support.
 */
function describeVectorImportError(err: unknown): {
  titleKey: string;
  translationKey: string;
  values: Record<string, string | number>;
} | null {
  if (err instanceof SvgTooComplexError) {
    return {
      titleKey: err.titleKey,
      translationKey: err.translationKey,
      // Grouped, because these are seven-digit numbers by the time the guard
      // fires and "2,097,152" is readable where "2097152" is not.
      values: { shapes: err.report.effectivePrimitives.toLocaleString() },
    };
  }
  if (err instanceof SvgRasterTimeoutError) {
    return {
      titleKey: err.titleKey,
      translationKey: err.translationKey,
      values: { seconds: Math.round(err.timeoutMs / 1000) },
    };
  }
  if (err instanceof VectorFileTooLargeError) {
    const { sizeLabel, maxLabel } = describeBudgetRejection("file_too_large", 0, err.bytes);
    return {
      titleKey: err.titleKey,
      translationKey: err.translationKey,
      values: { size: sizeLabel, max: maxLabel },
    };
  }
  return null;
}

/**
 * The DPI a design will genuinely print at, given the pixels its print source
 * holds and the physical size it is placed at. Reported to the customer, so it
 * describes the print source rather than the editor preview.
 */
function printDpiFor(info: ImageInfo, widthInches: number, heightInches: number): number {
  if (hasVectorPrintSource(info)) {
    // Vector artwork is re-rasterised at the placement size, so the only limit
    // is the canvas ceiling — and the export renders the whole *page* and takes
    // the ink box back out of it, so it is the page that has to fit. A design
    // occupying a tenth of its page needs a ten-times-larger render, which is
    // where a trimmed or cropped vector can fall short of 300 DPI.
    const box = info.vectorInkBox;
    return vectorPrintDpi(
      widthInches / Math.max(0.01, box?.w ?? 1),
      heightInches / Math.max(0.01, box?.h ?? 1),
    );
  }
  const sourceW = info.exportCrop?.width ?? info.image.naturalWidth ?? info.image.width;
  const sourceH = info.exportCrop?.height ?? info.image.naturalHeight ?? info.image.height;
  return Math.max(1, Math.round(Math.min(
    sourceW / Math.max(0.01, widthInches),
    sourceH / Math.max(0.01, heightInches),
  )));
}

/**
 * The design's print-source pixels as an `<img>`, at about `targetW` × `targetH`.
 *
 * Returns null when the design has no separate print source. Used to recover the
 * artwork a halftone has to be rebuilt from: the screened raster only ever lives
 * in `imageInfo.image`, so the print source is always the un-screened original.
 */
async function decodePrintSourceAsImage(
  info: ImageInfo,
  targetW: number,
  targetH: number,
): Promise<HTMLImageElement | null> {
  let blob: Blob | undefined;
  if (hasVectorPrintSource(info)) {
    blob = await createVectorPrintSourceResolver().resolve(info, targetW, targetH);
  }
  if (!blob) {
    if (!info.exportBlob) return null;
    const bitmap = await decodePrintSourceAtSize(info.exportBlob, info.exportCrop, targetW, targetH);
    if (!bitmap) return null;
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) { bitmap.close(); return null; }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    blob = (await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"))) ?? undefined;
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) return null;
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob!);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not decode the print source.")); };
    image.src = url;
  });
}

export function useImageEditorModelUploadCrop(bag: ImageEditorBagAfterArrange) {
  // Only the bag fields these handlers actually use are destructured here;
  // the full bag is still re-spread into the return so downstream consumers are unaffected.
  const {
    toast,
    t,
    isMobile,
    imageInfo,
    setImageInfo,
    resizeSettings,
    setResizeSettings,
    setIsUploading,
    setUploadProgress,
    artboardWidth,
    artboardHeight,
    setArtboardHeight,
    designs,
    setDesigns,
    selectedDesignId,
    selectedDesignIds,
    headerUploadInputRef,
    saveSnapshot,
    selectedDesign,
    GANGSHEET_HEIGHTS,
    artboardWidthRef,
    artboardHeightRef,
    applyImageDirectly,
    thumbnailCacheRef,
    contentFillCacheRef,
    assetDataUrlCacheRef,
    restoredLayerAssetRef,
  } = bag;
  // Actions from the Zustand UI store — replacements for the model's
  // previous `setMobilePanel` / `setContextMenu` / `setCropModalDesignId`.
  const { setMobilePanel, setContextMenu, setCropModalDesignId } = useUiActions();
  const [isUpscaling, setIsUpscaling] = useState(false);
  /** 0..1 while an upscale runs, `null` otherwise. */
  const [upscaleProgress, setUpscaleProgress] = useState<number | null>(null);
  const [canIncreaseQuality, setCanIncreaseQuality] = useState(false);

  useEffect(() => () => { getUpscaleManager().cancel(); }, []);

  // The control appears only once this machine has been measured and found
  // fast enough. A WebGPU adapter existing is not sufficient: on a Windows
  // laptop Chrome routinely binds WebGPU to the integrated GPU with no way to
  // ask for the discrete one, and the gap between the two is more than an
  // order of magnitude. The measurement doubles as the shader warm-up, so it
  // also pays down the first-click latency — but only once a design exists,
  // so an idle page never spins up a GPU session.
  const hasDesigns = designs.length > 0;
  useEffect(() => {
    if (!hasDesigns) return;
    let cancelled = false;
    void detectUpscaleSupport()
      .then(support => (support.available ? getUpscaleManager().isFastEnough() : false))
      .then(usable => { if (!cancelled) setCanIncreaseQuality(usable); });
    return () => { cancelled = true; };
  }, [hasDesigns]);

  const resolveUploadDpi = useCallback(async (
    file: File,
    image: HTMLImageElement,
    suppliedDpi?: number,
    /**
     * Whether the source is cut-out artwork. Supply this when `image` is a
     * content-cropped preview: cropping can remove every transparent pixel,
     * which would make `isOpaqueRasterUpload` misread cut-out art as a photo.
     */
    hasTransparency?: boolean,
  ): Promise<number> => {
    if (suppliedDpi !== undefined) return normalizeRasterDpiForInches(suppliedDpi);

    // `file` must be the original upload, not a downscaled preview: both the
    // header DPI read and the transparent-PNG print fallback below depend on
    // the original container's metadata.
    const dpiRaw = await fetchImageDpi(file).catch((err) => {
      console.warn('[fetchImageDpi] failed:', err);
      return RASTER_DPI_FALLBACK;
    });

    // A transparent PNG without pHYs metadata is the specific class of
    // artwork that needs the 300-DPI print fallback. Do not apply this to
    // opaque/JPEG uploads: those intentionally retain the existing 72-DPI
    // behavior and changing them would make normal designs open smaller.
    const isCutout = hasTransparency ?? !isOpaqueRasterUpload(image);
    const metadataFreeTransparentPng = await isPngWithoutEmbeddedDpi(file) && isCutout;
    const effectiveRawDpi = metadataFreeTransparentPng ? RASTER_DPI_FALLBACK : dpiRaw;
    return normalizeRasterDpiForInches(effectiveRawDpi);
  }, []);

  /**
   * Size gate for PDF and SVG, which never reach `importRasterForEditor` and so
   * had no ceiling of any kind.
   *
   * Both formats retain their entire source — `originalPdfData` for a PDF, the
   * sanitised `svgSource` for an SVG — and a draft save persists that source so
   * a recovered vector design still prints from geometry. It lives in the blob
   * store beside the image rather than inside the draft record, so it is no
   * longer deserialised on every boot, but it still occupies the origin's quota:
   * an accepted 400 MB PDF is 400 MB the customer's next save has to fit around.
   *
   * Returns true when the caller should stop.
   */
  const rejectOversizedVector = useCallback((file: File): boolean => {
    const budget = checkFileSizeBudget(file.size);
    if (budget.ok) return false;
    if (budget.reason === "file_too_large") {
      const { sizeLabel, maxLabel } = describeBudgetRejection("file_too_large", 0, file.size);
      toast({
        title: t("toast.imageTooLarge"),
        description: t("toast.imageTooLargeDesc", { size: sizeLabel, max: maxLabel }),
        variant: "destructive",
      });
    } else {
      toast({ title: t("toast.invalidImage"), description: t("toast.invalidImageDesc"), variant: "destructive" });
    }
    return true;
  }, [toast, t]);

  const handleFallbackImage = useCallback(async (
    file: File,
    image: HTMLImageElement,
    opts?: { dpi?: number; skipCrop?: boolean }
  ) => {
    const dpi = await resolveUploadDpi(file, image, opts?.dpi);

    let croppedCanvas: HTMLCanvasElement | null = null;
    if (opts?.skipCrop) {
      const fullCanvas = document.createElement("canvas");
      fullCanvas.width = image.width;
      fullCanvas.height = image.height;
      const ctx = fullCanvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(image, 0, 0);
        croppedCanvas = fullCanvas;
      }
    }
    if (!croppedCanvas) {
      try { croppedCanvas = cropImageToContent(image); } catch { /* use original */ }
    }

    const processImage = (finalImage: HTMLImageElement, previewFile: File) => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      setIsUploading(false);

      const { widthInches, heightInches } = inchesFromPixelsPair(
        finalImage.naturalWidth || finalImage.width,
        finalImage.naturalHeight || finalImage.height,
        dpi,
      );

      const newImageInfo: ImageInfo = {
        file: previewFile,
        image: finalImage,
        originalWidth: finalImage.width,
        originalHeight: finalImage.height,
        dpi,
      };

      applyImageDirectly(newImageInfo, widthInches, heightInches, imageHasCleanAlpha(finalImage));
      if (isMobile) setMobilePanel("preview");

      const effectiveDPI = Math.min(finalImage.width / widthInches, finalImage.height / heightInches);
      if (effectiveDPI < LOW_RES_EFFECTIVE_DPI_THRESHOLD) {
        toast({
          title: t("toast.lowRes"),
          description: t("toast.lowResDesc"),
          variant: "warning",
        });
      }
    };

    // The cropped canvas is encoded rather than turned into a data URL because
    // the bytes are needed twice: once to decode the preview, and once as the
    // design's `file` when cropping moved the artwork's frame. See the note in
    // `handleImageUpload` on why `file` has to match `image`.
    const croppedBlob = croppedCanvas
      ? await new Promise<Blob | null>(res => croppedCanvas!.toBlob(res, "image/png"))
      : null;
    if (croppedCanvas && croppedBlob) {
      const trimmed =
        croppedCanvas.width !== image.width || croppedCanvas.height !== image.height;
      const previewFile = trimmed
        ? new File([croppedBlob], pngUploadName(file.name), {
            type: "image/png",
            lastModified: file.lastModified,
          })
        : file;
      const objectUrl = URL.createObjectURL(croppedBlob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(objectUrl); processImage(img, previewFile); };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        setIsUploading(false);
        processImage(image, file);
      };
      img.src = objectUrl;
    } else {
      processImage(image, file);
    }
  }, [applyImageDirectly, isMobile, resolveUploadDpi, toast]);

  const handleImageUpload = useCallback(async (
    file: File,
    image: HTMLImageElement,
    uploadOpts?: {
      /**
       * Server prepare result. When set, `file` is still the original upload
       * and `image` is the editor-sized preview.
       */
      prepared?: PreparedRaster;
    },
  ) => {
    const prepared = uploadOpts?.prepared;
    try {
      if (!prepared) {
        const budget = checkPixelBudget(image.width, image.height);
        if (!budget.ok) {
          if (budget.reason === "unreadable_dimensions") {
            toast({ title: t("toast.invalidImage"), description: t("toast.invalidImageDesc"), variant: "destructive" });
          } else {
            const { sizeLabel, maxLabel } = describeBudgetRejection(
              budget.reason === "file_too_large" ? "file_too_large" : "too_many_pixels",
              budget.megapixels,
            );
            toast({
              title: t("toast.imageTooLarge"),
              description: t("toast.imageTooLargeDesc", {
                size: sizeLabel,
                max: maxLabel,
              }),
              variant: "destructive",
            });
          }
          return;
        }
        if (budget.mode === "prepare") {
          setIsUploading(true);
          setUploadProgress(15);
          try {
            const result = await prepareRasterUpload(file);
            setUploadProgress(55);
            await handleImageUpload(file, result.previewImage, { prepared: result });
          } catch (err) {
            console.error("[prepare-raster-upload] failed:", err);
            toast({
              title: t("toast.uploadFailed"),
              description:
                err instanceof PrepareNetworkError
                  ? t(err.kind === "file" ? "toast.uploadFileGoneDesc" : "toast.uploadNetworkDesc")
                  : err instanceof Error ? err.message : t("toast.uploadFailedDesc"),
              variant: "destructive",
            });
            setIsUploading(false);
            setUploadProgress(0);
          }
          return;
        }
      }

      setIsUploading(true);
      setUploadProgress(10);

      await new Promise(r => setTimeout(r, 0));
      setUploadProgress(25);

      const dpi = await resolveUploadDpi(file, image, undefined, prepared?.hasTransparency);
      // Physical size comes from the true source pixel count. For prepared
      // uploads that's the server's content box, not the shrunken preview.
      const sourceW = prepared?.sourceCrop.width ?? image.width;
      const sourceH = prepared?.sourceCrop.height ?? image.height;
      const imgWidthInches = sourceW / dpi;
      const imgHeightInches = sourceH / dpi;
      const ARTBOARD_MATCH_TOLERANCE = 0.05;
      const matchesArtboard =
        Math.abs(imgWidthInches - artboardWidth) / Math.max(artboardWidth, 0.1) <= ARTBOARD_MATCH_TOLERANCE &&
        Math.abs(imgHeightInches - artboardHeight) / Math.max(artboardHeight, 0.1) <= ARTBOARD_MATCH_TOLERANCE;

      const loadImageFromBlob = (blob: Blob): Promise<HTMLImageElement> =>
        new Promise((res, rej) => {
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => { URL.revokeObjectURL(url); res(img); };
          img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("Image load failed")); };
          img.src = url;
        });

      const canvasToBlob = (cvs: HTMLCanvasElement): Promise<Blob | null> =>
        new Promise(res => cvs.toBlob(res, "image/png"));

      let exportBlob: Blob;
      let exportCrop: ImageInfo["exportCrop"];
      let croppedImg: HTMLImageElement;
      let inchWidthPx: number;
      let inchHeightPx: number;

      if (prepared) {
        // The server already oriented the source and measured its content box,
        // so we skip the client full-res crop and never allocate a canvas at
        // source size. The original file stays the print source untouched.
        setUploadProgress(60);
        exportBlob = prepared.sourceBlob;
        exportCrop = prepared.sourceCrop;
        croppedImg = image;
        inchWidthPx = sourceW;
        inchHeightPx = sourceH;
      } else {
        let croppedCanvas: HTMLCanvasElement | null = null;
        if (matchesArtboard) {
          const fullCanvas = document.createElement("canvas");
          fullCanvas.width = image.width;
          fullCanvas.height = image.height;
          const ctx = fullCanvas.getContext("2d", { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(image, 0, 0);
            croppedCanvas = fullCanvas;
          }
        }
        if (!croppedCanvas) {
          if (isOpaqueRasterUpload(image)) {
            const fullCanvas = document.createElement("canvas");
            fullCanvas.width = image.width;
            fullCanvas.height = image.height;
            const fctx = fullCanvas.getContext("2d", { willReadFrequently: true });
            if (fctx) {
              fctx.drawImage(image, 0, 0);
              croppedCanvas = fullCanvas;
            }
          } else {
            croppedCanvas = await cropImageToContentAsync(image);
          }
        }
        if (!croppedCanvas) {
          console.error("Failed to crop image, using original");
          await handleFallbackImage(file, image, { dpi, skipCrop: matchesArtboard });
          return;
        }

        setUploadProgress(60);
        const blob = await canvasToBlob(croppedCanvas);
        setUploadProgress(70);
        if (!blob) {
          await handleFallbackImage(file, image, { dpi, skipCrop: matchesArtboard });
          return;
        }

        try {
          croppedImg = await loadImageFromBlob(blob);
        } catch {
          await handleFallbackImage(file, image, { dpi, skipCrop: matchesArtboard });
          return;
        }
        exportBlob = blob;
        inchWidthPx = croppedImg.naturalWidth || croppedImg.width;
        inchHeightPx = croppedImg.naturalHeight || croppedImg.height;
      }

      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }

      const maxStoredDimension = MAX_STORED_IMAGE_DIMENSION;
      const previewW = croppedImg.naturalWidth || croppedImg.width;
      const previewH = croppedImg.naturalHeight || croppedImg.height;
      const maxDim = Math.max(previewW, previewH);

      if (maxDim > maxStoredDimension) {
        setUploadProgress(75);
        const scale = maxStoredDimension / maxDim;
        const storedWidth = Math.round(previewW * scale);
        const storedHeight = Math.round(previewH * scale);
        const downsampleCanvas = document.createElement("canvas");
        downsampleCanvas.width = storedWidth;
        downsampleCanvas.height = storedHeight;
        const dsCtx = downsampleCanvas.getContext("2d");
        if (!dsCtx) throw new Error("Could not create canvas context for downsampling");
        const preserveCleanAlpha = prepared?.binaryAlpha || imageHasCleanAlpha(croppedImg);
        dsCtx.imageSmoothingEnabled = !preserveCleanAlpha;
        if (!preserveCleanAlpha) dsCtx.imageSmoothingQuality = "high";
        dsCtx.drawImage(croppedImg, 0, 0, storedWidth, storedHeight);
        const dsBlob = await canvasToBlob(downsampleCanvas);
        downsampleCanvas.width = 0;
        downsampleCanvas.height = 0;
        setUploadProgress(85);
        if (dsBlob) {
          try {
            croppedImg = await loadImageFromBlob(dsBlob);
          } catch { /* keep original croppedImg */ }
        }
      } else {
        setUploadProgress(85);
      }

      setUploadProgress(95);
      const { widthInches, heightInches } = inchesFromPixelsPair(inchWidthPx, inchHeightPx, dpi);
      const bw = croppedImg.naturalWidth || croppedImg.width;
      const bh = croppedImg.naturalHeight || croppedImg.height;

      // `file` is what a draft save persists, and restore rebuilds `image` by
      // decoding it, so it has to frame the artwork the same way `image` does.
      // The incoming upload does not whenever content-cropping trimmed
      // transparent margin off it, or the server prepared the preview from it:
      // the design's inch box describes the *cropped* artwork, so restore
      // stretched the whole uncropped bitmap into that box and the artwork came
      // back smaller, re-centred, with its margin reinstated — a recovered sheet
      // printed differently from the one the customer built.
      let previewFile = file;
      if (prepared) {
        previewFile = prepared.previewFile;
      } else if (previewW !== image.width || previewH !== image.height) {
        previewFile = new File([exportBlob], pngUploadName(file.name), {
          type: "image/png",
          lastModified: file.lastModified,
        });
        // Identical bytes to the print source, so keep one Blob rather than two
        // views of the same PNG.
        exportBlob = previewFile;
      }

      const newImageInfo: ImageInfo = {
        file: previewFile,
        image: croppedImg,
        originalWidth: bw,
        originalHeight: bh,
        dpi,
        exportBlob,
        exportCrop,
      };
      applyImageDirectly(newImageInfo, widthInches, heightInches, imageHasCleanAlpha(croppedImg));
      if (isMobile) setMobilePanel("preview");
      if (matchesArtboard) {
        toast({ title: t("toast.gangsheetDetected"), description: t("toast.gangsheetDetectedDesc") });
      }
      setUploadProgress(100);
      setTimeout(() => { setIsUploading(false); setUploadProgress(0); }, UPLOAD_PROGRESS_HIDE_DELAY_MS);

      const effectiveDPI = Math.min(inchWidthPx / widthInches, inchHeightPx / heightInches);
      if (effectiveDPI < LOW_RES_EFFECTIVE_DPI_THRESHOLD) {
        toast({
          title: t("toast.lowRes"),
          description: t("toast.lowResDesc"),
          variant: "warning",
        });
      }
    } catch (error) {
      console.error("Error processing uploaded image:", error);
      setIsUploading(false);
      setUploadProgress(0);
      try {
        const dpiFallback = await resolveUploadDpi(file, image);
        const wIn = image.width / dpiFallback;
        const hIn = image.height / dpiFallback;
        const match = Math.abs(wIn - artboardWidth) / Math.max(artboardWidth, 0.1) <= 0.05 &&
          Math.abs(hIn - artboardHeight) / Math.max(artboardHeight, 0.1) <= 0.05;
        await handleFallbackImage(file, image, { dpi: dpiFallback, skipCrop: match });
      } catch (fallbackErr) {
        console.error("Fallback image processing also failed:", fallbackErr);
        toast({ title: t("toast.uploadFailed"), description: t("toast.uploadFailedDesc"), variant: "destructive" });
      }
    }
  }, [applyImageDirectly, isMobile, resolveUploadDpi, toast, t, handleFallbackImage, artboardWidth, artboardHeight]);

  const handlePDFUpload = useCallback(async (file: File, pdfData: ParsedPDFData) => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    const { image, originalPdfData, dpi, widthInches, heightInches } = pdfData;

    // A PDF page is usually much bigger than the artwork on it, and that empty
    // page would otherwise become the design's footprint on the sheet.
    const trimmed = await trimVectorImport({ image, widthInches, heightInches });
    const finalImage = trimmed?.image ?? image;
    const pngBlob = trimmed?.pngBlob ?? pdfData.pngBlob;

    // Store the rendered page as a PNG File, the same way SVG uploads do, so a
    // PDF behaves like any other 300 DPI PNG downstream. This also repairs
    // draft recovery: restoring a design rebuilds its image with `new Image()`
    // from the stored file, which can never decode raw PDF bytes, so
    // PDF-backed designs previously failed to come back at all.
    const pngFile = new File(
      [pngBlob],
      file.name.replace(/\.pdf$/i, ".png"),
      { type: "image/png" },
    );

    const newImageInfo: ImageInfo = {
      file: pngFile,
      image: finalImage,
      originalWidth: finalImage.naturalWidth || finalImage.width,
      originalHeight: finalImage.naturalHeight || finalImage.height,
      dpi,
      isPDF: true,
      // Retained so the export path can re-render the page at the placement
      // size; `exportBlob` is the fallback if that ever fails.
      originalPdfData,
      exportBlob: pngBlob,
      vectorInkBox: trimmed?.inkBox,
    };

    applyImageDirectly(
      newImageInfo,
      trimmed?.widthInches ?? widthInches,
      trimmed?.heightInches ?? heightInches,
    );
    if (isMobile) setMobilePanel("preview");

    // PDFs out of Word, Canva, and PowerPoint paint an opaque page rectangle,
    // so the "transparent background" the customer assumes they have is
    // actually solid white and prints as a box around the design. Rasters get
    // this warning already; PDFs were silently missing it.
    if (isOpaqueRasterUpload(image)) {
      toast({
        title: t("toast.solidBg"),
        description: t("toast.solidBgDesc"),
        variant: "warning",
      });
    }
  }, [applyImageDirectly, isMobile, toast, t]);

  const handleSVGUpload = useCallback(async (file: File, svgData: ParsedSVGData) => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    // An artboard is usually larger than the artwork drawn on it, and that empty
    // margin would otherwise become the design's footprint on the sheet.
    const trimmed = await trimVectorImport({
      image: svgData.image,
      widthInches: svgData.widthInches,
      heightInches: svgData.heightInches,
    });
    const pngBlob = trimmed?.pngBlob ?? svgData.pngBlob;
    // Store the rasterised PNG as a real File so downstream export
    // paths that reach into `imageInfo.file` receive a PNG.
    const pngFile = new File(
      [pngBlob],
      file.name.replace(/\.svg$/i, ".png"),
      { type: "image/png" },
    );
    const newImageInfo: ImageInfo = {
      file: pngFile,
      image: trimmed?.image ?? svgData.image,
      originalWidth: trimmed?.widthPx ?? svgData.widthPx,
      originalHeight: trimmed?.heightPx ?? svgData.heightPx,
      dpi: svgData.dpi,
      exportBlob: pngBlob,
      // The import raster above is clamped to a screen-safe size. Keeping the
      // sanitised source lets the export path rasterise again at the placement
      // size, so a large design prints at 300 DPI instead of a stretched
      // preview. `exportBlob` remains the fallback if that re-render fails.
      svgSource: svgData.svgSource,
      vectorInkBox: trimmed?.inkBox,
    };
    applyImageDirectly(
      newImageInfo,
      trimmed?.widthInches ?? svgData.widthInches,
      trimmed?.heightInches ?? svgData.heightInches,
      false,
    );
    if (isMobile) setMobilePanel("preview");
  }, [applyImageDirectly, isMobile]);

  const handleBatchStart = useCallback((fileCount: number) => {
    const targetHeight = Math.min(48, GANGSHEET_HEIGHTS[GANGSHEET_HEIGHTS.length - 1]);
    const validHeight = GANGSHEET_HEIGHTS.reduce((best, h) => h <= targetHeight && h > best ? h : best, GANGSHEET_HEIGHTS[0]);
    if (fileCount > 1 && artboardHeightRef.current < validHeight) {
      setArtboardHeight(validHeight);
    }
  }, [GANGSHEET_HEIGHTS]);

  const handleFileUploadUnified = useCallback(async (
    file: File,
    image: HTMLImageElement | null,
    uploadOpts?: { prepared?: PreparedRaster },
  ) => {
    const ext = file.name.toLowerCase();
    const isPdf = file.type === 'application/pdf' || ext.endsWith('.pdf');
    if ((isPdf || isSVGFile(file)) && rejectOversizedVector(file)) return;
    // Persist supported uploads into the sidebar Uploads library
    // (best-effort, fire-and-forget — never blocks or fails the upload).
    //
    // Rasters go now: they carry no reference graph, so the thumbnail the
    // library builds costs their pixel count and nothing more.
    //
    // Vectors wait until their parser has accepted the file, and the ordering
    // is the whole fix. `saveUploadToLibrary` hands the *unmodified* `File` to
    // an `<img>`, so the browser resolves the author's full reference graph on
    // the main thread with no timeout that can fire — the callback would need
    // the very thread the load is holding. Measured on a 2.8 KB depth-30
    // `<use>` chain, that froze the real UI for 46 seconds; at depth 16, from
    // 1.6 KB of source, the main thread was gone for 65,849 ms. Running it
    // after `parseSVG` puts it behind the expansion guard, which analyses the
    // file exactly as authored — which is exactly the document the thumbnail
    // is about to render.
    if (!isPdf && !isSVGFile(file) && image) void saveUploadToLibrary(file);
    if (isPdf) {
      try {
        setIsUploading(true);
        const { parsePDF } = await import("@/lib/pdf-parser");
        const pdfData = await parsePDF(file);
        void saveUploadToLibrary(file);
        await handlePDFUpload(file, pdfData);
        if (pdfData.pageCount > 1) {
          toast({
            title: t("toast.pdfMultiPage"),
            description: t("toast.pdfMultiPageDesc", { pages: pdfData.pageCount }),
            variant: "warning",
          });
        }
        // Text-fidelity warning. Only fires when the PDF actually
        // contains rendered text — plain vector logos (paths only)
        // skip the toast so we don't cry wolf. See ParsedPDFData.hasText
        // for the coarse-but-safe detection strategy.
        if (pdfData.hasText) {
          toast({
            title: t("toast.pdfHasText"),
            description: t("toast.pdfHasTextDesc"),
            variant: "warning",
          });
        }
        if (isMobile) setMobilePanel("preview");
      } catch (err) {
        console.error('PDF parse error:', err);
        const specific = describeVectorImportError(err);
        toast({
          title: specific ? t(specific.titleKey) : t("toast.pdfFailed"),
          description: specific
            ? t(specific.translationKey, specific.values)
            : t("toast.pdfFailedDesc"),
          variant: "destructive",
        });
      } finally {
        setIsUploading(false);
      }
      return;
    }
    if (isSVGFile(file)) {
      try {
        setIsUploading(true);
        const { parseSVG } = await import("@/lib/svg-parser");
        const svgData = await parseSVG(file);
        // Safe here and not a line earlier: see the note above the raster save.
        void saveUploadToLibrary(file);
        await handleSVGUpload(file, svgData);
        // Font warning. Fires when live text asks for a typeface the
        // browser won't have while rendering an `<img>`-loaded SVG —
        // either fetched over the network (blocked) or never embedded at
        // all (Illustrator's default). Outlined text has no `<text>` and
        // so never warns. See analyseSvgFontRisk in svg-parser.ts.
        if (svgData.hasText && (svgData.hasExternalFonts || svgData.hasUnavailableFonts)) {
          toast({
            title: t("toast.svgExternalFont"),
            description: t("toast.svgExternalFontDesc"),
            variant: "warning",
          });
        }
        // Linked artwork can't load inside the sandbox, so it silently
        // disappears from the render. Tell the user rather than let them
        // discover it on the printed sheet.
        if (svgData.hasExternalAssets) {
          toast({
            title: t("toast.svgExternalAsset"),
            description: t("toast.svgExternalAssetDesc"),
            variant: "warning",
          });
        }
        // Artwork instantiated from another file. Same-document `<use>` now
        // renders, but a reference out to a sprite sheet or a URL cannot: the
        // renderer has no network access, so it is simply absent from the
        // preview. Zero for normal artwork.
        if (svgData.droppedInstanceRefs > 0) {
          toast({
            title: t("toast.svgDroppedInstances"),
            description: t("toast.svgDroppedInstancesDesc", { count: svgData.droppedInstanceRefs }),
            variant: "warning",
          });
        }
        // Ambiguous-size warning. Fires when we had to fall back to
        // the viewBox because the SVG author didn't set width/height.
        // The imported size is a "best guess" derived from 96 CSS-px
        // per inch — often several times smaller than the author
        // intended. Telling the user surfaces the resizer proactively.
        if (svgData.dimensionSource === "viewbox" || svgData.dimensionSource === "fallback") {
          toast({
            title: t("toast.svgAmbiguousSize"),
            description: t("toast.svgAmbiguousSizeDesc"),
            variant: "warning",
          });
        }
        if (isMobile) setMobilePanel("preview");
      } catch (err) {
        console.error('SVG parse error:', err);
        const specific = describeVectorImportError(err);
        toast({
          title: specific ? t(specific.titleKey) : t("toast.svgFailed"),
          description: specific
            ? t(specific.translationKey, specific.values)
            : t("toast.svgFailedDesc"),
          variant: "destructive",
        });
      } finally {
        setIsUploading(false);
      }
      return;
    }
    if (isEPSFile(file)) {
      toast({
        title: t("toast.epsUnsupported"),
        description: t("toast.epsUnsupportedDesc"),
        variant: "destructive",
      });
      return;
    }
    if (image) {
      await handleImageUpload(file, image, uploadOpts);
      if (isMobile) setMobilePanel("preview");
    }
  }, [handleImageUpload, handlePDFUpload, handleSVGUpload, isMobile, toast, t, rejectOversizedVector]);

  const processSidebarFile = useCallback((file: File): Promise<void> => {
    const ext = file.name.toLowerCase();
    const isPdf = file.type === 'application/pdf' || ext.endsWith('.pdf');
    const isSvg = isSVGFile(file);
    const isEps = isEPSFile(file);
    const isImage = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || ['.png', '.jpg', '.jpeg', '.webp'].some(x => ext.endsWith(x));
    if (!isImage && !isPdf && !isSvg && !isEps) {
      toast({ title: t("toast.unsupportedFormat"), description: t("toast.formatOnly"), variant: "destructive" });
      return Promise.resolve();
    }
    if (isEps) {
      toast({ title: t("toast.epsUnsupported"), description: t("toast.epsUnsupportedDesc"), variant: "destructive" });
      return Promise.resolve();
    }
    if ((isPdf || isSvg) && rejectOversizedVector(file)) return Promise.resolve();
    // Persist into the sidebar Uploads library (best-effort). Rasters go now;
    // vectors wait until their parser has vetted the file, because the library
    // thumbnails the raw source through an `<img>`. See the matching note in
    // `handleFileUploadUnified` for the measurements.
    if (!isPdf && !isSvg) void saveUploadToLibrary(file);
    if (isSvg) {
      return (async () => {
        try {
          setIsUploading(true);
          const { parseSVG } = await import("@/lib/svg-parser");
          const svgData = await parseSVG(file);
          void saveUploadToLibrary(file);
          await handleSVGUpload(file, svgData);
          // Mirror the warnings surfaced by `handleFileUploadUnified`
          // so drag-and-drop into the sidebar behaves identically to
          // clicking the file picker. See that function's comments
          // for why each warning fires.
          if (svgData.hasText && (svgData.hasExternalFonts || svgData.hasUnavailableFonts)) {
            toast({
              title: t("toast.svgExternalFont"),
              description: t("toast.svgExternalFontDesc"),
              variant: "warning",
            });
          }
          if (svgData.hasExternalAssets) {
            toast({
              title: t("toast.svgExternalAsset"),
              description: t("toast.svgExternalAssetDesc"),
              variant: "warning",
            });
          }
          if (svgData.droppedInstanceRefs > 0) {
            toast({
              title: t("toast.svgDroppedInstances"),
              description: t("toast.svgDroppedInstancesDesc", { count: svgData.droppedInstanceRefs }),
              variant: "warning",
            });
          }
          if (svgData.dimensionSource === "viewbox" || svgData.dimensionSource === "fallback") {
            toast({
              title: t("toast.svgAmbiguousSize"),
              description: t("toast.svgAmbiguousSizeDesc"),
              variant: "warning",
            });
          }
        } catch (err) {
          console.error('SVG parse error:', err);
          const specific = describeVectorImportError(err);
          toast({
            title: specific ? t(specific.titleKey) : t("toast.svgFailed"),
            description: specific
              ? t(specific.translationKey, specific.values)
              : t("toast.svgFailedDesc"),
            variant: "destructive",
          });
        } finally {
          setIsUploading(false);
        }
      })();
    }
    if (isPdf) {
      return (async () => {
        try {
          setIsUploading(true);
          const { parsePDF } = await import("@/lib/pdf-parser");
          const pdfData = await parsePDF(file);
          void saveUploadToLibrary(file);
          await handlePDFUpload(file, pdfData);
          if (pdfData.pageCount > 1) {
            toast({
              title: t("toast.pdfMultiPage"),
              description: t("toast.pdfMultiPageDesc", { pages: pdfData.pageCount }),
              variant: "warning",
            });
          }
          if (pdfData.hasText) {
            toast({
              title: t("toast.pdfHasText"),
              description: t("toast.pdfHasTextDesc"),
              variant: "warning",
            });
          }
        } catch (err) {
          console.error('PDF parse error:', err);
          const specific = describeVectorImportError(err);
          toast({
            title: specific ? t(specific.titleKey) : t("toast.pdfFailed"),
            description: specific
              ? t(specific.translationKey, specific.values)
              : t("toast.pdfFailedShort"),
            variant: "destructive",
          });
        } finally {
          setIsUploading(false);
        }
      })();
    }
    return (async () => {
      try {
        await importRasterForEditor(file, {
          onPrepared: async (prepared) => {
            await handleImageUpload(file, prepared.previewImage, { prepared });
          },
          onInline: async (rasterFile, img) => {
            const isPng = rasterFile.type === "image/png" || rasterFile.name.toLowerCase().endsWith(".png");
            if (!isPng) {
              const c = document.createElement("canvas");
              c.width = img.width;
              c.height = img.height;
              const ctx = c.getContext("2d", { willReadFrequently: true });
              if (!ctx) {
                await handleImageUpload(rasterFile, img);
                return;
              }
              ctx.drawImage(img, 0, 0);
              const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/png"));
              c.width = 0;
              c.height = 0;
              if (!blob) {
                await handleImageUpload(rasterFile, img);
                return;
              }
              const pf = new File([blob], rasterFile.name.replace(/\.\w+$/, ".png"), { type: "image/png" });
              const pi = await new Promise<HTMLImageElement>((resolve, reject) => {
                const imageEl = new Image();
                const u2 = URL.createObjectURL(blob);
                imageEl.onload = () => { URL.revokeObjectURL(u2); resolve(imageEl); };
                imageEl.onerror = () => { URL.revokeObjectURL(u2); reject(new Error("PNG convert failed")); };
                imageEl.src = u2;
              }).catch(async () => {
                await handleImageUpload(rasterFile, img);
                return null;
              });
              if (!pi) return;
              await handleImageUpload(pf, pi);
              return;
            }
            await handleImageUpload(rasterFile, img);
          },
          onReject: (reason, megapixels) => {
            if (reason === "unreadable_dimensions") {
              toast({ title: t("toast.invalidImage"), description: t("toast.invalidImageDesc"), variant: "destructive" });
              return;
            }
            const { sizeLabel, maxLabel } = describeBudgetRejection(reason, megapixels, file.size);
            toast({
              title: t("toast.imageTooLarge"),
              description: t("toast.imageTooLargeDesc", { size: sizeLabel, max: maxLabel }),
              variant: "destructive",
            });
          },
        });
      } catch (err) {
        console.error("[sidebar-upload] raster import failed:", err);
        toast({
          title: t("toast.uploadFailed"),
          description:
            err instanceof PrepareNetworkError
              ? t(err.kind === "file" ? "toast.uploadFileGoneDesc" : "toast.uploadNetworkDesc")
              : err instanceof Error ? err.message : t("toast.failedLoadFile", { name: file.name }),
          variant: "destructive",
        });
      }
    })();
  }, [handleImageUpload, handlePDFUpload, handleSVGUpload, toast, t, rejectOversizedVector]);

  const handleSidebarFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    if (files.length > 1) {
      const targetHeight = Math.min(48, GANGSHEET_HEIGHTS[GANGSHEET_HEIGHTS.length - 1]);
      const validHeight = GANGSHEET_HEIGHTS.reduce((best, h) => h <= targetHeight && h > best ? h : best, GANGSHEET_HEIGHTS[0]);
      if (artboardHeightRef.current < validHeight) {
        setArtboardHeight(validHeight);
      }
    }
    // Yield-between-items keeps the main thread free to paint upload
    // progress bars while long-running decodes are in flight.
    await runWithConcurrency(files, (file) => processSidebarFile(file), {
      concurrency: resolveUploadConcurrency(),
      onError: (error, file) => console.error(`Upload failed for ${file.name}:`, error),
    });
  }, [processSidebarFile, GANGSHEET_HEIGHTS]);

  useEffect(() => {
    const onOpenUpload = () => {
      headerUploadInputRef.current?.click();
    };
    window.addEventListener("dtf:open-upload", onOpenUpload);
    return () => {
      window.removeEventListener("dtf:open-upload", onOpenUpload);
    };
  }, []);

  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    if (files.length > 1) {
      const targetHeight = Math.min(48, GANGSHEET_HEIGHTS[GANGSHEET_HEIGHTS.length - 1]);
      const validHeight = GANGSHEET_HEIGHTS.reduce((best, h) => h <= targetHeight && h > best ? h : best, GANGSHEET_HEIGHTS[0]);
      if (artboardHeightRef.current < validHeight) {
        setArtboardHeight(validHeight);
      }
    }
    await runWithConcurrency(files, (file) => processSidebarFile(file), {
      concurrency: resolveUploadConcurrency(),
      onError: (error, file) => console.error(`Upload failed for ${file.name}:`, error),
    });
  }, [processSidebarFile, GANGSHEET_HEIGHTS]);

  /**
   * The three values `handleResizeChange` reads but does not want in its dependency list.
   *
   * `selectedDesign` is a `useMemo` on `[designs, selectedDesignId]` and `imageInfo` moves
   * with the artwork, so listing them made this callback change identity on every design
   * mutation — including every frame of a drag. It is passed to `ControlsSection` as
   * `onResizeChange`, and that identity churn was defeating the component's `React.memo`,
   * re-rendering two closed thirteen-option height dropdowns per frame for nothing.
   */
  const resizeLiveRef = useRef({ imageInfo, selectedDesign, resizeSettings });
  resizeLiveRef.current = { imageInfo, selectedDesign, resizeSettings };

  const handleResizeChange = useCallback((newSettings: Partial<ResizeSettings>) => {
    const { imageInfo, selectedDesign, resizeSettings } = resizeLiveRef.current;
    const currentImageInfo = selectedDesign?.imageInfo || imageInfo;
    const hasSizeChange = newSettings.widthInches !== undefined || newSettings.heightInches !== undefined;
    if (hasSizeChange && selectedDesignId) saveSnapshot();

    const canComputeAspect = currentImageInfo?.originalWidth && currentImageInfo?.originalHeight;
    let finalSettings: ResizeSettings = resizeSettings;
    setResizeSettings(prev => {
      const updated = { ...prev, ...newSettings };

      if (updated.maintainAspectRatio && canComputeAspect && newSettings.widthInches !== undefined) {
        const aspectRatio = currentImageInfo!.originalHeight / currentImageInfo!.originalWidth;
        updated.heightInches = Math.max(0.01, parseFloat((newSettings.widthInches! * aspectRatio).toFixed(1)));
      } else if (updated.maintainAspectRatio && canComputeAspect && newSettings.heightInches !== undefined) {
        const aspectRatio = currentImageInfo!.originalWidth / currentImageInfo!.originalHeight;
        updated.widthInches = Math.max(0.01, parseFloat((newSettings.heightInches! * aspectRatio).toFixed(1)));
      }

      finalSettings = updated;
      return updated;
    });

    if (hasSizeChange && selectedDesignId) {
      const abW = artboardWidthRef.current;
      const abH = artboardHeightRef.current;
      setDesigns(prev => prev.map(d => {
        if (d.id !== selectedDesignId) return d;
        const updated = { ...d, widthInches: finalSettings.widthInches, heightInches: finalSettings.heightInches };
        const { nx, ny } = clampDesignToArtboard(updated, abW, abH);
        return { ...updated, transform: { ...updated.transform, nx, ny } };
      }));
    }
  }, [selectedDesignId, saveSnapshot]);

  /**
   * Upscales the selected design with the local WebGPU super-resolution model.
   *
   * The edit deliberately runs against the design's *print source*, not the
   * preview: the preview is capped at `MAX_STORED_IMAGE_DIMENSION` and export
   * ignores it entirely, so upscaling what is on screen — which is what the
   * previous server-backed implementation did — improved nothing that ever
   * reached the film.
   */
  const handleIncreaseQuality = useCallback(async (scaleFactor: number) => {
    const design = selectedDesignId ? designs.find(d => d.id === selectedDesignId) : null;
    const sourceInfo = design?.imageInfo ?? imageInfo;
    if (!design || !sourceInfo?.image || isUpscaling) return;

    // Vector artwork is re-rasterised at placement size on export, so it is
    // already resolution-independent. Upscaling would bake it to fixed pixels,
    // which is strictly a downgrade.
    if (hasVectorPrintSource(sourceInfo)) {
      toast({ title: t("toast.upscaleNotNeeded"), description: t("toast.upscaleVectorDesc") });
      return;
    }

    let skipReason: string | null = null;
    let appliedScale = 0;

    /**
     * The size the design actually prints at.
     *
     * `widthInches` is the size it had at upload and stays there: resizing with
     * proportional lock on writes `transform.s` instead. Export, the cart and
     * the size field all read `widthInches * transform.s`, and measuring
     * against `widthInches` alone made this refuse every design that had been
     * scaled up — precisely the ones printing soft. The canvas being measured
     * is itself capped at `widthInches * 300`, so for any source with at least
     * 300 px per original inch the old figure pinned to exactly 300 and the
     * design was always rejected as already sharp, whatever it was scaled to.
     */
    const placedScale = Math.max(0.01, design.transform.s || 1);
    const placedWidthInches = Math.max(0.01, design.widthInches * placedScale);
    const placedHeightInches = Math.max(0.01, design.heightInches * placedScale);

    /** Runs the model over one full-resolution canvas and returns its replacement. */
    const upscaleCanvas = async (canvas: HTMLCanvasElement): Promise<HTMLCanvasElement> => {
      const currentDpi = Math.min(
        canvas.width / placedWidthInches,
        canvas.height / placedHeightInches,
      );
      if (currentDpi >= VECTOR_TARGET_DPI) {
        skipReason = "toast.upscaleAlreadySharpDesc";
        throw new Error(skipReason);
      }
      const scale = resolveUpscaleScale(canvas.width, canvas.height, scaleFactor);
      if (scale === 0) {
        skipReason = "toast.upscaleTooLargeDesc";
        throw new Error(skipReason);
      }

      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Could not read the design's pixels.");
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = await getUpscaleManager().upscale(
        pixels.data,
        canvas.width,
        canvas.height,
        scale,
        ({ completed, total }) => setUpscaleProgress(total > 0 ? completed / total : 0),
      );
      appliedScale = scale;
      console.info("[upscale]", {
        source: `${canvas.width}x${canvas.height}`,
        output: `${result.width}x${result.height}`,
        scale,
        ...result.timings,
      });

      const out = document.createElement("canvas");
      out.width = result.width;
      out.height = result.height;
      const outContext = out.getContext("2d", { willReadFrequently: true });
      if (!outContext) throw new Error("Could not create the upscaled canvas.");
      outContext.putImageData(new ImageData(result.rgba, result.width, result.height), 0, 0);
      return out;
    };

    setIsUpscaling(true);
    setUpscaleProgress(0);
    toast({ title: t("toast.upscaleStarted"), description: t("toast.upscaleStartedDesc") });
    try {
      const edited = await applyEditAtPrintResolution(
        sourceInfo,
        placedWidthInches,
        placedHeightInches,
        upscaleCanvas,
      );
      // No separate print source means the preview *is* the print source, so
      // there is nothing higher-resolution to prefer — upscale it directly.
      const applied = edited
        ?? await applyEditToPreviewSource(sourceInfo, MAX_STORED_IMAGE_DIMENSION, upscaleCanvas);
      if (!applied) throw new Error(t("toast.upscaleFailedDesc"));

      const nextDpi = Math.round(Math.min(
        applied.sourceWidth / placedWidthInches,
        applied.sourceHeight / placedHeightInches,
      ));
      const nextInfo: ImageInfo = {
        ...sourceInfo,
        ...printSourceFieldsAfterEdit(applied),
        originalWidth: applied.sourceWidth,
        originalHeight: applied.sourceHeight,
        isPDF: false,
        // `printSourceFieldsAfterEdit` derives DPI from the *pre-edit* render,
        // which is right for a crop and wrong for an edit that multiplies the
        // pixel count. Take it from what the upscale actually produced.
        dpi: nextDpi,
      };

      saveSnapshot();
      const oldSrc = sourceInfo.image.src;
      revokeThumbnailCacheEntry(thumbnailCacheRef.current, oldSrc);
      contentFillCacheRef.current.delete(oldSrc);
      assetDataUrlCacheRef.current.delete(design.id);
      restoredLayerAssetRef.current.delete(design.id);
      getContourWorkerManager().clearCache();
      setDesigns(prev => prev.map(current => current.id === design.id
        ? {
            ...current,
            imageInfo: nextInfo,
            originalDPI: nextDpi,
            alphaThresholded: false,
            halftoned: false,
            halftoneSettings: undefined,
            halftoneSourceImage: undefined,
          }
        : current
      ));
      setImageInfo(nextInfo);
      setResizeSettings(prev => ({ ...prev, widthInches: design.widthInches, heightInches: design.heightInches }));
      toast({ title: t("toast.upscaleSuccess"), description: t("toast.upscaleSuccessDesc", { scale: appliedScale }) });
    } catch (error) {
      if (skipReason) {
        toast({ title: t("toast.upscaleNotNeeded"), description: t(skipReason) });
      } else if (error instanceof Error && error.message === "cancelled") {
        // Nothing to say: the customer asked for this by navigating away.
      } else {
        console.error("[upscale] failed:", error);
        toast({
          title: t("toast.upscaleFailed"),
          description: t("toast.upscaleFailedDesc"),
          variant: "destructive",
        });
      }
    } finally {
      setIsUpscaling(false);
      setUpscaleProgress(null);
    }
  }, [
    selectedDesignId,
    designs,
    imageInfo,
    isUpscaling,
    toast,
    t,
    saveSnapshot,
    thumbnailCacheRef,
    contentFillCacheRef,
    assetDataUrlCacheRef,
    restoredLayerAssetRef,
  ]);


  /** Snaps alpha to fully opaque or fully clear. Resolution-independent. */
  const hardenAlpha = useCallback((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data;
    for (let i = 3; i < data.length; i += 4) {
      data[i] = data[i] >= 128 ? 255 : 0;
    }
    ctx.putImageData(imgData, 0, 0);
  }, []);

  const thresholdAlphaOnPreview = useCallback((info: ImageInfo): Promise<ImageInfo | null> => {
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
        hardenAlpha(cvs);
        cvs.toBlob(blob => {
          if (!blob) { resolve(null); return; }
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(url);
            // This branch runs when the preview *is* the print source, so the
            // hardened pixels have to become `file` too — otherwise a draft
            // restore decodes the pre-threshold bytes and the cleaned edges the
            // customer accepted are silently thrown away.
            resolve({
              ...info,
              image: img,
              file: new File([blob], pngUploadName(info.file.name), {
                type: "image/png",
                lastModified: Date.now(),
              }),
            });
          };
          img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
          img.src = url;
        }, 'image/png');
      } catch { resolve(null); }
    });
  }, [hardenAlpha]);

  const thresholdAlphaForDesign = useCallback(async (
    info: ImageInfo,
    widthInches: number,
    heightInches: number,
  ): Promise<ImageInfo | null> => {
    // Harden the full-resolution print source, otherwise the cleaned edges the
    // customer sees are discarded and the soft originals get printed.
    //
    // `applyEditAtPrintResolution` reports two different things that used to be
    // collapsed into one by `.catch(() => null)`. `null` means the design has no
    // separate print source, so editing the preview *is* editing what prints.
    // A rejection means the design does have one and the edit did not reach it —
    // the PNG encoder could not allocate, or the result would not decode, both
    // realistic on a full gangsheet under memory pressure. Falling back to a
    // preview-only edit there kept `exportBlob` / `svgSource` in place, and
    // since export prefers them the customer saw hardened edges and received the
    // original soft ones, or for a vector received the untouched artwork.
    //
    // So a rejection fails the edit outright rather than half-applying it. The
    // alternative — clearing every print-source field to make the edited preview
    // authoritative — turns a transient allocation failure into a permanent
    // resolution loss (a 20 inch design drops from 300 DPI to about 205) or, for
    // a vector, throws the geometry away for good. Changing nothing is
    // recoverable: the caller reports the failure and the customer can retry.
    const hasPrintSource = !!info.exportBlob || hasVectorPrintSource(info);
    let edited: Awaited<ReturnType<typeof applyEditAtPrintResolution>>;
    try {
      edited = await applyEditAtPrintResolution(info, widthInches, heightInches, hardenAlpha);
    } catch (err) {
      console.error("[alpha-threshold] print-resolution edit failed:", err);
      return null;
    }
    if (edited) return { ...info, ...printSourceFieldsAfterEdit(edited) };
    // A design with a print source that still produced no result could not be
    // decoded. Same reasoning as the rejection above: report, change nothing.
    if (hasPrintSource) {
      console.error("[alpha-threshold] print source could not be decoded; leaving the design untouched");
      return null;
    }
    return await thresholdAlphaOnPreview(info);
  }, [hardenAlpha, thresholdAlphaOnPreview]);

  const handleThresholdAlpha = useCallback(async () => {
    try {
      const targetIds = selectedDesignIds.size > 0 ? Array.from(selectedDesignIds) : (selectedDesignId ? [selectedDesignId] : []);
      if (targetIds.length === 0) return;
      saveSnapshot();
      const targetDesigns = designs.filter(d => targetIds.includes(d.id));
      const results = await Promise.all(targetDesigns.map(d => thresholdAlphaForDesign(d.imageInfo, d.widthInches, d.heightInches)));
      const updates = new Map<string, ImageInfo>();
      targetDesigns.forEach((d, i) => { if (results[i]) updates.set(d.id, results[i]!); });
      if (updates.size === 0) { toast({ title: t("toast.alphaFailed"), description: t("toast.alphaFailedDesc"), variant: "destructive" }); return; }
      setDesigns(prev => prev.map(d => {
        const newInfo = updates.get(d.id);
        return newInfo ? { ...d, imageInfo: newInfo, alphaThresholded: true } : d;
      }));
      if (selectedDesignId && updates.has(selectedDesignId)) setImageInfo(updates.get(selectedDesignId)!);
      toast({ title: t("toast.alphaApplied"), description: updates.size !== 1 ? t("toast.alphaAppliedDescPlural", { count: updates.size }) : t("toast.alphaAppliedDesc", { count: updates.size }) });
    } catch (err) {
      console.error('Alpha threshold failed:', err);
      toast({ title: t("toast.alphaFailed"), description: t("toast.alphaFailedDesc"), variant: "destructive" });
    }
  }, [designs, selectedDesignId, selectedDesignIds, saveSnapshot, toast, thresholdAlphaForDesign]);

  const handleThresholdAlphaAll = useCallback(async () => {
    try {
      if (designs.length === 0) return;
      saveSnapshot();
      const results = await Promise.all(designs.map(d => thresholdAlphaForDesign(d.imageInfo, d.widthInches, d.heightInches)));
      const updates = new Map<string, ImageInfo>();
      designs.forEach((d, i) => { if (results[i]) updates.set(d.id, results[i]!); });
      if (updates.size === 0) { toast({ title: t("toast.alphaFailed"), description: t("toast.alphaFailedAllDesc"), variant: "destructive" }); return; }
      setDesigns(prev => prev.map(d => {
        const newInfo = updates.get(d.id);
        return newInfo ? { ...d, imageInfo: newInfo, alphaThresholded: true } : d;
      }));
      if (selectedDesignId && updates.has(selectedDesignId)) setImageInfo(updates.get(selectedDesignId)!);
      toast({ title: t("toast.alphaAllApplied"), description: updates.size !== 1 ? t("toast.alphaAppliedDescPlural", { count: updates.size }) : t("toast.alphaAppliedDesc", { count: updates.size }) });
    } catch (err) {
      console.error('Alpha threshold all failed:', err);
      toast({ title: t("toast.alphaFailed"), description: t("toast.alphaFailedAllDesc"), variant: "destructive" });
    }
  }, [designs, selectedDesignId, saveSnapshot, toast, thresholdAlphaForDesign]);

  const handleCropDesign = useCallback(() => {
    // Read the current right-click target imperatively — the callback
    // identity should be stable across contextMenu open/close so
    // downstream memoization doesn't churn on every right-click.
    const menu = getUiSnapshot().contextMenu;
    const id = menu?.designId ?? selectedDesignId;
    if (id) {
      setCropModalDesignId(id);
      setContextMenu(null);
    }
  }, [selectedDesignId, setCropModalDesignId, setContextMenu]);

  const handleCropApply = useCallback(async (designId: string, newImageInfo: ImageInfo) => {
    const design = designs.find(d => d.id === designId);
    if (!design) return;
    saveSnapshot();
    const aspect = design.widthInches / design.heightInches;
    const newAspect = newImageInfo.image.naturalWidth / newImageInfo.image.naturalHeight;
    let widthInches = design.widthInches;
    let heightInches = design.heightInches;
    if (Math.abs(newAspect - aspect) > 0.01) {
      heightInches = widthInches / newAspect;
    }

    // The DPI badge reads `imageInfo.dpi` directly, and the crop keeps the
    // design's physical width while removing pixels from it, so the pre-crop
    // value describes resolution the design no longer has.
    const info: ImageInfo = { ...newImageInfo, dpi: printDpiFor(newImageInfo, widthInches, heightInches) };

    // The halftone rebuild re-screens from `halftoneSourceImage`, and the crop
    // changes `heightInches`, which is part of the signature it watches. Left
    // pointing at the pre-crop artwork it rebuilt — and re-committed — the
    // uncropped design about 180 ms later, so the crop visibly reverted and the
    // sheet printed uncropped. Halftoning never touches the print source, so the
    // cropped print source is exactly the un-screened artwork to rebuild from.
    let designFields: Partial<DesignItem> = {};
    if (design.halftoned || design.halftoneSourceImage) {
      const source = await decodePrintSourceAsImage(
        info,
        info.image.naturalWidth || info.image.width,
        info.image.naturalHeight || info.image.height,
      ).catch(err => {
        console.error("[crop] could not re-derive the halftone source:", err);
        return null;
      });
      if (source) {
        designFields = { halftoneSourceImage: source };
      } else {
        // Nothing left to re-screen from. Keeping `halftoned` would rebuild from
        // the already-screened preview and print a screen of a screen, so the
        // halftone is dropped and the customer is told rather than left to find
        // out on the sheet. `alphaThresholded` stays: the crop is a whole-pixel
        // blit, so the alpha it describes is still binary.
        designFields = { halftoned: false, halftoneSettings: undefined, halftoneSourceImage: undefined };
        toast({
          title: t("toast.cropHalftoneCleared"),
          description: t("toast.cropHalftoneClearedDesc"),
          variant: "warning",
        });
      }
    }

    setDesigns(prev => prev.map(d =>
      d.id === designId
        ? { ...d, ...designFields, imageInfo: info, widthInches, heightInches }
        : d
    ));
    if (selectedDesignId === designId) setImageInfo(info);
    setResizeSettings(prev => ({ ...prev, widthInches, heightInches }));
    setCropModalDesignId(null);
    toast({ title: t("toast.cropApplied"), description: t("toast.cropAppliedDesc") });
  }, [designs, selectedDesignId, saveSnapshot, toast, t, setImageInfo, setDesigns, setResizeSettings, setCropModalDesignId]);


  // Only handlers consumed outside this hook (via the merged bag → context → UI) are exposed.
  // Internal helpers (handleImageUpload/handlePDFUpload/handleFallbackImage/processSidebarFile/
  // thresholdAlphaForDesign) and drag internals (setIsDragOver/dragCounterRef) stay private.
  // applyImageDirectly is intentionally not re-listed — it already flows through `...bag`.
  return {
    ...bag,
    handleBatchStart,
    handleFileUploadUnified,
    handleSidebarFileChange,
    processSidebarFile,
    isDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handleResizeChange,
    handleThresholdAlpha,
    handleThresholdAlphaAll,
    handleCropDesign,
    handleCropApply,
    handleIncreaseQuality,
    isUpscaling,
    upscaleProgress,
    canIncreaseQuality,
  };
}

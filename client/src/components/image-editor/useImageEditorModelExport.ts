import { useCallback, useRef } from "react";
import { EXPORT_DPI, EXPORT_TIMEOUT_MS } from "./constants";
import {
  assertExportCanvasNotBlank,
  assertPrintSourcesReadable,
  assertValidPdfBytes,
  BLANK_EXPORT_MESSAGE,
  canUseMemoryEfficientPngExport,
  canvasHasInk,
  decodePrintSourceAtSize,
  exportPngWithWorker,
  getDesignLabel,
  getExportMemoryWarning,
  injectPngDpi,
  resolveExportDpi,
} from "./utils";
import { drawPrintLabel, labelReadsUpsideDown } from "@/lib/print-label";
import { drawPrintLabelOnPdfPage } from "@/lib/print-label-pdf";
import { triggerDownload } from "@/lib/download-file";
import type { ImageEditorBagAfterUploadCrop } from "./image-editor-hook-bag.types";
import { thresholdImageInfo } from "./useImageEditorModelHalftone";
import { isRecoverableImageInfo } from "@/lib/editor-draft-storage";
import { createVectorPrintSourceResolver, materialShortfalls } from "@/lib/vector-print-source";

export function useImageEditorModelExport(bag: ImageEditorBagAfterUploadCrop) {
  // Only the bag fields handleDownload actually uses are destructured here;
  // the full bag is still re-spread into the return so downstream consumers are unaffected.
  const {
    designs,
    imageInfo,
    artboardWidth,
    artboardHeight,
    toast,
    t,
    setIsProcessing,
    setExportProgressLabel,
    ensureDesignImagesAvailable,
  } = bag;

  /**
   * The sheet as it stands, read at the moment Download is pressed rather than captured in
   * the callback's dependency list.
   *
   * Export cares about the current sheet, so listing `designs` here was correct but
   * expensive: it gave `handleDownload` a new identity on every design mutation, and since
   * it is passed to `ControlsSection` as `onDownload` that alone defeated the component's
   * `React.memo` for the whole of every drag.
   */
  const exportLiveRef = useRef({ imageInfo, designs, artboardWidth, artboardHeight });
  exportLiveRef.current = { imageInfo, designs, artboardWidth, artboardHeight };

  const handleDownload = useCallback(async (downloadType: string = 'standard', format: string = 'png', spotColorsByDesign?: Record<string, any[]>) => {
    const { imageInfo, designs, artboardWidth, artboardHeight } = exportLiveRef.current;
    if (designs.length === 0) {
      toast({ title: t("toast.noDesigns"), description: t("toast.noDesignsDesc"), variant: "destructive" });
      return;
    }

    setIsProcessing(true);

    try {
      const exportDesigns = await ensureDesignImagesAvailable(designs);
      if (exportDesigns.some(design => !isRecoverableImageInfo(design.imageInfo))) {
        throw new Error("A design image could not be reloaded. Your progress is saved; recover the draft and try again.");
      }
      const firstName = (exportDesigns[0]?.name || imageInfo?.file.name || 'gangsheet').replace(/\.[^/.]+$/, '');

      await new Promise(r => setTimeout(r, 50));

      // Print source selection, matching the add-to-cart path.
      //
      // `imageInfo.image` is only the editor preview: rasters are capped at
      // MAX_STORED_IMAGE_DIMENSION and vectors at a screen-safe canvas size.
      // Drawing the download from it meant a design placed larger than its
      // preview was upscaled — a 12 in raster printed from 2000 px of real
      // detail, and a 20 in vector from 4096 px. `exportBlob` holds the
      // full-resolution source and gets decoded at the placement size instead,
      // with vector artwork re-rasterised from its retained geometry.
      //
      // Halftoned designs are the exception: their thresholded preview *is* the
      // artwork, so they keep drawing from `image`.
      const vectorSources = createVectorPrintSourceResolver();
      const vectorSourceByDesignId = new Map<string, Blob>();
      await Promise.all(
        exportDesigns.map(async d => {
          if (d.halftoned) return;
          const drawW = Math.max(1, Math.round(d.widthInches * d.transform.s * EXPORT_DPI));
          const drawH = Math.max(1, Math.round(d.heightInches * d.transform.s * EXPORT_DPI));
          const blob = await vectorSources.resolve(d.imageInfo, drawW, drawH);
          if (blob) vectorSourceByDesignId.set(d.id, blob);
        }),
      );
      const printSourceFor = (d: typeof exportDesigns[number]): Blob | undefined =>
        d.halftoned ? undefined : (vectorSourceByDesignId.get(d.id) ?? d.imageInfo.exportBlob);
      const printSourceCropFor = (d: typeof exportDesigns[number]) =>
        d.halftoned || vectorSourceByDesignId.has(d.id) ? undefined : d.imageInfo.exportCrop;

      // Check every print source is still readable before rendering anything.
      // A gangsheet takes minutes; finding out afterwards that one design's
      // original has moved wastes all of it, and the render would otherwise
      // substitute the capped preview and hand back a soft file that looks fine.
      await assertPrintSourcesReadable(
        exportDesigns.map(d => ({ source: printSourceFor(d), label: d.name })),
      );

      if (format === 'pdf') {
        const { PDFDocument, degrees } = await import('pdf-lib');
        const { addSpotColorVectorsToPDF } = await import('@/lib/spot-color-vectors');

        const exportDpi = EXPORT_DPI;
        const pageWidthPt = artboardWidth * 72;
        const pageHeightPt = artboardHeight * 72;
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);

        /**
         * Whether ANY design contributed visible pixels. Accumulated rather than asserted per
         * design, matching the PNG paths' semantics: the failure worth catching is "the sheet
         * rendered nothing", and a single legitimately transparent design must not fail the export.
         * Checked once after the loop.
         */
        let sawInk = false;
        for (const design of exportDesigns) {
          const drawW = Math.round(design.widthInches * design.transform.s * exportDpi);
          const drawH = Math.round(design.heightInches * design.transform.s * exportDpi);
          const sourceBlob = printSourceFor(design);
          const decoded = sourceBlob
            ? await decodePrintSourceAtSize(
                sourceBlob, printSourceCropFor(design), drawW, drawH, design.alphaThresholded,
              )
            : null;
          const img: ImageBitmap | HTMLImageElement = decoded ?? design.imageInfo.image;
          const cvs = document.createElement('canvas');
          cvs.width = drawW;
          cvs.height = drawH;
          const cctx = cvs.getContext('2d', { willReadFrequently: true });
          if (!cctx) { decoded?.close(); continue; }
          cctx.imageSmoothingEnabled = !design.alphaThresholded;
          if (design.transform.flipX || design.transform.flipY) {
            cctx.save();
            cctx.translate(design.transform.flipX ? drawW : 0, design.transform.flipY ? drawH : 0);
            cctx.scale(design.transform.flipX ? -1 : 1, design.transform.flipY ? -1 : 1);
            cctx.drawImage(img, 0, 0, drawW, drawH);
            cctx.restore();
          } else {
            cctx.drawImage(img, 0, 0, drawW, drawH);
          }
          // Must run before the canvas is released below. Skipped once ink has been seen, so a
          // healthy sheet pays for one scan and the full sweep only happens when it is blank.
          if (!sawInk && canvasHasInk(cvs)) sawInk = true;
          let pngDataUrl: string;
          try {
            pngDataUrl = cvs.toDataURL('image/png');
          } catch (err) {
            console.warn('Canvas toDataURL failed for design', design.id, err);
            decoded?.close();
            continue;
          }
          const base64 = pngDataUrl.split(',')[1];
          if (!base64) {
            console.warn('Invalid PNG data URL for design', design.id);
            decoded?.close();
            continue;
          }
          const pngBytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
          const pdfImage = await pdfDoc.embedPng(pngBytes);

          const designWidthPt = design.widthInches * design.transform.s * 72;
          const designHeightPt = design.heightInches * design.transform.s * 72;
          const centerXPt = design.transform.nx * pageWidthPt;
          const centerYPt = pageHeightPt - design.transform.ny * pageHeightPt;
          const rotDeg = design.transform.rotation ?? 0;
          const rotRad = (-rotDeg * Math.PI) / 180;
          const cosR = Math.cos(rotRad);
          const sinR = Math.sin(rotRad);

          page.drawImage(pdfImage, {
            x: centerXPt - (designWidthPt / 2) * cosR + (designHeightPt / 2) * sinR,
            y: centerYPt - (designWidthPt / 2) * sinR - (designHeightPt / 2) * cosR,
            width: designWidthPt,
            height: designHeightPt,
            rotate: degrees(-rotDeg),
          });

          const pdfLabel = getDesignLabel(design);
          if (pdfLabel) {
            const { StandardFonts } = await import('pdf-lib');
            const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
            drawPrintLabelOnPdfPage(page, font, pdfLabel, {
              centerXPt,
              centerYPt,
              rotationDeg: rotDeg,
              artHeightInches: design.heightInches * design.transform.s,
              artHeightPt: designHeightPt,
            }, degrees);
          }

          if (spotColorsByDesign) {
            const designSpotColors = spotColorsByDesign[design.id];
            if (designSpotColors && designSpotColors.length > 0) {
              const hasFluor = designSpotColors.some((c: any) => c.spotFluorY || c.spotFluorM || c.spotFluorG || c.spotFluorOrange);
              if (hasFluor) {
                const offsetXInches = design.transform.nx * artboardWidth - (design.widthInches * design.transform.s) / 2;
                const offsetYInches = design.transform.ny * artboardHeight - (design.heightInches * design.transform.s) / 2;
                await addSpotColorVectorsToPDF(
                  pdfDoc, page, img, designSpotColors,
                  design.widthInches * design.transform.s,
                  design.heightInches * design.transform.s,
                  artboardHeight,
                  offsetXInches,
                  offsetYInches,
                  design.transform.rotation ?? 0,
                );
              }
            }
          }
          cvs.width = 0;
          cvs.height = 0;
          decoded?.close();
        }

        if (exportDesigns.length > 0 && !sawInk) throw new Error(BLANK_EXPORT_MESSAGE);
        const pdfBytes = await pdfDoc.save();
        assertValidPdfBytes(pdfBytes);
        const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
        triggerDownload(pdfBlob, `${firstName}.pdf`);
      } else {
        const filename = `${firstName}.png`;

        const useWorker = canUseMemoryEfficientPngExport();
        const memoryWarning = getExportMemoryWarning();
        if (memoryWarning) {
          toast({
            title: t("toast.exportMemoryWarning"),
            description: memoryWarning,
          });
        }

        // A download can be downgraded and still be useful — the customer sees
        // the toast and knows what they got. The cart path makes the opposite
        // call on the same numbers, because nobody inspects a production file
        // before it is printed.
        const resolved = resolveExportDpi(artboardWidth, artboardHeight, useWorker);
        const exportDpi = resolved.dpi;
        if (resolved.clamped) {
          toast({
            title: t("toast.largeSheet"),
            description: t("toast.largeSheetDesc", { dpi: Math.floor(exportDpi) }),
          });
        }
        if (!useWorker) {
          toast({
            title: t("toast.exportCompatibilityWarning"),
            description: t("toast.exportCompatibilityWarningDesc"),
          });
        }

        const outW = Math.max(1, Math.round(artboardWidth * exportDpi));
        const outH = Math.max(1, Math.round(artboardHeight * exportDpi));

        let pngBlob: Blob;

        // ── Pre-clean halftoned designs ─────────────────────────────────────────
        // Halftoned designs have binary alpha. However, when drawn at a scaled or
        // rotated size on a canvas, bilinear interpolation reintroduces fringe
        // pixels.  We eliminate this by re-thresholding the source image first,
        // then using nearest-neighbour scaling (alphaThresholded flag, already set).
        const halftoneCleanMap = new Map<string, import("@/lib/types").ImageInfo>();
        await Promise.all(
          designs
            .filter(d => d.halftoned)
            .map(async d => {
              const cleaned = await thresholdImageInfo(d.imageInfo);
              if (cleaned) halftoneCleanMap.set(d.id, cleaned);
            })
        );
        const exportSrc = exportDesigns.map(d =>
          halftoneCleanMap.has(d.id)
            ? { ...d, imageInfo: halftoneCleanMap.get(d.id)! }
            : d
        );

        if (useWorker) {
          const result = await exportPngWithWorker({
            designs: exportSrc.map(d => ({
              widthInches: d.widthInches,
              heightInches: d.heightInches,
              nx: d.transform.nx,
              ny: d.transform.ny,
              s: d.transform.s,
              rotation: d.transform.rotation,
              flipX: d.transform.flipX,
              flipY: d.transform.flipY,
              image: d.imageInfo.image,
              sourceBlob: printSourceFor(d),
              sourceCrop: printSourceCropFor(d),
              alphaThresholded: d.alphaThresholded,
              printFileName: d.printFileName,
              name: d.name,
              label: getDesignLabel(d) ?? undefined,
            })),
            outW,
            outH,
            exportDpi,
            onProgress: ({ phase, completed, total }) => {
              if (phase === "preparing") {
                setExportProgressLabel(t("editor.exportPreparing"));
              } else if (phase === "rendering") {
                setExportProgressLabel(t("editor.exportRendering", { completed, total }));
              } else {
                setExportProgressLabel(t("editor.exportFinalizing"));
              }
            },
          });
          setExportProgressLabel(t("editor.exportFinalizing"));
          pngBlob = result.blob;
        } else {
          const exportCanvas = document.createElement('canvas');
          exportCanvas.width = outW;
          exportCanvas.height = outH;
          const ctx = exportCanvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) throw new Error('Failed to prepare export canvas');
          ctx.clearRect(0, 0, outW, outH);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          for (const design of exportSrc) {
            const drawW = Math.max(1, Math.round(design.widthInches * design.transform.s * exportDpi));
            const drawH = Math.max(1, Math.round(design.heightInches * design.transform.s * exportDpi));
            const sourceBlob = printSourceFor(design);
            const decoded = sourceBlob
              ? await decodePrintSourceAtSize(
                  sourceBlob, printSourceCropFor(design), drawW, drawH, design.alphaThresholded,
                )
              : null;
            const img: ImageBitmap | HTMLImageElement = decoded ?? design.imageInfo.image;
            const centerX = design.transform.nx * outW;
            const centerY = design.transform.ny * outH;
            if (design.alphaThresholded) ctx.imageSmoothingEnabled = false;
            ctx.save();
            ctx.translate(centerX, centerY);
            ctx.rotate((design.transform.rotation * Math.PI) / 180);
            ctx.scale(design.transform.flipX ? -1 : 1, design.transform.flipY ? -1 : 1);
            ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
            // Same layout the worker path and the preview use. This fallback used to put the
            // label inside the bottom-right corner unconditionally while they put it below,
            // so which of the two a customer got depended on whether the worker was available.
            const fallbackLabel = getDesignLabel(design);
            const fallbackArtH = design.heightInches * design.transform.s;
            if (fallbackLabel && fallbackArtH > 0) {
              ctx.scale(design.transform.flipX ? -1 : 1, design.transform.flipY ? -1 : 1);
              drawPrintLabel(
                ctx, fallbackLabel, drawH / fallbackArtH,
                labelReadsUpsideDown(design.transform.rotation),
              );
              ctx.scale(design.transform.flipX ? -1 : 1, design.transform.flipY ? -1 : 1);
            }
            ctx.restore();
            if (design.alphaThresholded) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; }
            decoded?.close();
          }
          assertExportCanvasNotBlank(exportCanvas, exportSrc.length);
          const rawBlob: Blob = await new Promise((res, rej) =>
            exportCanvas.toBlob((b) => b ? res(b) : rej(new Error('toBlob failed')), 'image/png'));
          exportCanvas.width = 0;
          exportCanvas.height = 0;
          pngBlob = await injectPngDpi(rawBlob, exportDpi);
        }

        triggerDownload(pngBlob, filename);
      }

      // Tell the customer when the sheet they just downloaded is softer than it
      // should be. A vector whose print-resolution re-render failed silently
      // fell back to the import preview: the file still exports, so nothing
      // else in this function fails and nothing else would ever mention it.
      //
      // Deliberately after the download rather than before it. The shortfall is
      // information about a file that already exists, so a fault in this warning
      // must not be able to cost someone their export.
      //
      // `materialShortfalls` and not `shortfalls()`: the import preview is
      // clamped to 4096 px, which is still 300 DPI up to about 13.6 in, so most
      // failures cost nothing. Warning on all of them would put "your print will
      // be soft" in front of customers whose print is fine, which is how a
      // warning gets ignored for the one design where it matters.
      const softDesigns = materialShortfalls(vectorSources);
      if (softDesigns.length > 0) {
        console.warn("[export] designs printed below target resolution:", softDesigns);
        toast({
          title: t("toast.exportVectorQualityReduced"),
          description: t("toast.exportVectorQualityReducedDesc", { count: softDesigns.length }),
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Download failed:", error);
      toast({ title: t("toast.downloadFailed"), description: error instanceof Error ? error.message : t("toast.downloadFailedDesc"), variant: "destructive" });
    } finally {
      setExportProgressLabel(undefined);
      setIsProcessing(false);
    }
  }, [toast, t, setExportProgressLabel, ensureDesignImagesAvailable, setIsProcessing]);

  const fileToDataUrl = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });
  }, []);


  return {
    ...bag,
    handleDownload,
    fileToDataUrl,
  };
}

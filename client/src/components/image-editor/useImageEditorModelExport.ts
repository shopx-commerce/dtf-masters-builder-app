import { useCallback } from "react";
import { EXPORT_DPI, EXPORT_TIMEOUT_MS } from "./constants";
import {
  canUseMemoryEfficientPngExport,
  exportPngWithWorker,
  getExportMemoryWarning,
  injectPngDpi,
} from "./utils";
import type { ImageEditorBagAfterUploadCrop } from "./image-editor-hook-bag.types";
import { thresholdImageInfo } from "./useImageEditorModelHalftone";
import { isRecoverableImageInfo } from "@/lib/editor-draft-storage";

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

  const handleDownload = useCallback(async (downloadType: string = 'standard', format: string = 'png', spotColorsByDesign?: Record<string, any[]>) => {
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

      if (format === 'pdf') {
        const { PDFDocument, degrees } = await import('pdf-lib');
        const { addSpotColorVectorsToPDF } = await import('@/lib/spot-color-vectors');

        const exportDpi = EXPORT_DPI;
        const pageWidthPt = artboardWidth * 72;
        const pageHeightPt = artboardHeight * 72;
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);

        for (const design of exportDesigns) {
          const img = design.imageInfo.image;
          const cvs = document.createElement('canvas');
          const drawW = Math.round(design.widthInches * design.transform.s * exportDpi);
          const drawH = Math.round(design.heightInches * design.transform.s * exportDpi);
          cvs.width = drawW;
          cvs.height = drawH;
          const cctx = cvs.getContext('2d');
          if (!cctx) continue;
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
          let pngDataUrl: string;
          try {
            pngDataUrl = cvs.toDataURL('image/png');
          } catch (err) {
            console.warn('Canvas toDataURL failed for design', design.id, err);
            continue;
          }
          const base64 = pngDataUrl.split(',')[1];
          if (!base64) {
            console.warn('Invalid PNG data URL for design', design.id);
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

          if (design.printFileName) {
            const { StandardFonts } = await import('pdf-lib');
            const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
            const displayName = design.name.replace(/\.[^/.]+$/, '');
            const fontSize = Math.max(4, Math.round(0.08 * 72));
            const textWidth = font.widthOfTextAtSize(displayName, fontSize);
            const margin = 0.02 * 72;
            const textX = centerXPt + (designWidthPt / 2) * cosR - (designHeightPt / 2) * sinR - textWidth - margin;
            const textY = centerYPt - (designWidthPt / 2) * sinR - (designHeightPt / 2) * cosR + margin;
            page.drawText(displayName, {
              x: textX,
              y: textY,
              size: fontSize,
              font,
              rotate: degrees(-rotDeg),
            });
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
        }

        const pdfBytes = await pdfDoc.save();
        const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(pdfBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${firstName}.pdf`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
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

        let exportDpi: number;
        if (useWorker) {
          exportDpi = EXPORT_DPI;
        } else {
          const MAX_FALLBACK_PIXELS = 80_000_000;
          const MAX_FALLBACK_DIM = 12_000;
          const dpiByArea = Math.sqrt(MAX_FALLBACK_PIXELS / Math.max(1e-6, artboardWidth * artboardHeight));
          const dpiByDim = Math.min(MAX_FALLBACK_DIM / artboardWidth, MAX_FALLBACK_DIM / artboardHeight);
          exportDpi = Math.min(EXPORT_DPI, dpiByArea, dpiByDim);
          if (exportDpi < EXPORT_DPI) {
            toast({
              title: t("toast.largeSheet"),
              description: t("toast.largeSheetDesc", { dpi: Math.floor(exportDpi) }),
            });
          }
          if (!canUseMemoryEfficientPngExport()) {
            toast({
              title: t("toast.exportCompatibilityWarning"),
              description: t("toast.exportCompatibilityWarningDesc"),
            });
          }
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
              alphaThresholded: d.alphaThresholded,
              printFileName: d.printFileName,
              name: d.name,
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
          const ctx = exportCanvas.getContext('2d');
          if (!ctx) throw new Error('Failed to prepare export canvas');
          ctx.clearRect(0, 0, outW, outH);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          for (const design of exportSrc) {
            const img = design.imageInfo.image;
            const drawW = Math.max(1, Math.round(design.widthInches * design.transform.s * exportDpi));
            const drawH = Math.max(1, Math.round(design.heightInches * design.transform.s * exportDpi));
            const centerX = design.transform.nx * outW;
            const centerY = design.transform.ny * outH;
            if (design.alphaThresholded) ctx.imageSmoothingEnabled = false;
            ctx.save();
            ctx.translate(centerX, centerY);
            ctx.rotate((design.transform.rotation * Math.PI) / 180);
            ctx.scale(design.transform.flipX ? -1 : 1, design.transform.flipY ? -1 : 1);
            ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
            if (design.printFileName) {
              ctx.scale(design.transform.flipX ? -1 : 1, design.transform.flipY ? -1 : 1);
              const fontSize = Math.max(8, Math.round(drawH * 0.045));
              ctx.font = `bold ${fontSize}px sans-serif`;
              ctx.fillStyle = '#000000';
              ctx.textAlign = 'right';
              ctx.textBaseline = 'bottom';
              const margin = Math.round(fontSize * 0.3);
              const displayName = design.name.replace(/\.[^/.]+$/, '');
              ctx.fillText(displayName, drawW / 2 - margin, drawH / 2 - margin);
              ctx.scale(design.transform.flipX ? -1 : 1, design.transform.flipY ? -1 : 1);
            }
            ctx.restore();
            if (design.alphaThresholded) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; }
          }
          const rawBlob: Blob = await new Promise((res, rej) =>
            exportCanvas.toBlob((b) => b ? res(b) : rej(new Error('toBlob failed')), 'image/png'));
          exportCanvas.width = 0;
          exportCanvas.height = 0;
          pngBlob = await injectPngDpi(rawBlob, exportDpi);
        }

        const url = URL.createObjectURL(pngBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        const revokeMs = Math.max(5000, Math.round(pngBlob.size / 100000));
        setTimeout(() => URL.revokeObjectURL(url), revokeMs);
      }
    } catch (error) {
      console.error("Download failed:", error);
      toast({ title: t("toast.downloadFailed"), description: error instanceof Error ? error.message : t("toast.downloadFailedDesc"), variant: "destructive" });
    } finally {
      setExportProgressLabel(undefined);
      setIsProcessing(false);
    }
  }, [imageInfo, designs, artboardWidth, artboardHeight, toast, t, setExportProgressLabel, ensureDesignImagesAvailable, setIsProcessing]);

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

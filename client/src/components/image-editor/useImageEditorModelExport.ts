import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { flushSync } from "react-dom";
import { cropImageToContent, cropImageToContentAsync, hasCleanAlpha, isOpaqueRasterUpload } from "@/lib/image-crop";
import { parsePDF, type ParsedPDFData } from "@/lib/pdf-parser";
import { useToast } from "@/hooks/use-toast";
import { useHistory, type HistorySnapshot } from "@/hooks/use-history";
import { useIsMobile } from "@/hooks/use-mobile";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useLanguage } from "@/lib/i18n";
import { getSelectedVariantPrice } from "@/lib/variant-price";
import { uploadProductionToR2 } from "@/lib/r2-direct-upload";
import {
  DEFAULT_DESIGN_TRANSFORM,
  DEFAULT_LAYER_CENTER_NX,
  DEFAULT_LAYER_CENTER_NY,
  EXPORT_DPI,
  EXPORT_TIMEOUT_MS,
  RASTER_DPI_FALLBACK,
} from "./constants";
import {
  clampDesignToArtboard,
  fetchImageDpi,
  getArrangeWorker,
  getEffectiveHeight,
  getExportWorker,
  getRotatedBounds,
  getStampExtra,
  injectPngDpi,
  inchesFromPixelsPair,
  imageHasCleanAlpha,
  nextExportRequestId,
  normalizeRasterDpiForInches,
  exportWorkerResultToBlob,
  shortAddToCartLabel,
} from "./utils";
import { useAddToCartStall } from "./use-add-to-cart-stall";
import type { ImageInfo, ResizeSettings, ImageTransform, DesignItem } from "@/lib/types";
import { HOT_PEEL_PROFILE } from "@/lib/profiles";
import type { ImageEditorProps } from "./types";
import type { SpotPreviewData } from "../controls-section";

export function useImageEditorModelExport(bag: Record<string, unknown>) {
  const {
    onDesignUploaded,
    profile,
    initialWidth,
    initialHeight,
    initialGangsheetHeights,
    initialQuantity,
    shopifyVariants,
    initialVariantId,
    shopDomain,
    embedFromShopify,
    initialDesignState,
    initialDesignId,
    isEditMode,
    toast,
    t,
    lang,
    isMobile,
    isLgUp,
    imageInfo,
    setImageInfo,
    resizeSettings,
    setResizeSettings,
    isProcessing,
    setIsProcessing,
    isAddingToCart,
    setIsAddingToCart,
    isUpdateFlow,
    setIsUpdateFlow,
    addToCartProgressLabel,
    setAddToCartProgressLabel,
    addToCartStallTimeoutRef,
    lastAddToCartPngBytesRef,
    shellUploadUrlRef,
    refreshAddToCartStallTimeout,
    isUploading,
    setIsUploading,
    uploadProgress,
    setUploadProgress,
    artboardWidth,
    setArtboardWidth,
    artboardHeight,
    setArtboardHeight,
    quantity,
    setQuantity,
    designGap,
    setDesignGap,
    duplicateCount,
    setDuplicateCount,
    clampDuplicateCount,
    parseDuplicateCount,
    handleDuplicateCountKeyDown,
    designTransform,
    setDesignTransform,
    designs,
    setDesigns,
    selectedDesignId,
    setSelectedDesignId,
    selectedDesignIds,
    setSelectedDesignIds,
    mobilePanel,
    setMobilePanel,
    showDesignInfo,
    setShowDesignInfo,
    selectionZoomActive,
    setSelectionZoomActive,
    editingLayerName,
    setEditingLayerName,
    editingNameValue,
    setEditingNameValue,
    clipboardRef,
    proportionalLock,
    setProportionalLock,
    designInfoRef,
    sidebarFileRef,
    headerUploadInputRef,
    canvasRef,
    downloadContainer,
    setDownloadContainer,
    spotPreviewData,
    setSpotPreviewData,
    fluorPanelContainer,
    setFluorPanelContainer,
    mobileToolbarContainer,
    setMobileToolbarContainer,
    copySpotSelectionsRef,
    contextMenu,
    setContextMenu,
    cropModalDesignId,
    setCropModalDesignId,
    pushSnapshot,
    undo,
    redo,
    clearIsUndoRedo,
    canUndo,
    canRedo,
    mountedRef,
    designsRef,
    nudgeSnapshotSavedRef,
    nudgeTimeoutRef,
    thumbnailCacheRef,
    assetDataUrlCacheRef,
    restoredLayerAssetRef,
    multiDragAccumRef,
    multiResizeStartRef,
    multiRotateStartRef,
    snapshotCacheRef,
    getSnapshot,
    saveSnapshot,
    applySnapshot,
    handleUndo,
    handleRedo,
    handleInteractionEnd,
    selectedDesign,
    activeImageInfo,
    activeDesignTransform,
    activeWidthInches,
    activeHeightInches,
    activeResizeSettings,
    selectedVariantPrice,
    effectiveDPI,
    layerRows,
    handleSelectDesign,
    handleMultiSelect,
    getLayerThumbnail,
    handleDesignTransformChange,
    handleMultiDragDelta,
    handleMultiResizeDelta,
    handleMultiRotateDelta,
    handleEffectiveSizeChange,
    isArtboardFull,
    handleDuplicateDesign,
    handleDuplicateAndArrange,
    handleDuplicateSelected,
    handleDuplicateById,
    handleRemoveOneCopy,
    handleCopySelected,
    handlePaste,
    handleDeleteGroup,
    handleDeleteDesign,
    handleDeleteMulti,
    handleRotate90,
    handleFlipX,
    handleFlipY,
    handleCanvasContextMenu,
    getAlignNxNy,
    handleAlignCorner,
    contentFillCacheRef,
    handleAutoArrange,
    handleArtboardResize,
    GANGSHEET_HEIGHTS,
    MAX_ARTBOARD_HEIGHT,
    recommendedArtboardHeight,
    handleExpandArtboard,
    handleUndoRef,
    handleRedoRef,
    handleAutoArrangeRef,
    handleDuplicateDesignRef,
    handleDeleteDesignRef,
    handleDeleteMultiRef,
    handleDuplicateSelectedRef,
    handleCopySelectedRef,
    handlePasteRef,
    handleRotate90Ref,
    selectedDesignIdRef,
    showDesignInfoRef,
    saveSnapshotRef,
    artboardWidthRef,
    artboardHeightRef,
    selectedDesignIdsRef,
    applyImageDirectly,
    handleFallbackImage,
    handleImageUpload,
    handlePDFUpload,
    handleBatchStart,
    handleFileUploadUnified,
    processSidebarFile,
    handleSidebarFileChange,
    isDragOver,
    setIsDragOver,
    dragCounterRef,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handleResizeChange,
    thresholdAlphaForDesign,
    handleThresholdAlpha,
    handleThresholdAlphaAll,
    handleCropDesign,
    handleCropApply,
  } = bag;

  const handleDownload = useCallback(async (downloadType: string = 'standard', format: string = 'png', spotColorsByDesign?: Record<string, any[]>) => {
    if (designs.length === 0) {
      toast({ title: t("toast.noDesigns"), description: t("toast.noDesignsDesc"), variant: "destructive" });
      return;
    }

    setIsProcessing(true);

    try {
      const firstName = (designs[0]?.name || imageInfo?.file.name || 'gangsheet').replace(/\.[^/.]+$/, '');

      await new Promise(r => setTimeout(r, 50));

      if (format === 'pdf') {
        const { PDFDocument, degrees } = await import('pdf-lib');
        const { addSpotColorVectorsToPDF } = await import('@/lib/spot-color-vectors');

        const exportDpi = 300;
        const pageWidthPt = artboardWidth * 72;
        const pageHeightPt = artboardHeight * 72;
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);

        for (const design of designs) {
          const img = design.imageInfo.image;
          const cvs = document.createElement('canvas');
          const drawW = Math.round(design.widthInches * design.transform.s * exportDpi);
          const drawH = Math.round(design.heightInches * design.transform.s * exportDpi);
          cvs.width = drawW;
          cvs.height = drawH;
          const cctx = cvs.getContext('2d');
          if (!cctx) continue;
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

        const worker = getExportWorker();
        const useWorker = worker && typeof OffscreenCanvas !== 'undefined';

        let exportDpi: number;
        if (useWorker) {
          exportDpi = 300;
        } else {
          const MAX_FALLBACK_PIXELS = 80_000_000;
          const MAX_FALLBACK_DIM = 12_000;
          const dpiByArea = Math.sqrt(MAX_FALLBACK_PIXELS / Math.max(1e-6, artboardWidth * artboardHeight));
          const dpiByDim = Math.min(MAX_FALLBACK_DIM / artboardWidth, MAX_FALLBACK_DIM / artboardHeight);
          exportDpi = Math.min(300, dpiByArea, dpiByDim);
          if (exportDpi < 300) {
            toast({
              title: t("toast.largeSheet"),
              description: t("toast.largeSheetDesc", { dpi: Math.floor(exportDpi) }),
            });
          }
        }

        const outW = Math.max(1, Math.round(artboardWidth * exportDpi));
        const outH = Math.max(1, Math.round(artboardHeight * exportDpi));

        let pngBlob: Blob;

        if (useWorker) {
          const bitmaps = await Promise.all(
            designs.map(d => createImageBitmap(d.imageInfo.image))
          );
          const exportDesigns = designs.map((d, i) => ({
            widthInches: d.widthInches,
            heightInches: d.heightInches,
            nx: d.transform.nx,
            ny: d.transform.ny,
            s: d.transform.s,
            rotation: d.transform.rotation,
            flipX: d.transform.flipX,
            flipY: d.transform.flipY,
            bitmap: bitmaps[i],
            alphaThresholded: d.alphaThresholded,
            printFileName: d.printFileName,
            name: d.name,
          }));
          const requestId = nextExportRequestId();
          pngBlob = await new Promise<Blob>((resolve, reject) => {
            const EXPORT_TIMEOUT_MS = 300_000;
            let settled = false;
            const cleanup = () => {
              worker.removeEventListener('message', handler);
              worker.removeEventListener('error', errorHandler);
              clearTimeout(timer);
            };
            const handler = (e: MessageEvent) => {
              if (e.data.requestId !== requestId) return;
              settled = true;
              cleanup();
              if (e.data.type === 'error') reject(new Error(e.data.error));
              else {
                try {
                  resolve(exportWorkerResultToBlob(e.data));
                } catch (err) {
                  reject(err instanceof Error ? err : new Error('Export failed'));
                }
              }
            };
            const errorHandler = (ev: ErrorEvent) => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(new Error(ev.message || 'Export worker crashed'));
            };
            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(new Error('Export timed out — the gangsheet may be too large. Try a smaller size.'));
            }, EXPORT_TIMEOUT_MS);
            worker.addEventListener('message', handler);
            worker.addEventListener('error', errorHandler);
            worker.postMessage(
              { type: 'export', requestId, designs: exportDesigns, outW, outH, exportDpi },
              bitmaps,
            );
          });
        } else {
          const exportCanvas = document.createElement('canvas');
          exportCanvas.width = outW;
          exportCanvas.height = outH;
          const ctx = exportCanvas.getContext('2d');
          if (!ctx) throw new Error('Failed to prepare export canvas');
          ctx.clearRect(0, 0, outW, outH);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          for (const design of designs) {
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
      setIsProcessing(false);
    }
  }, [imageInfo, designs, artboardWidth, artboardHeight, toast]);

  const fileToDataUrl = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });
  }, []);


  return { onDesignUploaded, profile, initialWidth, initialHeight, initialGangsheetHeights, initialQuantity, shopifyVariants, initialVariantId, shopDomain, embedFromShopify, initialDesignState, initialDesignId, isEditMode, toast, t, lang, isMobile, isLgUp, imageInfo, setImageInfo, resizeSettings, setResizeSettings, isProcessing, setIsProcessing, isAddingToCart, setIsAddingToCart, isUpdateFlow, setIsUpdateFlow, addToCartProgressLabel, setAddToCartProgressLabel, addToCartStallTimeoutRef, lastAddToCartPngBytesRef, shellUploadUrlRef, refreshAddToCartStallTimeout, isUploading, setIsUploading, uploadProgress, setUploadProgress, artboardWidth, setArtboardWidth, artboardHeight, setArtboardHeight, quantity, setQuantity, designGap, setDesignGap, duplicateCount, setDuplicateCount, clampDuplicateCount, parseDuplicateCount, handleDuplicateCountKeyDown, designTransform, setDesignTransform, designs, setDesigns, selectedDesignId, setSelectedDesignId, selectedDesignIds, setSelectedDesignIds, mobilePanel, setMobilePanel, showDesignInfo, setShowDesignInfo, selectionZoomActive, setSelectionZoomActive, editingLayerName, setEditingLayerName, editingNameValue, setEditingNameValue, clipboardRef, proportionalLock, setProportionalLock, designInfoRef, sidebarFileRef, headerUploadInputRef, canvasRef, downloadContainer, setDownloadContainer, spotPreviewData, setSpotPreviewData, fluorPanelContainer, setFluorPanelContainer, mobileToolbarContainer, setMobileToolbarContainer, copySpotSelectionsRef, contextMenu, setContextMenu, cropModalDesignId, setCropModalDesignId, pushSnapshot, undo, redo, clearIsUndoRedo, canUndo, canRedo, mountedRef, designsRef, nudgeSnapshotSavedRef, nudgeTimeoutRef, thumbnailCacheRef, assetDataUrlCacheRef, restoredLayerAssetRef, multiDragAccumRef, multiResizeStartRef, multiRotateStartRef, snapshotCacheRef, getSnapshot, saveSnapshot, applySnapshot, handleUndo, handleRedo, handleInteractionEnd, selectedDesign, activeImageInfo, activeDesignTransform, activeWidthInches, activeHeightInches, activeResizeSettings, selectedVariantPrice, effectiveDPI, layerRows, handleSelectDesign, handleMultiSelect, getLayerThumbnail, handleDesignTransformChange, handleMultiDragDelta, handleMultiResizeDelta, handleMultiRotateDelta, handleEffectiveSizeChange, isArtboardFull, handleDuplicateDesign, handleDuplicateAndArrange, handleDuplicateSelected, handleDuplicateById, handleRemoveOneCopy, handleCopySelected, handlePaste, handleDeleteGroup, handleDeleteDesign, handleDeleteMulti, handleRotate90, handleFlipX, handleFlipY, handleCanvasContextMenu, getAlignNxNy, handleAlignCorner, contentFillCacheRef, handleAutoArrange, handleArtboardResize, GANGSHEET_HEIGHTS, MAX_ARTBOARD_HEIGHT, recommendedArtboardHeight, handleExpandArtboard, handleUndoRef, handleRedoRef, handleAutoArrangeRef, handleDuplicateDesignRef, handleDeleteDesignRef, handleDeleteMultiRef, handleDuplicateSelectedRef, handleCopySelectedRef, handlePasteRef, handleRotate90Ref, selectedDesignIdRef, showDesignInfoRef, saveSnapshotRef, artboardWidthRef, artboardHeightRef, selectedDesignIdsRef, applyImageDirectly, handleFallbackImage, handleImageUpload, handlePDFUpload, handleBatchStart, handleFileUploadUnified, processSidebarFile, handleSidebarFileChange, isDragOver, setIsDragOver, dragCounterRef, handleDragEnter, handleDragLeave, handleDragOver, handleDrop, handleResizeChange, thresholdAlphaForDesign, handleThresholdAlpha, handleThresholdAlphaAll, handleCropDesign, handleCropApply, handleDownload, fileToDataUrl };
}

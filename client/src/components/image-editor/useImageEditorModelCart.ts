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
import { uploadProductionToR2, canUseShellRelay } from "@/lib/r2-direct-upload";
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
  shortAddToCartLabel,
} from "./utils";
import { useAddToCartStall } from "./use-add-to-cart-stall";
import type { ImageInfo, ResizeSettings, ImageTransform, DesignItem } from "@/lib/types";
import { HOT_PEEL_PROFILE } from "@/lib/profiles";
import type { ImageEditorProps } from "./types";
import type { SpotPreviewData } from "../controls-section";

export function useImageEditorModelCart(bag: Record<string, unknown>) {
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
    handleDownload,
    fileToDataUrl,
  } = bag;

  const buildDesignStatePayload = useCallback(async () => {
    const layers = designs.map((d, index) => ({
      layerId: d.id,
      name: d.name,
      type: "image",
      selected: d.id === selectedDesignId || selectedDesignIds.has(d.id),
      visible: true,
      locked: false,
      opacity: 1,
      zIndex: index,
      rotation: d.transform.rotation,
      x: d.transform.nx,
      y: d.transform.ny,
      width: d.widthInches,
      height: d.heightInches,
      scaleX: d.transform.s * (d.transform.flipX ? -1 : 1),
      scaleY: d.transform.s * (d.transform.flipY ? -1 : 1),
      settings: {
        alphaThresholded: Boolean(d.alphaThresholded),
        printFileName: Boolean(d.printFileName),
        originalDpi: d.originalDPI,
      },
    }));

    const savedLayersById = new Map(
      (Array.isArray((initialDesignState as { layers?: unknown[] } | null)?.layers)
        ? (initialDesignState as { layers: Array<{ layerId?: string; name?: string; asset?: { url?: string; key?: string; mimeType?: string } }> }).layers
        : []
      ).map((l) => [String(l.layerId || ""), l]),
    );

    const layerAssets = await Promise.all(
      designs.map(async (d) => {
        const f = d.imageInfo?.file;
        const fileSig = f ? `${f.name}:${f.size}` : "";
        const restored = restoredLayerAssetRef.current.get(d.id);
        const savedLayer = savedLayersById.get(d.id);
        const savedUrl = String(savedLayer?.asset?.url || restored?.url || "").trim();
        const savedKey = savedLayer?.asset?.key || restored?.key;

        // Edit: layer already in saved JSON — reuse R2 asset unless pixels changed (new upload).
        if (isEditMode && savedLayer?.asset?.url && savedUrl) {
          const pixelsUnchanged = !f || !restored || restored.fileSig === fileSig;
          if (pixelsUnchanged) {
            return {
              layerId: d.id,
              filename: f?.name || savedLayer?.name || null,
              mimeType: savedLayer?.asset?.mimeType || restored?.mimeType || f?.type || "image/png",
              url: savedUrl,
              key: savedKey ? String(savedKey) : undefined,
            };
          }
        }

        if (!f) {
          return {
            layerId: d.id,
            filename: null,
            mimeType: null,
            dataUrl: null,
          };
        }
        const sig = fileSig;
        const cached = assetDataUrlCacheRef.current.get(d.id);
        if (cached?.sig === sig) {
          return {
            layerId: d.id,
            filename: f.name,
            mimeType: f.type || null,
            dataUrl: cached.dataUrl,
          };
        }
        const dataUrl = await fileToDataUrl(f);
        assetDataUrlCacheRef.current.set(d.id, { sig, dataUrl, filename: f.name, mimeType: f.type || undefined });
        return {
          layerId: d.id,
          filename: f.name,
          mimeType: f.type || null,
          dataUrl,
        };
      }),
    );

    return {
      designId:
        (initialDesignState as { designId?: string | null } | null)?.designId ||
        initialDesignId ||
        null,
      builderPath: typeof window !== "undefined" ? window.location.pathname : null,
      canvas: {
        artboardWidthInches: artboardWidth,
        artboardHeightInches: artboardHeight,
        outputDpi: 300,
      },
      settings: {
        quantity,
        designGap,
      },
      gangsheetSize: `${artboardWidth}" x ${artboardHeight}"`,
      layers,
      layerAssets,
    };
  }, [
    designs,
    selectedDesignId,
    selectedDesignIds,
    fileToDataUrl,
    artboardWidth,
    artboardHeight,
    quantity,
    designGap,
    initialDesignState,
    initialDesignId,
    isEditMode,
  ]);

  const handleAddToCart = useCallback(async () => {
    if (designs.length === 0) {
      toast({ title: "No designs", description: "Add at least one design before adding to cart.", variant: "destructive" });
      return;
    }
    setIsAddingToCart(true);
    setIsUpdateFlow(isEditMode);
    setIsProcessing(true);
    if (addToCartStallTimeoutRef.current != null) {
      window.clearTimeout(addToCartStallTimeoutRef.current);
      addToCartStallTimeoutRef.current = null;
    }
    try {
      const exportDpi = 300;
      const outW = Math.max(1, Math.round(artboardWidth * exportDpi));
      const outH = Math.max(1, Math.round(artboardHeight * exportDpi));
      const worker = getExportWorker();
      const useWorker = worker && typeof OffscreenCanvas !== 'undefined';
      let pngBlob: Blob;
      let exportWorkerBuffer: ArrayBuffer | null = null;

      if (useWorker) {
        const bitmaps = await Promise.all(designs.map((d) => createImageBitmap(d.imageInfo.image)));
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
        const exportResult = await new Promise<{ buffer: ArrayBuffer; byteLength: number }>((resolve, reject) => {
          const timer = window.setTimeout(() => reject(new Error('Export timed out — sheet may be too large.')), EXPORT_TIMEOUT_MS);
          const onMessage = (e: MessageEvent) => {
            if (e.data.requestId !== requestId) return;
            worker.removeEventListener('message', onMessage);
            window.clearTimeout(timer);
            if (e.data.type === 'error') reject(new Error(e.data.error));
            else if (e.data.buffer) {
              const buf = e.data.buffer as ArrayBuffer;
              const byteLength = Number(e.data.byteLength) > 0 ? Number(e.data.byteLength) : buf.byteLength;
              resolve({ buffer: buf, byteLength });
            }
            else reject(new Error('Export returned no image data'));
          };
          worker.addEventListener('message', onMessage);
          worker.postMessage({ type: 'export', requestId, designs: exportDesigns, outW, outH, exportDpi }, bitmaps);
        });
        exportWorkerBuffer = exportResult.buffer;
        pngBlob = new Blob([exportWorkerBuffer], { type: 'image/png' });
      } else {
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = outW;
        exportCanvas.height = outH;
        const ctx = exportCanvas.getContext('2d');
        if (!ctx) throw new Error('Canvas not supported');
        ctx.clearRect(0, 0, outW, outH);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        for (const design of designs) {
          const img = design.imageInfo.image;
          const drawW = Math.max(1, Math.round(design.widthInches * design.transform.s * exportDpi));
          const drawH = Math.max(1, Math.round(design.heightInches * design.transform.s * exportDpi));
          const centerX = design.transform.nx * outW;
          const centerY = design.transform.ny * outH;
          ctx.save();
          ctx.translate(centerX, centerY);
          ctx.rotate((design.transform.rotation * Math.PI) / 180);
          ctx.scale(design.transform.flipX ? -1 : 1, design.transform.flipY ? -1 : 1);
          ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
          ctx.restore();
        }
        const rawBlob: Blob = await new Promise((res, rej) =>
          exportCanvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'),
        );
        exportCanvas.width = 0;
        exportCanvas.height = 0;
        pngBlob = await injectPngDpi(rawBlob, exportDpi);
      }
      lastAddToCartPngBytesRef.current = pngBlob.size;

      const selectedVariant = shopifyVariants?.find((v) => v.height != null && Math.abs(v.height - artboardHeight) < 0.01);
      const vid = selectedVariant?.id || initialVariantId || '';
      const vidDigits = vid.replace(/\D/g, '');

      if (!vidDigits) throw new Error('No variant ID available');
      if (!shopDomain) throw new Error('Shop domain missing — open the builder from the storefront product page.');

      const designState = await buildDesignStatePayload();
      const existingProduction = (initialDesignState as { production?: { url?: string | null; key?: string | null } } | null)?.production;
      const filename = 'gangsheet-' + Date.now() + '.png';
      const productionKey =
        isEditMode && existingProduction?.key ? String(existingProduction.key) : undefined;
      const uploadUrl = shellUploadUrlRef.current?.trim() || '';
      const uploadInBuilder = canUseShellRelay() || Boolean(uploadUrl);
      const onUploadProgress = (msg: string) => setAddToCartProgressLabel(msg);

      let productionUrl: string | null = null;
      let uploadedProductionKey: string | null = productionKey || null;

      if (uploadInBuilder) {
        const uploadOpts = { objectKey: productionKey, useShellRelay: canUseShellRelay() };
        const uploadBody =
          exportWorkerBuffer && exportWorkerBuffer.byteLength > 0
            ? new Blob([exportWorkerBuffer], { type: "image/png" })
            : pngBlob;
        try {
          const uploaded = await uploadProductionToR2(
            uploadBody,
            filename,
            uploadUrl,
            onUploadProgress,
            uploadOpts,
          );
          productionUrl = uploaded.productionUrl;
          uploadedProductionKey = uploaded.key || uploadedProductionKey;
          exportWorkerBuffer = null;
        } catch (uploadErr) {
          const detail = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
          console.warn("[handleAddToCart] Builder R2 upload failed, falling back to parent shell:", detail);
          setAddToCartProgressLabel(undefined);
          // Parent shell can upload via signed proxy URL when builder→R2 or shell relay fails.
        }
      }

      const message = {
        type: isEditMode ? 'dtf-builder-save-design' : 'dtf-builder-add-to-cart',
        variantId: vidDigits,
        quantity: quantity,
        gangsheetSize: artboardWidth + '" x ' + artboardHeight + '"',
        shop: shopDomain || '',
        filename,
        productionExport: true,
        dedupId: `${isEditMode ? "upd" : "atc"}-${vidDigits}-${Date.now()}`,
        designState,
        builderUploaded: Boolean(productionUrl),
        ...(productionUrl
          ? {
              productionUrl,
              productionKey: uploadedProductionKey || undefined,
            }
          : {}),
        ...(isEditMode && existingProduction?.url && !productionUrl
          ? { productionUrl: String(existingProduction.url) }
          : {}),
        builderVersion: (import.meta as unknown as { env?: { VITE_APP_VERSION?: string } })?.env?.VITE_APP_VERSION || "builder-unversioned",
      };

      const pngByteLength = lastAddToCartPngBytesRef.current;

      if (!productionUrl) {
        if (!pngBlob.size) throw new Error("Empty design image");
        const pngBuffer = await pngBlob.arrayBuffer();
        (message as { pngBuffer?: ArrayBuffer }).pngBuffer = pngBuffer;
        window.parent.postMessage(message, '*', [pngBuffer]);
        refreshAddToCartStallTimeout(pngByteLength || pngBuffer.byteLength);
      } else {
        window.parent.postMessage(message, '*');
        refreshAddToCartStallTimeout(pngByteLength);
      }
      // Keep loading state until parent redirects (upload runs in parent). Do not clear in finally.
    } catch (error) {
      console.error('Add to cart failed:', error);
      toast({
        title: isEditMode ? "Update failed" : "Failed",
        description: error instanceof Error ? error.message : (isEditMode ? "Could not update design" : "Could not add to cart"),
        variant: "destructive"
      });
      setIsAddingToCart(false);
      setIsUpdateFlow(false);
      setIsProcessing(false);
      if (addToCartStallTimeoutRef.current != null) {
        window.clearTimeout(addToCartStallTimeoutRef.current);
        addToCartStallTimeoutRef.current = null;
      }
    }
  }, [designs, artboardWidth, artboardHeight, quantity, shopifyVariants, initialVariantId, shopDomain, toast, refreshAddToCartStallTimeout, buildDesignStatePayload, isEditMode, initialDesignState]);

  return { onDesignUploaded, profile, initialWidth, initialHeight, initialGangsheetHeights, initialQuantity, shopifyVariants, initialVariantId, shopDomain, embedFromShopify, initialDesignState, initialDesignId, isEditMode, toast, t, lang, isMobile, isLgUp, imageInfo, setImageInfo, resizeSettings, setResizeSettings, isProcessing, setIsProcessing, isAddingToCart, setIsAddingToCart, isUpdateFlow, setIsUpdateFlow, addToCartProgressLabel, setAddToCartProgressLabel, addToCartStallTimeoutRef, lastAddToCartPngBytesRef, shellUploadUrlRef, refreshAddToCartStallTimeout, isUploading, setIsUploading, uploadProgress, setUploadProgress, artboardWidth, setArtboardWidth, artboardHeight, setArtboardHeight, quantity, setQuantity, designGap, setDesignGap, duplicateCount, setDuplicateCount, clampDuplicateCount, parseDuplicateCount, handleDuplicateCountKeyDown, designTransform, setDesignTransform, designs, setDesigns, selectedDesignId, setSelectedDesignId, selectedDesignIds, setSelectedDesignIds, mobilePanel, setMobilePanel, showDesignInfo, setShowDesignInfo, selectionZoomActive, setSelectionZoomActive, editingLayerName, setEditingLayerName, editingNameValue, setEditingNameValue, clipboardRef, proportionalLock, setProportionalLock, designInfoRef, sidebarFileRef, headerUploadInputRef, canvasRef, downloadContainer, setDownloadContainer, spotPreviewData, setSpotPreviewData, fluorPanelContainer, setFluorPanelContainer, mobileToolbarContainer, setMobileToolbarContainer, copySpotSelectionsRef, contextMenu, setContextMenu, cropModalDesignId, setCropModalDesignId, pushSnapshot, undo, redo, clearIsUndoRedo, canUndo, canRedo, mountedRef, designsRef, nudgeSnapshotSavedRef, nudgeTimeoutRef, thumbnailCacheRef, assetDataUrlCacheRef, restoredLayerAssetRef, multiDragAccumRef, multiResizeStartRef, multiRotateStartRef, snapshotCacheRef, getSnapshot, saveSnapshot, applySnapshot, handleUndo, handleRedo, handleInteractionEnd, selectedDesign, activeImageInfo, activeDesignTransform, activeWidthInches, activeHeightInches, activeResizeSettings, selectedVariantPrice, effectiveDPI, layerRows, handleSelectDesign, handleMultiSelect, getLayerThumbnail, handleDesignTransformChange, handleMultiDragDelta, handleMultiResizeDelta, handleMultiRotateDelta, handleEffectiveSizeChange, isArtboardFull, handleDuplicateDesign, handleDuplicateAndArrange, handleDuplicateSelected, handleDuplicateById, handleRemoveOneCopy, handleCopySelected, handlePaste, handleDeleteGroup, handleDeleteDesign, handleDeleteMulti, handleRotate90, handleFlipX, handleFlipY, handleCanvasContextMenu, getAlignNxNy, handleAlignCorner, contentFillCacheRef, handleAutoArrange, handleArtboardResize, GANGSHEET_HEIGHTS, MAX_ARTBOARD_HEIGHT, recommendedArtboardHeight, handleExpandArtboard, handleUndoRef, handleRedoRef, handleAutoArrangeRef, handleDuplicateDesignRef, handleDeleteDesignRef, handleDeleteMultiRef, handleDuplicateSelectedRef, handleCopySelectedRef, handlePasteRef, handleRotate90Ref, selectedDesignIdRef, showDesignInfoRef, saveSnapshotRef, artboardWidthRef, artboardHeightRef, selectedDesignIdsRef, applyImageDirectly, handleFallbackImage, handleImageUpload, handlePDFUpload, handleBatchStart, handleFileUploadUnified, processSidebarFile, handleSidebarFileChange, isDragOver, setIsDragOver, dragCounterRef, handleDragEnter, handleDragLeave, handleDragOver, handleDrop, handleResizeChange, thresholdAlphaForDesign, handleThresholdAlpha, handleThresholdAlphaAll, handleCropDesign, handleCropApply, handleDownload, fileToDataUrl, buildDesignStatePayload, handleAddToCart };
}

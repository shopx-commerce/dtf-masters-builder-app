import { useState, useRef, useCallback, useEffect } from "react";
import { cropImageToContent, cropImageToContentAsync, isOpaqueRasterUpload } from "@/lib/image-crop";
import { parsePDF, type ParsedPDFData } from "@/lib/pdf-parser";
import {
  EXPORT_DPI,
  LAYER_THUMBNAIL_SIZE,
  LOW_RES_EFFECTIVE_DPI_THRESHOLD,
  MAX_STORED_IMAGE_DIMENSION,
  RASTER_DPI_FALLBACK,
} from "./constants";
import {
  fetchImageDpi,
  imageHasCleanAlpha,
  inchesFromPixelsPair,
  normalizeRasterDpiForInches,
} from "./utils";
import type { ImageInfo } from "@/lib/types";
import type { ImageEditorBagAfterArrange } from "./image-editor-hook-bag.types";

export function useImageEditorModelUploadCrop(bag: ImageEditorBagAfterArrange) {
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
  } = bag;

  const handleFallbackImage = useCallback(async (
    file: File,
    image: HTMLImageElement,
    opts?: { dpi?: number; skipCrop?: boolean }
  ) => {
    const dpiRaw = opts?.dpi ?? (await fetchImageDpi(file).catch((err) => { console.warn('[fetchImageDpi] failed:', err); return RASTER_DPI_FALLBACK; }));

    let croppedCanvas: HTMLCanvasElement | null = null;
    if (opts?.skipCrop) {
      const fullCanvas = document.createElement("canvas");
      fullCanvas.width = image.width;
      fullCanvas.height = image.height;
      const ctx = fullCanvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(image, 0, 0);
        croppedCanvas = fullCanvas;
      }
    }
    if (!croppedCanvas) {
      try { croppedCanvas = cropImageToContent(image); } catch { /* use original */ }
    }

    const processImage = (finalImage: HTMLImageElement) => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      setIsUploading(false);

      const dpi = normalizeRasterDpiForInches(dpiRaw, finalImage);

      const { widthInches, heightInches } = inchesFromPixelsPair(
        finalImage.naturalWidth || finalImage.width,
        finalImage.naturalHeight || finalImage.height,
        dpi,
      );

      const newImageInfo: ImageInfo = {
        file,
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

    if (croppedCanvas) {
      const img = new Image();
      img.onload = () => processImage(img);
      img.onerror = () => { setIsUploading(false); processImage(image); };
      img.src = croppedCanvas.toDataURL();
    } else {
      processImage(image);
    }
  }, [applyImageDirectly, isMobile, toast]);

  const handleImageUpload = useCallback(async (file: File, image: HTMLImageElement) => {
    try {
      if (image.width * image.height > 1000000000) {
        toast({ title: t("toast.imageTooLarge"), description: t("toast.imageTooLargeDesc"), variant: "destructive" });
        return;
      }
      
      if (image.width <= 0 || image.height <= 0) {
        toast({ title: t("toast.invalidImage"), description: t("toast.invalidImageDesc"), variant: "destructive" });
        return;
      }
      
      setIsUploading(true);
      setUploadProgress(10);
      
      await new Promise(r => setTimeout(r, 0));
      setUploadProgress(25);
      
      const dpiRaw = await fetchImageDpi(file).catch((err) => { console.warn('[fetchImageDpi] failed:', err); return RASTER_DPI_FALLBACK; });
      const dpi = normalizeRasterDpiForInches(dpiRaw, image);
      const imgWidthInches = image.width / dpi;
      const imgHeightInches = image.height / dpi;
      const ARTBOARD_MATCH_TOLERANCE = 0.05;
      const matchesArtboard =
        Math.abs(imgWidthInches - artboardWidth) / Math.max(artboardWidth, 0.1) <= ARTBOARD_MATCH_TOLERANCE &&
        Math.abs(imgHeightInches - artboardHeight) / Math.max(artboardHeight, 0.1) <= ARTBOARD_MATCH_TOLERANCE;

      let croppedCanvas: HTMLCanvasElement | null = null;
      if (matchesArtboard) {
        const fullCanvas = document.createElement("canvas");
        fullCanvas.width = image.width;
        fullCanvas.height = image.height;
        const ctx = fullCanvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(image, 0, 0);
          croppedCanvas = fullCanvas;
        }
      }
      if (!croppedCanvas) {
        if (isOpaqueRasterUpload(image)) {
          const fullCanvas = document.createElement('canvas');
          fullCanvas.width = image.width;
          fullCanvas.height = image.height;
          const fctx = fullCanvas.getContext('2d');
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
      const maxStoredDimension = MAX_STORED_IMAGE_DIMENSION;

      const loadImageFromBlob = (blob: Blob): Promise<HTMLImageElement> =>
        new Promise((res, rej) => {
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => { URL.revokeObjectURL(url); res(img); };
          img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Image load failed')); };
          img.src = url;
        });

      const canvasToBlob = (cvs: HTMLCanvasElement): Promise<Blob | null> =>
        new Promise(res => cvs.toBlob(res, 'image/png'));

      const blob = await canvasToBlob(croppedCanvas);
      setUploadProgress(70);
      if (!blob) { await handleFallbackImage(file, image, { dpi, skipCrop: matchesArtboard }); return; }

      let croppedImg: HTMLImageElement;
      try {
        croppedImg = await loadImageFromBlob(blob);
      } catch {
        await handleFallbackImage(file, image, { dpi, skipCrop: matchesArtboard }); return;
      }

      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }

      const intrinsicW = croppedImg.naturalWidth || croppedImg.width;
      const intrinsicH = croppedImg.naturalHeight || croppedImg.height;
      let storedWidth = intrinsicW;
      let storedHeight = intrinsicH;
      const maxDim = Math.max(intrinsicW, intrinsicH);

      if (maxDim > maxStoredDimension) {
        setUploadProgress(75);
        const scale = maxStoredDimension / maxDim;
        storedWidth = Math.round(intrinsicW * scale);
        storedHeight = Math.round(intrinsicH * scale);
        const downsampleCanvas = document.createElement('canvas');
        downsampleCanvas.width = storedWidth;
        downsampleCanvas.height = storedHeight;
        const dsCtx = downsampleCanvas.getContext('2d');
        if (!dsCtx) throw new Error('Could not create canvas context for downsampling');
        const preserveCleanAlpha = imageHasCleanAlpha(croppedImg);
        dsCtx.imageSmoothingEnabled = !preserveCleanAlpha;
        if (!preserveCleanAlpha) dsCtx.imageSmoothingQuality = 'high';
        dsCtx.drawImage(croppedImg, 0, 0, storedWidth, storedHeight);
        const dsBlob = await canvasToBlob(downsampleCanvas);
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
      const { widthInches, heightInches } = inchesFromPixelsPair(intrinsicW, intrinsicH, dpi);
      const bw = croppedImg.naturalWidth || croppedImg.width;
      const bh = croppedImg.naturalHeight || croppedImg.height;
      const newImageInfo: ImageInfo = { file, image: croppedImg, originalWidth: bw, originalHeight: bh, dpi };
      applyImageDirectly(newImageInfo, widthInches, heightInches, imageHasCleanAlpha(croppedImg));
      if (isMobile) setMobilePanel("preview");
      if (matchesArtboard) {
        toast({ title: t("toast.gangsheetDetected"), description: t("toast.gangsheetDetectedDesc") });
      }
      setUploadProgress(100);
      setTimeout(() => { setIsUploading(false); setUploadProgress(0); }, 300);

      const effectiveDPI = Math.min(intrinsicW / widthInches, intrinsicH / heightInches);
      if (effectiveDPI < LOW_RES_EFFECTIVE_DPI_THRESHOLD) {
        toast({
          title: t("toast.lowRes"),
          description: t("toast.lowResDesc"),
          variant: "warning",
        });
      }
      } catch (error) {
        console.error('Error processing uploaded image:', error);
        setIsUploading(false);
        setUploadProgress(0);
        try {
          const dpiFallbackRaw = await fetchImageDpi(file).catch((err) => { console.warn('[fetchImageDpi] failed:', err); return RASTER_DPI_FALLBACK; });
          const dpiFallback = normalizeRasterDpiForInches(dpiFallbackRaw, image);
          const wIn = image.width / dpiFallback;
          const hIn = image.height / dpiFallback;
          const match = Math.abs(wIn - artboardWidth) / Math.max(artboardWidth, 0.1) <= 0.05 &&
            Math.abs(hIn - artboardHeight) / Math.max(artboardHeight, 0.1) <= 0.05;
          await handleFallbackImage(file, image, { dpi: dpiFallback, skipCrop: match });
        } catch (fallbackErr) {
        console.error('Fallback image processing also failed:', fallbackErr);
        toast({ title: t("toast.uploadFailed"), description: t("toast.uploadFailedDesc"), variant: "destructive" });
      }
    }
  }, [applyImageDirectly, isMobile, toast, handleFallbackImage, artboardWidth, artboardHeight]);

  const handlePDFUpload = useCallback((file: File, pdfData: ParsedPDFData) => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    
    const { image, originalPdfData, dpi } = pdfData;
    
    const newImageInfo: ImageInfo = {
      file,
      image,
      originalWidth: image.width,
      originalHeight: image.height,
      dpi,
      isPDF: true,
      originalPdfData,
    };
    
    const { widthInches, heightInches } = inchesFromPixelsPair(
      image.naturalWidth || image.width,
      image.naturalHeight || image.height,
      dpi,
    );

    applyImageDirectly(newImageInfo, widthInches, heightInches);
    if (isMobile) setMobilePanel("preview");
  }, [applyImageDirectly, isMobile]);

  const handleBatchStart = useCallback((fileCount: number) => {
    const targetHeight = Math.min(48, GANGSHEET_HEIGHTS[GANGSHEET_HEIGHTS.length - 1]);
    const validHeight = GANGSHEET_HEIGHTS.reduce((best, h) => h <= targetHeight && h > best ? h : best, GANGSHEET_HEIGHTS[0]);
    if (fileCount > 1 && artboardHeightRef.current < validHeight) {
      setArtboardHeight(validHeight);
    }
  }, [GANGSHEET_HEIGHTS]);

  const handleFileUploadUnified = useCallback(async (file: File, image: HTMLImageElement | null) => {
    const ext = file.name.toLowerCase();
    const isPdf = file.type === 'application/pdf' || ext.endsWith('.pdf');
    if (isPdf) {
      try {
        setIsUploading(true);
        const pdfData = await parsePDF(file);
        handlePDFUpload(file, pdfData);
        if (isMobile) setMobilePanel("preview");
      } catch (err) {
        console.error('PDF parse error:', err);
        toast({ title: t("toast.pdfFailed"), description: t("toast.pdfFailedDesc"), variant: "destructive" });
      } finally {
        setIsUploading(false);
      }
      return;
    }
    if (image) {
      await handleImageUpload(file, image);
      if (isMobile) setMobilePanel("preview");
    }
  }, [handleImageUpload, handlePDFUpload, isMobile, toast]);

  const processSidebarFile = useCallback((file: File): Promise<void> => {
    const ext = file.name.toLowerCase();
    const isPdf = file.type === 'application/pdf' || ext.endsWith('.pdf');
    const isImage = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || ['.png', '.jpg', '.jpeg', '.webp'].some(x => ext.endsWith(x));
    if (!isImage && !isPdf) {
      toast({ title: t("toast.unsupportedFormat"), description: t("toast.formatOnly"), variant: "destructive" });
      return Promise.resolve();
    }
    if (isPdf) {
      return (async () => {
        try {
          setIsUploading(true);
          const pdfData = await parsePDF(file);
          handlePDFUpload(file, pdfData);
        } catch (err) {
          console.error('PDF parse error:', err);
          toast({ title: t("toast.pdfFailed"), description: t("toast.pdfFailedShort"), variant: "destructive" });
        } finally {
          setIsUploading(false);
        }
      })();
    }
    return new Promise<void>((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const isPng = file.type === 'image/png' || ext.endsWith('.png');
        if (!isPng) {
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          const ctx = c.getContext('2d');
          if (!ctx) { handleImageUpload(file, img).finally(resolve); return; }
          ctx.drawImage(img, 0, 0);
          c.toBlob(blob => {
            if (!blob) { handleImageUpload(file, img).finally(resolve); return; }
            const pf = new File([blob], file.name.replace(/\.\w+$/, '.png'), { type: 'image/png' });
            const pi = new Image();
            const u2 = URL.createObjectURL(blob);
            pi.onload = () => { URL.revokeObjectURL(u2); handleImageUpload(pf, pi).finally(resolve); };
            pi.onerror = () => { URL.revokeObjectURL(u2); handleImageUpload(file, img).finally(resolve); };
            pi.src = u2;
          }, 'image/png');
        } else {
          handleImageUpload(file, img).finally(resolve);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        toast({ title: t("toast.failedLoad"), description: t("toast.failedLoadFile", { name: file.name }), variant: "destructive" });
        resolve();
      };
      img.src = url;
    });
  }, [handleImageUpload, handlePDFUpload, toast]);

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
    for (const file of files) {
      await processSidebarFile(file);
    }
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
    for (const file of files) {
      await processSidebarFile(file);
    }
  }, [processSidebarFile, GANGSHEET_HEIGHTS]);

  const handleResizeChange = useCallback((newSettings: Partial<ResizeSettings>) => {
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
  }, [imageInfo, selectedDesign, selectedDesignId, saveSnapshot, resizeSettings]);


  const thresholdAlphaForDesign = useCallback((info: ImageInfo): Promise<ImageInfo | null> => {
    return new Promise(resolve => {
      try {
        const src = info.image;
        const w = src.naturalWidth || src.width;
        const h = src.naturalHeight || src.height;
        if (!w || !h) { resolve(null); return; }
        const cvs = document.createElement('canvas');
        cvs.width = w; cvs.height = h;
        const ctx = cvs.getContext('2d');
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
  }, []);

  const handleThresholdAlpha = useCallback(async () => {
    try {
      const targetIds = selectedDesignIds.size > 0 ? Array.from(selectedDesignIds) : (selectedDesignId ? [selectedDesignId] : []);
      if (targetIds.length === 0) return;
      saveSnapshot();
      const targetDesigns = designs.filter(d => targetIds.includes(d.id));
      const results = await Promise.all(targetDesigns.map(d => thresholdAlphaForDesign(d.imageInfo)));
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
      const results = await Promise.all(designs.map(d => thresholdAlphaForDesign(d.imageInfo)));
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
    const id = contextMenu?.designId ?? selectedDesignId;
    if (id) {
      setCropModalDesignId(id);
      setContextMenu(null);
    }
  }, [contextMenu, selectedDesignId]);

  const handleCropApply = useCallback((designId: string, newImageInfo: ImageInfo) => {
    saveSnapshot();
    const design = designs.find(d => d.id === designId);
    if (!design) return;
    const aspect = design.widthInches / design.heightInches;
    const newAspect = newImageInfo.image.naturalWidth / newImageInfo.image.naturalHeight;
    let widthInches = design.widthInches;
    let heightInches = design.heightInches;
    if (Math.abs(newAspect - aspect) > 0.01) {
      heightInches = widthInches / newAspect;
    }
    setDesigns(prev => prev.map(d =>
      d.id === designId
        ? { ...d, imageInfo: newImageInfo, widthInches, heightInches }
        : d
    ));
    if (selectedDesignId === designId) setImageInfo(newImageInfo);
    setResizeSettings(prev => ({ ...prev, widthInches, heightInches }));
    setCropModalDesignId(null);
    toast({ title: t("toast.cropApplied"), description: t("toast.cropAppliedDesc") });
  }, [designs, selectedDesignId, saveSnapshot, toast, setImageInfo]);


  return {
    ...bag,
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
  };
}

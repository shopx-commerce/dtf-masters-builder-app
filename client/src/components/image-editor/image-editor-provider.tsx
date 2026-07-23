import type { ImageEditorProps } from "./types";
import { ImageEditorContext } from "./image-editor-context";
import { useImageEditorModelStateDesign } from "./useImageEditorModelStateDesign";
import { useImageEditorModelArrangeKeyboard } from "./useImageEditorModelArrangeKeyboard";
import { useImageEditorModelUploadCrop } from "./useImageEditorModelUploadCrop";
import { useImageEditorModelExport } from "./useImageEditorModelExport";
import { useImageEditorModelCart } from "./useImageEditorModelCart";
import type { EditorActionToolbarProps } from "./editor-action-toolbar";

export type { ImageInfo, ResizeSettings, ImageTransform, DesignItem } from "@/lib/types";

export function ImageEditorProvider({ children, ...props }: ImageEditorProps & { children: React.ReactNode }) {
  const value = useImageEditorModel(props);
  return <ImageEditorContext.Provider value={value}>{children}</ImageEditorContext.Provider>;
}

function useImageEditorModel(props: ImageEditorProps) {
  const p0 = useImageEditorModelStateDesign(props);
  const p1 = useImageEditorModelArrangeKeyboard(p0);
  const p2 = useImageEditorModelUploadCrop({ ...p0, ...p1 });
  const p3 = useImageEditorModelExport({ ...p0, ...p1, ...p2 });
  const p4 = useImageEditorModelCart({ ...p0, ...p1, ...p2, ...p3 });
  const bag = { ...p0, ...p1, ...p2, ...p3, ...p4 };

  const actionToolbarProps: EditorActionToolbarProps = {
    t: bag.t,
    lang: bag.lang,
    embedFromShopify: bag.embedFromShopify,
    isUploading: bag.isUploading,
    activeImageInfo: bag.activeImageInfo,
    handleFileUploadUnified: bag.handleFileUploadUnified,
    handleBatchStart: bag.handleBatchStart,
    selectedDesignId: bag.selectedDesignId,
    selectedDesignIds: bag.selectedDesignIds,
    designs: bag.designs,
    handleThresholdAlpha: bag.handleThresholdAlpha,
    handleThresholdAlphaAll: bag.handleThresholdAlphaAll,
    handleAutoArrange: bag.handleAutoArrange,
    canUndo: bag.canUndo,
    canRedo: bag.canRedo,
    handleUndo: bag.handleUndo,
    handleRedo: bag.handleRedo,
    duplicateCount: bag.duplicateCount,
    setDuplicateCount: bag.setDuplicateCount,
    parseDuplicateCount: bag.parseDuplicateCount,
    handleDuplicateCountKeyDown: bag.handleDuplicateCountKeyDown,
    clampDuplicateCount: bag.clampDuplicateCount,
    handleDuplicateDesign: bag.handleDuplicateDesign,
    handleDeleteDesign: bag.handleDeleteDesign,
    handleDeleteMulti: bag.handleDeleteMulti,
    handleDuplicateAndArrange: bag.handleDuplicateAndArrange,
    designGap: bag.designGap,
    setDesignGap: bag.setDesignGap,
    handleAutoArrangeRef: bag.handleAutoArrangeRef,
    artboardWidth: bag.artboardWidth,
    artboardHeight: bag.artboardHeight,
    setArtboardWidth: bag.setArtboardWidth,
    setArtboardHeight: bag.setArtboardHeight,
    proportionalLock: bag.proportionalLock,
    setProportionalLock: bag.setProportionalLock,
    activeResizeSettings: bag.activeResizeSettings,
    activeDesignTransform: bag.activeDesignTransform,
    effectiveDPI: bag.effectiveDPI,
    handleEffectiveSizeChange: bag.handleEffectiveSizeChange,
    handleRotate90: bag.handleRotate90,
    handleAlignCorner: bag.handleAlignCorner,
    isMobile: bag.isMobile,
    isLgUp: bag.isLgUp,
    selectedVariantPrice: bag.selectedVariantPrice,
    GANGSHEET_HEIGHTS: bag.GANGSHEET_HEIGHTS,
    recommendedArtboardHeight: bag.recommendedArtboardHeight,
    profile: bag.profile,
    onAddToCart: bag.handleAddToCart,
    hasVariantId: !!(bag.initialVariantId || bag.shopifyVariants?.length),
    isEditMode: bag.isEditMode,
    isAddingToCart: bag.isAddingToCart,
    isProcessing: bag.isProcessing,
  };

  return { ...bag, actionToolbarProps };
}

export type ImageEditorModel = ReturnType<typeof useImageEditorModel>;

import type { ImageEditorProps } from "./types";
import { ImageEditorContext } from "./image-editor-context";
import { useImageEditorModelStateDesign } from "./useImageEditorModelStateDesign";
import { useImageEditorModelArrangeKeyboard } from "./useImageEditorModelArrangeKeyboard";
import { useImageEditorModelUploadCrop } from "./useImageEditorModelUploadCrop";
import { useImageEditorModelHalftone } from "./useImageEditorModelHalftone";
import { useImageEditorModelExport } from "./useImageEditorModelExport";
import { useImageEditorModelCart } from "./useImageEditorModelCart";
import type { EditorActionToolbarProps } from "./editor-action-toolbar";
import { clampDesignToArtboard } from "./utils";

export type { ImageInfo, ResizeSettings, ImageTransform, DesignItem } from "@/lib/types";

export function ImageEditorProvider({ children, ...props }: ImageEditorProps & { children: React.ReactNode }) {
  const value = useImageEditorModel(props);
  return <ImageEditorContext.Provider value={value}>{children}</ImageEditorContext.Provider>;
}

function useImageEditorModel(props: ImageEditorProps) {
  const p0 = useImageEditorModelStateDesign(props);
  const p1 = useImageEditorModelArrangeKeyboard(p0);
  const p2 = useImageEditorModelUploadCrop({ ...p0, ...p1 });
  const p3 = useImageEditorModelHalftone({ ...p0, ...p1, ...p2 });
  const p4 = useImageEditorModelExport({ ...p0, ...p1, ...p2, ...p3 });
  const p5 = useImageEditorModelCart({ ...p0, ...p1, ...p2, ...p3, ...p4 });
  const bag = { ...p0, ...p1, ...p2, ...p3, ...p4, ...p5 };

  const handleSetRotation = (degrees: number) => {
    const ids = bag.selectedDesignIds.size > 0
      ? bag.selectedDesignIds
      : (bag.selectedDesignId ? new Set([bag.selectedDesignId]) : new Set<string>());
    if (ids.size === 0 || !Number.isFinite(degrees)) return;
    const rotation = ((Math.round(degrees) % 360) + 360) % 360;
    bag.saveSnapshot();
    bag.setDesigns(prev => prev.map(d => {
      if (!ids.has(d.id)) return d;
      const rotated = { ...d, transform: { ...d.transform, rotation } };
      const { nx, ny } = clampDesignToArtboard(rotated, bag.artboardWidth, bag.artboardHeight);
      return { ...rotated, transform: { ...rotated.transform, nx, ny } };
    }));
  };

  const handleAlignAxis = (axis: "horizontal" | "vertical") => {
    const ids = bag.selectedDesignIds.size > 0
      ? bag.selectedDesignIds
      : (bag.selectedDesignId ? new Set([bag.selectedDesignId]) : new Set<string>());
    const targets = bag.designs.filter(d => ids.has(d.id));
    if (targets.length === 0) return;
    bag.saveSnapshot();
    const center = targets.reduce(
      (sum, d) => sum + (axis === "horizontal" ? d.transform.nx : d.transform.ny),
      0,
    ) / targets.length;
    bag.setDesigns(prev => prev.map(d => {
      if (!ids.has(d.id)) return d;
      const next = { ...d, transform: { ...d.transform, [axis === "horizontal" ? "nx" : "ny"]: center } };
      const { nx, ny } = clampDesignToArtboard(next, bag.artboardWidth, bag.artboardHeight);
      return { ...next, transform: { ...next.transform, nx, ny } };
    }));
  };

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
    handleSetRotation,
    handleAlignAxis,
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

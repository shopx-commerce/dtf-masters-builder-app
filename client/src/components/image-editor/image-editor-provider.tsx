import type { ImageEditorProps } from "./types";
import { ImageEditorContext } from "./image-editor-context";
import { useImageEditorModelStateDesign } from "./useImageEditorModelStateDesign";
import { useImageEditorModelArrangeKeyboard } from "./useImageEditorModelArrangeKeyboard";
import { useImageEditorModelUploadCrop } from "./useImageEditorModelUploadCrop";
import { useImageEditorModelHalftone } from "./useImageEditorModelHalftone";
import { useImageEditorModelExport } from "./useImageEditorModelExport";
import { useImageEditorModelCart } from "./useImageEditorModelCart";
import type { EditorActionToolbarProps } from "./editor-action-toolbar";
import { clampDesignToArtboard, getRotatedBounds } from "./utils";

export type { ImageInfo, ResizeSettings, ImageTransform, DesignItem } from "@/lib/types";

function rotateDesignGroup(
  designs: DesignItem[],
  ids: Set<string>,
  angleDeg: number,
  artboardWidth: number,
  artboardHeight: number,
) {
  const targets = designs.filter(d => ids.has(d.id));
  if (targets.length === 0) return new Map<string, { nx: number; ny: number; rotation: number }>();

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const d of targets) {
    const bounds = getRotatedBounds(d);
    const cx = d.transform.nx * artboardWidth;
    const cy = d.transform.ny * artboardHeight;
    minX = Math.min(minX, cx + bounds.minX);
    maxX = Math.max(maxX, cx + bounds.maxX);
    minY = Math.min(minY, cy + bounds.minY);
    maxY = Math.max(maxY, cy + bounds.maxY);
  }

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const candidates = targets.map(d => {
    const px = d.transform.nx * artboardWidth - centerX;
    const py = d.transform.ny * artboardHeight - centerY;
    return {
      d,
      nx: (centerX + px * cos - py * sin) / artboardWidth,
      ny: (centerY + px * sin + py * cos) / artboardHeight,
      rotation: ((d.transform.rotation + angleDeg) % 360 + 360) % 360,
    };
  });

  let nextMinX = Infinity, nextMaxX = -Infinity, nextMinY = Infinity, nextMaxY = -Infinity;
  for (const { d, nx, ny, rotation } of candidates) {
    const bounds = getRotatedBounds({
      ...d,
      transform: { ...d.transform, nx, ny, rotation },
    });
    const cx = nx * artboardWidth;
    const cy = ny * artboardHeight;
    nextMinX = Math.min(nextMinX, cx + bounds.minX);
    nextMaxX = Math.max(nextMaxX, cx + bounds.maxX);
    nextMinY = Math.min(nextMinY, cy + bounds.minY);
    nextMaxY = Math.max(nextMaxY, cy + bounds.maxY);
  }

  if (nextMinX < 0 || nextMaxX > artboardWidth || nextMinY < 0 || nextMaxY > artboardHeight) {
    return null;
  }
  return new Map(candidates.map(({ d, nx, ny, rotation }) => [
    d.id,
    { nx, ny, rotation },
  ]));
}

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

  const handleSetGroupCount = (row: { designs: typeof bag.designs }, targetCount: number) => {
    if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 200) return;
    const delta = targetCount - row.designs.length;
    if (delta === 0) return;
    bag.saveSnapshot();
    if (delta > 0) {
      const base = row.designs[0];
      const baseName = base.name.replace(/ copy( \d+)?$/, "");
      const copies = Array.from({ length: delta }, () => ({
        ...base,
        id: crypto.randomUUID(),
        name: baseName,
        transform: { ...base.transform },
        printFileName: false,
      }));
      bag.setDesigns(prev => [...prev, ...copies]);
      bag.setSelectedDesignIds(new Set([...row.designs.map(d => d.id), ...copies.map(d => d.id)]));
      bag.setSelectedDesignId(copies[copies.length - 1].id);
    } else {
      const idsToRemove = new Set(row.designs.slice(targetCount).map(d => d.id));
      bag.setDesigns(prev => prev.filter(d => !idsToRemove.has(d.id)));
      bag.setSelectedDesignIds(prev => new Set([...prev].filter(id => !idsToRemove.has(id))));
      if (bag.selectedDesignId && idsToRemove.has(bag.selectedDesignId)) {
        bag.setSelectedDesignId(row.designs.find(d => !idsToRemove.has(d.id))?.id ?? null);
      }
    }
    // Wait for the copy list and selection state to commit before arranging.
    // Auto-Arrange will reuse the configured height-expansion loop if the new
    // copies do not fit on the current gangsheet.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        bag.handleAutoArrangeRef.current({ skipSnapshot: true, preserveSelection: true });
      });
    });
  };

  const handleSetRotation = (degrees: number) => {
    const ids = bag.selectedDesignIds.size > 0
      ? bag.selectedDesignIds
      : (bag.selectedDesignId ? new Set([bag.selectedDesignId]) : new Set<string>());
    if (ids.size === 0 || !Number.isFinite(degrees)) return;
    const rotation = ((Math.round(degrees) % 360) + 360) % 360;
    bag.saveSnapshot();
    bag.setDesigns(prev => {
      if (ids.size > 1) {
        const active = prev.find(d => d.id === bag.selectedDesignId);
        const delta = active ? rotation - active.transform.rotation : 0;
        const rotated = rotateDesignGroup(prev, ids, delta, bag.artboardWidth, bag.artboardHeight);
        if (!rotated) return prev;
        return prev.map(d => {
          const next = rotated.get(d.id);
          return next ? { ...d, transform: { ...d.transform, ...next } } : d;
        });
      }
      return prev.map(d => {
        if (!ids.has(d.id)) return d;
        const next = { ...d, transform: { ...d.transform, rotation } };
        const { nx, ny } = clampDesignToArtboard(next, bag.artboardWidth, bag.artboardHeight);
        return { ...next, transform: { ...next.transform, nx, ny } };
      });
    });
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

  return { ...bag, handleSetGroupCount, actionToolbarProps };
}

export type ImageEditorModel = ReturnType<typeof useImageEditorModel>;

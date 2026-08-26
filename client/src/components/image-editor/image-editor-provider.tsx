import { useCallback } from "react";
import type { ImageEditorProps } from "./types";
import { ImageEditorContext } from "./image-editor-context";
import { useImageEditorModelStateDesign } from "./useImageEditorModelStateDesign";
import { useImageEditorModelArrangeKeyboard } from "./useImageEditorModelArrangeKeyboard";
import { useImageEditorModelUploadCrop } from "./useImageEditorModelUploadCrop";
import { useImageEditorModelHalftone } from "./useImageEditorModelHalftone";
import { useImageEditorModelColorChange } from "./useImageEditorModelColorChange";
import { useImageEditorModelExport } from "./useImageEditorModelExport";
import { useImageEditorModelCart } from "./useImageEditorModelCart";
import { useCartPreviewUploader } from "./use-cart-preview-uploader";
import type { EditorActionToolbarProps } from "./editor-action-toolbar";
import {
  clampDesignToArtboard,
  getDesignSelectionBounds,
  getDesignSelectionUnits,
  getRotatedBounds,
  rotateDesignSelection,
} from "./utils";
import type { DesignItem } from "@/lib/types";

export type { ImageInfo, ResizeSettings, ImageTransform, DesignItem } from "@/lib/types";

/**
 * Provisional spacing for freshly-created copies, in inches. Only has to be close: the
 * arrange that follows repacks everything with the customer's real gap setting.
 */
const COPY_SEED_GAP_INCHES = 0.25;

/**
 * Lay new copies out in a grid below the existing artwork instead of stacking them all on
 * the design they came from.
 *
 * Copies used to be born at the base's exact transform, so for the whole time the packer
 * was working — seconds, on a sheet with a couple of hundred designs — the customer was
 * looking at a single design with N invisible duplicates underneath it. Any hiccup in the
 * arrange left that pile on screen, which is what "it just overlaps everything and doesn't
 * even auto arrange" describes.
 *
 * This is deliberately arithmetic rather than a pack: it runs in the same tick as the
 * click, it never overlaps, and it starts below the current content so it does not disturb
 * work the customer has already placed — which also gives the packer's stable-layout pass
 * a sensible starting point. Rows that run past the bottom of the sheet are fine; the
 * arrange that follows either fits them or grows the sheet, exactly as before.
 */
function seedCopyGrid(args: {
  base: Omit<DesignItem, "groupId">;
  baseName: string;
  ids: string[];
  existing: DesignItem[];
  artboardWidth: number;
  artboardHeight: number;
}): DesignItem[] {
  const { base, baseName, ids, existing, artboardWidth, artboardHeight } = args;
  const bounds = getRotatedBounds(base);
  const footprintW = bounds.maxX - bounds.minX;
  const footprintH = bounds.maxY - bounds.minY;

  const makeCopy = (id: string, transform: DesignItem["transform"]): DesignItem => ({
    ...base,
    id,
    name: baseName,
    transform,
  });

  // A degenerate footprint would divide by zero below. Falling back to the old co-located
  // behaviour is worse than nothing but still lets arrange sort it out.
  if (!(footprintW > 0) || !(footprintH > 0)) {
    return ids.map(id => makeCopy(id, { ...base.transform }));
  }

  let bandBottom = 0;
  for (const d of existing) {
    const b = getRotatedBounds(d);
    const bottom = d.transform.ny * artboardHeight + b.maxY;
    if (bottom > bandBottom) bandBottom = bottom;
  }

  const gap = COPY_SEED_GAP_INCHES;
  const columns = Math.max(1, Math.floor((artboardWidth + gap) / (footprintW + gap)));
  return ids.map((id, i) => {
    const column = i % columns;
    const rowIndex = Math.floor(i / columns);
    // Grid cell's top-left, converted to the design's centre — which is not the centre of
    // its bounding box once rotation or a print-name stamp is involved.
    const left = gap + column * (footprintW + gap);
    const top = bandBottom + gap + rowIndex * (footprintH + gap);
    return makeCopy(id, {
      ...base.transform,
      nx: (left - bounds.minX) / artboardWidth,
      ny: (top - bounds.minY) / artboardHeight,
    });
  });
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
  const colorChange = useImageEditorModelColorChange({ ...p0, ...p1, ...p2, ...p3 });
  const p4 = useImageEditorModelExport({ ...p0, ...p1, ...p2, ...p3, ...colorChange });
  // Hand-picked fields rather than the accumulated bag: this hook's inputs are narrow and explicit,
  // so what it actually depends on stays readable at the call site.
  const cartPreview = useCartPreviewUploader({
    designs: p0.designs,
    artboardWidth: p0.artboardWidth,
    artboardHeight: p0.artboardHeight,
    designIdRef: p0.designIdRef,
    shellUploadUrlRef: p0.shellUploadUrlRef,
    shellShopKeyRef: p0.shellShopKeyRef,
    shellConfigReady: p0.shellConfigReady,
  });
  const p5 = useImageEditorModelCart({ ...p0, ...p1, ...p2, ...p3, ...p4, ...cartPreview });
  const bag = { ...p0, ...p1, ...p2, ...p3, ...colorChange, ...p4, ...p5, ...cartPreview };

  // These three handlers used to be plain function declarations recreated
  // on every provider render — which meant every child that received them
  // (notably `<EditorActionToolbar>`) got new prop refs on every model
  // state change, defeating `React.memo` before it could even run its
  // shallow compare. Wrapping them in `useCallback` with explicit deps
  // keeps their identity stable when the specific bag fields they
  // actually read haven't changed.
  const {
    saveSnapshot: bagSaveSnapshot,
    setDesigns: bagSetDesigns,
    setSelectedDesignIds: bagSetSelectedDesignIds,
    setSelectedDesignId: bagSetSelectedDesignId,
    selectedDesignId: bagSelectedDesignId,
    selectedDesignIds: bagSelectedDesignIds,
    handleAutoArrangeRef: bagHandleAutoArrangeRef,
    beginArrangeRef: bagBeginArrangeRef,
    artboardWidth: bagArtboardWidth,
    artboardHeight: bagArtboardHeight,
    designs: bagDesigns,
  } = bag;

  const handleSetGroupCount = useCallback((row: { designs: typeof bagDesigns }, targetCount: number) => {
    if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 200) return;
    const delta = targetCount - row.designs.length;
    if (delta === 0) return;
    bagSaveSnapshot();
    // Before the copies land: the seeded grid below and the pack that replaces it are two
    // separate paints, and the veil is what stops the customer seeing the first one.
    bagBeginArrangeRef.current();
    if (delta > 0) {
      const base = row.designs[0];
      const baseName = base.name.replace(/ copy( \d+)?$/, "");
      // Strip `groupId` from row-count copies. If the source belongs to
      // a user-defined group, inheriting that `groupId` would collapse
      // every copy into the same super-item during auto-arrange, and the
      // packer would then look for one slot big enough for the lot.
      // Stripping matches `handleDuplicateDesign`'s behavior for
      // single-source copies: layer-row "+" is semantically "add N more
      // of this item to the sheet", not "expand the group", so the new
      // copies should be free to be placed independently by arrange.
      const { groupId: _dropGid, ...baseNoGroup } = base;
      const copyIds = Array.from({ length: delta }, () => crypto.randomUUID());
      bagSetDesigns(prev => [...prev, ...seedCopyGrid({
        base: baseNoGroup,
        baseName,
        ids: copyIds,
        existing: prev,
        artboardWidth: bagArtboardWidth,
        artboardHeight: bagArtboardHeight,
      })]);
      bagSetSelectedDesignIds(new Set([...row.designs.map(d => d.id), ...copyIds]));
      bagSetSelectedDesignId(copyIds[copyIds.length - 1]);
    } else {
      const idsToRemove = new Set(row.designs.slice(targetCount).map(d => d.id));
      bagSetDesigns(prev => prev.filter(d => !idsToRemove.has(d.id)));
      bagSetSelectedDesignIds(prev => new Set([...prev].filter(id => !idsToRemove.has(id))));
      if (bagSelectedDesignId && idsToRemove.has(bagSelectedDesignId)) {
        bagSetSelectedDesignId(row.designs.find(d => !idsToRemove.has(d.id))?.id ?? null);
      }
    }
    // Wait for the copy list and selection state to commit before arranging.
    // Auto-Arrange will reuse the configured height-expansion loop if the new
    // copies do not fit on the current gangsheet.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Copy-count changes must repack the whole sheet. The newly created
        // copies are selected for layer feedback, but selected-only arranging
        // would keep every other design fixed and stack copies in one column.
        // `fullRepack` so the result matches the Auto-Arrange button — see
        // COPY_ARRANGE_OPTS in useImageEditorModelStateDesign.
        bagHandleAutoArrangeRef.current({
          skipSnapshot: true,
          preserveSelection: true,
          arrangeAll: true,
          fullRepack: true,
        });
      });
    });
  }, [bagSaveSnapshot, bagSetDesigns, bagSetSelectedDesignIds, bagSetSelectedDesignId, bagSelectedDesignId, bagHandleAutoArrangeRef, bagBeginArrangeRef, bagArtboardWidth, bagArtboardHeight]);

  const handleSetRotation = useCallback((degrees: number) => {
    const ids = bagSelectedDesignIds.size > 0
      ? bagSelectedDesignIds
      : (bagSelectedDesignId ? new Set([bagSelectedDesignId]) : new Set<string>());
    if (ids.size === 0 || !Number.isFinite(degrees)) return;
    const rotation = ((Math.round(degrees) % 360) + 360) % 360;
    bagSaveSnapshot();
    bagSetDesigns(prev => {
      if (ids.size > 1) {
        const active = prev.find(d => d.id === bagSelectedDesignId);
        const delta = active ? rotation - active.transform.rotation : 0;
         const rotated = rotateDesignSelection(prev, ids, delta, bagArtboardWidth, bagArtboardHeight);
        if (!rotated) return prev;
        return prev.map(d => {
          const next = rotated.get(d.id);
          return next ? { ...d, transform: { ...d.transform, ...next } } : d;
        });
      }
      return prev.map(d => {
        if (!ids.has(d.id)) return d;
        const next = { ...d, transform: { ...d.transform, rotation } };
        const { nx, ny } = clampDesignToArtboard(next, bagArtboardWidth, bagArtboardHeight);
        return { ...next, transform: { ...next.transform, nx, ny } };
      });
    });
  }, [bagSelectedDesignIds, bagSelectedDesignId, bagSaveSnapshot, bagSetDesigns, bagArtboardWidth, bagArtboardHeight]);

  // Center-align the current selection along one axis.
  //
  // Axis naming follows the Illustrator / Figma convention:
  //   `axis === "vertical"`   → items share a *vertical* center axis
  //                              → all get the same X coordinate (`nx`), so
  //                              they move left/right. Button: "Center left
  //                              to right" (`CenterHorizontalIcon`).
  //   `axis === "horizontal"` → items share a *horizontal* center axis
  //                              → all get the same Y coordinate (`ny`), so
  //                              they move up/down. Button: "Center top to
  //                              bottom" (`CenterVerticalIcon`).
  //
  // Previous implementation wrote the *other* axis (see git history);
  // that is why "align vertically" collapsed everything onto one Y line
  // (looked like a merge) and "align horizontally" barely moved anything
  // on a tall gangsheet.
  //
  // Targeting rules — chosen for predictability in a consumer editor:
  //   - Zero designs selected → no-op (defensive; the button is disabled
  //     in that state anyway).
  //   - One design selected   → snap to the artboard's center line
  //     (0.5). "Center on sheet" is the intuitive one-item behavior;
  //     averaging a single value would silently produce a no-op.
  //   - Two+ designs selected → snap all to the *bounding-box* center
  //     of the selection along the target axis. Bounding-box center
  //     `(min + max) / 2` is more predictable than the mean, which
  //     weights toward clusters and can drift far from the visual
  //     midpoint of a lopsided selection.
  const handleAlignAxis = useCallback((axis: "horizontal" | "vertical") => {
    const ids = bagSelectedDesignIds.size > 0
      ? bagSelectedDesignIds
      : (bagSelectedDesignId ? new Set([bagSelectedDesignId]) : new Set<string>());
    if (ids.size === 0) return;
    const units = getDesignSelectionUnits(
      bagDesigns,
      ids,
      bagArtboardWidth,
      bagArtboardHeight,
    );
    if (units.length === 0) return;
    bagSaveSnapshot();

    // Field the operation writes: vertical axis → nx; horizontal axis → ny.
    const field: "nx" | "ny" = axis === "vertical" ? "nx" : "ny";

    const selectionBounds = getDesignSelectionBounds(
      bagDesigns,
      ids,
      bagArtboardWidth,
      bagArtboardHeight,
    );
    if (!selectionBounds) return;
    const targetPx = units.length === 1
      ? (axis === "vertical" ? bagArtboardWidth : bagArtboardHeight) / 2
      : (axis === "vertical"
        ? (selectionBounds.minX + selectionBounds.maxX) / 2
        : (selectionBounds.minY + selectionBounds.maxY) / 2);

    const deltas = new Map<string, number>();
    for (const unit of units) {
      const unitCenter = field === "nx"
        ? (unit.minX + unit.maxX) / 2
        : (unit.minY + unit.maxY) / 2;
      const axisSize = field === "nx" ? bagArtboardWidth : bagArtboardHeight;
      const desired = (targetPx - unitCenter) / axisSize;
      const minDelta = field === "nx"
        ? -unit.minX / bagArtboardWidth
        : -unit.minY / bagArtboardHeight;
      const maxDelta = field === "nx"
        ? (bagArtboardWidth - unit.maxX) / bagArtboardWidth
        : (bagArtboardHeight - unit.maxY) / bagArtboardHeight;
      const delta = minDelta <= maxDelta
        ? Math.max(minDelta, Math.min(maxDelta, desired))
        : 0;
      for (const member of unit.members) deltas.set(member.id, delta);
    }

    bagSetDesigns(prev => prev.map(d => {
      const delta = deltas.get(d.id);
      if (delta === undefined) return d;
      return {
        ...d,
        transform: {
          ...d.transform,
          nx: d.transform.nx + (field === "nx" ? delta : 0),
          ny: d.transform.ny + (field === "ny" ? delta : 0),
        },
      };
    }));
  }, [bagSelectedDesignIds, bagSelectedDesignId, bagDesigns, bagSaveSnapshot, bagSetDesigns, bagArtboardWidth, bagArtboardHeight]);

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
    canFill: bag.canFill,
    handleFillEmptySpace: bag.handleFillEmptySpace,
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
    exportProgressLabel: bag.exportProgressLabel,
    handleIncreaseQuality: bag.handleIncreaseQuality,
    isUpscaling: bag.isUpscaling,
    upscaleProgress: bag.upscaleProgress,
    canIncreaseQuality: bag.canIncreaseQuality,
  };

  return { ...bag, handleSetGroupCount, actionToolbarProps };
}

export type ImageEditorModel = ReturnType<typeof useImageEditorModel>;

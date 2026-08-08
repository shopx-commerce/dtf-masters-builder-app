import UploadSection from "../upload-section";
import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import PreviewSection from "../preview-section";
import ControlsSection from "../controls-section";
import CropModal from "../crop-modal";
import SizeInput from "./size-input";
import EditorActionToolbar from "./editor-action-toolbar";
import MobileToolSheet from "./mobile-tool-sheet";
import { LayerRow, type LayerRowHandlers } from "./layer-row";
import { UploadsPanel } from "./uploads-panel";
import { useToast } from "@/hooks/use-toast";
import { useKeyboardSafeFocus } from "@/hooks/use-keyboard-safe-focus";
import { useMobileLayout } from "@/hooks/use-layout-viewport";
import { formatDimensions, formatLength, useMetric, getUnitSuffix } from "@/lib/format-length";
import { formatVariantPriceForDisplay } from "@/lib/variant-price";
import { useWandTolerance, useToolActions } from "@/state/tool-store";
import {
  ArrowDownLeft, ArrowDownRight, ArrowUpLeft, ArrowUpRight, Copy, ChevronDown, ChevronUp,
  Droplets, Eraser, FlipHorizontal2, FlipVertical2, Group, Layers, LayoutGrid, Link, Loader2, Minus, Plus, RotateCw,
  Trash2, Undo2, Redo2, Ungroup, Unlink, WandSparkles, X, XCircle,
} from "lucide-react";
import { useImageEditorContext } from "./image-editor-context";
import {
  useContextMenu,
  useShowDesignInfo,
  useSelectionZoomActive,
  usePanModeActive,
  useWandDeleteModeActive,
  useActiveSpotChannel,
  useSpotPreviewData,
  useCropModalDesignId,
  useUiActions,
  useUiStore,
} from "@/state/ui-store";

/** Halftone icon — a grid of circles shrinking diagonally. */
const HalftoneIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
    <circle cx="2.5"  cy="2.5"  r="2.2"/>
    <circle cx="8"    cy="2.5"  r="1.6"/>
    <circle cx="13.5" cy="2.5"  r="0.9"/>
    <circle cx="2.5"  cy="8"    r="1.6"/>
    <circle cx="8"    cy="8"    r="1.1"/>
    <circle cx="13.5" cy="8"    r="0.6"/>
    <circle cx="2.5"  cy="13.5" r="0.9"/>
    <circle cx="8"    cy="13.5" r="0.6"/>
    <circle cx="13.5" cy="13.5" r="0.3"/>
  </svg>
);



export default function ImageEditorView() {
  const {
    t, lang, profile, embedFromShopify, isMobile, isLgUp, isUploading, uploadProgress, isProcessing, exportProgressLabel,
    isAddingToCart, isEditMode, isUpdateFlow, isDragOver, artboardWidth, artboardHeight,
    quantity, designGap, duplicateCount, designs, setDesigns, selectedDesignId, setSelectedDesignId,
    selectedDesignIds, setSelectedDesignIds,
    proportionalLock,
    setProportionalLock,
    activeImageInfo, activeDesignTransform,
    activeResizeSettings, selectedVariantPrice, effectiveDPI, layerRows, canvasRef, designInfoRef,
    sidebarFileRef, headerUploadInputRef, downloadContainer, setDownloadContainer,
    fluorPanelContainer, setFluorPanelContainer, mobileToolbarContainer, setMobileToolbarContainer,
    copySpotSelectionsRef, GANGSHEET_HEIGHTS, MAX_ARTBOARD_HEIGHT, recommendedArtboardHeight,
    initialVariantId, shopifyVariants,
    handleFileUploadUnified, handleBatchStart, handleSidebarFileChange, processSidebarFile, handleDragEnter,
    handleDragLeave, handleDragOver, handleDrop, handleSelectDesign, handleMultiSelect,
    handleGroupSelected, handleUngroupSelected, selectedHasGroup,
    handleDesignTransformChange, handleMultiDragDelta, handleMultiResizeDelta, handleMultiRotateDelta,
    handleEffectiveSizeChange, handleResizeChange, handleDuplicateDesign,
    handleDuplicateAndArrange, handleDuplicateSelected, handleDuplicateById, handleRemoveOneCopy, handleSetGroupCount,
    handleDeleteDesign, handleDeleteGroup, handleDeleteMulti, handleRotate90, handleFlipX, handleFlipY, handleAlignCorner,
    handleAutoArrange, handleArtboardHeightPick, handleThresholdAlpha,
    handleThresholdAlphaAll, handleCropDesign, handleCropApply, handleDownload, handleAddToCart,
    handleApplyHalftone, handleOpenHalftoneMenu, halftoneStrength, setHalftoneStrength,
    halftoneMenuOpen, setHalftoneMenuOpen, halftoneTopColors,
    handleRemoveWhiteBackground, handleWandDelete,
    handleCanvasContextMenu, handleInteractionEnd, handleUndo, handleRedo, canUndo, canRedo,
    handleAutoArrangeRef, actionToolbarProps, getLayerThumbnail, setDesignGap, setDuplicateCount,
    parseDuplicateCount, handleDuplicateCountKeyDown, clampDuplicateCount, setArtboardWidth,
    setArtboardHeight, setQuantity, draftRecoveryAvailable, isRecoveringDraft,
    recoverEditorDraft, discardEditorDraft,
  } = useImageEditorContext();
  const { toast } = useToast();
  // Which layout to render, as distinct from `isMobile` (which stays "is this a
  // small touch device" and drives target sizing in `preview-section` and the
  // fixed bottom bar in `controls-section`).
  //
  // Two things separate them. A phone on its side is 844×390: wide enough to
  // leave the mobile layout, too short for the desktop one, whose sidebar is
  // `w-full` until `lg` and pushes the canvas ~790px down a viewport that cannot
  // scroll. And inside the storefront iframe `window.innerWidth` is the iframe's
  // width, not the device's, so a padded theme container can hand a tablet the
  // phone layout — the shell can correct that over `dtf-builder-shell-config`.
  // See `hooks/use-layout-viewport.ts`.
  const mobileLayout = useMobileLayout();
  // The phone presents one surface — canvas, persistent bar, contextual sheet.
  // Everything the old Controls panel held that is not contextual to a
  // selection now lives behind this, summoned over the canvas rather than
  // taking layout width or height from it.
  const [layersOpen, setLayersOpen] = useState(false);
  const wandTolerance = useWandTolerance();
  const { setWandTolerance } = useToolActions();
  // Lifts a focused field clear of the software keyboard. Inert unless the
  // visual viewport actually shrinks, so desktop is untouched.
  useKeyboardSafeFocus();
  const handleAddFromUploads = useCallback(async (file: File) => {
    await processSidebarFile(file);
  }, [processSidebarFile]);
  const handleUploadUnavailable = useCallback(() => {
    toast({ title: t("editor.uploadsUnavailable"), variant: "destructive" });
  }, [toast, t]);
  // UI-mode state comes from the Zustand `ui-store` — see
  // `state/ui-store.ts`. These toggles used to sit in the model bag and
  // any change (right-click, mobile-panel flip, spot-channel hover, etc.)
  // regenerated the whole bag, which invalidated every model callback.
  // Now the model is untouched and only this view (plus the specific
  // consumers below) re-renders when they change.
  const contextMenu = useContextMenu();
  // `mobilePanel` is no longer read here: the phone has one surface, so there
  // is nothing to flip between. The store field and its writers stay because
  // `useImageEditorModelUploadCrop` still sets it after an upload.
  const showDesignInfo = useShowDesignInfo();
  const selectionZoomActive = useSelectionZoomActive();
  const panModeActive = usePanModeActive();
  const wandDeleteModeActive = useWandDeleteModeActive();
  const activeSpotChannel = useActiveSpotChannel();
  const spotPreviewData = useSpotPreviewData();
  const cropModalDesignId = useCropModalDesignId();
  const {
    setContextMenu,
    setMobilePanel,
    setShowDesignInfo,
    setSelectionZoomActive,
    setPanModeActive,
    setWandDeleteModeActive,
    setActiveSpotChannel,
    setSpotPreviewData,
    setCropModalDesignId,
  } = useUiActions();

  // Auto-close the right-click context menu on outside click, scroll, or
  // Escape. Moved out of the model hook so opening / closing the menu no
  // longer re-runs the model — only this view (which already subscribes
  // to `contextMenu`) reacts to the change.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu, setContextMenu]);

  // NOTE: `editingCountKey` / `editingCountValue` (and their name-input
  // counterparts) previously lived here + in the model bag and were
  // threaded to every `<LayerRow>` as props. They now live in the Zustand
  // `editing-store` and each row subscribes to *only* its own slice, so
  // typing in one row's inputs no longer forces every other row to
  // re-render.
  const wandAssignRef = useRef<((nx: number, ny: number) => void) | null>(null);
  const clearActiveChannelRef = useRef<(() => void) | null>(null);
  const halftoneEnabled = profile?.id === "hot-peel" || profile?.id === "fluorescent";

  // Stable-identity callbacks for the two `<PreviewSection>` call sites
  // (mobile + desktop). Both were inline arrow functions until now, which
  // meant every parent re-render created new prop references and defeated
  // `memo(PreviewSection)`'s shallow compare. Wrapping them once here
  // gives the memo compare a real chance to short-circuit when nothing
  // relevant has changed.
  //
  // Deps are the two Zustand action refs (stable for the store's
  // lifetime, so this effectively pins the callback identity forever).
  const handleWandTap = useCallback(
    (nx: number, _ny: number, _id: string | null) => {
      wandAssignRef.current?.(nx, _ny);
    },
    [],
  );
  const handleSelectionZoomChange = useCallback(
    (active: boolean) => {
      setSelectionZoomActive(active);
      if (active) {
        clearActiveChannelRef.current?.();
        setPanModeActive(false);
        setWandDeleteModeActive(false);
      }
    },
    [setSelectionZoomActive, setPanModeActive, setWandDeleteModeActive],
  );
  const handleWandDeactivate = useCallback(() => {
    setWandDeleteModeActive(false);
  }, [setWandDeleteModeActive]);

  // `ControlsSection` prop stabilization. Two inline arrows previously
  // defeated `memo(ControlsSection)`:
  //   `onArtboardHeightChange` closed over `artboardWidth` (changes on
  //     resize only — rare, safe to include in deps).
  //   `onWandDeleteToggle` closed over `wandDeleteModeActive` (a hot
  //     boolean that would invalidate the callback on every toggle). We
  //     read it imperatively via `useUiStore.getState()` at click time so
  //     the callback identity stays permanently stable.
  // Picking a height from the dropdown is the one height change the customer makes on
  // purpose, so it goes through `handleArtboardHeightPick`, which records it as the floor
  // auto-shrink will not drop below.
  const handleArtboardHeightChange = useCallback(
    (h: number) => handleArtboardHeightPick(h),
    [handleArtboardHeightPick],
  );
  const handleWandDeleteToggle = useCallback(() => {
    const prev = useUiStore.getState().wandDeleteModeActive;
    const nextActive = !prev;
    setWandDeleteModeActive(nextActive);
    if (nextActive) {
      clearActiveChannelRef.current?.();
      setPanModeActive(false);
      setSelectionZoomActive(false);
      setMobilePanel("preview");
    }
  }, [
    setWandDeleteModeActive,
    setPanModeActive,
    setSelectionZoomActive,
    setMobilePanel,
  ]);

  // Stable-identity handler bundle for `LayerRow`. The context returns
  // some handlers with new identity per render (notably `handleSetGroupCount`,
  // which closes over the ever-changing model `bag`), so we redirect
  // through a ref. `layerHandlers` never changes identity — that's what
  // lets `memo(LayerRow)` skip re-renders when unrelated state churns.
  const layerHandlersLiveRef = useRef({
    handleSelectDesign,
    handleSetGroupCount,
    handleDeleteGroup,
    setDesigns,
    getLayerThumbnail,
  });
  layerHandlersLiveRef.current = {
    handleSelectDesign,
    handleSetGroupCount,
    handleDeleteGroup,
    setDesigns,
    getLayerThumbnail,
  };
  const layerHandlers = useMemo<LayerRowHandlers>(
    () => ({
      handleSelectDesign: (id) => layerHandlersLiveRef.current.handleSelectDesign(id),
      handleSetGroupCount: (row, count) =>
        layerHandlersLiveRef.current.handleSetGroupCount(row, count),
      handleDeleteGroup: (ids) => layerHandlersLiveRef.current.handleDeleteGroup(ids),
      handleAutoArrangeRef,
      setDesigns: (updater) => layerHandlersLiveRef.current.setDesigns(updater),
      getLayerThumbnail: (design) => layerHandlersLiveRef.current.getLayerThumbnail(design),
    }),
    [handleAutoArrangeRef],
  );

  /** Shared by the desktop sidebar's layers card and the phone's layers sheet. */
  const layerListItems = layerRows.map((row) => {
    const rowKey = `${row.baseName}::${row.sizeKey}`;
    return <LayerRow key={rowKey} rowKey={rowKey} row={row} handlers={layerHandlers} />;
  });

  /**
   * One element, rendered into exactly one of the two arms.
   *
   * On desktop it is the sidebar's first card. On the phone it is mounted
   * `hidden`: its two inline cards (gangsheet size, White BG / Magic Wand)
   * are re-laid-out for touch elsewhere in the mobile arm, but the component
   * itself must stay mounted because the download / add-to-cart bar and both
   * fluorescent panels are `createPortal` children of it, and `display: none`
   * on a React ancestor does not reach a portal's DOM parent.
   */
  const controlsSection = (
    <ControlsSection
      resizeSettings={activeResizeSettings}
      onResizeChange={handleResizeChange}
      onDownload={handleDownload}
      isProcessing={isProcessing}
      exportProgressLabel={exportProgressLabel}
      imageInfo={activeImageInfo}
      artboardWidth={artboardWidth}
      artboardHeight={artboardHeight}
      onArtboardHeightChange={handleArtboardHeightChange}
      downloadContainer={downloadContainer}
      designCount={designs.length}
      gangsheetHeights={GANGSHEET_HEIGHTS}
      recommendedArtboardHeight={recommendedArtboardHeight}
      downloadFormat={profile.downloadFormat}
      enableFluorescent={profile.enableFluorescent}
      selectedDesignId={selectedDesignId}
      onSpotPreviewChange={setSpotPreviewData}
      fluorPanelContainer={fluorPanelContainer}
      copySpotSelectionsRef={copySpotSelectionsRef}
      onActiveChannelChange={setActiveSpotChannel}
      wandAssignRef={wandAssignRef}
      panModeActive={panModeActive}
      onPanModeChange={setPanModeActive}
      clearActiveChannelRef={clearActiveChannelRef}
      quantity={quantity}
      onQuantityChange={setQuantity}
      shopifyVariants={shopifyVariants}
      onAddToCart={handleAddToCart}
      hasVariantId={!!(initialVariantId || shopifyVariants?.length)}
      isAddingToCart={isAddingToCart}
      addToCartLabel={isEditMode ? "Update Design" : undefined}
      addingStatusLabel={isEditMode ? "Updating" : undefined}
      lockGangsheetSize={isEditMode}
      onRemoveWhiteBackground={handleRemoveWhiteBackground}
      wandDeleteActive={wandDeleteModeActive}
      onWandDeleteToggle={handleWandDeleteToggle}
    />
  );

  if (!activeImageInfo && !embedFromShopify) {
    return (
      <div
        className="h-full flex items-center justify-center bg-gray-50 relative"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {draftRecoveryAvailable && (
          <div className="absolute inset-x-2 top-2 z-[60] flex items-center justify-between gap-3 rounded-lg border border-cyan-300 bg-white/95 px-3 py-2 text-sm shadow-lg backdrop-blur-sm">
            <div className="min-w-0">
              <p className="font-semibold text-gray-900">{t("editor.draftRecoveryTitle")}</p>
              <p className="truncate text-xs text-gray-600">{t("editor.draftRecoveryDescription")}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => void discardEditorDraft()}
                className="rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
              >
                {t("editor.draftDiscard")}
              </button>
              <button
                type="button"
                onClick={() => void recoverEditorDraft()}
                disabled={isRecoveringDraft}
                className="rounded-md bg-cyan-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-cyan-700 disabled:opacity-60"
              >
                {isRecoveringDraft ? t("editor.draftRecovering") : t("editor.draftRecover")}
              </button>
            </div>
          </div>
        )}
        <input
          ref={headerUploadInputRef}
          type="file"
          className="hidden"
          accept=".png,.jpg,.jpeg,.webp,.pdf,image/png,image/jpeg,image/webp,application/pdf"
          multiple
          onChange={handleSidebarFileChange}
        />
        {isDragOver && (
          <div className="absolute inset-0 z-50 bg-blue-500/10 border-2 border-dashed border-blue-500 rounded-lg flex items-center justify-center pointer-events-none">
            <div className="bg-white/95 rounded-xl px-8 py-6 shadow-lg text-center">
              <Plus className="w-10 h-10 text-blue-500 mx-auto mb-2" />
              <p className="text-blue-600 font-semibold text-lg">Drop files to add designs</p>
              <p className="text-gray-500 text-sm mt-1">PNG, JPG, WebP, or PDF</p>
            </div>
          </div>
        )}
        <div className="w-full max-w-xl mx-auto transition-all duration-300 px-4">
          {isUploading ? (
            <div className="flex flex-col items-center gap-6 py-12">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/30">
                <Loader2 className="w-8 h-8 text-white animate-spin" />
              </div>
              <div className="text-center">
                <p className="text-gray-900 text-lg font-semibold mb-1">{t("editor.processingDesign")}</p>
                <p className="text-gray-600 text-sm">{t("editor.optimizing")}</p>
              </div>
              <div className="w-full max-w-xs">
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 rounded-full transition-all duration-500 ease-out"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
                <p className="text-center text-xs text-gray-600 mt-2">{uploadProgress}%</p>
              </div>
            </div>
          ) : (
            <>
              <UploadSection 
                onImageUpload={handleFileUploadUnified}
                onBatchStart={handleBatchStart}
                imageInfo={null}
              />
              {/* Uploads library — re-add previously uploaded files to a fresh
                  sheet. Desktop only: upload history is off the phone
                  entirely, here as well as in the editor. */}
              {!mobileLayout && (
                <div className="mt-4 w-full max-w-xl mx-auto">
                  <UploadsPanel
                    t={t}
                    onAddFile={handleAddFromUploads}
                    onUnavailable={handleUploadUnavailable}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      /* `isMobile`, not `mobileLayout`: this reserve exists solely to clear the
         bottom bar that `controls-section` pins with `position: fixed`, and that
         is gated on `useIsMobile()`. The two must agree or the bar covers
         content. */
      className={`h-full flex flex-col ${isMobile ? "pb-16" : ""} relative`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {draftRecoveryAvailable && (
        <div className="absolute inset-x-2 top-2 z-[60] flex items-center justify-between gap-3 rounded-lg border border-cyan-300 bg-white/95 px-3 py-2 text-sm shadow-lg backdrop-blur-sm">
          <div className="min-w-0">
            <p className="font-semibold text-gray-900">{t("editor.draftRecoveryTitle")}</p>
            <p className="truncate text-xs text-gray-600">{t("editor.draftRecoveryDescription")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void discardEditorDraft()}
              className="rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
            >
              {t("editor.draftDiscard")}
            </button>
            <button
              type="button"
              onClick={() => void recoverEditorDraft()}
              disabled={isRecoveringDraft}
              className="rounded-md bg-cyan-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-cyan-700 disabled:opacity-60"
            >
              {isRecoveringDraft ? t("editor.draftRecovering") : t("editor.draftRecover")}
            </button>
          </div>
        </div>
      )}
      <input
        ref={headerUploadInputRef}
        type="file"
        className="hidden"
        accept=".png,.jpg,.jpeg,.webp,.pdf,image/png,image/jpeg,image/webp,application/pdf"
        multiple
        onChange={handleSidebarFileChange}
      />
      {isDragOver && (
          <div className="absolute inset-0 z-50 bg-blue-500/10 border-2 border-dashed border-blue-500 rounded-lg flex items-center justify-center pointer-events-none">
            <div className="bg-white/95 rounded-xl px-8 py-6 shadow-lg text-center">
              <Plus className="w-10 h-10 text-blue-500 mx-auto mb-2" />
              <p className="text-blue-600 font-semibold text-lg">Drop files to add designs</p>
              <p className="text-gray-500 text-sm mt-1">PNG, JPG, WebP, or PDF</p>
            </div>
          </div>
        )}
        <div className="flex-1 min-h-0 flex flex-row">
      {/* Left sidebar - Layers + Settings.
          Desktop and tablet only. The phone used to render this `w-full`
          beside the canvas and slide between the two with a `translateX`,
          which parked ~30 controls off the left edge of the viewport; every
          one of them now has a home in the mobile arm below. `ControlsSection`
          still mounts on the phone (see the hidden host further down) because
          the download / add-to-cart bar and the fluorescent panels are its
          portals. */}
      {!mobileLayout && (
      <div className="flex-shrink-0 border-r border-gray-200 bg-white overflow-x-hidden w-[320px] xl:w-[340px] overflow-y-auto">
        <div className="p-2.5 space-y-2">
          {controlsSection}

           {!mobileLayout && halftoneEnabled && (
             <div className="relative rounded-lg border border-amber-200 bg-amber-50/40 p-2">
               <button
                 onClick={handleOpenHalftoneMenu}
                 disabled={!selectedDesignId && selectedDesignIds.size === 0}
                 className={`flex w-full items-center justify-center gap-1 rounded-md border px-2 py-2 text-[11px] font-medium transition-all ${selectedDesignId || selectedDesignIds.size > 0 ? "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100" : "pointer-events-none bg-gray-200 text-gray-500 opacity-30"}`}
                 title="Halftone: convert design colours to halftone dots for dark-garment DTF"
               >
                 <HalftoneIcon className="h-3 w-3" />Halftone
               </button>
               {halftoneMenuOpen && (selectedDesignId || selectedDesignIds.size > 0) && (
                 <div className="absolute left-0 top-full z-50 mt-1 w-48 rounded-md border border-gray-200 bg-white p-2 shadow-lg">
                   <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Strength</p>
                   <div className="mb-2 flex gap-1">
                     {(['light', 'balanced', 'strong'] as const).map((s) => (
                       <button
                         key={s}
                         onClick={() => setHalftoneStrength(s)}
                         className={`flex-1 rounded border py-0.5 text-[10px] font-medium capitalize transition-colors ${halftoneStrength === s ? "border-amber-600 bg-amber-500 text-white" : "border-gray-200 bg-gray-50 text-gray-600 hover:bg-amber-50"}`}
                       >
                         {s}
                       </button>
                     ))}
                   </div>
                   <button
                     onClick={() => {
                       setHalftoneMenuOpen(false);
                       const id = selectedDesignId ?? [...selectedDesignIds][0];
                       if (id) handleApplyHalftone(id, 0, 0, 0, halftoneStrength);
                     }}
                     className="mb-1 w-full rounded bg-gray-900 px-2 py-1.5 text-[11px] font-medium text-white hover:bg-gray-700"
                   >
                     ⬛ Black garment
                   </button>
                   {halftoneTopColors.length > 0 && (
                     <div className="mt-1 space-y-1">
                       <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Colour garment</p>
                       {halftoneTopColors.map((c, i) => (
                         <button
                           key={i}
                           onClick={() => {
                             setHalftoneMenuOpen(false);
                             const id = selectedDesignId ?? [...selectedDesignIds][0];
                             if (id) handleApplyHalftone(id, c.r, c.g, c.b, halftoneStrength);
                           }}
                           className="flex w-full items-center gap-2 rounded px-2 py-1 text-[11px] hover:bg-gray-100"
                         >
                           <span className="h-3.5 w-3.5 flex-shrink-0 rounded-full border border-gray-200" style={{ background: c.hex }} />
                           <span className="truncate text-gray-700">{c.name ?? c.hex}</span>
                         </button>
                       ))}
                     </div>
                   )}
                 </div>
               )}
             </div>
           )}

          {/* Fluorescent panel portal target */}
          {profile.enableFluorescent && <div ref={setFluorPanelContainer} />}

          {/* Layers Panel */}
          {designs.length > 0 && (
            <div ref={designInfoRef} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <div className="flex items-center gap-3 px-3 py-2.5 min-w-0">
                <div className="flex flex-1 min-w-0 items-center gap-3 rounded-md px-1.5 py-1 text-base font-semibold text-gray-800 overflow-hidden">
                  <Layers className="h-7 w-7 flex-shrink-0 text-cyan-500" strokeWidth={2.25} />
                  <span className="truncate">{t("editor.layers")}</span>
                  <span className="flex-shrink-0 rounded-full bg-cyan-100 px-2.5 py-1 text-sm font-bold tabular-nums text-cyan-700">{designs.length}</span>
                </div>
                <button
                  onClick={() => sidebarFileRef.current?.click()}
                  className="flex min-h-10 flex-shrink-0 items-center gap-1.5 rounded-lg border border-cyan-600 bg-cyan-500 px-4 py-2 text-sm font-bold text-white shadow-md shadow-cyan-500/25 transition-all hover:bg-cyan-600 hover:shadow-lg hover:shadow-cyan-500/30 active:scale-[0.98] whitespace-nowrap"
                  title={t("editor.addDesignTitle")}
                >
                  <Plus className="h-5 w-5 flex-shrink-0" strokeWidth={2.5} />
                  <span>{t("editor.addDesigns")}</span>
                </button>
                <input
                  ref={sidebarFileRef}
                  type="file"
                  className="hidden"
                  accept=".png,.jpg,.jpeg,.webp,.pdf,image/png,image/jpeg,image/webp,application/pdf"
                  multiple
                  onChange={handleSidebarFileChange}
                />
              </div>
              {showDesignInfo && (
                /* The short cap exists so a one- or two-layer list does not
                   reserve empty space. A touch row is 152px against 87px for a
                   mouse, so 180px shows barely one of them; the coarse cap is
                   sized to fit two. */
                <div
                  className={`layers-scroll border-t border-gray-200 overflow-y-scroll ${layerRows.length > 2 ? 'max-h-[400px]' : 'max-h-[180px] coarse:max-h-[320px]'}`}
                  style={{
                    scrollbarWidth: 'thin',
                    scrollbarColor: '#9ca3af transparent',
                  }}
                >
                  <style>{`
                    .layers-scroll::-webkit-scrollbar { width: 5px; }
                    .layers-scroll::-webkit-scrollbar-track { background: transparent; }
                    .layers-scroll::-webkit-scrollbar-thumb { background: #9ca3af; border-radius: 4px; }
                    .layers-scroll::-webkit-scrollbar-thumb:hover { background: #9ca3af; }
                  `}</style>
                  {layerListItems}
                </div>
              )}
            </div>
          )}

          {/* Uploads library panel — previously uploaded files, re-addable.
              Desktop only: on the phone the library was the thing "Add
              Designs" routed through, and it is gone from that arm entirely. */}
          <UploadsPanel
            t={t}
            onAddFile={handleAddFromUploads}
            onUnavailable={handleUploadUnavailable}
          />
        </div>
      </div>
      )}

      {/* Right area - Canvas workspace */}
      <div className={`min-w-0 flex flex-col ${mobileLayout ? "w-full flex-shrink-0" : "flex-1 h-full overflow-hidden"}`}>
        {/* The toolbar's own mobile/desktop arms have to match the layout it is
            rendered into, so the bag's device-level `isMobile` is overridden. */}
        {!mobileLayout && <EditorActionToolbar {...actionToolbarProps} isMobile={mobileLayout} />}

        {/* Preview Canvas */}
        {mobileLayout ? (
          <div className="flex min-h-0 flex-1 flex-col">
              {/* Portal host. Renders nothing itself — see the note on
                  `controlsSection`. */}
              <div className="hidden" aria-hidden="true">{controlsSection}</div>
              {/* Full-bleed canvas. The sheet below overlays it rather than
                  sitting beside it, because `PreviewSection` sizes the
                  gangsheet from this box and anything that takes width or
                  height here comes straight off the artwork. */}
              <div className="relative min-h-0 min-w-0 flex-1">
                <PreviewSection
                  ref={canvasRef}
                  imageInfo={activeImageInfo}
                  resizeSettings={activeResizeSettings}
                  artboardWidth={artboardWidth}
                  artboardHeight={artboardHeight}
                  designTransform={activeDesignTransform}
                  onTransformChange={handleDesignTransformChange}
                  designs={designs}
                  selectedDesignId={selectedDesignId}
                  selectedDesignIds={selectedDesignIds}
                  onSelectDesign={handleSelectDesign}
                  onMultiSelect={handleMultiSelect}
                  onMultiDragDelta={handleMultiDragDelta}
                  onMultiResizeDelta={handleMultiResizeDelta}
                  onMultiRotateDelta={handleMultiRotateDelta}
                  onDuplicateSelected={handleDuplicateSelected}
                  onInteractionEnd={handleInteractionEnd}
                  onDesignContextMenu={handleCanvasContextMenu}
                  spotPreviewData={profile.enableFluorescent ? spotPreviewData : undefined}
                  activeSpotChannel={profile.enableFluorescent ? activeSpotChannel : null}
                  onWandTap={profile.enableFluorescent ? handleWandTap : undefined}
                  panModeActive={profile.enableFluorescent ? panModeActive : false}
                  onPanModeChange={profile.enableFluorescent ? setPanModeActive : undefined}
                  selectionZoomActive={selectionZoomActive}
                  onSelectionZoomChange={handleSelectionZoomChange}
                  bottomToolbarContainer={mobileToolbarContainer}
                   wandDeleteActive={wandDeleteModeActive}
                   onWandDeleteTap={handleWandDelete}
                   onWandDeactivate={handleWandDeactivate}
                />

                {/* Contextual tools. Nothing selected means no sheet at all, so
                    the controls cost zero canvas for as long as they are of no
                    use. Every row below is `flex-nowrap` + `justify-start`:
                    wrapping would silently eat canvas, and a centred row that
                    overflows spills off the left edge where no scroll reaches. */}
                <MobileToolSheet
                  /* Both sheets are `bottom-0 z-40`; only one is ever mounted
                     so they cannot stack. Closing the layers sheet brings the
                     contextual one straight back. */
                  open={!!selectedDesignId && !layersOpen}
                  handleLabel={t("editor.toolSheetHandle")}
                  handleAccessory={
                    <span
                      className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-bold leading-none ${effectiveDPI < 277 ? "border border-amber-400 bg-amber-100 text-amber-700" : "border border-emerald-700 bg-emerald-100 text-emerald-700"}`}
                      title={t("editor.effectiveRes", { dpi: effectiveDPI })}
                    >
                      {effectiveDPI} DPI
                    </span>
                  }
                >
                  {(level) => (
                    <>
                      <div className="flex flex-nowrap items-center justify-start gap-1 overflow-x-auto rounded-md border border-gray-200 bg-white px-1 py-1">
                        <div className="inline-flex flex-shrink-0 items-center gap-0.5">
                          <span className="text-[12px] font-bold text-gray-800">W</span>
                          <SizeInput value={activeResizeSettings.widthInches * activeDesignTransform.s} onCommit={(v) => handleEffectiveSizeChange("width", v)} title={useMetric(lang) ? t("editor.widthTitleCm") : t("editor.widthTitle")} max={artboardWidth} lang={lang} />
                          <span className="text-[11px] font-medium text-gray-700">{getUnitSuffix(activeResizeSettings.widthInches * activeDesignTransform.s, lang)}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setProportionalLock((v) => !v)}
                          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-cyan-500 hover:bg-cyan-50 coarse:h-11 coarse:w-11"
                          title={proportionalLock ? t("editor.proportionsLocked") : t("editor.proportionsUnlocked")}
                        >
                          {proportionalLock ? <Link className="h-3.5 w-3.5" /> : <Unlink className="h-3.5 w-3.5" />}
                        </button>
                        <div className="inline-flex flex-shrink-0 items-center gap-0.5">
                          <span className="text-[12px] font-bold text-gray-800">H</span>
                          <SizeInput value={activeResizeSettings.heightInches * activeDesignTransform.s} onCommit={(v) => handleEffectiveSizeChange("height", v)} title={useMetric(lang) ? t("editor.heightTitleCm") : t("editor.heightTitle")} max={artboardHeight} lang={lang} />
                          <span className="text-[11px] font-medium text-gray-700">{getUnitSuffix(activeResizeSettings.heightInches * activeDesignTransform.s, lang)}</span>
                        </div>
                      </div>

                      {level !== "peek" && (
                        <>
                          <div className="flex flex-nowrap items-center justify-start gap-0.5 overflow-x-auto">
                            <button onClick={handleRotate90} disabled={!selectedDesignId} className="h-8 w-8 flex-shrink-0 rounded border border-gray-300 bg-white text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 disabled:pointer-events-none disabled:opacity-30 coarse:h-11 coarse:w-11" title={t("editor.rotate")}><RotateCw className="mx-auto h-4 w-4" /></button>
                            <button onClick={() => handleAlignCorner('tl')} disabled={!selectedDesignId} className="h-8 w-8 flex-shrink-0 rounded text-gray-600 hover:bg-gray-100 hover:text-cyan-400 disabled:pointer-events-none disabled:opacity-30 coarse:h-11 coarse:w-11" title={t("editor.alignTL")}><ArrowUpLeft className="mx-auto h-4 w-4" /></button>
                            <button onClick={() => handleAlignCorner('tr')} disabled={!selectedDesignId} className="h-8 w-8 flex-shrink-0 rounded text-gray-600 hover:bg-gray-100 hover:text-cyan-400 disabled:pointer-events-none disabled:opacity-30 coarse:h-11 coarse:w-11" title={t("editor.alignTR")}><ArrowUpRight className="mx-auto h-4 w-4" /></button>
                            <button onClick={() => handleAlignCorner('bl')} disabled={!selectedDesignId} className="h-8 w-8 flex-shrink-0 rounded text-gray-600 hover:bg-gray-100 hover:text-cyan-400 disabled:pointer-events-none disabled:opacity-30 coarse:h-11 coarse:w-11" title={t("editor.alignBL")}><ArrowDownLeft className="mx-auto h-4 w-4" /></button>
                            <button onClick={() => handleAlignCorner('br')} disabled={!selectedDesignId} className="h-8 w-8 flex-shrink-0 rounded text-gray-600 hover:bg-gray-100 hover:text-cyan-400 disabled:pointer-events-none disabled:opacity-30 coarse:h-11 coarse:w-11" title={t("editor.alignBR")}><ArrowDownRight className="mx-auto h-4 w-4" /></button>
                          </div>

                          <div className="flex flex-nowrap items-center justify-start gap-2 overflow-x-auto">
                            <button
                              onClick={() => handleDuplicateDesign(duplicateCount)}
                              disabled={!selectedDesignId}
                              className={`flex-shrink-0 rounded-md px-2 py-2 text-[11px] font-medium transition-all coarse:min-h-[44px] ${selectedDesignId ? "border border-[#CBD5E1] bg-[#F1F5F9] text-[#7C3AED]" : "pointer-events-none bg-gray-200 text-gray-500 opacity-30"}`}
                              title={t("editor.duplicate")}
                            >
                              <span className="inline-flex w-full items-center justify-center gap-1 text-center whitespace-nowrap leading-snug">
                                <Copy className="h-3.5 w-3.5 flex-shrink-0" />
                                <span>{t("editor.duplicate").replace(/ \(.*/, "")}</span>
                              </span>
                            </button>
                            {/* Hit area and glyph are separate boxes on a coarse
                                pointer, the same trade `size-input.tsx` and
                                `layer-row.tsx` make: the two chevrons keep their
                                12px bezels and get 44x44 boxes around them, which
                                is why the stepper leaves the input's right edge
                                and becomes a sibling column. Copy count multiplies
                                material consumption, so a mis-tap here costs film
                                by the sheet. */}
                            <div className="flex flex-shrink-0 items-center gap-px">
                              {/* 46 rather than 44: the 1px border is part of
                                  this box, and the field inside it is what the
                                  finger actually lands on. */}
                              <div className="h-[28px] w-10 overflow-hidden rounded border border-gray-300 bg-white focus-within:border-cyan-500 coarse:h-[46px] coarse:w-14">
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={duplicateCount}
                                  onChange={(e) => setDuplicateCount(parseDuplicateCount(e.target.value))}
                                  onKeyDown={handleDuplicateCountKeyDown}
                                  disabled={!selectedDesignId}
                                  /* 16px on any touch screen so iOS does not auto-zoom on
                                     focus — same reasoning as `size-input.tsx`. Gated on the
                                     pointer rather than on the width breakpoint, so a tablet
                                     in this layout is covered too. */
                                  className="w-full h-full text-center text-[12px] coarse:text-[16px] font-semibold leading-none p-0 bg-white outline-none disabled:opacity-30 disabled:pointer-events-none"
                                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                                  title={t("editor.copyCount")}
                                />
                              </div>
                              <div className="flex flex-col gap-[3px] coarse:gap-2">
                                <button
                                  type="button"
                                  onClick={() => setDuplicateCount((prev) => clampDuplicateCount(prev + 1))}
                                  disabled={!selectedDesignId || duplicateCount >= 99}
                                  className="group flex h-3.5 w-4 items-center justify-center disabled:opacity-30 disabled:pointer-events-none coarse:h-11 coarse:w-11"
                                  title={t("editor.increaseCopies")}
                                  aria-label={t("editor.increaseCopies")}
                                >
                                  <span className="flex h-3.5 w-4 min-w-4 items-center justify-center rounded border border-gray-300 bg-gray-50 text-gray-600 group-hover:bg-gray-100">
                                    <ChevronUp className="w-2.5 h-2.5" />
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDuplicateCount((prev) => clampDuplicateCount(prev - 1))}
                                  disabled={!selectedDesignId || duplicateCount <= 1}
                                  className="group flex h-3.5 w-4 items-center justify-center disabled:opacity-30 disabled:pointer-events-none coarse:h-11 coarse:w-11"
                                  title={t("editor.decreaseCopies")}
                                  aria-label={t("editor.decreaseCopies")}
                                >
                                  <span className="flex h-3.5 w-4 min-w-4 items-center justify-center rounded border border-gray-300 bg-gray-50 text-gray-600 group-hover:bg-gray-100">
                                    <ChevronDown className="w-2.5 h-2.5" />
                                  </span>
                                </button>
                              </div>
                            </div>
                            <button
                              onClick={() => handleDuplicateAndArrange(duplicateCount)}
                              disabled={!selectedDesignId}
                               className={`flex-shrink-0 rounded-md px-2 py-2 text-[12px] font-semibold transition-all coarse:min-h-[44px] ${selectedDesignId ? "border border-[#CBD5E1] bg-[#F1F5F9] text-[#0891B2]" : "pointer-events-none bg-gray-200 text-gray-500 opacity-30"}`}
                              title={t("editor.duplicateArrange")}
                            >
                              <span className="inline-flex w-full items-center justify-center gap-1 text-center whitespace-nowrap leading-snug">
                                <Copy className="h-3.5 w-3.5 flex-shrink-0" />
                                <span>{t("editor.duplicateArrange")}</span>
                              </span>
                            </button>
                          </div>

                          <div className="flex flex-nowrap items-center justify-start gap-2 overflow-x-auto">
                            <button onClick={handleThresholdAlpha} disabled={!selectedDesignId && selectedDesignIds.size === 0} className={`flex flex-shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border px-2 py-2 text-[11px] font-medium transition-all coarse:min-h-[44px] ${selectedDesignId || selectedDesignIds.size > 0 ? "border-[#CBD5E1] bg-[#F1F5F9] text-[#2563EB]" : "pointer-events-none bg-gray-200 text-gray-500 opacity-30"}`} title={t("editor.cleanAlphaTitle")}><Droplets className="h-3 w-3" />{t("editor.cleanAlpha")}</button>
                            {level === "full" && (
                              <button onClick={handleThresholdAlphaAll} disabled={designs.length === 0} className={`flex flex-shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border px-2 py-2 text-[11px] font-medium transition-all coarse:min-h-[44px] ${designs.length > 0 ? "border-[#CBD5E1] bg-[#F1F5F9] text-[#2563EB]" : "pointer-events-none bg-gray-200 text-gray-500 opacity-30"}`} title={t("editor.cleanAlphaAllTitle")}><Droplets className="h-3 w-3" />{t("editor.cleanAlphaAll")}</button>
                            )}
                          </div>

                          {/* White BG and Magic Wand. Both act on the current
                              selection — `handleRemoveWhiteBackground` returns
                              early without one — so the selection-gated sheet
                              is where they belong, not a panel that was
                              reachable with nothing selected. */}
                          <div className="flex flex-nowrap items-center justify-start gap-2 overflow-x-auto">
                            <button
                              type="button"
                              onClick={handleRemoveWhiteBackground}
                              className="flex flex-shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border border-amber-200 bg-amber-50 px-2 py-2 text-[11px] font-medium text-amber-700 transition-all hover:bg-amber-100 coarse:min-h-[44px]"
                              title={t("editor.whiteBgTitle")}
                            >
                              <Eraser className="h-3 w-3 flex-shrink-0" />{t("editor.whiteBg")}
                            </button>
                            <button
                              type="button"
                              onClick={handleWandDeleteToggle}
                              className={`flex flex-shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border px-2 py-2 text-[11px] font-medium transition-all coarse:min-h-[44px] ${wandDeleteModeActive
                                ? "border-fuchsia-600 bg-fuchsia-600 text-white hover:bg-fuchsia-700"
                                : "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-600 hover:bg-fuchsia-100"}`}
                              title={wandDeleteModeActive ? t("editor.magicWandActiveTitle") : t("editor.magicWandTitle")}
                            >
                              <WandSparkles className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                              {wandDeleteModeActive ? t("editor.magicWandOn") : t("editor.magicWand")}
                            </button>
                          </div>

                          {wandDeleteModeActive && (
                            <label className="flex flex-nowrap items-center justify-start gap-2 overflow-x-auto text-[12px] text-fuchsia-800">
                              <span className="flex-shrink-0 font-medium">{t("editor.wandTolerance")}</span>
                              {/* The track is 8px tall; `coarse:h-11` grows the
                                  input's own box around it so the hit area
                                  clears 44px without a fatter thumb. */}
                              <input
                                type="range"
                                min="1"
                                max="100"
                                value={wandTolerance}
                                onChange={(e) => setWandTolerance(Number(e.target.value))}
                                className="min-w-0 flex-1 accent-fuchsia-600 coarse:h-11"
                                aria-label={t("editor.wandTolerance")}
                              />
                              <span className="w-6 flex-shrink-0 text-right tabular-nums">{wandTolerance}</span>
                            </label>
                          )}

                          {halftoneEnabled && (
                            /* Its own row, and deliberately not a scrolling one:
                               `overflow-x: auto` forces `overflow-y` to compute to
                               `auto` as well, which would clip the popover. */
                            <div className="relative w-fit">
                              <button
                                onClick={handleOpenHalftoneMenu}
                                disabled={!selectedDesignId && selectedDesignIds.size === 0}
                                className={`flex w-full items-center justify-center gap-1 whitespace-nowrap rounded-md border px-2 py-2 text-[11px] font-medium transition-all coarse:min-h-[44px] ${selectedDesignId || selectedDesignIds.size > 0 ? "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100" : "pointer-events-none bg-gray-200 text-gray-500 opacity-30"}`}
                                title="Halftone: convert design colours to halftone dots for dark-garment DTF"
                              >
                                <HalftoneIcon className="h-3 w-3" />Halftone
                              </button>
                              {halftoneMenuOpen && (selectedDesignId || selectedDesignIds.size > 0) && (
                                /* Opens upward: this sits near the bottom of the
                                   screen, so `top-full` would land the menu under
                                   the sheet's own scroll edge. */
                                <div className="absolute bottom-full left-0 z-50 mb-1 w-48 rounded-md border border-gray-200 bg-white p-2 shadow-lg">
                                  <p className="mb-1 text-[11px] font-semibold text-gray-700 uppercase tracking-wide">Strength</p>
                                  <div className="mb-2 flex gap-1">
                                    {(['light','balanced','strong'] as const).map(s => (
                                      <button key={s} onClick={() => setHalftoneStrength(s)}
                                        className={`flex-1 text-[11px] py-1 rounded border font-medium capitalize transition-colors ${halftoneStrength === s ? 'bg-amber-500 text-white border-amber-600' : 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-amber-50'}`}>
                                        {s}
                                      </button>
                                    ))}
                                  </div>
                                  <button
                                    onClick={() => { setHalftoneMenuOpen(false); const id = selectedDesignId ?? [...selectedDesignIds][0]; if (id) handleApplyHalftone(id, 0, 0, 0, halftoneStrength); }}
                                    className="mb-1 w-full rounded bg-gray-900 px-2 py-1.5 text-[11px] font-medium text-white hover:bg-gray-700"
                                  >
                                    ⬛ Black garment
                                  </button>
                                  {halftoneTopColors.length > 0 && (
                                    <div className="mt-1 space-y-1">
                                      <p className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">Colour garment</p>
                                      {halftoneTopColors.map((c, i) => (
                                        <button key={i}
                                          onClick={() => { setHalftoneMenuOpen(false); const id = selectedDesignId ?? [...selectedDesignIds][0]; if (id) handleApplyHalftone(id, c.r, c.g, c.b, halftoneStrength); }}
                                          className="flex w-full items-center gap-2 rounded px-2 py-1 text-[11px] hover:bg-gray-100"
                                        >
                                          <span className="h-3.5 w-3.5 flex-shrink-0 rounded-full border border-gray-200" style={{ background: c.hex }} />
                                          <span className="truncate text-gray-700">{c.name ?? c.hex}</span>
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      )}

                      {level === "full" && designs.length >= 2 && (
                        <div className="flex flex-nowrap items-center justify-start gap-1 overflow-x-auto">
                           <span className="flex-shrink-0 text-[11px] font-medium text-gray-700">{t("editor.margin")}</span>
                          <select
                            value={designGap === undefined ? "auto" : String(designGap)}
                            onChange={(e) => {
                              const v = e.target.value;
                              const newGap = v === "auto" ? undefined : parseFloat(v);
                              setDesignGap(newGap);
                              setTimeout(() => handleAutoArrangeRef.current({ skipSnapshot: false, preserveSelection: true, fullRepack: true }), 0);
                            }}
                             className="h-8 flex-shrink-0 px-1.5 bg-gray-100 border border-gray-300 rounded text-[12px] coarse:text-[16px] coarse:h-11 font-medium text-gray-800 outline-none cursor-pointer hover:border-gray-400 focus:border-cyan-500 transition-colors"
                            title={useMetric(lang) ? t("editor.marginGapCm") : t("editor.marginGap")}
                          >
                            <option value="auto">{t("editor.marginAuto")}</option>
                            <option value="0.0625">{useMetric(lang) ? formatLength(0.0625, lang) : "1/16″"}</option>
                            <option value="0.125">{useMetric(lang) ? formatLength(0.125, lang) : "1/8″"}</option>
                            <option value="0.25">{useMetric(lang) ? formatLength(0.25, lang) : "1/4″"}</option>
                            <option value="0.5">{useMetric(lang) ? formatLength(0.5, lang) : "1/2″"}</option>
                            <option value="1">{useMetric(lang) ? formatLength(1, lang) : "1″"}</option>
                          </select>
                        </div>
                      )}
                    </>
                  )}
                </MobileToolSheet>

                {/* Summoned layers panel. Same overlay semantics as the tool
                    sheet — `absolute bottom-0` inside the canvas box, so the
                    box itself never changes size and `PreviewSection` never
                    re-fits the artwork. `sizing="fill"` because a list has no
                    natural peek height to measure. */}
                <MobileToolSheet
                  open={layersOpen}
                  testId="mobile-layers-sheet"
                  /* Content-sized, not fill. A fill-sized sheet picks its height
                     from the space available rather than the list in it, so one
                     layer got a 610px sheet holding 193px of content and 373px
                     of white — the panel read as enormous because it was. Sized
                     to content it is as tall as the rows it has, and a list long
                     enough to exceed the ceiling scrolls, which is the only case
                     fill was protecting against.

                     The 56px of canvas the tool sheet reserves is also dropped
                     to 16: that reservation keeps artwork visible while you
                     resize it, and a list has no such tie. Landscape leaves this
                     box ~228px, so those 40px are the difference between showing
                     a row and showing none. */
                  minCanvasStripPx={16}
                  handleLabel={t("editor.layersSheetHandle")}
                  handleLeading={
                    <button
                      type="button"
                      /* The handle above owns pointer events for dragging, so
                         this has to claim its own before they reach it. */
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); setLayersOpen(false); }}
                      className="flex h-11 w-11 items-center justify-center rounded text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                      title={t("editor.closeLayers")}
                      aria-label={t("editor.closeLayers")}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  }
                >
                  {() => (
                    <>
                      {/* Gangsheet size and price. Document-level rather than
                          contextual, and the one control that sets what the
                          customer pays, so it leads the panel. A native
                          `select` rather than the desktop combobox: it raises
                          the OS picker, and it cannot be clipped by the
                          sheet's own scroll the way a rendered popover can. */}
                      <div className="flex flex-nowrap items-center justify-start gap-1.5 overflow-x-auto border-b border-gray-200 pb-2">
                        <Layers className="h-4 w-4 flex-shrink-0 text-cyan-500" />
                        <span className="flex-shrink-0 text-[12px] font-semibold text-gray-900">{t("controls.gangsheetSize")}</span>
                        <span className="flex-shrink-0 text-[12px] font-semibold tabular-nums text-gray-800">{formatLength(artboardWidth, lang)}{lang === "en" ? '"' : ""}</span>
                        <span className="flex-shrink-0 text-[12px] text-gray-700">×</span>
                        {isEditMode ? (
                          <span className="flex-shrink-0 rounded border border-gray-200 bg-gray-100 px-2 py-1 text-[12px] font-semibold tabular-nums text-gray-900">
                            {formatLength(artboardHeight, lang)}{lang === "en" ? '"' : ""}
                          </span>
                        ) : (
                          <select
                            value={String(artboardHeight)}
                            onChange={(e) => handleArtboardHeightChange(parseFloat(e.target.value))}
                            /* Fixed width on purpose: a native select is as
                               wide as its longest option, and the recommended
                               entry carries a "(current bounds)" suffix that
                               would otherwise stretch this to twice the row.
                               The suffix is suppressed on the selected entry —
                               see below — so the collapsed control never has to
                               render it and this width is always enough. */
                            className="h-8 w-[5.5rem] flex-shrink-0 cursor-pointer rounded border border-gray-300 bg-gray-100 px-1.5 text-[12px] font-semibold tabular-nums text-gray-900 outline-none transition-colors hover:border-gray-400 focus:border-cyan-500 coarse:h-11 coarse:w-[6.5rem] coarse:text-[16px]"
                            title={t("controls.gangsheetSize")}
                            data-testid="mobile-gangsheet-height"
                          >
                            {GANGSHEET_HEIGHTS.map((h) => (
                              <option key={h} value={String(h)}>
                                {formatLength(h, lang)}{lang === "en" ? '"' : ""}
                                {/* A closed native select shows the selected option's own
                                    text, and this one is too narrow for the suffix — it
                                    rendered as `12.00" (c`, cut mid-word. The hint only
                                    means anything as advice not yet taken, so the entry
                                    that is already selected drops it and the long form is
                                    left to the open list, which is free to be wider. */}
                                {recommendedArtboardHeight === h && artboardHeight !== h
                                  ? ` (${t("controls.currentBounds")})`
                                  : ""}
                              </option>
                            ))}
                          </select>
                        )}
                        {selectedVariantPrice != null && (
                          <span className="flex-shrink-0 whitespace-nowrap rounded-full border border-emerald-600 bg-white px-2 py-0.5 text-[11px] font-bold leading-tight tabular-nums text-emerald-600">
                            {formatVariantPriceForDisplay(selectedVariantPrice)}
                          </span>
                        )}
                      </div>

                      <div className="flex flex-nowrap items-center justify-start gap-2 overflow-x-auto">
                        <Layers className="h-5 w-5 flex-shrink-0 text-cyan-500" strokeWidth={2.25} />
                        <span className="flex-shrink-0 text-[13px] font-semibold text-gray-800">{t("editor.layers")}</span>
                        <span className="flex-shrink-0 rounded-full bg-cyan-100 px-2 py-0.5 text-[12px] font-bold tabular-nums text-cyan-700">{designs.length}</span>
                        {/* Straight to the file picker. The uploads library it
                            used to sit beside is not mounted on this arm. */}
                        <button
                          type="button"
                          onClick={() => sidebarFileRef.current?.click()}
                          className="flex min-h-10 flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-cyan-600 bg-cyan-500 px-3 py-2 text-[12px] font-bold text-white shadow-md shadow-cyan-500/25 transition-all hover:bg-cyan-600 active:scale-[0.98] coarse:min-h-[44px]"
                          title={t("editor.addDesignTitle")}
                          data-testid="mobile-add-designs"
                        >
                          <Plus className="h-4 w-4 flex-shrink-0" strokeWidth={2.5} />
                          <span>{t("editor.addDesigns")}</span>
                        </button>
                        <input
                          ref={sidebarFileRef}
                          type="file"
                          className="hidden"
                          accept=".png,.jpg,.jpeg,.webp,.pdf,image/png,image/jpeg,image/webp,application/pdf"
                          multiple
                          onChange={handleSidebarFileChange}
                        />
                      </div>

                      {/* No `max-height` of its own: the sheet is already a
                          scroller, and a second one nested inside it makes the
                          list a trap for a thumb that meant to drag the sheet. */}
                      {/* `data-mobile-layers` drives the `layersheet:` variant
                          that grows `LayerRow`'s targets to 44px here without
                          moving the same rows in the desktop sidebar, which an
                          iPad also renders on a touch screen. */}
                      {/* `divide-y` replaces separation the desktop row gets for
                          free from its 20px of vertical padding. With that
                          padding cut to 8 here, two unselected rows would
                          otherwise run together into one block of text. */}
                      <div data-mobile-layers className="divide-y divide-gray-200 rounded-lg border border-gray-200">{layerListItems}</div>

                      {/* Fluorescent spot-colour panels portal here on this
                          arm; on desktop they go to the sidebar. */}
                      {profile.enableFluorescent && <div ref={setFluorPanelContainer} />}
                    </>
                  )}
                </MobileToolSheet>
              </div>

            {/* Undo/redo are the most-used controls in a touch editor, so they
                stay in the flow and out of the sheet — two taps deep is a
                regression no amount of sheet polish pays for. Delete rides with
                them because it is already selection-gated and belongs beside
                the action that reverses it. */}
            <div className="flex flex-shrink-0 flex-nowrap items-center justify-start gap-1.5 overflow-x-auto border-t border-gray-200 bg-white px-2 py-0" data-testid="mobile-persistent-bar">
              {/* Leftmost because it is the only route to the layers list, the
                  gangsheet size and Add Designs; if a longer translation makes
                  this row scroll, the control that must never be the one out
                  of reach is this one. Icon-only, like its three neighbours —
                  a text label costs ~50px the row does not have. */}
              <button
                type="button"
                onClick={() => setLayersOpen((v) => !v)}
                className={`relative h-8 w-8 flex-shrink-0 rounded border transition-colors coarse:h-11 coarse:w-11 ${layersOpen ? "border-cyan-600 bg-cyan-500 text-white" : "border-gray-300 bg-white text-gray-600 hover:bg-gray-100 hover:text-gray-900"}`}
                title={layersOpen ? t("editor.closeLayers") : t("editor.openLayers")}
                aria-label={layersOpen ? t("editor.closeLayers") : t("editor.openLayers")}
                aria-expanded={layersOpen}
                data-testid="mobile-layers-toggle"
              >
                <Layers className="mx-auto h-4 w-4" />
                {designs.length > 0 && (
                  <span className={`pointer-events-none absolute -right-1 -top-1 min-w-[16px] rounded-full px-1 text-[10px] font-bold leading-4 tabular-nums ${layersOpen ? "bg-white text-cyan-700" : "bg-cyan-500 text-white"}`}>
                    {designs.length}
                  </span>
                )}
              </button>
              <button onClick={handleUndo} disabled={!canUndo()} className="h-8 w-8 flex-shrink-0 rounded border border-gray-300 bg-white text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 disabled:pointer-events-none disabled:opacity-30 coarse:h-11 coarse:w-11" title={t("editor.undo")}><Undo2 className="mx-auto h-4 w-4" /></button>
              <button onClick={handleRedo} disabled={!canRedo()} className="h-8 w-8 flex-shrink-0 rounded border border-gray-300 bg-white text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 disabled:pointer-events-none disabled:opacity-30 coarse:h-11 coarse:w-11" title={t("editor.redo")}><Redo2 className="mx-auto h-4 w-4" /></button>
              <button onClick={() => { if (selectedDesignIds.size > 1) handleDeleteMulti(selectedDesignIds); else if (selectedDesignId) handleDeleteDesign(selectedDesignId); }} disabled={!selectedDesignId} className="h-8 w-8 flex-shrink-0 rounded border border-red-200 bg-white text-red-500 transition-colors hover:bg-red-50 hover:text-red-600 disabled:pointer-events-none disabled:opacity-30 coarse:h-11 coarse:w-11" title={t("editor.delete")}><Trash2 className="mx-auto h-4 w-4" /></button>
              <button
                onClick={() => handleAutoArrange({ preserveSelection: selectedDesignIds.size >= 2, fullRepack: true })}
                disabled={designs.length < 2 && selectedDesignIds.size < 2}
                 className={`flex min-h-[36px] flex-shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-[12px] font-semibold transition-colors coarse:min-h-[44px] ${
                  designs.length >= 2 || selectedDesignIds.size >= 2
                    ? "border border-pink-600 bg-pink-500 text-black shadow-md shadow-pink-500/25 hover:bg-pink-600"
                    : "pointer-events-none bg-gray-200 text-gray-500 opacity-30"
                }`}
                title={selectedDesignIds.size >= 2 ? t("editor.autoArrangeSelected") : t("editor.autoArrangeAll")}
              >
                <LayoutGrid className="h-3.5 w-3.5 flex-shrink-0" />
                {t("editor.autoArrange")}
              </button>
            </div>
            <div ref={setMobileToolbarContainer} className="flex-shrink-0" data-testid="mobile-canvas-toolbar" />
          </div>
        ) : (
          <div className="flex-1 min-h-0 relative">
            <PreviewSection
              ref={canvasRef}
              imageInfo={activeImageInfo}
              resizeSettings={activeResizeSettings}
              artboardWidth={artboardWidth}
              artboardHeight={artboardHeight}
              designTransform={activeDesignTransform}
              onTransformChange={handleDesignTransformChange}
              designs={designs}
              selectedDesignId={selectedDesignId}
              selectedDesignIds={selectedDesignIds}
              onSelectDesign={handleSelectDesign}
              onMultiSelect={handleMultiSelect}
              onMultiDragDelta={handleMultiDragDelta}
              onMultiResizeDelta={handleMultiResizeDelta}
              onMultiRotateDelta={handleMultiRotateDelta}
              onDuplicateSelected={handleDuplicateSelected}
              onInteractionEnd={handleInteractionEnd}
              onDesignContextMenu={handleCanvasContextMenu}
              spotPreviewData={profile.enableFluorescent ? spotPreviewData : undefined}
              activeSpotChannel={profile.enableFluorescent ? activeSpotChannel : null}
              onWandTap={profile.enableFluorescent ? handleWandTap : undefined}
              panModeActive={profile.enableFluorescent ? panModeActive : false}
              onPanModeChange={profile.enableFluorescent ? setPanModeActive : undefined}
              selectionZoomActive={selectionZoomActive}
              onSelectionZoomChange={handleSelectionZoomChange}
              wandDeleteActive={wandDeleteModeActive}
              onWandDeleteTap={handleWandDelete}
              onWandDeactivate={handleWandDeactivate}
            />
          </div>
        )}
      </div>
      
      </div>
      {/* Download bar at the very bottom of the app */}
      <div ref={setDownloadContainer} className="flex-shrink-0" />

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          className={`fixed z-50 bg-white border border-gray-300 rounded-lg shadow-2xl shadow-black/60 py-1 ${lang !== 'en' ? 'min-w-[220px]' : 'min-w-[190px]'}`}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {([
            { icon: Copy, label: t("editor.duplicate").replace(/ \(.*/, '') + ` (${duplicateCount})`, shortcut: 'Ctrl+D', action: () => { handleDuplicateDesign(duplicateCount); setContextMenu(null); }, disabled: false },
            { icon: Copy, label: t("editor.duplicateArrange") + ` (${duplicateCount})`, shortcut: '', action: () => { handleDuplicateAndArrange(duplicateCount); setContextMenu(null); }, disabled: false },
            { icon: Trash2, label: t("editor.delete").replace(/ \(.*/, ''), shortcut: 'Del', action: () => { if (selectedDesignIds.size > 1) handleDeleteMulti(selectedDesignIds); else handleDeleteDesign(contextMenu.designId); setContextMenu(null); }, disabled: false },
            null,
            { icon: RotateCw, label: t("editor.rotate").replace(/ \(.*/, ''), shortcut: 'R', action: () => { handleRotate90(); setContextMenu(null); }, disabled: false },
            { icon: FlipHorizontal2, label: t("editor.flipH"), shortcut: '', action: () => { handleFlipX(); setContextMenu(null); }, disabled: false },
            { icon: FlipVertical2, label: t("editor.flipV"), shortcut: '', action: () => { handleFlipY(); setContextMenu(null); }, disabled: false },
            null,
            { icon: Droplets, label: t("editor.cleanAlpha"), shortcut: '', action: () => { handleThresholdAlpha(); setContextMenu(null); }, disabled: false },
            null,
            // Group / Ungroup — surfaced conditionally so the menu stays
            // compact for the common single-design case. `Group` shows
            // only when 2+ ungrouped designs are selected; `Ungroup`
            // shows only when the selection contains at least one
            // grouped design. The Ctrl+G / Ctrl+Shift+G shortcuts follow
            // Illustrator/Figma conventions users already know.
            ...(selectedDesignIds.size >= 2 && !selectedHasGroup
              ? [
                  { icon: Group, label: t("editor.groupSelected"), shortcut: 'Ctrl+G', action: () => { handleGroupSelected(); setContextMenu(null); }, disabled: false },
                  null,
                ]
              : []),
            ...(selectedHasGroup
              ? [
                  { icon: Ungroup, label: t("editor.ungroupSelected"), shortcut: 'Ctrl+Shift+G', action: () => { handleUngroupSelected(); setContextMenu(null); }, disabled: false },
                  null,
                ]
              : []),
            { icon: LayoutGrid, label: t("editor.selectAll"), shortcut: 'Ctrl+A', action: () => { handleMultiSelect(designs.map(d => d.id)); setContextMenu(null); }, disabled: designs.length === 0 },
            { icon: XCircle, label: t("editor.deselect"), shortcut: 'Esc', action: () => { handleSelectDesign(null); setContextMenu(null); }, disabled: false },
          ] as Array<{ icon: React.ComponentType<any>; label: string; shortcut: string; action: () => void; disabled: boolean } | null>).map((item, i) =>
            item === null ? (
              <div key={`sep-${i}`} className="h-px bg-gray-100 my-1" />
            ) : (
              <button
                key={item.label}
                onClick={item.action}
                disabled={item.disabled}
                className="w-full flex items-center gap-3 px-3 py-1.5 text-left text-xs text-gray-900 hover:bg-gray-200 hover:text-gray-900 disabled:opacity-30 disabled:pointer-events-none transition-colors"
              >
                <item.icon className="w-3.5 h-3.5 text-gray-600 flex-shrink-0" />
                <span className="flex-1">{item.label}</span>
                {item.shortcut && <span className="text-[10px] text-gray-600 ml-2">{item.shortcut}</span>}
              </button>
            )
          )}
        </div>
      )}

      {/* Crop Modal */}
      {cropModalDesignId && (() => {
        const design = designs.find(d => d.id === cropModalDesignId);
        return design ? (
          <CropModal
            open={!!design}
            onClose={() => setCropModalDesignId(null)}
            imageInfo={design.imageInfo}
            onCrop={(newInfo) => handleCropApply(cropModalDesignId, newInfo)}
            t={t}
          />
        ) : null;
      })()}

      {/* Processing Modal — covers downloads, edit-link restore, and add-to-cart/update */}
      {isProcessing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-lg p-6 max-w-sm mx-4">
            <div className="flex items-center space-x-3">
              <div className="animate-spin rounded-full h-5 w-5 border-2 border-cyan-500 border-t-transparent"></div>
              <span className="text-white">
                {isAddingToCart
                  ? (isUpdateFlow ? t("editor.updatingDesignModal") : t("editor.addingToCartModal"))
                  : t("editor.processing")}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

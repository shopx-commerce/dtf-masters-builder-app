import UploadSection from "../upload-section";
import { useRef, useState } from "react";
import PreviewSection from "../preview-section";
import ControlsSection from "../controls-section";
import CropModal from "../crop-modal";
import SizeInput from "./size-input";
import EditorActionToolbar from "./editor-action-toolbar";
import { formatDimensions, formatLength, useMetric, getUnitSuffix } from "@/lib/format-length";
import {
  ArrowDownLeft, ArrowDownRight, ArrowUpLeft, ArrowUpRight, Copy, ChevronDown, ChevronUp,
  Droplets, FlipHorizontal2, FlipVertical2, Layers, LayoutGrid, Link, Loader2, Minus, Plus, RotateCw,
  Trash2, Undo2, Redo2, Unlink, XCircle,
} from "lucide-react";
import { useImageEditorContext } from "./image-editor-context";

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
    t, lang, profile, embedFromShopify, isMobile, isLgUp, isUploading, uploadProgress, isProcessing,
    isAddingToCart, isEditMode, isUpdateFlow, isDragOver, artboardWidth, artboardHeight,
    quantity, designGap, duplicateCount, designs, setDesigns, selectedDesignId, setSelectedDesignId,
    selectedDesignIds, setSelectedDesignIds, mobilePanel,
    setMobilePanel, showDesignInfo, setShowDesignInfo, selectionZoomActive, setSelectionZoomActive,
    editingLayerName, setEditingLayerName, editingNameValue, setEditingNameValue, proportionalLock,
    setProportionalLock, spotPreviewData, setSpotPreviewData, contextMenu, setContextMenu,
    cropModalDesignId, setCropModalDesignId, activeImageInfo, activeDesignTransform,
    activeResizeSettings, selectedVariantPrice, effectiveDPI, layerRows, canvasRef, designInfoRef,
    sidebarFileRef, headerUploadInputRef, downloadContainer, setDownloadContainer,
    fluorPanelContainer, setFluorPanelContainer, mobileToolbarContainer, setMobileToolbarContainer,
    copySpotSelectionsRef, GANGSHEET_HEIGHTS, MAX_ARTBOARD_HEIGHT, recommendedArtboardHeight,
    initialVariantId, shopifyVariants,
    handleFileUploadUnified, handleBatchStart, handleSidebarFileChange, handleDragEnter,
    handleDragLeave, handleDragOver, handleDrop, handleSelectDesign, handleMultiSelect,
    handleDesignTransformChange, handleMultiDragDelta, handleMultiResizeDelta, handleMultiRotateDelta,
    handleEffectiveSizeChange, handleResizeChange, handleDuplicateDesign,
    handleDuplicateAndArrange, handleDuplicateSelected, handleDuplicateById, handleRemoveOneCopy, handleSetGroupCount,
    handleDeleteDesign, handleDeleteGroup, handleDeleteMulti, handleRotate90, handleFlipX, handleFlipY, handleAlignCorner,
    handleAutoArrange, handleArtboardResize, handleThresholdAlpha,
    handleThresholdAlphaAll, handleCropDesign, handleCropApply, handleDownload, handleAddToCart,
    handleApplyHalftone, handleOpenHalftoneMenu, halftoneStrength, setHalftoneStrength,
    halftoneMenuOpen, setHalftoneMenuOpen, halftoneTopColors,
    handleRemoveWhiteBackground, handleWandDelete, wandDeleteModeActive, setWandDeleteModeActive,
    wandTolerance, setWandTolerance,
    handleCanvasContextMenu, handleInteractionEnd, handleUndo, handleRedo, canUndo, canRedo,
    handleAutoArrangeRef, actionToolbarProps, getLayerThumbnail, setDesignGap, setDuplicateCount,
    parseDuplicateCount, handleDuplicateCountKeyDown, clampDuplicateCount, setArtboardWidth,
    setArtboardHeight, setQuantity, draftRecoveryAvailable, isRecoveringDraft,
    recoverEditorDraft, discardEditorDraft,
  } = useImageEditorContext();
  const [activeSpotChannel, setActiveSpotChannel] = useState<string | null>(null);
  const [editingCountKey, setEditingCountKey] = useState<string | null>(null);
  const [editingCountValue, setEditingCountValue] = useState("");
  const [panModeActive, setPanModeActive] = useState(false);
  const wandAssignRef = useRef<((nx: number, ny: number) => void) | null>(null);
  const clearActiveChannelRef = useRef<(() => void) | null>(null);
  const halftoneEnabled = profile?.id === "hot-peel" || profile?.id === "fluorescent";

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
            <UploadSection 
              onImageUpload={handleFileUploadUnified}
              onBatchStart={handleBatchStart}
              imageInfo={null}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div
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
        {isMobile && (
          <div className="flex-shrink-0 border-b border-gray-200 bg-white px-2 py-1.5">
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setMobilePanel("controls");
                  setWandDeleteModeActive(false);
                }}
                className={`rounded px-2 py-1 text-xs font-bold tracking-wide transition-colors ${mobilePanel === "controls" ? "bg-violet-600 text-white shadow-md shadow-violet-200" : "bg-violet-100 text-violet-400"}`}
              >
                🎛️ Controls
              </button>
              <button
                type="button"
                onClick={() => setMobilePanel("preview")}
                className={`rounded px-2 py-1 text-xs font-bold tracking-wide transition-colors ${mobilePanel === "preview" ? "bg-cyan-500 text-white shadow-md shadow-cyan-200" : "bg-cyan-100 text-cyan-400"}`}
              >
                👁️ Preview
              </button>
            </div>
          </div>
        )}
        <div
          className={isMobile ? "flex min-h-0 flex-1 flex-row transition-transform duration-300 ease-out" : "flex-1 min-h-0 flex flex-col lg:flex-row"}
          style={isMobile ? { transform: mobilePanel === "preview" ? "translateX(-100%)" : "translateX(0)" } : undefined}
        >
      {/* Left sidebar - Layers + Settings */}
      <div className={`flex-shrink-0 w-full lg:w-[320px] xl:w-[340px] border-r border-gray-200 bg-white overflow-x-hidden ${isMobile ? "" : "overflow-y-auto"}`}>
        <div className="p-2.5 space-y-2">
          <ControlsSection
            resizeSettings={activeResizeSettings}
            onResizeChange={handleResizeChange}
            onDownload={handleDownload}
            isProcessing={isProcessing}
            imageInfo={activeImageInfo}
            artboardWidth={artboardWidth}
            artboardHeight={artboardHeight}
            onArtboardHeightChange={(h) => handleArtboardResize(artboardWidth, h)}
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
            onWandDeleteToggle={() => {
              const nextActive = !wandDeleteModeActive;
              setWandDeleteModeActive(nextActive);
              if (nextActive) {
                clearActiveChannelRef.current?.();
                setPanModeActive(false);
                setSelectionZoomActive(false);
                setMobilePanel("preview");
              }
            }}
            wandTolerance={wandTolerance}
            onWandToleranceChange={setWandTolerance}
          />

           {!isMobile && halftoneEnabled && (
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
                <div
                  className={`layers-scroll border-t border-gray-200 overflow-y-scroll ${layerRows.length > 2 ? 'max-h-[400px]' : 'max-h-[180px]'}`}
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
                  {layerRows.map((row) => {
                    const first = row.designs[0];
                    const count = row.designs.length;
                    const isSelected = row.designs.some(d => d.id === selectedDesignId || selectedDesignIds.has(d.id));
                    return (
                    <div
                      key={`${row.baseName}::${row.sizeKey}`}
                      className={`relative grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 px-2.5 py-2.5 cursor-pointer transition-colors ${isSelected ? 'bg-cyan-50 border-l-2 border-cyan-400' : 'hover:bg-gray-100/70 border-l-2 border-transparent'}`}
                      onClick={(e) => {
                        if (e.ctrlKey || e.metaKey) {
                          setSelectedDesignIds(prev => {
                            const next = new Set(prev);
                            const allSelected = row.designs.every(d => next.has(d.id));
                            if (allSelected) {
                              for (const d of row.designs) next.delete(d.id);
                              setSelectedDesignId(next.size > 0 ? Array.from(next)[next.size - 1] : null);
                            } else {
                              for (const d of row.designs) next.add(d.id);
                              setSelectedDesignId(first.id);
                            }
                            return next;
                          });
                        } else {
                          handleSelectDesign(first.id);
                        }
                      }}
                    >
                      <div className="row-span-2 h-9 w-9 rounded bg-gray-100 border border-gray-300 flex-shrink-0 overflow-hidden flex items-center justify-center">
                        <img
                          src={getLayerThumbnail(first)}
                          alt=""
                          className="max-w-full max-h-full object-contain"
                          loading="lazy"
                          style={{ transform: `${first.transform.flipX ? 'scaleX(-1)' : ''} ${first.transform.flipY ? 'scaleY(-1)' : ''}` }}
                        />
                      </div>
                      <div className="min-w-0 overflow-hidden pr-7">
                        {editingLayerName === `${row.baseName}::${row.sizeKey}` ? (
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <input
                              autoFocus
                              className="text-[11px] text-gray-900 bg-white border border-cyan-400 rounded px-1 py-0 w-full outline-none"
                              value={editingNameValue}
                              onChange={(e) => setEditingNameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  const trimmed = editingNameValue.trim();
                                  if (trimmed) {
                                    setDesigns(prev => prev.map(d =>
                                      row.designs.some(rd => rd.id === d.id) ? { ...d, name: trimmed } : d
                                    ));
                                  }
                                  setEditingLayerName(null);
                                } else if (e.key === 'Escape') {
                                  setEditingLayerName(null);
                                }
                              }}
                              onBlur={() => {
                                const trimmed = editingNameValue.trim();
                                if (trimmed) {
                                  setDesigns(prev => prev.map(d =>
                                    row.designs.some(rd => rd.id === d.id) ? { ...d, name: trimmed } : d
                                  ));
                                }
                                setEditingLayerName(null);
                              }}
                            />
                          </div>
                        ) : (
                          <p
                            className="text-[11px] text-gray-900 truncate cursor-text hover:text-cyan-600 transition-colors"
                            title={t("editor.renameDesign")}
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingLayerName(`${row.baseName}::${row.sizeKey}`);
                              setEditingNameValue(first.name);
                            }}
                          >
                            {row.baseName}
                            {row.isResized && <span className="ml-1 text-[9px] text-amber-400/80 font-medium">{t("editor.resized")}</span>}
                          </p>
                        )}
                        <p className={`text-gray-600 truncate tabular-nums ${lang !== 'en' ? 'text-[9px]' : 'text-[10px]'}`} title={formatDimensions(first.widthInches * first.transform.s, first.heightInches * first.transform.s, lang)}>
                          {formatDimensions(first.widthInches * first.transform.s, first.heightInches * first.transform.s, lang)}
                        </p>
                      </div>
                      <div className="col-start-2 flex min-w-0 items-center gap-1.5">
                        <div className="flex items-center gap-px shrink-0" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="text"
                            inputMode="numeric"
                            min={1}
                            max={200}
                            readOnly={editingCountKey !== `${row.baseName}::${row.sizeKey}`}
                            autoFocus={editingCountKey === `${row.baseName}::${row.sizeKey}`}
                            className={`h-6 w-14 rounded border-2 bg-white text-center text-[11px] font-semibold tabular-nums text-gray-800 outline-none shadow-sm transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${editingCountKey === `${row.baseName}::${row.sizeKey}` ? "border-cyan-500" : "cursor-pointer border-gray-300 hover:border-cyan-400 hover:bg-cyan-50"}`}
                            value={editingCountKey === `${row.baseName}::${row.sizeKey}` ? editingCountValue : String(count)}
                            onChange={(e) => setEditingCountValue(e.target.value.replace(/\D/g, "").slice(0, 3))}
                            onFocus={() => {
                              if (editingCountKey !== `${row.baseName}::${row.sizeKey}`) {
                                setEditingCountKey(`${row.baseName}::${row.sizeKey}`);
                                setEditingCountValue(String(count));
                              }
                            }}
                            onBlur={() => {
                              handleSetGroupCount(row, parseInt(editingCountValue || String(count), 10));
                              setEditingCountKey(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                handleSetGroupCount(row, parseInt(editingCountValue || String(count), 10));
                                setEditingCountKey(null);
                              } else if (e.key === "Escape") {
                                setEditingCountKey(null);
                              }
                              e.stopPropagation();
                            }}
                            title="Click to set exact copy count"
                          />
                          <div className="flex flex-col gap-px">
                            <button
                              type="button"
                              tabIndex={-1}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => handleSetGroupCount(row, count + 1)}
                              disabled={count >= 200}
                              className="flex h-[10px] w-3.5 items-center justify-center rounded-t border border-gray-300 bg-gray-100 text-gray-400 transition-colors hover:bg-cyan-100 hover:text-cyan-600 disabled:opacity-30"
                              title="Increase copies"
                            >
                              <ChevronUp className="h-2.5 w-2.5" strokeWidth={3} />
                            </button>
                            <button
                              type="button"
                              tabIndex={-1}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => handleSetGroupCount(row, count - 1)}
                              disabled={count <= 1}
                              className="flex h-[10px] w-3.5 items-center justify-center rounded-b border border-t-0 border-gray-300 bg-gray-100 text-gray-400 transition-colors hover:bg-cyan-100 hover:text-cyan-600 disabled:opacity-30"
                              title="Decrease copies"
                            >
                              <ChevronDown className="h-2.5 w-2.5" strokeWidth={3} />
                            </button>
                          </div>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const targetCount = editingCountKey === `${row.baseName}::${row.sizeKey}`
                              ? parseInt(editingCountValue, 10)
                              : count;
                            const groupIds = new Set(row.designs.map(d => d.id));
                            setSelectedDesignIds(groupIds);
                            setSelectedDesignId(first.id);
                            if (targetCount !== count) {
                              handleSetGroupCount(row, targetCount);
                            } else if (Number.isInteger(targetCount)) {
                              setTimeout(() => handleAutoArrangeRef.current({ preserveSelection: true }), 0);
                            }
                            setEditingCountKey(null);
                          }}
                          className="inline-flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-md border border-fuchsia-400 bg-fuchsia-100 px-1.5 text-[9px] font-bold text-fuchsia-800 shadow-sm shadow-fuchsia-500/20 transition-colors hover:bg-fuchsia-200"
                          title="Duplicate & Arrange"
                        >
                          <Copy className="h-3 w-3" />
                          <span className="whitespace-nowrap">Duplicate &amp; Arrange</span>
                        </button>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteGroup(row.designs.map(d => d.id)); }}
                        className="absolute right-2.5 top-2.5 p-0.5 rounded hover:bg-gray-200 text-red-500 hover:text-red-600 transition-colors flex-shrink-0"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ); })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right area - Canvas workspace */}
      <div className={`min-w-0 flex flex-col ${isMobile ? "w-full flex-shrink-0" : "flex-1 h-full overflow-hidden"}`}>
        {!isMobile && <EditorActionToolbar {...actionToolbarProps} />}

        {/* Preview Canvas */}
        {isMobile ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1">
            <div className="min-h-0 min-w-0 h-full pl-1.5 basis-[53%] shrink-0 flex flex-col">
              <div className="flex-shrink-0 flex items-center gap-0.5 bg-white border-b border-gray-200 px-2 py-1">
                <button onClick={handleRotate90} disabled={!selectedDesignId} className="h-8 w-8 rounded border border-gray-300 bg-white text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 disabled:pointer-events-none disabled:opacity-30" title={t("editor.rotate")}><RotateCw className="mx-auto h-4 w-4" /></button>
                <button onClick={() => handleAlignCorner('tl')} disabled={!selectedDesignId} className="h-8 w-8 rounded text-gray-600 hover:bg-gray-100 hover:text-cyan-400 disabled:pointer-events-none disabled:opacity-30" title={t("editor.alignTL")}><ArrowUpLeft className="mx-auto h-4 w-4" /></button>
                <button onClick={() => handleAlignCorner('tr')} disabled={!selectedDesignId} className="h-8 w-8 rounded text-gray-600 hover:bg-gray-100 hover:text-cyan-400 disabled:pointer-events-none disabled:opacity-30" title={t("editor.alignTR")}><ArrowUpRight className="mx-auto h-4 w-4" /></button>
                <button onClick={() => handleAlignCorner('bl')} disabled={!selectedDesignId} className="h-8 w-8 rounded text-gray-600 hover:bg-gray-100 hover:text-cyan-400 disabled:pointer-events-none disabled:opacity-30" title={t("editor.alignBL")}><ArrowDownLeft className="mx-auto h-4 w-4" /></button>
                <button onClick={() => handleAlignCorner('br')} disabled={!selectedDesignId} className="h-8 w-8 rounded text-gray-600 hover:bg-gray-100 hover:text-cyan-400 disabled:pointer-events-none disabled:opacity-30" title={t("editor.alignBR")}><ArrowDownRight className="mx-auto h-4 w-4" /></button>
              </div>
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
                  onWandTap={profile.enableFluorescent ? (nx, ny, id) => wandAssignRef.current?.(nx, ny) : undefined}
                  panModeActive={profile.enableFluorescent ? panModeActive : false}
                  onPanModeChange={profile.enableFluorescent ? setPanModeActive : undefined}
                  selectionZoomActive={selectionZoomActive}
                  onSelectionZoomChange={(active) => {
                    setSelectionZoomActive(active);
                    if (active) {
                      clearActiveChannelRef.current?.();
                      setPanModeActive(false);
                      setWandDeleteModeActive(false);
                    }
                  }}
                  bottomToolbarContainer={mobileToolbarContainer}
                   wandDeleteActive={wandDeleteModeActive}
                   onWandDeleteTap={handleWandDelete}
                   onWandDeactivate={() => setWandDeleteModeActive(false)}
                />
              </div>
            </div>

            <div className="min-h-0 h-full basis-[47%] shrink-0 border-l border-gray-200 bg-gray-100 p-2">
              <div className="flex h-full flex-col gap-2 overflow-y-auto">
                <button onClick={handleThresholdAlpha} disabled={!selectedDesignId && selectedDesignIds.size === 0} className={`flex items-center justify-center gap-1 rounded-md border px-2 py-2 text-[11px] font-medium transition-all ${selectedDesignId || selectedDesignIds.size > 0 ? "border-[#CBD5E1] bg-[#F1F5F9] text-[#2563EB]" : "pointer-events-none bg-gray-200 text-gray-500 opacity-30"}`} title={t("editor.cleanAlphaTitle")}><Droplets className="h-3 w-3" />{t("editor.cleanAlpha")}</button>
                <button onClick={handleThresholdAlphaAll} disabled={designs.length === 0} className={`flex items-center justify-center gap-1 rounded-md border px-2 py-2 text-[11px] font-medium transition-all ${designs.length > 0 ? "border-[#CBD5E1] bg-[#F1F5F9] text-[#2563EB]" : "pointer-events-none bg-gray-200 text-gray-500 opacity-30"}`} title={t("editor.cleanAlphaAllTitle")}><Droplets className="h-3 w-3" />{t("editor.cleanAlphaAll")}</button>
                {halftoneEnabled && (
                  <div className="relative">
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
                <div className={`rounded-md border border-gray-200 bg-white p-2 ${isMobile ? "mx-auto" : ""}`}>
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={() => handleDuplicateDesign(duplicateCount)}
                      disabled={!selectedDesignId}
                      className={`w-full rounded-md px-2 py-2 text-[11px] font-medium transition-all ${selectedDesignId ? "border border-[#CBD5E1] bg-[#F1F5F9] text-[#7C3AED]" : "pointer-events-none bg-gray-200 text-gray-500 opacity-30"}`}
                      title={t("editor.duplicate")}
                    >
                      <span className="inline-flex w-full items-center justify-center gap-1 text-center whitespace-normal break-words leading-snug">
                        <Copy className="h-3.5 w-3.5 flex-shrink-0" />
                        <span>{t("editor.duplicate").replace(/ \(.*/, "")}</span>
                      </span>
                    </button>
                    <div className="relative w-10 h-[28px] lg:h-[24px] mx-auto rounded border border-gray-300 bg-white overflow-hidden focus-within:border-cyan-500">
                      <input
                        type="text"
                        inputMode="numeric"
                        value={duplicateCount}
                        onChange={(e) => setDuplicateCount(parseDuplicateCount(e.target.value))}
                        onKeyDown={handleDuplicateCountKeyDown}
                        disabled={!selectedDesignId}
                         className="w-full h-full text-center text-[12px] font-semibold leading-none p-0 pr-3 bg-white outline-none disabled:opacity-30 disabled:pointer-events-none"
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        title="Number of copies"
                      />
                      <div className="absolute right-0 top-0 h-full w-3 border-l border-gray-300 overflow-hidden rounded-r">
                        <button
                          type="button"
                          onClick={() => setDuplicateCount((prev) => clampDuplicateCount(prev + 1))}
                          disabled={!selectedDesignId || duplicateCount >= 99}
                          className="h-1/2 w-full flex items-center justify-center border-b border-gray-300 bg-gray-50 hover:bg-gray-100 disabled:opacity-30 disabled:pointer-events-none"
                          title="Increase copies"
                        >
                          <ChevronUp className="w-2.5 h-2.5 text-gray-600" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDuplicateCount((prev) => clampDuplicateCount(prev - 1))}
                          disabled={!selectedDesignId || duplicateCount <= 1}
                          className="h-1/2 w-full flex items-center justify-center bg-gray-50 hover:bg-gray-100 disabled:opacity-30 disabled:pointer-events-none"
                          title="Decrease copies"
                        >
                          <ChevronDown className="w-2.5 h-2.5 text-gray-600" />
                        </button>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDuplicateAndArrange(duplicateCount)}
                      disabled={!selectedDesignId}
                       className={`w-full rounded-md px-2 py-2 text-[12px] font-semibold transition-all ${selectedDesignId ? "border border-[#CBD5E1] bg-[#F1F5F9] text-[#0891B2]" : "pointer-events-none bg-gray-200 text-gray-500 opacity-30"}`}
                      title={t("editor.duplicateArrange")}
                    >
                      <span className="inline-flex w-full items-center justify-center gap-1 text-center whitespace-normal break-words leading-snug">
                        <Copy className="h-3.5 w-3.5 flex-shrink-0" />
                        <span>{t("editor.duplicateArrange")}</span>
                      </span>
                    </button>
                    {designs.length >= 2 && (
                      <div className="mt-1 flex items-center justify-center gap-1">
                         <span className="text-[11px] font-medium text-gray-700">{t("editor.margin")}</span>
                        <select
                          value={designGap === undefined ? "auto" : String(designGap)}
                          onChange={(e) => {
                            const v = e.target.value;
                            const newGap = v === "auto" ? undefined : parseFloat(v);
                            setDesignGap(newGap);
                            setTimeout(() => handleAutoArrangeRef.current({ skipSnapshot: false, preserveSelection: true }), 0);
                          }}
                           className="h-8 px-1.5 bg-gray-100 border border-gray-300 rounded text-[12px] font-medium text-gray-800 outline-none cursor-pointer hover:border-gray-400 focus:border-cyan-500 transition-colors"
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
                  </div>
                </div>
                <span className={`mx-auto inline-flex rounded px-2 py-1 text-[11px] font-bold ${effectiveDPI < 277 ? "border border-amber-400 bg-amber-100 text-amber-700" : "border border-emerald-700 bg-emerald-100 text-emerald-700"}`} title={t("editor.effectiveRes", { dpi: effectiveDPI })}>{effectiveDPI} DPI</span>
                <div className={`rounded-md border border-gray-200 bg-white p-2 ${isMobile ? "mx-auto w-fit max-w-full" : ""}`}>
                  <div className="mx-auto mb-1 inline-flex items-center justify-center gap-1">
                    <span className="text-[12px] font-bold text-gray-800">W</span>
                    <SizeInput value={activeResizeSettings.widthInches * activeDesignTransform.s} onCommit={(v) => handleEffectiveSizeChange("width", v)} title={useMetric(lang) ? t("editor.widthTitleCm") : t("editor.widthTitle")} max={artboardWidth} lang={lang} />
                    <span className="text-[11px] font-medium text-gray-700">{getUnitSuffix(activeResizeSettings.widthInches * activeDesignTransform.s, lang)}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setProportionalLock((v) => !v)}
                    className="mx-auto mb-1 flex h-5 w-5 items-center justify-center rounded text-cyan-500 hover:bg-cyan-50"
                    title={proportionalLock ? t("editor.proportionsLocked") : t("editor.proportionsUnlocked")}
                  >
                    {proportionalLock ? <Link className="h-3.5 w-3.5" /> : <Unlink className="h-3.5 w-3.5" />}
                  </button>
                  <div className="mx-auto inline-flex items-center justify-center gap-1">
                    <span className="text-[12px] font-bold text-gray-800">H</span>
                    <SizeInput value={activeResizeSettings.heightInches * activeDesignTransform.s} onCommit={(v) => handleEffectiveSizeChange("height", v)} title={useMetric(lang) ? t("editor.heightTitleCm") : t("editor.heightTitle")} max={artboardHeight} lang={lang} />
                    <span className="text-[11px] font-medium text-gray-700">{getUnitSuffix(activeResizeSettings.heightInches * activeDesignTransform.s, lang)}</span>
                  </div>
                </div>
                <button
                  onClick={() => handleAutoArrange({ preserveSelection: selectedDesignIds.size >= 2 })}
                  disabled={designs.length < 2 && selectedDesignIds.size < 2}
                   className={`mx-auto flex min-h-[36px] items-center justify-center gap-1 rounded-md px-2 py-1 text-[12px] font-semibold transition-colors ${
                    designs.length >= 2 || selectedDesignIds.size >= 2
                      ? "border border-pink-600 bg-pink-500 text-black shadow-md shadow-pink-500/25 hover:bg-pink-600"
                      : "pointer-events-none bg-gray-200 text-gray-500 opacity-30"
                  }`}
                  title={selectedDesignIds.size >= 2 ? t("editor.autoArrangeSelected") : t("editor.autoArrangeAll")}
                >
                  <LayoutGrid className="h-3.5 w-3.5 flex-shrink-0" />
                  {t("editor.autoArrange")}
                </button>
                <div className="mt-auto mx-auto flex items-center gap-1 rounded-md border border-gray-200 bg-white p-1">
                <button onClick={handleUndo} disabled={!canUndo()} className="h-8 w-8 rounded border border-gray-300 bg-white text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 disabled:pointer-events-none disabled:opacity-30" title={t("editor.undo")}><Undo2 className="mx-auto h-4 w-4" /></button>
                <button onClick={handleRedo} disabled={!canRedo()} className="h-8 w-8 rounded border border-gray-300 bg-white text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 disabled:pointer-events-none disabled:opacity-30" title={t("editor.redo")}><Redo2 className="mx-auto h-4 w-4" /></button>
                <button onClick={() => { if (selectedDesignIds.size > 1) handleDeleteMulti(selectedDesignIds); else if (selectedDesignId) handleDeleteDesign(selectedDesignId); }} disabled={!selectedDesignId} className="h-8 w-8 rounded border border-red-200 bg-white text-red-500 transition-colors hover:bg-red-50 hover:text-red-600 disabled:pointer-events-none disabled:opacity-30" title={t("editor.delete")}><Trash2 className="mx-auto h-4 w-4" /></button>
              </div>
              </div>
            </div>
            </div>
            <div ref={setMobileToolbarContainer} className="flex-shrink-0" />
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
              onWandTap={profile.enableFluorescent ? (nx, ny, id) => wandAssignRef.current?.(nx, ny) : undefined}
              panModeActive={profile.enableFluorescent ? panModeActive : false}
              onPanModeChange={profile.enableFluorescent ? setPanModeActive : undefined}
              selectionZoomActive={selectionZoomActive}
              onSelectionZoomChange={(active) => {
                setSelectionZoomActive(active);
                if (active) {
                  clearActiveChannelRef.current?.();
                  setPanModeActive(false);
                  setWandDeleteModeActive(false);
                }
              }}
              wandDeleteActive={wandDeleteModeActive}
              onWandDeleteTap={handleWandDelete}
              onWandDeactivate={() => setWandDeleteModeActive(false)}
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

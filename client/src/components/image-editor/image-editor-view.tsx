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
import { useMobileLayout, useShortViewport } from "@/hooks/use-layout-viewport";
import { formatDimensions, formatLength, useMetric, getUnitSuffix } from "@/lib/format-length";
import { useWandTolerance, useToolActions } from "@/state/tool-store";
import {
  ArrowDownLeft, ArrowDownRight, ArrowUpLeft, ArrowUpRight, Copy,
  Droplets, Eraser, FlipHorizontal2, FlipVertical2, Group, Layers, LayoutGrid, Link, Loader2, Minus, Plus, Redo2, RotateCw,
  SlidersHorizontal, Sparkles, Trash2, Undo2, Ungroup, Unlink, WandSparkles, X, XCircle,
} from "lucide-react";
import { CenterHorizontalIcon, CenterVerticalIcon } from "./center-axis-icons";
import { HalftoneIcon } from "./halftone-icon";
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

/**
 * The tools in the phone's Design tools sheet, and the thing the bar offers to repeat.
 *
 * Naming them lets one list drive the grid, the "run it again" pill, and which tool is
 * remembered, so a tool cannot appear in the sheet and be missing from the pill.
 */
type DesignToolId =
  | "whiteBg"
  | "wand"
  | "cleanAlpha"
  | "alignRotate"
  | "flipH"
  | "flipV"
  | "upscale"
  | "halftone"
  | "autoArrange";

interface DesignTool {
  id: DesignToolId;
  label: string;
  title: string;
  Icon: React.ComponentType<{ className?: string }>;
  /** Grid button colours. The pill borrows the same palette so the two read as one control. */
  tone: string;
  pillTone: string;
  disabled: boolean;
  run: () => void;
}

export default function ImageEditorView() {
  const {
    t, lang, profile, embedFromShopify, isMobile, isLgUp, isUploading, uploadProgress, isProcessing, exportProgressLabel,
    isAddingToCart, isEditMode, isUpdateFlow, isDragOver, artboardWidth, artboardHeight,
    forceRegenerateProduction, setForceRegenerateProduction,
    quantity, designGap, duplicateCount, designs, setDesigns, selectedDesignId, setSelectedDesignId,
    selectedDesignIds, setSelectedDesignIds,
    proportionalLock,
    setProportionalLock,
    activeImageInfo, activeDesignTransform,
    activeResizeSettings, effectiveDPI, layerRows, canvasRef, designInfoRef,
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
    handleIncreaseQuality, isUpscaling, upscaleProgress, canIncreaseQuality,
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
  const shortViewport = useShortViewport();
  // The phone presents one surface — canvas, persistent bar, contextual sheet.
  // Everything the old Controls panel held that is not contextual to a
  // selection now lives behind this, summoned over the canvas rather than
  // taking layout width or height from it.
  const [layersOpen, setLayersOpen] = useState(false);
  /**
   * The phone's home for everything that changes how a design *looks*.
   *
   * These controls existed before this sheet, in the contextual one, behind its
   * half and full detents — which meant they only appeared if you happened to
   * drag a sheet upward, and most customers never did. Summoning them by name
   * from the persistent bar is the whole point; the contextual sheet is left to
   * sizing, which is what a tap on a design is usually about.
   */
  const [designToolsOpen, setDesignToolsOpen] = useState(false);
  const [toolsCollapseSignal, setToolsCollapseSignal] = useState(0);
  const [alignRotatePanelOpen, setAlignRotatePanelOpen] = useState(false);
  const [pixelCleanPanelOpen, setPixelCleanPanelOpen] = useState(false);
  /**
   * Where the canvas's backdrop-colour swatches land on the phone: the right-hand end of the
   * view bar, which is on screen for the whole session.
   */
  const [backdropSwatchHost, setBackdropSwatchHost] = useState<HTMLDivElement | null>(null);
  /**
   * Get out of the way and show what just happened.
   *
   * Every tool in the sheet changes the artwork, and the artwork is behind the
   * sheet. Dropping to the strip and fitting the view to the design that
   * changed turns "I pressed something" into "I can see what it did". `focusSelected`
   * is the canvas' own Focus control, reached through the handle.
   */
  const focusSelectedRef = useRef<(() => void) | null>(null);
  const registerCanvasFocus = useCallback((focus: () => void) => {
    focusSelectedRef.current = focus;
  }, []);
  const minimiseToolsAndFocus = useCallback(() => {
    setToolsCollapseSignal((n) => n + 1);
    focusSelectedRef.current?.();
  }, []);
  /**
   * The tool the customer reached for last, kept so the bar can offer it again.
   *
   * Most of these apply once and finish — there is no mode to display afterwards — but
   * running the same tool over several designs in a row is the common way a sheet gets
   * cleaned up, and doing that meant reopening the sheet each time. The one exception is the
   * wand, which is a real mode; when it is armed it takes the slot regardless of this.
   */
  const [lastToolId, setLastToolId] = useState<DesignToolId | null>(null);
  /**
   * The halftone options open below the six tool buttons, which on a phone puts
   * them past the bottom of the sheet's own scroll — the customer taps Halftone
   * and nothing appears to happen. Pulling the panel into view is the whole
   * difference between the control working and seeming broken.
   */
  const halftonePanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!halftoneMenuOpen || !designToolsOpen) return;
    // After the panel has been laid out, or there is nothing to scroll to.
    const frame = requestAnimationFrame(() => {
      halftonePanelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [halftoneMenuOpen, designToolsOpen]);
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

  /**
   * Shared by the desktop sidebar's layers card and the phone's layers sheet.
   *
   * Built only when one of those two is actually showing it, and memoised on the rows
   * themselves. Hoisting this out of the sidebar's `showDesignInfo` conditional so both arms
   * could share it quietly made it unconditional: the phone, which does not render the
   * sidebar at all, went from paying nothing for these elements to rebuilding all of them on
   * every view render, including every frame of a drag and with the layers sheet shut.
   */
  const layerListVisible = showDesignInfo || layersOpen;
  const layerListItems = useMemo(
    () =>
      layerListVisible
        ? layerRows.map((row) => {
            const rowKey = `${row.baseName}::${row.sizeKey}`;
            return <LayerRow key={rowKey} rowKey={rowKey} row={row} handlers={layerHandlers} />;
          })
        : null,
    [layerListVisible, layerRows, layerHandlers],
  );

  /**
   * Built only for the phone, which is the only layout with a Design tools sheet — the
   * desktop toolbar spells these out across the top of the editor instead.
   *
   * Every entry closes over the handler it runs, so the grid below is a `.map` and the bar's
   * pill is a lookup. `runTool` is what both go through, so using a tool from either place
   * records it the same way.
   */
  // Panel state must not survive the sheet closing by ANY route (tools pill,
  // layers toggle, minimiseToolsAndFocus) — reopening the sheet later should
  // never resurrect a stale options panel.
  useEffect(() => {
    if (!designToolsOpen) {
      setAlignRotatePanelOpen(false);
      setPixelCleanPanelOpen(false);
    }
  }, [designToolsOpen]);
  // Align/Rotate acts on the selection; deselecting closes it rather than
  // letting it reappear pre-opened with the next selection.
  useEffect(() => {
    if (!selectedDesignId) setAlignRotatePanelOpen(false);
  }, [selectedDesignId]);

  // The page header shows the gangsheet size where the language toggle used
  // to sit. CustomEvents keep the page decoupled from editor internals,
  // mirroring the existing "dtf:open-upload" pattern: the editor broadcasts
  // size info (and re-sends on request, since the header can mount first),
  // and header dropdown picks come back as "dtf:set-sheet-height".
  useEffect(() => {
    const send = () => {
      window.dispatchEvent(new CustomEvent("dtf:sheet-info", {
        detail: {
          widthLabel: `${formatLength(artboardWidth, lang)}${lang === "en" ? '"' : ""}`,
          height: artboardHeight,
          heightLabel: `${formatLength(artboardHeight, lang)}${lang === "en" ? '"' : ""}`,
          locked: isEditMode,
          options: GANGSHEET_HEIGHTS.map((h) => ({
            value: h,
            // Same rule as the in-sheet select this replaces: the
            // "(current bounds)" hint only marks advice not yet taken, so
            // the selected entry drops it and the closed control never has
            // to render the long form.
            label: `${formatLength(h, lang)}${lang === "en" ? '"' : ""}${
              recommendedArtboardHeight === h && artboardHeight !== h
                ? ` (${t("controls.currentBounds")})`
                : ""
            }`,
          })),
        },
      }));
    };
    send();
    window.addEventListener("dtf:request-sheet-info", send);
    return () => {
      window.removeEventListener("dtf:request-sheet-info", send);
      // Tell the header the info it holds is dead: the badge hides rather
      // than offering a picker no editor is listening to (the editor
      // remounts on key changes and disappears behind loading/error
      // branches). On a mere dep change the effect re-runs and re-sends
      // synchronously, so the only lasting null is a real teardown.
      window.dispatchEvent(new CustomEvent("dtf:sheet-info", { detail: null }));
    };
  }, [artboardWidth, artboardHeight, recommendedArtboardHeight, isEditMode, lang, t, GANGSHEET_HEIGHTS]);
  useEffect(() => {
    const onSet = (e: Event) => {
      const h = (e as CustomEvent).detail?.height;
      if (typeof h === "number" && Number.isFinite(h) && !isEditMode) {
        handleArtboardHeightChange(h);
      }
    };
    window.addEventListener("dtf:set-sheet-height", onSet);
    return () => window.removeEventListener("dtf:set-sheet-height", onSet);
  }, [handleArtboardHeightChange, isEditMode]);

  const designTools: DesignTool[] = !mobileLayout ? [] : [
    {
      id: "alignRotate",
      label: t("editor.alignRotate"),
      title: t("editor.alignRotateTitle"),
      Icon: RotateCw,
      tone: alignRotatePanelOpen
        ? "border-black bg-black text-white"
        : "border-gray-300 bg-white text-gray-700 hover:bg-gray-100",
      pillTone: "border-gray-300 bg-white text-gray-700",
      disabled: !selectedDesignId,
      run: () => {
        setPixelCleanPanelOpen(false);
        setAlignRotatePanelOpen((v) => !v);
        setDesignToolsOpen(true);
        setLayersOpen(false);
      },
    },
    {
      id: "whiteBg",
      label: t("editor.whiteBg"),
      title: t("editor.whiteBgTitle"),
      Icon: Eraser,
      tone: "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100",
      pillTone: "border-amber-300 bg-amber-50 text-amber-700",
      disabled: !selectedDesignId,
      run: handleRemoveWhiteBackground,
    },
    {
      id: "wand",
      label: t("editor.magicWand"),
      title: t("editor.magicWandTitle"),
      Icon: WandSparkles,
      tone: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-600 hover:bg-fuchsia-100",
      pillTone: "border-fuchsia-300 bg-fuchsia-50 text-fuchsia-700",
      disabled: !selectedDesignId,
      run: handleWandDeleteToggle,
    },
    {
      id: "cleanAlpha",
      label: t("editor.cleanAlpha"),
      title: t("editor.cleanAlphaTitle"),
      Icon: Droplets,
      tone: pixelCleanPanelOpen
        ? "border-[#2563EB] bg-[#2563EB] text-white"
        : "border-[#CBD5E1] bg-[#F1F5F9] text-[#2563EB]",
      pillTone: "border-[#CBD5E1] bg-[#F1F5F9] text-[#2563EB]",
      disabled: designs.length === 0,
      run: () => {
        setAlignRotatePanelOpen(false);
        setPixelCleanPanelOpen((v) => !v);
        setDesignToolsOpen(true);
        setLayersOpen(false);
      },
    },
    {
      id: "flipH",
      label: t("editor.flipH"),
      title: t("editor.flipH"),
      Icon: FlipHorizontal2,
      tone: "border-gray-300 bg-white text-gray-700 hover:bg-gray-100",
      pillTone: "border-gray-300 bg-white text-gray-700",
      disabled: !selectedDesignId,
      run: handleFlipX,
    },
    {
      id: "flipV",
      label: t("editor.flipV"),
      title: t("editor.flipV"),
      Icon: FlipVertical2,
      tone: "border-gray-300 bg-white text-gray-700 hover:bg-gray-100",
      pillTone: "border-gray-300 bg-white text-gray-700",
      disabled: !selectedDesignId,
      run: handleFlipY,
    },
    /* Auto-Arrange sits with the tools now rather than in the bar. Imports and copy-count
       changes already arrange as they land, so pressing it is the exception rather than the
       routine, and it was holding the only labelled slot on the row. */
    {
      id: "autoArrange",
      label: t("editor.autoArrange"),
      title: selectedDesignIds.size >= 2 ? t("editor.autoArrangeSelected") : t("editor.autoArrangeAll"),
      Icon: LayoutGrid,
      tone: "border-pink-600 bg-pink-500 text-black hover:bg-pink-600",
      pillTone: "border-pink-600 bg-pink-500 text-black",
      disabled: designs.length < 2 && selectedDesignIds.size < 2,
      run: () => handleAutoArrange({ preserveSelection: selectedDesignIds.size >= 2, fullRepack: true }),
    },
    ...(canIncreaseQuality
      ? [{
          id: "upscale" as const,
          label: isUpscaling && upscaleProgress !== null
            ? `${Math.round(upscaleProgress * 100)}%`
            : t("editor.increaseQuality"),
          title: t("editor.increaseQuality"),
          Icon: Sparkles,
          tone: "border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100",
          pillTone: "border-violet-300 bg-violet-50 text-violet-700",
          disabled: !selectedDesignId || isUpscaling,
          run: () => { void handleIncreaseQuality(2); },
        }]
      : []),
    ...(halftoneEnabled
      ? [{
          id: "halftone" as const,
          label: t("editor.halftone"),
          title: t("editor.halftoneTitle"),
          Icon: HalftoneIcon,
          tone: halftoneMenuOpen
            ? "border-amber-600 bg-amber-500 text-white"
            : "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100",
          pillTone: "border-amber-300 bg-amber-50 text-amber-700",
          disabled: !selectedDesignId && selectedDesignIds.size === 0,
          /* Its options render inside the sheet, so repeating it from the pill has to bring
             the sheet back up or the menu would open somewhere nobody can see. */
          run: () => { setDesignToolsOpen(true); setLayersOpen(false); handleOpenHalftoneMenu(); },
        }]
      : []),
  ];

  /**
   * Halftone / Align-Rotate / Pixel Clean open options instead of applying, so
   * they must not collapse the sheet they just drew into.
   */
  const runTool = (tool: DesignTool) => {
    setLastToolId(tool.id);
    tool.run();
    if (tool.id !== "halftone" && tool.id !== "alignRotate" && tool.id !== "cleanAlpha") {
      minimiseToolsAndFocus();
    }
  };

  const lastTool = lastToolId ? designTools.find((tool) => tool.id === lastToolId) ?? null : null;

  /**
   * Whether the phone's action bar is showing a tool in its right-hand slot, and so whether
   * the Design tools button has to give up its label to make room. Mirrors the condition the
   * slot itself renders under, so the two can never disagree.
   */
  const activeToolShown = wandDeleteModeActive || !!lastTool;

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
      regenerateProduction={isEditMode ? forceRegenerateProduction : undefined}
      onRegenerateProductionChange={isEditMode ? setForceRegenerateProduction : undefined}
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
          accept=".png,.jpg,.jpeg,.webp,.pdf,.svg,image/png,image/jpeg,image/webp,image/svg+xml,application/pdf"
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
        accept=".png,.jpg,.jpeg,.webp,.pdf,.svg,image/png,image/jpeg,image/webp,image/svg+xml,application/pdf"
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


          {/* Fluorescent panel portal target */}
          {profile.enableFluorescent && <div ref={setFluorPanelContainer} />}

          {/* Add Designs — the only desktop upload entry now (the copy that
              sat over the canvas with the file name is gone). Full-width on
              its own row, with the Layers panel directly beneath. It lives
              outside the designs.length gate so an emptied sheet still
              offers a way to add artwork. */}
          <button
            onClick={() => sidebarFileRef.current?.click()}
            className="flex w-full min-h-11 items-center justify-center gap-2 rounded-lg border border-cyan-600 bg-cyan-500 px-4 py-2.5 text-sm font-bold text-white shadow-md shadow-cyan-500/25 transition-all hover:bg-cyan-600 hover:shadow-lg hover:shadow-cyan-500/30 active:scale-[0.98]"
            title={t("editor.addDesignTitle")}
          >
            {actionToolbarProps.isUploading ? (
              <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin" />
            ) : (
              <Plus className="h-5 w-5 flex-shrink-0" strokeWidth={2.5} />
            )}
            <span>{actionToolbarProps.isUploading ? t("editor.processing") : t("editor.addDesigns")}</span>
          </button>
          <input
            ref={sidebarFileRef}
            type="file"
            className="hidden"
            accept=".png,.jpg,.jpeg,.webp,.pdf,.svg,image/png,image/jpeg,image/webp,image/svg+xml,application/pdf"
            multiple
            onChange={handleSidebarFileChange}
          />

          {/* Layers Panel */}
          {designs.length > 0 && (
            <div ref={designInfoRef} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <div className="flex items-center gap-3 px-3 py-2.5 min-w-0">
                <div className="flex flex-1 min-w-0 items-center gap-3 rounded-md px-1.5 py-1 text-base font-semibold text-gray-800 overflow-hidden">
                  <Layers className="h-7 w-7 flex-shrink-0 text-cyan-500" strokeWidth={2.25} />
                  <span className="truncate">{t("editor.layers")}</span>
                  <span className="flex-shrink-0 rounded-full bg-cyan-100 px-2.5 py-1 text-sm font-bold tabular-nums text-cyan-700">{designs.length}</span>
                </div>
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
        {!mobileLayout && (
          <EditorActionToolbar
            {...actionToolbarProps}
            isMobile={mobileLayout}
            handleRemoveWhiteBackground={handleRemoveWhiteBackground}
            wandDeleteActive={wandDeleteModeActive}
            handleWandDeleteToggle={handleWandDeleteToggle}
            halftoneEnabled={halftoneEnabled}
            handleOpenHalftoneMenu={handleOpenHalftoneMenu}
            halftoneMenuOpen={halftoneMenuOpen}
            setHalftoneMenuOpen={setHalftoneMenuOpen}
            halftoneStrength={halftoneStrength}
            setHalftoneStrength={setHalftoneStrength}
            halftoneTopColors={halftoneTopColors}
            handleApplyHalftone={handleApplyHalftone}
          />
        )}

        {/* Preview Canvas */}
        {mobileLayout ? (
          <div className="flex min-h-0 flex-1 flex-col">
              {/* Portal host. Renders nothing itself — see the note on
                  `controlsSection`. */}
              <div className="hidden" aria-hidden="true">{controlsSection}</div>

              {/* View bar.
                  Undo and Redo are the same white icon pills as the desktop
                  canvas overlay — one look for the same two controls on both
                  layouts (asked for explicitly). The curved-arrow/rotate-handle
                  confusion that once argued for text labels is settled
                  differently now: the labelled "Reset" sits right beside them,
                  anchoring the cluster as view/history controls.

                  They stay in this bar rather than floating over the canvas
                  because the band that looks empty stops being empty on a tall
                  sheet or at any zoom-in. */}
              <div
                className="flex flex-shrink-0 items-center gap-1 overflow-x-auto border-b border-gray-200 bg-gray-100 py-1 pl-2 pr-1 [scrollbar-width:thin]"
                data-testid="mobile-view-bar"
              >
                <button
                  type="button"
                  onClick={handleUndo}
                  disabled={!canUndo()}
                  className="flex h-9 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-700 shadow-sm transition-colors hover:bg-gray-100 disabled:pointer-events-none disabled:opacity-30 coarse:h-11 coarse:w-12"
                  title={t("editor.undo")}
                  aria-label={t("editor.undo")}
                >
                  <Undo2 className="h-5 w-5" strokeWidth={2.5} />
                </button>
                <button
                  type="button"
                  onClick={handleRedo}
                  disabled={!canRedo()}
                  className="flex h-9 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-700 shadow-sm transition-colors hover:bg-gray-100 disabled:pointer-events-none disabled:opacity-30 coarse:h-11 coarse:w-12"
                  title={t("editor.redo")}
                  aria-label={t("editor.redo")}
                >
                  <Redo2 className="h-5 w-5" strokeWidth={2.5} />
                </button>
                <div className="h-5 w-px flex-shrink-0 bg-gray-300" />
                {/* Reset / zoom / focus portal in here from the canvas. */}
                <div ref={setMobileToolbarContainer} className="flex min-w-0 flex-1 items-center" data-testid="mobile-canvas-toolbar" />
                {/* The backdrop the canvas draws behind the artwork.
                    
                    Back at the right-hand end of this bar, where the zoom
                    controls leave about 150px unused. It spent a while in the
                    Design tools sheet, which put a viewing preference two taps
                    deep behind a panel about editing the artwork — and hid it
                    entirely unless that panel happened to be open. Everything
                    else in this bar changes how you are looking at the sheet
                    rather than what is on it, which is exactly what choosing a
                    garment colour to preview against does.

                    `PreviewSection` owns the colour and portals the swatches
                    into this box. */}
                <div ref={setBackdropSwatchHost} className="flex flex-shrink-0 items-center pl-1" />
              </div>

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
                  backdropSwatchContainer={backdropSwatchHost}
                   wandDeleteActive={wandDeleteModeActive}
                   onWandDeleteTap={handleWandDelete}
                   onWandDeactivate={handleWandDeactivate}
                   onRegisterFocus={registerCanvasFocus}
                />

                {/* Contextual tools. Nothing selected means no sheet at all, so
                    the controls cost zero canvas for as long as they are of no
                    use. Every row below is `flex-nowrap` + `justify-start`:
                    wrapping would silently eat canvas, and a centred row that
                    overflows spills off the left edge where no scroll reaches. */}
                <MobileToolSheet
                  /* All three sheets are `bottom-0 z-40`; only one is ever
                     mounted so they cannot stack. Closing either summoned sheet
                     brings the contextual one straight back. */
                  open={!!selectedDesignId && !layersOpen && !designToolsOpen}
                  handleLabel={t("editor.toolSheetHandle")}
                  handleAccessory={
                    <>
                      {/* Lives here rather than inside the size panel below, where
                          desktop puts it. The panel has to fit two fields and four
                          stepper buttons across 374px and this badge was the 34px
                          that pushed the height stepper off the edge. The handle
                          strip is already where the sheet's status goes. */}
                      {selectedDesignIds.size > 1 && (
                        <span
                          className="inline-flex rounded-full border border-cyan-500 bg-cyan-50 px-1.5 py-0.5 text-[11px] font-bold leading-none tabular-nums text-cyan-700"
                          title={t("editor.resizeAppliesToAll", { count: selectedDesignIds.size })}
                        >
                          ×{selectedDesignIds.size}
                        </span>
                      )}
                      <span
                        className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-bold leading-none ${effectiveDPI < 277 ? "border border-amber-400 bg-amber-100 text-amber-700" : "border border-emerald-700 bg-emerald-100 text-emerald-700"}`}
                        title={t("editor.effectiveRes", { dpi: effectiveDPI })}
                      >
                        {effectiveDPI} DPI
                      </span>
                    </>
                  }
                >
                  {(level) => (
                    <>
                      {/* The same tinted panel the desktop toolbar uses, for the
                          same reason: it makes the white fields the highest-contrast
                          thing on the sheet, so the size control is findable without
                          any explanatory copy. The phone needs it more than desktop
                          does — this sheet is the only place a size can be typed. */}
                      {/* Sized to the device rather than to its contents. Every
                          part of this row except the two number fields is a fixed
                          touch target, so the fields are what flexes; see `fluid`
                          in `SizeInput`. `overflow-x-auto` stays as the floor for
                          a viewport too narrow even for that, but no phone in
                          normal use should reach it now.

                          Flexing has a ceiling as well as a floor: this sheet is
                          also the tablet's sizing control, and a 1024px iPad gave
                          each field 372px of width to hold four characters. Past
                          about 200px per field the extra width is not legibility,
                          it just makes the number look lost, so the leftover goes
                          to the margins instead. */}
                      <div className="mx-auto flex w-full max-w-[480px] flex-nowrap items-center justify-center gap-0.5 overflow-x-auto rounded-lg border-2 border-cyan-500 bg-cyan-100 px-1 py-1 shadow-sm">
                        <div className="flex min-w-0 max-w-[200px] flex-1 items-center gap-0.5">
                          <span className="flex-shrink-0 text-[12px] font-bold leading-none text-cyan-900">W</span>
                          <SizeInput fluid value={activeResizeSettings.widthInches * activeDesignTransform.s} onCommit={(v) => handleEffectiveSizeChange("width", v)} title={useMetric(lang) ? t("editor.widthTitleCm") : t("editor.widthTitle")} max={artboardWidth} lang={lang} />
                          {/* The unit label is the first thing to drop when the row
                              runs out of room. `cm` is two characters where the inch
                              mark is one, and carrying it below ~430px squeezed the
                              field under the width its own digits need: a customer
                              in Spanish saw 18.06 render as 18.0. The sheet's
                              dimension label still states the unit. */}
                          <span className={`flex-shrink-0 text-[11px] font-semibold text-cyan-900 ${useMetric(lang) ? "max-[430px]:hidden" : ""}`}>{getUnitSuffix(activeResizeSettings.widthInches * activeDesignTransform.s, lang)}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setProportionalLock((v) => !v)}
                          className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded transition-colors coarse:h-11 coarse:w-9 max-[380px]:coarse:!w-8 ${proportionalLock ? "bg-white text-cyan-600 shadow-sm" : "text-cyan-700/70 hover:bg-white/70"}`}
                          title={proportionalLock ? t("editor.proportionsLocked") : t("editor.proportionsUnlocked")}
                        >
                          {proportionalLock ? <Link className="h-3.5 w-3.5 coarse:h-4 coarse:w-4" /> : <Unlink className="h-3.5 w-3.5 coarse:h-4 coarse:w-4" />}
                        </button>
                        <div className="flex min-w-0 max-w-[200px] flex-1 items-center gap-0.5">
                          <span className="flex-shrink-0 text-[12px] font-bold leading-none text-cyan-900">H</span>
                          <SizeInput fluid value={activeResizeSettings.heightInches * activeDesignTransform.s} onCommit={(v) => handleEffectiveSizeChange("height", v)} title={useMetric(lang) ? t("editor.heightTitleCm") : t("editor.heightTitle")} max={artboardHeight} lang={lang} />
                          <span className={`flex-shrink-0 text-[11px] font-semibold text-cyan-900 ${useMetric(lang) ? "max-[430px]:hidden" : ""}`}>{getUnitSuffix(activeResizeSettings.heightInches * activeDesignTransform.s, lang)}</span>
                        </div>
                      </div>

                      {level !== "peek" && (
                        <>
                          <div className="flex flex-nowrap items-center justify-start gap-2 overflow-x-auto">
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
                                  {/* Same bezel and same −/+ as the layers and size
                                      steppers — this one kept chevrons on both pointers
                                      and was the odd one out of the three. */}
                                  <span className="flex h-3.5 w-4 min-w-4 items-center justify-center rounded border border-gray-300 bg-gray-50 text-gray-600 group-hover:bg-gray-100">
                                    <Plus className="h-3 w-3" strokeWidth={3} />
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
                                    <Minus className="h-3 w-3" strokeWidth={3} />
                                  </span>
                                </button>
                              </div>
                            </div>
                            <button
                              onClick={() => handleDuplicateAndArrange(duplicateCount)}
                              disabled={!selectedDesignId}
                               className={`flex-shrink-0 rounded-md px-2 py-2 text-[12px] font-semibold transition-all coarse:min-h-[44px] ${selectedDesignId ? "border border-[#CBD5E1] bg-[#F1F5F9] text-[#0891B2]" : "pointer-events-none bg-gray-200 text-gray-500 opacity-30"}`}
                              title={t("editor.duplicateArrangeTitle")}
                            >
                              <span className="inline-flex w-full items-center justify-center gap-1 text-center whitespace-nowrap leading-snug">
                                <Copy className="h-3.5 w-3.5 flex-shrink-0" />
                                <span>{t("editor.duplicateArrange")}</span>
                              </span>
                            </button>
                          </div>

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
                      <X className="h-6 w-6" />
                    </button>
                  }
                >
                  {() => (
                    <>
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
                          accept=".png,.jpg,.jpeg,.webp,.pdf,.svg,image/png,image/jpeg,image/webp,image/svg+xml,application/pdf"
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
                      {/* The gangsheet size control that used to trail this
                          list lives in the page header now (see the
                          "dtf:sheet-info" events) — the sheet is back to
                          being only about layers. */}
                      <div data-mobile-layers className="divide-y divide-gray-200 rounded-lg border border-gray-200">{layerListItems}</div>

                      {/* Fluorescent spot-colour panels portal here on this
                          arm; on desktop they go to the sidebar. */}
                      {profile.enableFluorescent && <div ref={setFluorPanelContainer} />}
                    </>
                  )}
                </MobileToolSheet>

                {/* Everything that changes how a design looks.
                    Never `peek`: that is the collapsed strip this sheet drops
                    to after a tool runs, so opening there would show the
                    customer the minimised state of a panel they just asked for.
                    Sideways it opens all the way, because `half` of a 228px box
                    is 160px and showed four of the eight tools. */}
                <MobileToolSheet
                  open={designToolsOpen}
                  testId="mobile-design-tools-sheet"
                  /* A fixed grid of tools, not a list, so it has a real height
                     to be measured against. Without this the sheet takes its
                     60% whatever is in it, which on a tablet — where the eight
                     tools reflow from four rows into two — is most of a screen
                     of white sitting on top of the artwork. */
                  fitContent
                  initialDetent={shortViewport ? "full" : "half"}
                  collapseSignal={toolsCollapseSignal}
                  minCanvasStripPx={16}
                  handleLabel={t("editor.designToolsHandle")}
                  handleLeading={
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDesignToolsOpen(false);
                        setAlignRotatePanelOpen(false);
                        setPixelCleanPanelOpen(false);
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="flex h-11 w-11 items-center justify-center text-gray-500 hover:text-gray-800"
                      aria-label={t("editor.closeDesignTools")}
                      title={t("editor.closeDesignTools")}
                    >
                      <X className="h-6 w-6" />
                    </button>
                  }
                >
                  {(level) => (
                    <>
                      {/* The strip used to become the magic wand's control panel
                          whenever the wand was armed. The action bar carries the
                          tolerance and the off switch now, permanently and whether
                          this sheet is open or shut, so all that is left to say
                          here is what to do next — and arming the wand collapses
                          the sheet to exactly this height, which is the moment
                          that sentence is worth reading. It is text rather than a
                          button because the handle strip above already expands the
                          sheet, and a second target for that job in the same 44px
                          band is how you get a tap that does nothing. */}
                      {level === "peek" && (
                        <p className={`px-1 py-0.5 text-center text-[11px] font-medium ${wandDeleteModeActive ? "text-fuchsia-700" : "text-gray-500"}`}>
                          {wandDeleteModeActive ? t("editor.wandActiveHint") : t("editor.designToolsExpand")}
                        </p>
                      )}

                      {level !== "peek" && (
                        <>
                          {!selectedDesignId && selectedDesignIds.size === 0 && (
                            <p className="px-1 text-[11px] font-medium text-gray-500">{t("editor.selectDesignFirst")}</p>
                          )}

                          {/* Fluid rather than a fixed two columns: sideways
                              this sheet is 844px wide, and two columns spent
                              that on 400px-wide buttons while pushing half the
                              tools below the fold of a 160px sheet. Auto-fit
                              gives four columns there and still two at 390px.
                              170 rather than 150 because at five columns the
                              cells were 161px and French truncated "Retourner
                              Horizontalement"; four cells of 207 fit it, and
                              eight buttons still come to two rows either way. */}
                          <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-1.5">
                            {designTools.map((tool) => (
                              <button
                                key={tool.id}
                                type="button"
                                onClick={() => runTool(tool)}
                                disabled={tool.disabled}
                                className={`flex items-center justify-center gap-1 whitespace-nowrap rounded-md border px-2 py-2 text-[11px] font-medium transition-all disabled:pointer-events-none disabled:opacity-30 coarse:min-h-[44px] ${tool.tone}`}
                                title={tool.title}
                                aria-expanded={
                                  tool.id === "halftone" ? halftoneMenuOpen
                                    : tool.id === "alignRotate" ? alignRotatePanelOpen
                                      : tool.id === "cleanAlpha" ? pixelCleanPanelOpen
                                        : undefined
                                }
                              >
                                <tool.Icon className="h-3.5 w-3.5 flex-shrink-0" />
                                <span className="truncate">{tool.label}</span>
                              </button>
                            ))}
                          </div>

                          {alignRotatePanelOpen && selectedDesignId && (
                            <div className="rounded-md border border-gray-200 bg-gray-50 p-1.5">
                              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-600">{t("editor.alignRotate")}</p>
                              <div className="flex flex-wrap items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => { handleRotate90(); minimiseToolsAndFocus(); }}
                                  className="h-11 w-11 rounded-md border border-gray-300 bg-white text-gray-700"
                                  title={t("editor.rotate")}
                                >
                                  <RotateCw className="mx-auto h-4 w-4" />
                                </button>
                                {[0, 90, 180, 270].map((deg) => (
                                  <button
                                    key={deg}
                                    type="button"
                                    onClick={() => { actionToolbarProps.handleSetRotation(deg); minimiseToolsAndFocus(); }}
                                    className="h-11 min-w-11 rounded-md border border-gray-300 bg-white px-2 text-[12px] font-bold tabular-nums text-gray-800"
                                  >
                                    {deg}°
                                  </button>
                                ))}
                                <div className="h-8 w-px bg-gray-200" />
                                <button type="button" onClick={() => { actionToolbarProps.handleAlignAxis("vertical"); minimiseToolsAndFocus(); }} className="h-11 w-11 rounded-md border border-gray-300 bg-white" title={t("editor.alignCenterX")} aria-label={t("editor.alignCenterX")}><CenterHorizontalIcon className="mx-auto h-4 w-4" /></button>
                                <button type="button" onClick={() => { actionToolbarProps.handleAlignAxis("horizontal"); minimiseToolsAndFocus(); }} className="h-11 w-11 rounded-md border border-gray-300 bg-white" title={t("editor.alignCenterY")} aria-label={t("editor.alignCenterY")}><CenterVerticalIcon className="mx-auto h-4 w-4" /></button>
                                <button type="button" onClick={() => { handleAlignCorner("tl"); minimiseToolsAndFocus(); }} className="h-11 w-11 rounded-md border border-gray-300 bg-white" title={t("editor.alignTL")}><ArrowUpLeft className="mx-auto h-4 w-4" /></button>
                                <button type="button" onClick={() => { handleAlignCorner("tr"); minimiseToolsAndFocus(); }} className="h-11 w-11 rounded-md border border-gray-300 bg-white" title={t("editor.alignTR")}><ArrowUpRight className="mx-auto h-4 w-4" /></button>
                                <button type="button" onClick={() => { handleAlignCorner("bl"); minimiseToolsAndFocus(); }} className="h-11 w-11 rounded-md border border-gray-300 bg-white" title={t("editor.alignBL")}><ArrowDownLeft className="mx-auto h-4 w-4" /></button>
                                <button type="button" onClick={() => { handleAlignCorner("br"); minimiseToolsAndFocus(); }} className="h-11 w-11 rounded-md border border-gray-300 bg-white" title={t("editor.alignBR")}><ArrowDownRight className="mx-auto h-4 w-4" /></button>
                              </div>
                            </div>
                          )}

                          {pixelCleanPanelOpen && (
                            <div className="rounded-md border border-slate-200 bg-slate-50 p-1.5">
                              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-600">{t("editor.cleanAlpha")}</p>
                              <div className="grid grid-cols-2 gap-1.5">
                                <button
                                  type="button"
                                  disabled={!selectedDesignId && selectedDesignIds.size === 0}
                                  onClick={() => {
                                    handleThresholdAlpha();
                                    setPixelCleanPanelOpen(false);
                                    minimiseToolsAndFocus();
                                  }}
                                  className="flex items-center justify-center gap-1 rounded-md border border-[#CBD5E1] bg-[#F1F5F9] px-2 py-2 text-[11px] font-medium text-[#2563EB] disabled:opacity-40 coarse:min-h-[44px]"
                                >
                                  <Droplets className="h-3.5 w-3.5" />
                                  {t("editor.cleanAlphaSelected")}
                                </button>
                                <button
                                  type="button"
                                  disabled={designs.length === 0}
                                  onClick={() => {
                                    handleThresholdAlphaAll();
                                    setPixelCleanPanelOpen(false);
                                    minimiseToolsAndFocus();
                                  }}
                                  className="flex items-center justify-center gap-1 rounded-md border border-[#CBD5E1] bg-[#F1F5F9] px-2 py-2 text-[11px] font-medium text-[#2563EB] disabled:opacity-40 coarse:min-h-[44px]"
                                >
                                  <Droplets className="h-3.5 w-3.5" />
                                  {t("editor.cleanAlphaFullPage")}
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Inline below the grid, not the popover the desktop
                              uses: a popover anchored inside a sheet that owns
                              its own scroll is clipped by it, and there is no
                              room above to escape into. Outside the grid so the
                              closed panel is two rows of buttons and nothing
                              else — sideways that is the difference between the
                              whole set fitting and half of it being below the
                              fold. */}
                          {halftoneEnabled && halftoneMenuOpen && (selectedDesignId || selectedDesignIds.size > 0) && (
                            <div ref={halftonePanelRef} className="rounded-md border border-amber-200 bg-amber-50/60 p-1.5">
                                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-600">{t("editor.halftoneStrength")}</p>
                                  <div className="mb-1.5 flex gap-1">
                                    {([
                                      ["light", t("editor.halftoneLight")],
                                      ["balanced", t("editor.halftoneBalanced")],
                                      ["strong", t("editor.halftoneStrong")],
                                    ] as const).map(([s, label]) => (
                                      <button
                                        key={s}
                                        type="button"
                                        onClick={() => setHalftoneStrength(s)}
                                        aria-pressed={halftoneStrength === s}
                                        className={`flex-1 rounded border px-1 py-1 text-[11px] font-medium transition-colors coarse:min-h-[44px] ${halftoneStrength === s ? "border-amber-600 bg-amber-500 text-white" : "border-gray-200 bg-white text-gray-700 hover:bg-amber-50"}`}
                                      >
                                        {label}
                                      </button>
                                    ))}
                                  </div>
                                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-600">{t("editor.halftoneChooseGarment")}</p>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setHalftoneMenuOpen(false);
                                      const id = selectedDesignId ?? [...selectedDesignIds][0];
                                      if (id) handleApplyHalftone(id, 0, 0, 0, halftoneStrength);
                                      minimiseToolsAndFocus();
                                    }}
                                    className="mb-1 flex w-full items-center gap-2 rounded bg-gray-900 px-2 py-1.5 text-[11px] font-medium text-white hover:bg-gray-700 coarse:min-h-[44px]"
                                  >
                                    <span className="h-3.5 w-3.5 flex-shrink-0 rounded-full border border-gray-600 bg-black" />
                                    <span className="truncate">{t("editor.halftoneBlackGarment")}</span>
                                  </button>
                                  {halftoneTopColors.map((c, i) => (
                                    <button
                                      key={i}
                                      type="button"
                                      onClick={() => {
                                        setHalftoneMenuOpen(false);
                                        const id = selectedDesignId ?? [...selectedDesignIds][0];
                                        if (id) handleApplyHalftone(id, c.r, c.g, c.b, halftoneStrength);
                                        minimiseToolsAndFocus();
                                      }}
                                      className="flex w-full items-center gap-2 rounded px-2 py-1 text-[11px] hover:bg-white coarse:min-h-[44px]"
                                    >
                                      <span className="h-3.5 w-3.5 flex-shrink-0 rounded-full border border-gray-300" style={{ background: c.hex }} />
                                      <span className="truncate text-gray-700">{c.name ?? c.hex}</span>
                                    </button>
                                  ))}
                            </div>
                          )}

                        </>
                      )}
                    </>
                  )}
                </MobileToolSheet>
              </div>

            {/* Action bar. Everything here changes the sheet; the view bar at
                the top changes only how you are looking at it. Undo and Redo
                were here until they were given labels and moved up there, which
                is also what left this row the width for Auto-Arrange to keep
                its name. */}
            <div className="flex flex-shrink-0 flex-nowrap items-center justify-start gap-1.5 overflow-x-auto border-t border-gray-200 bg-white px-2 py-0" data-testid="mobile-persistent-bar">
              {/* Leftmost because it is the only route to the layers list and
                  Add Designs; if a longer translation makes this row scroll,
                  the control that must never be the one out of reach is this
                  one. It carries the word "Layers" (asked for explicitly) —
                  the row scrolls sideways, so the label costs reach for the
                  rightmost controls, never fit for this one. */}
              <button
                type="button"
                onClick={() => { setLayersOpen((v) => !v); setDesignToolsOpen(false); }}
                className={`relative flex min-h-[36px] flex-shrink-0 items-center gap-1 whitespace-nowrap rounded border px-2 text-[12px] font-semibold transition-colors coarse:min-h-[44px] ${layersOpen ? "border-cyan-600 bg-cyan-500 text-white" : "border-gray-300 bg-white text-gray-600 hover:bg-gray-100 hover:text-gray-900"}`}
                title={layersOpen ? t("editor.closeLayers") : t("editor.openLayers")}
                aria-label={layersOpen ? t("editor.closeLayers") : t("editor.openLayers")}
                aria-expanded={layersOpen}
                data-testid="mobile-layers-toggle"
              >
                <Layers className="h-4 w-4 flex-shrink-0" />
                {t("editor.layers")}
                {designs.length > 0 && (
                  <span className={`pointer-events-none absolute -right-1 -top-1 min-w-[16px] rounded-full px-1 text-[10px] font-bold leading-4 tabular-nums ${layersOpen ? "bg-white text-cyan-700" : "bg-cyan-500 text-white"}`}>
                    {designs.length}
                  </span>
                )}
              </button>
              <button onClick={() => { if (selectedDesignIds.size > 1) handleDeleteMulti(selectedDesignIds); else if (selectedDesignId) handleDeleteDesign(selectedDesignId); }} disabled={!selectedDesignId} className="h-8 w-8 flex-shrink-0 rounded border border-red-200 bg-white text-red-500 transition-colors hover:bg-red-50 hover:text-red-600 disabled:pointer-events-none disabled:opacity-30 coarse:h-11 coarse:w-11" title={t("editor.delete")}><Trash2 className="mx-auto h-4 w-4" /></button>
              {/* Labelled, and holding the slot Auto-Arrange used to. Everything
                  that changes how a design looks is behind this one button, so
                  an icon alone asked the customer to guess; Auto-Arrange gave up
                  the name because imports and copy-count changes already arrange
                  as they land, which makes pressing it the exception. It moved
                  into the list this opens.

                  The name is only there while the slot to its right is empty.
                  Once a tool is in play that slot holds the wand's tolerance,
                  readout and off switch, and the two together do not fit a
                  360px phone — the off switch was the part that fell off the
                  end, which is the worst possible thing to lose. Dropping to an
                  icon buys back ~60px, and it is only ever the second label on
                  the row: whatever took the slot is named there instead. */}
              <button
                type="button"
                onClick={() => { setDesignToolsOpen((v) => !v); setLayersOpen(false); }}
                className={`flex flex-shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border text-[12px] font-semibold transition-colors ${activeToolShown ? "h-8 w-8 coarse:h-11 coarse:w-11" : "min-h-[36px] px-2 py-1 coarse:min-h-[44px]"} ${designToolsOpen ? "border-violet-700 bg-gradient-to-r from-violet-700 to-fuchsia-700 text-white shadow-md shadow-violet-500/30" : "border-violet-600 bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-md shadow-violet-500/25 hover:from-violet-600 hover:to-fuchsia-600"}`}
                title={t("editor.designTools")}
                /* Carried explicitly because the visible name goes away above. */
                aria-label={t("editor.designTools")}
                aria-expanded={designToolsOpen}
                data-testid="mobile-design-tools-toggle"
              >
                <SlidersHorizontal className={activeToolShown ? "h-4 w-4 flex-shrink-0" : "h-3.5 w-3.5 flex-shrink-0"} />
                {!activeToolShown && t("editor.designTools")}
              </button>

              {/* Whatever tool the customer is in the middle of.
                  
                  The wand takes it whenever it is armed, because it is a mode
                  rather than an edit: it stays on until switched off, and its
                  tolerance is the thing you adjust between taps. Otherwise the
                  slot offers the last tool again, which is how a sheet actually
                  gets cleaned up — the same tool over one design after another,
                  which used to mean reopening the sheet every time. Switching the
                  wand off leaves it here too, so re-arming it on the next design
                  is one tap.

                  This is the only off switch for the wand outside the sheet, and
                  deliberately not on the Design tools button itself: that button
                  opens and closes a panel and should not also cancel what the
                  panel started. */}
              {wandDeleteModeActive ? (
                <div className="flex min-h-[36px] flex-shrink-0 items-center gap-1 rounded-md border border-fuchsia-400 bg-fuchsia-50 pl-1.5 pr-1 coarse:min-h-[44px]" data-testid="mobile-active-tool">
                  <WandSparkles className="h-3.5 w-3.5 flex-shrink-0 text-fuchsia-600" aria-hidden="true" />
                  {/* Deliberately stubby. Four controls plus a label have to share
                      what is left of 390px after Layers, Delete and Design tools,
                      and of the four this is the one that degrades gracefully:
                      tolerance is a coarse setting with a live readout beside it
                      and the full-width slider still in the sheet. Letting it have
                      the room it wants pushed Turn off past the right edge, and
                      the way out of a mode is the last thing that should need a
                      sideways scroll to reach. */}
                  <input
                    type="range"
                    min="1"
                    max="100"
                    value={wandTolerance}
                    onChange={(e) => setWandTolerance(Number(e.target.value))}
                    className="w-12 flex-shrink-0 accent-fuchsia-600"
                    aria-label={t("editor.wandTolerance")}
                    title={t("editor.wandTolerance")}
                  />
                  <span className="w-5 flex-shrink-0 text-right text-[11px] font-semibold tabular-nums text-fuchsia-800">{wandTolerance}</span>
                  <button
                    type="button"
                    onClick={handleWandDeleteToggle}
                    className="flex-shrink-0 rounded bg-fuchsia-600 px-1.5 py-1 text-[11px] font-bold text-white transition-colors hover:bg-fuchsia-700 coarse:min-h-[36px]"
                    title={t("editor.wandTurnOff")}
                  >
                    {t("editor.wandTurnOff")}
                  </button>
                </div>
              ) : lastTool ? (
                <button
                  type="button"
                  onClick={() => runTool(lastTool)}
                  disabled={lastTool.disabled}
                  className={`flex min-h-[36px] flex-shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border px-2 py-1 text-[12px] font-semibold transition-colors disabled:pointer-events-none disabled:opacity-30 coarse:min-h-[44px] ${lastTool.pillTone}`}
                  title={t("editor.applyAgain", { tool: lastTool.label })}
                  data-testid="mobile-active-tool"
                >
                  <lastTool.Icon className="h-3.5 w-3.5 flex-shrink-0" />
                  {lastTool.label}
                </button>
              ) : null}
            </div>
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
            {/* Undo/redo pinned to the canvas's top-right corner so they sit
                in the same spot no matter how the toolbar wraps. The wrapper
                ignores pointer events so it never steals canvas clicks; only
                the buttons themselves are interactive. */}
            {/* z-50 keeps the pair above the canvas rulers/scrollbars and
                selection overlays; the right inset clears the vertical
                scrollbar's hit zone. */}
            <div className="pointer-events-none absolute right-5 top-3 z-50 flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleUndo}
                disabled={!canUndo()}
                className="pointer-events-auto flex h-10 w-11 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-700 shadow-md transition-colors hover:bg-gray-100 hover:text-black disabled:opacity-30 disabled:pointer-events-none"
                title={t("editor.undo")}
                aria-label={t("editor.undo")}
              >
                <Undo2 className="h-5 w-5" strokeWidth={2.5} />
              </button>
              <button
                type="button"
                onClick={handleRedo}
                disabled={!canRedo()}
                className="pointer-events-auto flex h-10 w-11 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-700 shadow-md transition-colors hover:bg-gray-100 hover:text-black disabled:opacity-30 disabled:pointer-events-none"
                title={t("editor.redo")}
                aria-label={t("editor.redo")}
              >
                <Redo2 className="h-5 w-5" strokeWidth={2.5} />
              </button>
            </div>
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
            { icon: Copy, label: t("editor.duplicateArrange") + (duplicateCount > 1 ? ` (${duplicateCount})` : ""), shortcut: '', action: () => { handleDuplicateAndArrange(duplicateCount); setContextMenu(null); }, disabled: false },
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

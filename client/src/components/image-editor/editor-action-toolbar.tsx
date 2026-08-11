import { useState, memo, useEffect, useRef } from "react";
import SizeInput from "./size-input";
import {
  ArrowDownLeft,
  ArrowDownRight,
  ArrowUpLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Copy,
  Droplets,
  Eraser,
  Grid2x2Plus,
  SlidersHorizontal,
  Sparkles,
  LayoutGrid,
  Link,
  Loader2,
  RotateCw,
  ShoppingCart,
  Trash2,
  Unlink,
  WandSparkles,
} from "lucide-react";
import { CenterHorizontalIcon, CenterVerticalIcon } from "./center-axis-icons";
import { HalftoneIcon } from "./halftone-icon";
import { useWandTolerance, useToolActions } from "@/state/tool-store";
import { formatLength, getUnitSuffix, useMetric } from "@/lib/format-length";
import { formatVariantPriceForDisplay } from "@/lib/variant-price";
import type { ProfileConfig } from "@/lib/profiles";
import type { HalftoneStrength, ImageInfo, ImageTransform, ResizeSettings } from "@/lib/types";
import type { PreparedRaster } from "@/lib/prepare-raster-upload";
import { UPSCALE_FACTORS, type UpscaleFactor } from "@/lib/upscale-manager";

export type EditorActionToolbarProps = {
  t: (key: string, vars?: Record<string, string | number>) => string;
  lang: "en" | "es" | "fr";
  embedFromShopify?: boolean;
  isUploading: boolean;
  activeImageInfo: ImageInfo | null;
  handleFileUploadUnified: (
    file: File,
    image: HTMLImageElement | null,
    opts?: { prepared?: PreparedRaster },
  ) => Promise<void>;
  handleBatchStart: (fileCount: number) => void;
  selectedDesignId: string | null;
  selectedDesignIds: Set<string>;
  designs: { id: string }[];
  handleThresholdAlpha: () => void;
  handleThresholdAlphaAll: () => void;
  handleAutoArrange: (opts?: { skipSnapshot?: boolean; preserveSelection?: boolean; fullRepack?: boolean }) => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  handleUndo: () => void;
  handleRedo: () => void;
  duplicateCount: number;
  setDuplicateCount: React.Dispatch<React.SetStateAction<number>>;
  parseDuplicateCount: (raw: string) => number;
  handleDuplicateCountKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  clampDuplicateCount: (value: number) => number;
  handleDuplicateDesign: (count?: number) => void;
  handleDeleteDesign: (id: string) => void;
  handleDeleteMulti: (ids: Set<string>) => void;
  handleDuplicateAndArrange: (count: number) => void;
  canFill: boolean;
  handleFillEmptySpace: () => void;
  designGap: number | undefined;
  setDesignGap: (v: number | undefined) => void;
  handleAutoArrangeRef: React.MutableRefObject<(opts?: { skipSnapshot?: boolean; preserveSelection?: boolean; fullRepack?: boolean }) => void>;
  artboardWidth: number;
  artboardHeight: number;
  setArtboardWidth: (v: number) => void;
  setArtboardHeight: (v: number) => void;
  proportionalLock: boolean;
  setProportionalLock: React.Dispatch<React.SetStateAction<boolean>>;
  activeResizeSettings: ResizeSettings;
  activeDesignTransform: ImageTransform;
  effectiveDPI: number;
  handleEffectiveSizeChange: (axis: "width" | "height", value: number) => void;
  handleRotate90: () => void;
  handleSetRotation: (degrees: number) => void;
  handleAlignAxis: (axis: "horizontal" | "vertical") => void;
  handleAlignCorner: (corner: "tl" | "tr" | "bl" | "br") => void;
  isMobile: boolean;
  isLgUp: boolean;
  selectedVariantPrice: string | null;
  GANGSHEET_HEIGHTS: number[];
  recommendedArtboardHeight: number | null;
  profile: ProfileConfig;
  onAddToCart?: () => void;
  hasVariantId?: boolean;
  isEditMode?: boolean;
  isAddingToCart?: boolean;
  isProcessing?: boolean;
  exportProgressLabel?: string;
  handleIncreaseQuality: (scaleFactor: number) => Promise<void>;
  isUpscaling: boolean;
  /** 0..1 while an upscale runs, `null` otherwise. */
  upscaleProgress: number | null;
  /**
   * Whether to render the upscale control at all. Gated on
   * `detectUpscaleSupport()` so an unusable backend produces no button rather
   * than a permanently greyed one — see `client/src/lib/upscale-support.ts`.
   */
  canIncreaseQuality: boolean;
  /**
   * Desktop "Design tools" cluster (White BG / Magic Wand / Halftone), which
   * replaced the sidebar cards those tools used to occupy. Optional because
   * the provider's prop bag predates them — the view passes them explicitly
   * at the render site.
   */
  handleRemoveWhiteBackground?: () => void;
  wandDeleteActive?: boolean;
  handleWandDeleteToggle?: () => void;
  halftoneEnabled?: boolean;
  handleOpenHalftoneMenu?: () => void;
  halftoneMenuOpen?: boolean;
  setHalftoneMenuOpen?: (open: boolean) => void;
  halftoneStrength?: HalftoneStrength;
  setHalftoneStrength?: (strength: HalftoneStrength) => void;
  halftoneTopColors?: Array<{ hex: string; name?: string; r: number; g: number; b: number }>;
  handleApplyHalftone?: (designId: string, r: number, g: number, b: number, strength: HalftoneStrength) => void;
};

function EditorActionToolbar(props: EditorActionToolbarProps) {
  const {
    t,
    lang,
    embedFromShopify,
    isUploading,
    activeImageInfo,
    handleFileUploadUnified,
    handleBatchStart,
    selectedDesignId,
    selectedDesignIds,
    designs,
    handleThresholdAlpha,
    handleThresholdAlphaAll,
    handleAutoArrange,
    canUndo,
    canRedo,
    handleUndo,
    handleRedo,
    duplicateCount,
    setDuplicateCount,
    parseDuplicateCount,
    handleDuplicateCountKeyDown,
    clampDuplicateCount,
    handleDuplicateDesign,
    handleDeleteDesign,
    handleDeleteMulti,
    handleDuplicateAndArrange,
    canFill,
    handleFillEmptySpace,
    designGap,
    setDesignGap,
    handleAutoArrangeRef,
    artboardWidth,
    artboardHeight,
    setArtboardWidth,
    setArtboardHeight,
    proportionalLock,
    setProportionalLock,
    activeResizeSettings,
    activeDesignTransform,
    effectiveDPI,
    handleEffectiveSizeChange,
    handleRotate90,
    handleSetRotation,
    handleAlignAxis,
    handleAlignCorner,
    isMobile,
    isLgUp,
    selectedVariantPrice,
    GANGSHEET_HEIGHTS,
    recommendedArtboardHeight,
    profile,
    onAddToCart,
    hasVariantId,
    isEditMode,
    isAddingToCart,
    isProcessing,
    exportProgressLabel,
    handleIncreaseQuality,
    isUpscaling,
    upscaleProgress,
    canIncreaseQuality,
    handleRemoveWhiteBackground,
    wandDeleteActive = false,
    handleWandDeleteToggle,
    halftoneEnabled = false,
    handleOpenHalftoneMenu,
    halftoneMenuOpen = false,
    setHalftoneMenuOpen,
    halftoneStrength = "balanced",
    setHalftoneStrength,
    halftoneTopColors = [],
    handleApplyHalftone,
  } = props;
  const metric = useMetric(lang);
  const maxGangsheetHeight = GANGSHEET_HEIGHTS.length > 0
    ? Math.max(...GANGSHEET_HEIGHTS)
    : artboardHeight;
  const canAddToCart = !!activeImageInfo || designs.length > 0;
  const cartButtonDisabled = !!isProcessing || !canAddToCart;
  const cartButtonBusy = !!isAddingToCart || !!isProcessing;
  const cartButtonLabel = !canAddToCart
    ? t("controls.addToCart")
    : isAddingToCart
       ? (exportProgressLabel || t("controls.addingToCart"))
      : isProcessing
        ? (exportProgressLabel || t("editor.processing"))
        : t("controls.addToCart");
  const cartButtonTitle = !canAddToCart ? t("controls.uploadFirst") : cartButtonLabel;
  const [upscaleScale, setUpscaleScale] = useState<UpscaleFactor>(2);
  const [alignRotateOpen, setAlignRotateOpen] = useState(false);
  const [designToolsOpen, setDesignToolsOpen] = useState(false);
  /** The tool last picked from the Design tools dropdown, offered again as a pill — same idea as the phone bar. */
  const [lastDesignToolId, setLastDesignToolId] = useState<"cleanSelected" | "cleanAll" | "whiteBg" | "wand" | "halftone" | null>(null);
  const alignRotateRef = useRef<HTMLDivElement>(null);
  const designToolsRef = useRef<HTMLDivElement>(null);
  // Wand tolerance lives in the Zustand tool store (not props) so slider
  // ticks stay out of the editor bag — same subscription the sidebar card
  // used before it moved here.
  const wandTolerance = useWandTolerance();
  const { setWandTolerance } = useToolActions();

  /** Mirrors the phone's Design-tools list for the three tools that moved off
   *  the sidebar, plus the two Pixel Clean actions that moved out of their own
   *  Row-1 dropdown. */
  const desktopDesignTools = [
    {
      id: "cleanSelected" as const,
      label: t("editor.cleanAlphaSelected"),
      title: t("editor.cleanAlphaTitle"),
      Icon: Droplets,
      menuTone: "text-[#2563EB]",
      pillTone: "border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100",
      disabled: !selectedDesignId && selectedDesignIds.size === 0,
      run: () => { handleThresholdAlpha(); },
    },
    {
      id: "cleanAll" as const,
      label: t("editor.cleanAlphaFullPage"),
      title: t("editor.cleanAlphaTitle"),
      Icon: Droplets,
      menuTone: "text-[#2563EB]",
      pillTone: "border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100",
      disabled: designs.length === 0,
      run: () => { handleThresholdAlphaAll(); },
    },
    {
      id: "whiteBg" as const,
      label: t("editor.whiteBg"),
      title: t("editor.whiteBgTitle"),
      Icon: Eraser,
      menuTone: "text-amber-700",
      pillTone: "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100",
      disabled: !selectedDesignId,
      run: () => { handleRemoveWhiteBackground?.(); },
    },
    {
      id: "wand" as const,
      label: t("editor.magicWand"),
      title: t("editor.magicWandTitle"),
      Icon: WandSparkles,
      menuTone: "text-fuchsia-600",
      pillTone: "border-fuchsia-300 bg-fuchsia-50 text-fuchsia-700 hover:bg-fuchsia-100",
      disabled: !selectedDesignId,
      run: () => { handleWandDeleteToggle?.(); },
    },
    ...(halftoneEnabled
      ? [{
          id: "halftone" as const,
          label: t("editor.halftone"),
          title: t("editor.halftoneTitle"),
          Icon: HalftoneIcon,
          menuTone: "text-amber-700",
          pillTone: "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100",
          disabled: !selectedDesignId && selectedDesignIds.size === 0,
          run: () => { handleOpenHalftoneMenu?.(); },
        }]
      : []),
  ];
  const lastDesignTool = lastDesignToolId
    ? desktopDesignTools.find((tool) => tool.id === lastDesignToolId) ?? null
    : null;

  // Close any chooser on outside click or Escape; they are mutually
  // exclusive so opening one closes the others. The Design tools cluster
  // also anchors the halftone options panel, whose open flag lives in
  // editor state (`halftoneMenuOpen`) because the phone sheet renders the
  // same panel from it.
  useEffect(() => {
    if (!alignRotateOpen && !designToolsOpen && !halftoneMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (alignRotateOpen && alignRotateRef.current && !alignRotateRef.current.contains(target)) {
        setAlignRotateOpen(false);
      }
      if (designToolsRef.current && !designToolsRef.current.contains(target)) {
        if (designToolsOpen) setDesignToolsOpen(false);
        if (halftoneMenuOpen) setHalftoneMenuOpen?.(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAlignRotateOpen(false);
        setDesignToolsOpen(false);
        if (halftoneMenuOpen) setHalftoneMenuOpen?.(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [alignRotateOpen, designToolsOpen, halftoneMenuOpen, setHalftoneMenuOpen]);

  return (
    <>
  {/* Top bar: three rows on mobile, wraps on desktop when metric to avoid overlap */}
   <div className="flex-shrink-0 flex flex-col lg:flex-row lg:flex-wrap lg:items-center gap-2 bg-white border-b border-gray-200 px-2 py-2 lg:px-3 lg:py-2">
    {/* Row 1: Increase Quality, Delete, Cart. Upload lives in the sidebar,
        undo/redo float over the canvas, and the duplicate cluster rides
        Row 2 beside Auto-Arrange. */}
    <div className="flex items-center gap-1.5 lg:gap-2 min-w-0 flex-wrap flex-shrink-0 lg:basis-full lg:flex-nowrap lg:items-start">
      <div className="contents lg:flex lg:flex-1 lg:min-w-0 lg:flex-wrap lg:items-center lg:gap-2">
      {/* Wraps at lg because a narrow landscape tablet (1024px) leaves this row
          about 30px short of holding both button groups, and the toolbar clips
          rather than scrolls — "Duplicate & Arrange" was being cut in half. */}
      <div className="flex flex-col gap-1 lg:flex-row lg:flex-wrap lg:gap-1 flex-shrink-0 lg:shrink lg:min-w-0 ml-auto lg:ml-0">
        <div className="flex items-center gap-1">
          {canIncreaseQuality && (
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => void handleIncreaseQuality(upscaleScale)}
              disabled={!selectedDesignId || isUpscaling}
              className={`flex items-center gap-1.5 rounded-l-md border px-2 py-1 lg:px-3 lg:py-2 text-[11px] lg:text-sm font-medium shadow-sm min-h-[36px] ${
                selectedDesignId && !isUpscaling
                  ? 'border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100'
                  : 'border-gray-200 bg-gray-200 text-gray-500 opacity-50'
              }`}
              title={t("editor.increaseQualityTitle")}
            >
              {isUpscaling ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3 lg:h-4 lg:w-4" />}
              {isUpscaling
                ? (upscaleProgress != null
                    ? t("editor.increasingQualityProgress", { percent: Math.round(upscaleProgress * 100) })
                    : t("editor.increasingQuality"))
                : t("editor.increaseQuality")}
            </button>
            <select
              aria-label={t("editor.increaseQualityScale")}
              value={upscaleScale}
              onChange={event => setUpscaleScale(Number(event.target.value) as UpscaleFactor)}
              disabled={isUpscaling}
              className="h-9 rounded-r-md border border-l-0 border-violet-300 bg-white px-1 text-[11px] font-bold text-violet-700 outline-none disabled:opacity-50"
            >
              {UPSCALE_FACTORS.map(factor => (
                <option key={factor} value={factor}>{factor}×</option>
              ))}
            </select>
          </div>
          )}
        </div>
      </div>
      <div className="flex min-w-0 items-center justify-end gap-0.5 flex-wrap">
        <button
          onClick={() => {
            if (selectedDesignIds.size > 1) {
              handleDeleteMulti(selectedDesignIds);
            } else if (selectedDesignId) {
              handleDeleteDesign(selectedDesignId);
            }
          }}
          disabled={!selectedDesignId}
          className="w-8 h-8 lg:w-10 lg:h-10 rounded-md hover:bg-gray-200/80 text-red-500 hover:text-red-600 transition-colors disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center"
          title={t("editor.delete")}
        >
          <Trash2 className="w-4 h-4 lg:w-5 lg:h-5" />
        </button>
        {isMobile && (
          <button
            onClick={() => handleAutoArrange({ preserveSelection: selectedDesignIds.size >= 2, fullRepack: true })}
            disabled={designs.length < 2 && selectedDesignIds.size < 2}
            className={`flex items-center gap-1 px-2 py-1 rounded-md transition-all whitespace-nowrap font-semibold shadow-sm min-h-[36px] ${lang !== 'en' ? 'text-[11px]' : 'text-[12px]'} ml-auto ${
              designs.length >= 2 || selectedDesignIds.size >= 2
                ? 'bg-pink-500 hover:bg-pink-600 text-black border border-pink-600 shadow-md shadow-pink-500/25'
                : 'bg-gray-200 text-gray-500 opacity-30 pointer-events-none'
            }`}
            title={selectedDesignIds.size >= 2 ? t("editor.autoArrangeSelected") : t("editor.autoArrangeAll")}
          >
            <LayoutGrid className="w-3 h-3 flex-shrink-0" />
            {t("editor.autoArrange")}
          </button>
        )}
      </div>
      </div>
      {isLgUp && ((!isEditMode && hasVariantId && onAddToCart) || selectedVariantPrice != null) && (
        <div className="flex flex-shrink-0 items-center gap-0.5 lg:gap-1">
          {!isEditMode && hasVariantId && onAddToCart && (
            <>
              <div className="w-px h-4 bg-gray-200 mx-0.5 flex-shrink-0" aria-hidden />
              <button
                onClick={onAddToCart}
                disabled={cartButtonDisabled}
                className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-gradient-to-r from-emerald-500 to-green-600 px-2.5 py-1.5 text-[11px] font-semibold text-white shadow-sm transition-all hover:from-emerald-600 hover:to-green-700 disabled:pointer-events-none disabled:opacity-50 lg:text-xs"
                title={cartButtonTitle}
              >
                {cartButtonBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShoppingCart className="h-3.5 w-3.5" />
                )}
                <span>{cartButtonLabel}</span>
              </button>
            </>
          )}
          {selectedVariantPrice != null && (
            <span className="shrink-0 whitespace-nowrap rounded-full border border-emerald-600 bg-white px-2 py-0.5 text-[11px] font-bold leading-none text-emerald-600 tabular-nums lg:text-xs">
              {formatVariantPriceForDisplay(selectedVariantPrice)}
            </span>
          )}
        </div>
      )}
    </div>
    {/* Row 2: Size, DPI, Duplicate, Auto-Arrange + Margin, Rotate/Align,
        Design tools — always on its own line */}
    <div className="flex items-center gap-1.5 lg:gap-2 flex-wrap lg:basis-full">
      {activeImageInfo && (
        <>
          <div className="w-px h-5 bg-gray-100 flex-shrink-0 hidden lg:block" />
          <div className="flex items-center gap-1.5 min-w-0 flex-shrink-0">
            {/*
              Sizing panel.

              The W/H controls sit on a filled cyan panel rather than bare on
              the toolbar. This replaced a transient "← Click to resize" hint
              that pulsed for five seconds after the first upload: the hint
              only taught the control once, and only to whoever happened to
              look within that window. A permanent tinted panel behind the
              white inputs makes them the highest-contrast thing in the row,
              so the control is findable at any time without any copy.

              Purely presentational — the inputs, the proportional lock, and
              their commit handlers are untouched.
            */}
            <div className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border-2 border-cyan-500 bg-cyan-100 px-2 py-1 shadow-sm">
              <span className="text-[13px] font-bold leading-none tracking-tight text-cyan-900">{t("editor.size")}</span>
              {selectedDesignIds.size > 1 && (
                <span className="flex-shrink-0 rounded-full border border-cyan-500 bg-white px-1 py-px text-[9px] font-bold tabular-nums text-cyan-700" title={t("editor.resizeAppliesToAll", { count: selectedDesignIds.size })}>
                  ×{selectedDesignIds.size}
                </span>
              )}
              <div className="flex items-center gap-0.5 flex-shrink-0 flex-wrap">
                <span className="text-[12px] font-bold leading-none text-cyan-900">W</span>
                <SizeInput
                  value={activeResizeSettings.widthInches * activeDesignTransform.s}
                  onCommit={(v) => handleEffectiveSizeChange("width", v)}
                  title={useMetric(lang) ? t("editor.widthTitleCm") : t("editor.widthTitle")}
                  max={artboardWidth}
                  lang={lang}
                />
                <span className={`font-semibold text-cyan-900 ${lang === 'en' ? 'text-[11px]' : 'text-[10px]'}`}>{getUnitSuffix(activeResizeSettings.widthInches * activeDesignTransform.s, lang)}</span>
                <button
                  onClick={() => setProportionalLock(prev => !prev)}
                  className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${proportionalLock ? 'bg-white text-cyan-600 shadow-sm hover:bg-cyan-50' : 'text-cyan-700/70 hover:bg-white/70 hover:text-cyan-800'}`}
                  title={proportionalLock ? t("editor.proportionsLocked") : t("editor.proportionsUnlocked")}
                >
                  {proportionalLock ? <Link className="h-3.5 w-3.5" /> : <Unlink className="h-3.5 w-3.5" />}
                </button>
                <span className="text-[12px] font-bold leading-none text-cyan-900">H</span>
                <SizeInput
                  value={activeResizeSettings.heightInches * activeDesignTransform.s}
                  onCommit={(v) => handleEffectiveSizeChange("height", v)}
                  title={useMetric(lang) ? t("editor.heightTitleCm") : t("editor.heightTitle")}
                  max={maxGangsheetHeight}
                  lang={lang}
                />
                <span className={`font-semibold text-cyan-900 ${lang === 'en' ? 'text-[11px]' : 'text-[10px]'}`}>{getUnitSuffix(activeResizeSettings.heightInches * activeDesignTransform.s, lang)}</span>
              </div>
            </div>
            <span
              className={`text-[11px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 inline-flex items-center gap-1.5 ${
                effectiveDPI < 198
                  ? 'text-amber-600 bg-amber-100 border border-amber-400'
                  : effectiveDPI < 277
                    ? 'text-amber-600 bg-amber-100 border border-amber-400'
                    : 'text-emerald-600 bg-emerald-100 border border-emerald-700'
              }`}
              title={t("editor.effectiveRes", { dpi: effectiveDPI })}
            >
              <span>{effectiveDPI} DPI</span>
              <span className="text-[10px] font-medium opacity-90 hidden sm:inline">
                {effectiveDPI < 198 ? 'Low Res' : effectiveDPI < 277 ? 'Okay to print' : 'Excellent'}
              </span>
            </span>
          </div>
          {isMobile && (
            <div className="flex items-center gap-1 ml-auto">
              <button
                onClick={() => handleDuplicateDesign(duplicateCount)}
                disabled={!selectedDesignId}
                className={`flex items-center gap-1 px-2 py-1 rounded-md transition-all whitespace-nowrap text-[11px] font-medium shadow-sm min-h-[36px] ${
                  selectedDesignId
                    ? 'bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#7C3AED] border border-[#CBD5E1] shadow-none'
                    : 'bg-gray-200 text-gray-500 opacity-30 pointer-events-none'
                }`}
                title={t("editor.duplicate")}
              >
                <Copy className="w-3 h-3" />
                {t("editor.duplicate").replace(/ \(.*/, '')}
              </button>
            <div className="relative w-10 h-[32px] rounded border border-gray-300 bg-white overflow-hidden focus-within:border-cyan-500">
                <input
                  type="text"
                  inputMode="numeric"
                  value={duplicateCount}
                  onChange={(e) => setDuplicateCount(parseDuplicateCount(e.target.value))}
                  onKeyDown={handleDuplicateCountKeyDown}
                  disabled={!selectedDesignId}
                  className="w-full h-full text-center text-[11px] leading-none p-0 pr-3 bg-white outline-none disabled:opacity-30 disabled:pointer-events-none"
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
                className={`flex items-center gap-1 px-2 py-1 rounded-md transition-all whitespace-nowrap text-[10px] font-medium shadow-sm min-h-[36px] ${
                  selectedDesignId
                    ? 'bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#0891B2] border border-[#CBD5E1] shadow-none'
                    : 'bg-gray-200 text-gray-500 opacity-30 pointer-events-none'
                }`}
                title={t("editor.duplicateArrangeTitle")}
              >
                <Copy className="w-3 h-3" />
                {t("editor.duplicateArrange")}
              </button>
              <button
                onClick={handleFillEmptySpace}
                disabled={!canFill}
                className={`flex items-center gap-1 px-2 py-1 rounded-md transition-all whitespace-nowrap text-[10px] font-medium shadow-sm min-h-[36px] ${
                  canFill
                    ? 'bg-emerald-500 hover:bg-emerald-600 text-white border border-emerald-600'
                    : 'bg-gray-200 text-gray-500 opacity-30 pointer-events-none'
                }`}
                title={t("editor.fillSheetTitle")}
              >
                <Grid2x2Plus className="w-3 h-3" />
                {t("editor.fillSheet")}
              </button>
            </div>
          )}
        </>
      )}
      {!isMobile && (
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          {/* Copies + Duplicate & Arrange moved down from Row 1 so duplication
              sits in the same row as Auto-Arrange. */}
          <div className="flex items-center gap-1">
            {/* `coarse:` sizing, not `lg:`, because a tablet renders this desktop
                arm on a touch screen. 16px is the threshold below which iOS
                Safari zooms the page in on focus, and the widget has to widen to
                hold three digits at that size without clipping.

                The height needs `!`: Tailwind emits custom variants ahead of the
                responsive ones, so `lg:h-[24px]` would otherwise win on a tablet
                and leave a 24px target under a 16px input. */}
            <div className="relative w-10 coarse:w-16 h-[28px] lg:h-[24px] coarse:!h-11 rounded border border-gray-300 bg-white overflow-hidden focus-within:border-cyan-500">
              <input
                type="text"
                inputMode="numeric"
                value={duplicateCount}
                onChange={(e) => setDuplicateCount(parseDuplicateCount(e.target.value))}
                onKeyDown={handleDuplicateCountKeyDown}
                disabled={!selectedDesignId}
                className="w-full h-full text-center text-[11px] coarse:text-[16px] leading-none p-0 pr-3 coarse:pr-6 bg-white outline-none disabled:opacity-30 disabled:pointer-events-none"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                title="Number of copies"
              />
              <div className="absolute right-0 top-0 h-full w-3 coarse:w-6 border-l border-gray-300 overflow-hidden rounded-r">
                <button
                  type="button"
                  onClick={() => setDuplicateCount((prev) => clampDuplicateCount(prev + 1))}
                  disabled={!selectedDesignId || duplicateCount >= 99}
                  className="h-1/2 w-full flex items-center justify-center border-b border-gray-300 bg-gray-50 hover:bg-gray-100 disabled:opacity-30 disabled:pointer-events-none"
                  title="Increase copies"
                >
                  <ChevronUp className="w-2.5 h-2.5 coarse:w-4 coarse:h-4 text-gray-600" />
                </button>
                <button
                  type="button"
                  onClick={() => setDuplicateCount((prev) => clampDuplicateCount(prev - 1))}
                  disabled={!selectedDesignId || duplicateCount <= 1}
                  className="h-1/2 w-full flex items-center justify-center bg-gray-50 hover:bg-gray-100 disabled:opacity-30 disabled:pointer-events-none"
                  title="Decrease copies"
                >
                  <ChevronDown className="w-2.5 h-2.5 coarse:w-4 coarse:h-4 text-gray-600" />
                </button>
              </div>
            </div>
            <button
              onClick={() => handleDuplicateAndArrange(duplicateCount)}
              disabled={!selectedDesignId}
              className={`flex items-center gap-1 px-2 py-1 lg:px-4 lg:py-2 rounded-md transition-all whitespace-nowrap ${lang !== 'en' ? 'text-[11px] lg:text-sm' : 'text-[12px] lg:text-sm'} font-semibold shadow-sm min-h-[36px] coarse:min-h-[44px] ${
                selectedDesignId
                  ? 'bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#0891B2] border border-[#CBD5E1] shadow-none'
                  : 'bg-gray-200 text-gray-500 opacity-30 pointer-events-none'
              }`}
              title={t("editor.duplicateArrangeTitle")}
            >
              <Copy className="w-3 h-3 lg:w-4 lg:h-4" />
              {t("editor.duplicateArrange")}
            </button>
            {/* Fill Sheet rides in the duplication group: it is duplication,
                just "as many as fit" instead of a chosen count. Enabled with
                no selection too — it falls back to the smallest design. */}
            <button
              onClick={handleFillEmptySpace}
              disabled={!canFill}
              className={`flex items-center gap-1 px-2 py-1 lg:px-4 lg:py-2 rounded-md transition-all whitespace-nowrap ${lang !== 'en' ? 'text-[11px] lg:text-sm' : 'text-[12px] lg:text-sm'} font-semibold min-h-[36px] coarse:min-h-[44px] ${
                canFill
                  ? 'bg-emerald-500 hover:bg-emerald-600 text-white border border-emerald-600 shadow-md shadow-emerald-500/25'
                  : 'bg-gray-200 text-gray-500 opacity-30 pointer-events-none'
              }`}
              title={t("editor.fillSheetTitle")}
            >
              <Grid2x2Plus className="w-3 h-3 lg:w-4 lg:h-4 flex-shrink-0" />
              {t("editor.fillSheet")}
            </button>
          </div>
          <button
            onClick={() => handleAutoArrange({ preserveSelection: selectedDesignIds.size >= 2, fullRepack: true })}
            disabled={designs.length < 2 && selectedDesignIds.size < 2}
            className={`flex items-center gap-1 px-2 py-1 lg:px-4 lg:py-2 rounded-md transition-all whitespace-nowrap text-[11px] lg:text-sm font-medium min-h-[36px] coarse:min-h-[44px] ${
              designs.length >= 2 || selectedDesignIds.size >= 2
                ? 'bg-pink-500 hover:bg-pink-600 text-black border border-pink-600 shadow-md shadow-pink-500/25'
                : 'bg-gray-200 text-gray-500 opacity-30 pointer-events-none'
            }`}
            title={selectedDesignIds.size >= 2 ? t("editor.autoArrangeSelected") : t("editor.autoArrangeAll")}
          >
            <LayoutGrid className="w-3 h-3 lg:w-4 lg:h-4 flex-shrink-0" />
            {t("editor.autoArrange")}
          </button>
          {/* Margin rides with Auto-Arrange as one cluster: the label sits in
              a tiny caption over the dropdown instead of beside it, so the
              pair reads as a single compact control. */}
          {designs.length >= 2 && (
            <div className="flex flex-col items-center gap-0.5 flex-shrink-0">
              <span className="text-[9px] coarse:text-[10px] font-semibold uppercase tracking-wider leading-none text-gray-500">{t("editor.margin")}</span>
              <select
                value={designGap === undefined ? "auto" : String(designGap)}
                onChange={(e) => {
                  const v = e.target.value;
                  const newGap = v === "auto" ? undefined : parseFloat(v);
                  setDesignGap(newGap);
                  if (designs.length >= 2) {
                    setTimeout(() => handleAutoArrangeRef.current({ skipSnapshot: false, preserveSelection: true, fullRepack: true }), 0);
                  }
                }}
                className="h-7 coarse:h-11 px-1.5 coarse:px-2 bg-gray-100 border border-gray-300 rounded text-[11px] coarse:text-[16px] font-medium text-gray-800 outline-none cursor-pointer hover:border-gray-400 focus:border-cyan-500 transition-colors"
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
          {/* Align/Rotate — collapsed behind one control; it lives inside
              this same right-aligned cluster so it always sits beside
              Auto-Arrange no matter how the row wraps. */}
        {!isMobile && (
          <div className="relative flex items-center gap-1" ref={alignRotateRef}>
            <div className="w-px h-4 bg-gray-100 mx-0.5 hidden lg:block" />
            <button
              type="button"
              onClick={() => {
                setDesignToolsOpen(false);
                setHalftoneMenuOpen?.(false);
                setAlignRotateOpen((v) => !v);
              }}
              disabled={!selectedDesignId}
              aria-expanded={alignRotateOpen}
              aria-haspopup="true"
              className={`flex items-center gap-1.5 px-2 py-1 lg:px-3 lg:py-1.5 rounded-md border transition-all whitespace-nowrap text-[11px] lg:text-sm font-medium min-h-[36px] ${
                selectedDesignId
                  ? alignRotateOpen
                    ? "border-black bg-black text-white"
                    : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                  : "border-gray-200 bg-gray-200 text-gray-500 opacity-30 pointer-events-none"
              }`}
              title={t("editor.alignRotateTitle")}
            >
              <RotateCw className="w-3.5 h-3.5" />
              {t("editor.alignRotate")}
              <ChevronDown className={`w-3 h-3 transition-transform ${alignRotateOpen ? "rotate-180" : ""}`} />
            </button>
            {alignRotateOpen && selectedDesignId && (
              /* `right-0` + `w-max`: the trigger now sits at the toolbar's
                 right edge, so the panel grows leftwards to stay onscreen.
                 `w-max` matters — an absolute box otherwise shrinks to its
                 ~150px containing block and wraps into a tower. */
              <div className="absolute right-0 top-full z-50 mt-1 flex w-max max-w-[92vw] flex-wrap items-center gap-1.5 rounded-xl border-2 border-black bg-white p-2 shadow-lg">
                <button
                  onClick={handleRotate90}
                  className="w-10 h-10 lg:w-[30px] lg:h-[30px] rounded-lg lg:rounded-md border-2 border-black bg-black text-white hover:bg-white hover:text-black transition-colors flex items-center justify-center shadow-sm"
                  title={t("editor.rotate")}
                >
                  <RotateCw className="w-4 h-4 lg:w-3.5 lg:h-3.5" />
                </button>
                <div className="flex items-center gap-1.5 lg:gap-1 rounded-xl lg:rounded-lg border-2 border-black bg-white px-1.5 py-1 lg:px-1 lg:py-0.5 shadow-sm">
                  <span className="min-w-[48px] lg:min-w-[34px] rounded-lg lg:rounded-md border-2 border-black bg-white px-1.5 py-1 lg:px-1 lg:py-0.5 text-center text-[16px] lg:text-[12px] font-bold tabular-nums text-black">{Math.round(activeDesignTransform.rotation || 0)}°</span>
                  {[0, 90, 180, 270].map(deg => (
                    <button key={deg} onClick={() => handleSetRotation(deg)} className="flex h-9 min-w-10 lg:h-[30px] lg:min-w-7 items-center justify-center rounded-lg lg:rounded-md border border-black bg-white px-1.5 lg:px-1 text-[13px] lg:text-[11px] font-bold tabular-nums text-black hover:bg-black hover:text-white">
                      {deg}°
                    </button>
                  ))}
                </div>
                {/* Align cluster — same six buttons as before, still one group;
                    the axis icons stay custom (see `center-axis-icons.tsx`). */}
                <div className="flex items-center gap-0.5 lg:gap-px rounded-lg border-2 border-black bg-white px-1 py-0.5 lg:px-0.5 shadow-sm">
                  <button
                    onClick={() => handleAlignAxis("vertical")}
                    className="relative p-2 lg:p-1 rounded-md border border-black bg-white text-black hover:bg-black hover:text-white transition-colors min-w-[42px] min-h-[42px] lg:min-w-[30px] lg:min-h-[30px] flex items-center justify-center"
                    title={t("editor.alignCenterX")}
                    aria-label={t("editor.alignCenterX")}
                  >
                    <CenterHorizontalIcon className="w-5 h-5 lg:w-[18px] lg:h-[18px]" />
                  </button>
                  <button
                    onClick={() => handleAlignAxis("horizontal")}
                    className="relative p-2 lg:p-1 rounded-md border border-black bg-white text-black hover:bg-black hover:text-white transition-colors min-w-[42px] min-h-[42px] lg:min-w-[30px] lg:min-h-[30px] flex items-center justify-center"
                    title={t("editor.alignCenterY")}
                    aria-label={t("editor.alignCenterY")}
                  >
                    <CenterVerticalIcon className="w-5 h-5 lg:w-[18px] lg:h-[18px]" />
                  </button>
                  <div className="w-px h-6 lg:h-4 bg-gray-300 mx-0.5" />
                  <button
                    onClick={() => handleAlignCorner('tl')}
                    className="p-2 lg:p-1 rounded-md border border-black bg-white text-black hover:bg-black hover:text-white transition-colors min-w-[42px] min-h-[42px] lg:min-w-[30px] lg:min-h-[30px] flex items-center justify-center"
                    title={t("editor.alignTL")}
                    aria-label={t("editor.alignTL")}
                  >
                    <ArrowUpLeft className="w-4 h-4 lg:w-3.5 lg:h-3.5" />
                  </button>
                  <button
                    onClick={() => handleAlignCorner('tr')}
                    className="p-2 lg:p-1 rounded-md border border-black bg-white text-black hover:bg-black hover:text-white transition-colors min-w-[42px] min-h-[42px] lg:min-w-[30px] lg:min-h-[30px] flex items-center justify-center"
                    title={t("editor.alignTR")}
                    aria-label={t("editor.alignTR")}
                  >
                    <ArrowUpRight className="w-4 h-4 lg:w-3.5 lg:h-3.5" />
                  </button>
                  <button
                    onClick={() => handleAlignCorner('bl')}
                    className="p-2 lg:p-1 rounded-md border border-black bg-white text-black hover:bg-black hover:text-white transition-colors min-w-[42px] min-h-[42px] lg:min-w-[30px] lg:min-h-[30px] flex items-center justify-center"
                    title={t("editor.alignBL")}
                    aria-label={t("editor.alignBL")}
                  >
                    <ArrowDownLeft className="w-4 h-4 lg:w-3.5 lg:h-3.5" />
                  </button>
                  <button
                    onClick={() => handleAlignCorner('br')}
                    className="p-2 lg:p-1 rounded-md border border-black bg-white text-black hover:bg-black hover:text-white transition-colors min-w-[42px] min-h-[42px] lg:min-w-[30px] lg:min-h-[30px] flex items-center justify-center"
                    title={t("editor.alignBR")}
                    aria-label={t("editor.alignBR")}
                  >
                    <ArrowDownRight className="w-4 h-4 lg:w-3.5 lg:h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {/* Design tools — White BG / Magic Wand / Halftone behind one button,
            like the phone's Design tools sheet. The last-picked tool stays
            next to it as a pill; an armed wand takes the slot with its
            tolerance slider until it is turned off. */}
        {!isMobile && (
          <div className="relative flex items-center gap-1" ref={designToolsRef}>
            <div className="w-px h-4 bg-gray-100 mx-0.5 hidden lg:block" />
            <button
              type="button"
              onClick={() => {
                setAlignRotateOpen(false);
                setHalftoneMenuOpen?.(false);
                setDesignToolsOpen((v) => !v);
              }}
              disabled={designs.length === 0}
              aria-expanded={designToolsOpen}
              aria-haspopup="menu"
              className={`flex items-center gap-1.5 px-2 py-1 lg:px-3 lg:py-1.5 rounded-md border transition-all whitespace-nowrap text-[11px] lg:text-sm font-semibold min-h-[36px] coarse:min-h-[44px] ${
                designs.length > 0
                  ? designToolsOpen
                    ? "border-violet-700 bg-gradient-to-r from-violet-700 to-fuchsia-700 text-white shadow-md shadow-violet-500/30"
                    : "border-violet-600 bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-md shadow-violet-500/25 hover:from-violet-600 hover:to-fuchsia-600"
                  : "border-gray-200 bg-gray-200 text-gray-500 opacity-30 pointer-events-none"
              }`}
              title={t("editor.designTools")}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              {t("editor.designTools")}
              <ChevronDown className={`w-3 h-3 transition-transform ${designToolsOpen ? "rotate-180" : ""}`} />
            </button>
            {designToolsOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full z-50 mt-1 w-max min-w-[12rem] overflow-hidden rounded-md border border-gray-200 bg-white py-1 shadow-lg"
              >
                {desktopDesignTools.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    role="menuitem"
                    disabled={tool.disabled}
                    onClick={() => {
                      setDesignToolsOpen(false);
                      setLastDesignToolId(tool.id);
                      tool.run();
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-40 ${tool.menuTone}`}
                    title={tool.title}
                  >
                    <tool.Icon className="h-3.5 w-3.5 flex-shrink-0" />
                    {tool.label}
                  </button>
                ))}
              </div>
            )}
            {wandDeleteActive ? (
              <div
                className="flex min-h-[36px] flex-shrink-0 items-center gap-1.5 rounded-md border border-fuchsia-400 bg-fuchsia-50 pl-2 pr-1"
                title={t("editor.magicWandActiveTitle")}
              >
                <WandSparkles className="h-3.5 w-3.5 flex-shrink-0 text-fuchsia-600" aria-hidden="true" />
                <span className="whitespace-nowrap text-[11px] font-bold text-fuchsia-700">{t("editor.magicWandOn")}</span>
                <input
                  type="range"
                  min="1"
                  max="100"
                  value={wandTolerance}
                  onChange={(e) => setWandTolerance(Number(e.target.value))}
                  className="w-16 flex-shrink-0 accent-fuchsia-600"
                  aria-label={t("editor.wandTolerance")}
                  title={t("editor.wandTolerance")}
                />
                <span className="w-5 flex-shrink-0 text-right text-[11px] font-semibold tabular-nums text-fuchsia-800">{wandTolerance}</span>
                <button
                  type="button"
                  onClick={() => handleWandDeleteToggle?.()}
                  className="flex-shrink-0 rounded bg-fuchsia-600 px-1.5 py-1 text-[11px] font-bold text-white transition-colors hover:bg-fuchsia-700"
                  title={t("editor.wandTurnOff")}
                >
                  {t("editor.wandTurnOff")}
                </button>
              </div>
            ) : lastDesignTool ? (
              <button
                type="button"
                onClick={lastDesignTool.run}
                disabled={lastDesignTool.disabled}
                className={`flex min-h-[36px] flex-shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border px-2 py-1 text-[12px] font-semibold transition-colors disabled:pointer-events-none disabled:opacity-30 ${lastDesignTool.pillTone}`}
                title={t("editor.applyAgain", { tool: lastDesignTool.label })}
              >
                <lastDesignTool.Icon className="h-3.5 w-3.5 flex-shrink-0" />
                {lastDesignTool.label}
              </button>
            ) : null}
            {halftoneMenuOpen && (selectedDesignId || selectedDesignIds.size > 0) && (
              <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border border-gray-200 bg-white p-2 shadow-lg">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Strength</p>
                <div className="mb-2 flex gap-1">
                  {(["light", "balanced", "strong"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setHalftoneStrength?.(s)}
                      className={`flex-1 rounded border py-0.5 text-[10px] font-medium capitalize transition-colors ${halftoneStrength === s ? "border-amber-600 bg-amber-500 text-white" : "border-gray-200 bg-gray-50 text-gray-600 hover:bg-amber-50"}`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setHalftoneMenuOpen?.(false);
                    const id = selectedDesignId ?? [...selectedDesignIds][0];
                    if (id) handleApplyHalftone?.(id, 0, 0, 0, halftoneStrength);
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
                        type="button"
                        onClick={() => {
                          setHalftoneMenuOpen?.(false);
                          const id = selectedDesignId ?? [...selectedDesignIds][0];
                          if (id) handleApplyHalftone?.(id, c.r, c.g, c.b, halftoneStrength);
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
        </div>
      )}
    </div>
  </div>

    </>
  );
}

// Wrap in `React.memo` so unrelated view state changes (spot-channel
// hover, mobile-panel flip) skip re-rendering this ~650-line toolbar.
// Halftone menu state is a toolbar prop now (the Design tools cluster
// anchors that panel), so its changes legitimately re-render. Every callback prop is `useCallback`-wrapped
// in the provider (including the three previously plain handlers:
// `handleSetRotation`, `handleAlignAxis`, `handleSetGroupCount`) so
// memo's shallow-compare has a real chance to short-circuit.
export default memo(EditorActionToolbar);

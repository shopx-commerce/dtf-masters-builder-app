import { useState, memo } from "react";
import UploadSection from "../upload-section";
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
  Sparkles,
  LayoutGrid,
  Link,
  Loader2,
  Redo2,
  RotateCw,
  ShoppingCart,
  Trash2,
  Undo2,
  Unlink,
} from "lucide-react";
import { CenterHorizontalIcon, CenterVerticalIcon } from "./center-axis-icons";
import { formatLength, getUnitSuffix, useMetric } from "@/lib/format-length";
import { formatVariantPriceForDisplay } from "@/lib/variant-price";
import type { ProfileConfig } from "@/lib/profiles";
import type { ImageInfo, ImageTransform, ResizeSettings } from "@/lib/types";
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

  return (
    <>
  {/* Top bar: three rows on mobile, wraps on desktop when metric to avoid overlap */}
   <div className="flex-shrink-0 flex flex-col lg:flex-row lg:flex-wrap lg:items-center gap-2 bg-white border-b border-gray-200 px-2 py-2 lg:px-3 lg:py-2">
    {/* Row 1: Upload, file info, Auto-Arrange, Undo/Redo/Dup/Del */}
    <div className="flex items-center gap-1.5 lg:gap-2 min-w-0 flex-wrap flex-shrink-0 lg:basis-full lg:flex-nowrap lg:items-start">
      <div className="contents lg:flex lg:flex-1 lg:min-w-0 lg:flex-wrap lg:items-center lg:gap-2">
      <UploadSection
        onImageUpload={handleFileUploadUnified}
        onBatchStart={handleBatchStart}
        imageInfo={activeImageInfo}
        embedCompact={embedFromShopify}
      />
      {isUploading && (
        <div className="flex items-center gap-1.5 text-cyan-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span className="text-[11px]">{t("editor.processing")}</span>
        </div>
      )}
      {activeImageInfo?.file?.name && (
        <p className="text-[11px] text-gray-600 truncate max-w-[100px] hidden sm:block" title={activeImageInfo.file.name}>
          {activeImageInfo.file.name}
        </p>
      )}
      <div className="flex flex-col gap-1 lg:flex-row lg:gap-1 flex-shrink-0 ml-auto lg:ml-0">
        <div className="flex items-center gap-1">
          <button
            onClick={handleThresholdAlpha}
            disabled={!selectedDesignId && selectedDesignIds.size === 0}
            className={`flex items-center gap-1.5 px-2 py-1 lg:px-4 lg:py-2 rounded-md transition-all whitespace-nowrap text-[11px] lg:text-sm font-medium shadow-sm min-h-[36px] ${
              selectedDesignId || selectedDesignIds.size > 0
                ? 'bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#2563EB] border border-[#CBD5E1] shadow-none'
                : 'bg-gray-200 text-gray-500 opacity-30 pointer-events-none'
            }`}
            title={t("editor.cleanAlphaTitle")}
          >
            <Droplets className="w-3 h-3 lg:w-4 lg:h-4" />
            {t("editor.cleanAlpha")}
          </button>
          <button
            onClick={handleThresholdAlphaAll}
            disabled={designs.length === 0}
            className={`flex items-center gap-1.5 px-2 py-1 lg:px-4 lg:py-2 rounded-md transition-all whitespace-nowrap text-[11px] lg:text-sm font-medium shadow-sm min-h-[36px] ${
              designs.length > 0
                ? 'bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#2563EB] border border-[#CBD5E1] shadow-none'
                : 'bg-gray-200 text-gray-500 opacity-30 pointer-events-none'
            }`}
            title={t("editor.cleanAlphaAllTitle")}
          >
            <Droplets className="w-3 h-3 lg:w-4 lg:h-4" />
            {t("editor.cleanAlphaAll")}
          </button>
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
        {!isMobile && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => handleDuplicateDesign(duplicateCount)}
              disabled={!selectedDesignId}
              className={`flex items-center gap-1 px-2 py-1 lg:px-4 lg:py-2 rounded-md transition-all whitespace-nowrap text-[11px] lg:text-sm font-medium shadow-sm min-h-[36px] ${
                selectedDesignId
                  ? 'bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#7C3AED] border border-[#CBD5E1] shadow-none'
                  : 'bg-gray-200 text-gray-500 opacity-30 pointer-events-none'
              }`}
              title={t("editor.duplicate")}
            >
              <Copy className="w-3 h-3 lg:w-4 lg:h-4" />
              {t("editor.duplicate").replace(/ \(.*/, '')}
            </button>
            {/* `coarse:` sizing, not `lg:`, because a tablet renders this desktop
                arm on a touch screen. 16px is the threshold below which iOS
                Safari zooms the page in on focus, and the widget has to widen to
                hold three digits at that size without clipping. */}
            <div className="relative w-10 coarse:w-16 h-[28px] lg:h-[24px] coarse:h-8 rounded border border-gray-300 bg-white overflow-hidden focus-within:border-cyan-500">
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
              className={`flex items-center gap-1 px-2 py-1 lg:px-4 lg:py-2 rounded-md transition-all whitespace-nowrap ${lang !== 'en' ? 'text-[11px] lg:text-sm' : 'text-[12px] lg:text-sm'} font-semibold shadow-sm min-h-[36px] ${
                selectedDesignId
                  ? 'bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#0891B2] border border-[#CBD5E1] shadow-none'
                  : 'bg-gray-200 text-gray-500 opacity-30 pointer-events-none'
              }`}
              title={t("editor.duplicateArrange")}
            >
              <Copy className="w-3 h-3 lg:w-4 lg:h-4" />
              {t("editor.duplicateArrange")}
            </button>
          </div>
        )}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-0.5 flex-wrap">
        <button
          onClick={handleUndo}
          disabled={!canUndo()}
          className="h-10 min-w-[76px] lg:h-11 lg:min-w-[92px] rounded-lg border-2 border-black bg-black px-2.5 text-white hover:bg-white hover:text-black transition-colors disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center gap-1.5 shadow-sm"
          title={t("editor.undo")}
        >
          <Undo2 className="w-5 h-5 lg:w-6 lg:h-6" strokeWidth={2.5} />
          <span className="text-[13px] lg:text-[15px] font-black tracking-wide">UNDO</span>
        </button>
        <button
          onClick={handleRedo}
          disabled={!canRedo()}
          className="w-8 h-8 lg:w-10 lg:h-10 rounded border border-gray-300 bg-white hover:bg-gray-100 text-gray-600 hover:text-gray-900 transition-colors disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center shadow-sm"
          title={t("editor.redo")}
        >
          <Redo2 className="w-4 h-4 lg:w-5 lg:h-5" />
        </button>
        <div className="w-px h-4 bg-gray-100 mx-0.5" />
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
    {/* Row 2: Size, DPI, Margin, Rotate, Align — always on its own line */}
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
                title={t("editor.duplicateArrange")}
              >
                <Copy className="w-3 h-3" />
                {t("editor.duplicateArrange")}
              </button>
            </div>
          )}
        </>
      )}
      {!isMobile && (
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => handleAutoArrange({ preserveSelection: selectedDesignIds.size >= 2, fullRepack: true })}
            disabled={designs.length < 2 && selectedDesignIds.size < 2}
            className={`flex items-center gap-1 px-2 py-1 lg:px-4 lg:py-2 rounded-md transition-all whitespace-nowrap text-[11px] lg:text-sm font-medium min-h-[36px] ${
              designs.length >= 2 || selectedDesignIds.size >= 2
                ? 'bg-pink-500 hover:bg-pink-600 text-black border border-pink-600 shadow-md shadow-pink-500/25'
                : 'bg-gray-200 text-gray-500 opacity-30 pointer-events-none'
            }`}
            title={selectedDesignIds.size >= 2 ? t("editor.autoArrangeSelected") : t("editor.autoArrangeAll")}
          >
            <LayoutGrid className="w-3 h-3 lg:w-4 lg:h-4 flex-shrink-0" />
            {t("editor.autoArrange")}
          </button>
        </div>
      )}
      {!isMobile && designs.length >= 2 && (
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <div className="w-px h-5 bg-gray-100 hidden lg:block" />
          <div className="flex items-center gap-1">
            <span className="text-[11px] font-medium text-gray-700">{t("editor.margin")}</span>
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
        </div>
      )}
      {/* Row 3: rotate/align controls (desktop only) */}
      <div className="flex items-center gap-0.5 flex-shrink-0 flex-wrap lg:flex-nowrap w-full lg:w-auto">
        {!isMobile && (
          <>
            <div className="w-px h-4 bg-gray-100 mx-0.5 hidden lg:block" />
            <button
              onClick={handleRotate90}
              disabled={!selectedDesignId}
              className="w-10 h-10 lg:w-[30px] lg:h-[30px] rounded-lg lg:rounded-md border-2 border-black bg-black text-white hover:bg-white hover:text-black transition-colors disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center shadow-sm"
              title={t("editor.rotate")}
            >
              <RotateCw className="w-4 h-4 lg:w-3.5 lg:h-3.5" />
            </button>
            {selectedDesignId && (
              <div className="flex items-center gap-1.5 lg:gap-1 rounded-xl lg:rounded-lg border-2 border-black bg-white px-1.5 py-1 lg:px-1 lg:py-0.5 shadow-sm">
                <span className="min-w-[48px] lg:min-w-[34px] rounded-lg lg:rounded-md border-2 border-black bg-white px-1.5 py-1 lg:px-1 lg:py-0.5 text-center text-[16px] lg:text-[12px] font-bold tabular-nums text-black">{Math.round(activeDesignTransform.rotation || 0)}°</span>
                {[0, 90, 180, 270].map(deg => (
                  <button key={deg} onClick={() => handleSetRotation(deg)} className="flex h-9 min-w-10 lg:h-[30px] lg:min-w-7 items-center justify-center rounded-lg lg:rounded-md border border-black bg-white px-1.5 lg:px-1 text-[13px] lg:text-[11px] font-bold tabular-nums text-black hover:bg-black hover:text-white">
                    {deg}°
                  </button>
                ))}
              </div>
            )}
            {/*
              Align cluster.

              Six buttons in a single visually-grouped block. Previously the
              two axis-align buttons lived *inside* the rotation container,
              which mixed unrelated operations and confused users; the four
              corner buttons were also on a separate grid with different
              visibility rules. Now all six share the same enable/disable
              behavior (`selectedDesignId`), the same disabled affordance,
              and a single container so their function reads as one group.

              The two axis buttons draw their own icons (see
              `center-axis-icons.tsx`): the Lucide equivalents plus a corner
              "X" / "Y" letter were reported as unreadable at this size.
            */}
            <div className="flex items-center gap-0.5 lg:gap-px rounded-lg border-2 border-black bg-white px-1 py-0.5 lg:px-0.5 shadow-sm">
              <button
                onClick={() => handleAlignAxis("vertical")}
                disabled={!selectedDesignId}
                className="relative p-2 lg:p-1 rounded-md border border-black bg-white text-black hover:bg-black hover:text-white transition-colors disabled:opacity-30 disabled:pointer-events-none min-w-[42px] min-h-[42px] lg:min-w-[30px] lg:min-h-[30px] flex items-center justify-center"
                title={t("editor.alignCenterX")}
                aria-label={t("editor.alignCenterX")}
              >
                <CenterHorizontalIcon className="w-5 h-5 lg:w-[18px] lg:h-[18px]" />
              </button>
              <button
                onClick={() => handleAlignAxis("horizontal")}
                disabled={!selectedDesignId}
                className="relative p-2 lg:p-1 rounded-md border border-black bg-white text-black hover:bg-black hover:text-white transition-colors disabled:opacity-30 disabled:pointer-events-none min-w-[42px] min-h-[42px] lg:min-w-[30px] lg:min-h-[30px] flex items-center justify-center"
                title={t("editor.alignCenterY")}
                aria-label={t("editor.alignCenterY")}
              >
                <CenterVerticalIcon className="w-5 h-5 lg:w-[18px] lg:h-[18px]" />
              </button>
              <div className="w-px h-6 lg:h-4 bg-gray-300 mx-0.5" />
              <button
                onClick={() => handleAlignCorner('tl')}
                disabled={!selectedDesignId}
                className="p-2 lg:p-1 rounded-md border border-black bg-white text-black hover:bg-black hover:text-white transition-colors disabled:opacity-30 disabled:pointer-events-none min-w-[42px] min-h-[42px] lg:min-w-[30px] lg:min-h-[30px] flex items-center justify-center"
                title={t("editor.alignTL")}
                aria-label={t("editor.alignTL")}
              >
                <ArrowUpLeft className="w-4 h-4 lg:w-3.5 lg:h-3.5" />
              </button>
              <button
                onClick={() => handleAlignCorner('tr')}
                disabled={!selectedDesignId}
                className="p-2 lg:p-1 rounded-md border border-black bg-white text-black hover:bg-black hover:text-white transition-colors disabled:opacity-30 disabled:pointer-events-none min-w-[42px] min-h-[42px] lg:min-w-[30px] lg:min-h-[30px] flex items-center justify-center"
                title={t("editor.alignTR")}
                aria-label={t("editor.alignTR")}
              >
                <ArrowUpRight className="w-4 h-4 lg:w-3.5 lg:h-3.5" />
              </button>
              <button
                onClick={() => handleAlignCorner('bl')}
                disabled={!selectedDesignId}
                className="p-2 lg:p-1 rounded-md border border-black bg-white text-black hover:bg-black hover:text-white transition-colors disabled:opacity-30 disabled:pointer-events-none min-w-[42px] min-h-[42px] lg:min-w-[30px] lg:min-h-[30px] flex items-center justify-center"
                title={t("editor.alignBL")}
                aria-label={t("editor.alignBL")}
              >
                <ArrowDownLeft className="w-4 h-4 lg:w-3.5 lg:h-3.5" />
              </button>
              <button
                onClick={() => handleAlignCorner('br')}
                disabled={!selectedDesignId}
                className="p-2 lg:p-1 rounded-md border border-black bg-white text-black hover:bg-black hover:text-white transition-colors disabled:opacity-30 disabled:pointer-events-none min-w-[42px] min-h-[42px] lg:min-w-[30px] lg:min-h-[30px] flex items-center justify-center"
                title={t("editor.alignBR")}
                aria-label={t("editor.alignBR")}
              >
                <ArrowDownRight className="w-4 h-4 lg:w-3.5 lg:h-3.5" />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  </div>

    </>
  );
}

// Wrap in `React.memo` so unrelated view state changes (halftone menu
// open/close, spot-channel hover, mobile-panel flip) skip re-rendering
// this ~650-line toolbar. Every callback prop is `useCallback`-wrapped
// in the provider (including the three previously plain handlers:
// `handleSetRotation`, `handleAlignAxis`, `handleSetGroupCount`) so
// memo's shallow-compare has a real chance to short-circuit.
export default memo(EditorActionToolbar);

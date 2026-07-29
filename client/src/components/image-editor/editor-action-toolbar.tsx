import { useEffect, useRef, useState } from "react";
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
  LayoutGrid,
  Link,
  Loader2,
  Redo2,
  RotateCw,
  AlignCenterHorizontal,
  AlignCenterVertical,
  ShoppingCart,
  Trash2,
  Undo2,
  Unlink,
  X,
} from "lucide-react";
import { formatLength, getUnitSuffix, useMetric } from "@/lib/format-length";
import { formatVariantPriceForDisplay } from "@/lib/variant-price";
import type { ProfileConfig } from "@/lib/profiles";
import type { ImageInfo, ImageTransform, ResizeSettings } from "@/lib/types";

export type EditorActionToolbarProps = {
  t: (key: string, vars?: Record<string, string | number>) => string;
  lang: "en" | "es" | "fr";
  embedFromShopify?: boolean;
  isUploading: boolean;
  activeImageInfo: ImageInfo | null;
  handleFileUploadUnified: (file: File, image: HTMLImageElement | null) => Promise<void>;
  handleBatchStart: (fileCount: number) => void;
  selectedDesignId: string | null;
  selectedDesignIds: Set<string>;
  designs: { id: string }[];
  handleThresholdAlpha: () => void;
  handleThresholdAlphaAll: () => void;
  handleAutoArrange: (opts?: { skipSnapshot?: boolean; preserveSelection?: boolean }) => void;
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
  handleAutoArrangeRef: React.MutableRefObject<(opts?: { skipSnapshot?: boolean; preserveSelection?: boolean }) => void>;
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
};

export default function EditorActionToolbar(props: EditorActionToolbarProps) {
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
  } = props;
  const metric = useMetric(lang);
  const canAddToCart = !!activeImageInfo || designs.length > 0;
  const cartButtonDisabled = !!isProcessing || !canAddToCart;
  const cartButtonBusy = !!isAddingToCart || !!isProcessing;
  const cartButtonLabel = !canAddToCart
    ? t("controls.addToCart")
    : isAddingToCart
      ? t("controls.addingToCart")
      : isProcessing
        ? t("editor.processing")
        : t("controls.addToCart");
  const cartButtonTitle = !canAddToCart ? t("controls.uploadFirst") : cartButtonLabel;
  const [showSizeHint, setShowSizeHint] = useState(false);
  const hadImageRef = useRef(false);

  useEffect(() => {
    if (activeImageInfo && !hadImageRef.current) {
      hadImageRef.current = true;
      setShowSizeHint(true);
      const timer = window.setTimeout(() => setShowSizeHint(false), 5000);
      return () => window.clearTimeout(timer);
    }
    if (!activeImageInfo) hadImageRef.current = false;
  }, [activeImageInfo]);

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
            <div className="relative w-10 h-[28px] lg:h-[24px] rounded border border-gray-300 bg-white overflow-hidden focus-within:border-cyan-500">
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
              className={`flex items-center gap-1 px-2 py-1 lg:px-4 lg:py-2 rounded-md transition-all whitespace-nowrap ${lang !== 'en' ? 'text-[10px] lg:text-sm' : 'text-[11px] lg:text-sm'} font-medium shadow-sm min-h-[36px] ${
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
          className="w-8 h-8 lg:w-10 lg:h-10 rounded border border-gray-300 bg-white hover:bg-gray-100 text-gray-600 hover:text-gray-900 transition-colors disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center shadow-sm"
          title={t("editor.undo")}
        >
          <Undo2 className="w-4 h-4 lg:w-5 lg:h-5" />
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
            onClick={() => handleAutoArrange({ preserveSelection: selectedDesignIds.size >= 2 })}
            disabled={designs.length < 2 && selectedDesignIds.size < 2}
            className={`flex items-center gap-1 px-2 py-1 rounded-md transition-all whitespace-nowrap font-medium shadow-sm min-h-[36px] ${lang !== 'en' ? 'text-[10px]' : 'text-[11px]'} ml-auto ${
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
            <span className="mr-1 text-[10px] font-semibold text-gray-500">Size</span>
            {selectedDesignIds.size > 1 && (
              <span className="mr-1 flex-shrink-0 rounded-full border border-cyan-300 bg-cyan-50 px-1 py-px text-[9px] font-bold tabular-nums text-cyan-600" title={`Resize applies to all ${selectedDesignIds.size} selected designs`}>
                ×{selectedDesignIds.size}
              </span>
            )}
            <div className="flex items-center gap-0.5 flex-shrink-0 flex-wrap">
              <span className="text-[10px] text-gray-600">W</span>
              <SizeInput
                value={activeResizeSettings.widthInches * activeDesignTransform.s}
                onCommit={(v) => { handleEffectiveSizeChange("width", v); setShowSizeHint(false); }}
                title={useMetric(lang) ? t("editor.widthTitleCm") : t("editor.widthTitle")}
                max={artboardWidth}
                lang={lang}
              />
              <span className={`text-gray-600 ${lang === 'en' ? 'text-[10px]' : 'text-[9px]'}`}>{getUnitSuffix(activeResizeSettings.widthInches * activeDesignTransform.s, lang)}</span>
              <button
                onClick={() => setProportionalLock(prev => !prev)}
                className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${proportionalLock ? 'text-cyan-500 hover:bg-cyan-50' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-700'}`}
                title={proportionalLock ? 'Proportions locked – click to unlock' : 'Proportions unlocked – click to lock'}
              >
                {proportionalLock ? <Link className="h-3.5 w-3.5" /> : <Unlink className="h-3.5 w-3.5" />}
              </button>
              <span className="text-[10px] text-gray-600">H</span>
              <SizeInput
                value={activeResizeSettings.heightInches * activeDesignTransform.s}
                onCommit={(v) => { handleEffectiveSizeChange("height", v); setShowSizeHint(false); }}
                title={useMetric(lang) ? t("editor.heightTitleCm") : t("editor.heightTitle")}
                max={artboardHeight}
                lang={lang}
              />
              <span className={`text-gray-600 ${lang === 'en' ? 'text-[10px]' : 'text-[9px]'}`}>{getUnitSuffix(activeResizeSettings.heightInches * activeDesignTransform.s, lang)}</span>
            </div>
            {showSizeHint && (
              <span className="ml-1 inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-cyan-300 bg-cyan-50 px-2 py-0.5 text-[10px] text-cyan-700 animate-pulse">
                ← Click to resize
                <button
                  type="button"
                  onClick={() => setShowSizeHint(false)}
                  className="flex h-3 w-3 items-center justify-center"
                  aria-label="Dismiss resize hint"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            )}
            <span
              className={`text-[9px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0 inline-flex items-center gap-1.5 ${
                effectiveDPI < 198
                  ? 'text-amber-600 bg-amber-100 border border-amber-400'
                  : effectiveDPI < 277
                    ? 'text-amber-600 bg-amber-100 border border-amber-400'
                    : 'text-emerald-600 bg-emerald-100 border border-emerald-700'
              }`}
              title={t("editor.effectiveRes", { dpi: effectiveDPI })}
            >
              <span>{effectiveDPI} DPI</span>
              <span className="text-[8px] font-medium opacity-90 hidden sm:inline">
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
            onClick={() => handleAutoArrange({ preserveSelection: selectedDesignIds.size >= 2 })}
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
            <span className="text-[10px] text-gray-600">{t("editor.margin")}</span>
            <select
              value={designGap === undefined ? "auto" : String(designGap)}
              onChange={(e) => {
                const v = e.target.value;
                const newGap = v === "auto" ? undefined : parseFloat(v);
                setDesignGap(newGap);
                if (designs.length >= 2) {
                  setTimeout(() => handleAutoArrangeRef.current({ skipSnapshot: false, preserveSelection: true }), 0);
                }
              }}
              className="h-5 px-1 bg-gray-100 border border-gray-300 rounded text-[10px] text-gray-700 outline-none cursor-pointer hover:border-gray-400 focus:border-cyan-500 transition-colors"
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
              className="w-8 h-8 lg:w-7 lg:h-7 rounded border border-gray-300 bg-white hover:bg-gray-100 text-gray-600 hover:text-gray-900 transition-colors disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center shadow-sm"
              title={t("editor.rotate")}
            >
              <RotateCw className="w-4 h-4" />
            </button>
            {selectedDesignId && (
              <div className="flex items-center gap-1 rounded border border-gray-200 bg-gray-50 px-1 py-0.5">
                <button onClick={() => handleAlignAxis("vertical")} className="flex h-7 w-7 items-center justify-center rounded text-gray-600 hover:bg-white hover:text-cyan-600" title="Center vertically">
                  <AlignCenterVertical className="h-4 w-4" />
                </button>
                <button onClick={() => handleAlignAxis("horizontal")} className="flex h-7 w-7 items-center justify-center rounded text-gray-600 hover:bg-white hover:text-cyan-600" title="Center horizontally">
                  <AlignCenterHorizontal className="h-4 w-4" />
                </button>
                <span className="min-w-[38px] text-center text-[10px] font-medium tabular-nums text-gray-600">{Math.round(activeDesignTransform.rotation || 0)}°</span>
                {[0, 90, 180, 270].map(deg => (
                  <button key={deg} onClick={() => handleSetRotation(deg)} className="flex h-7 min-w-7 items-center justify-center rounded px-1 text-[10px] font-medium text-gray-600 hover:bg-white hover:text-cyan-600">
                    {deg}°
                  </button>
                ))}
              </div>
            )}
            <div className="grid grid-cols-4 gap-0.5 lg:contents">
              <button
                onClick={() => handleAlignCorner('tl')}
                disabled={!selectedDesignId}
                className="p-2 lg:p-1.5 rounded-md hover:bg-gray-200/80 text-gray-600 hover:text-cyan-400 transition-colors disabled:opacity-30 disabled:pointer-events-none min-w-[40px] min-h-[40px] lg:min-w-0 lg:min-h-0 flex items-center justify-center"
                title={t("editor.alignTL")}
              >
                <ArrowUpLeft className="w-4 h-4 lg:w-3.5 lg:h-3.5" />
              </button>
              <button
                onClick={() => handleAlignCorner('tr')}
                disabled={!selectedDesignId}
                className="p-2 lg:p-1.5 rounded-md hover:bg-gray-200/80 text-gray-600 hover:text-cyan-400 transition-colors disabled:opacity-30 disabled:pointer-events-none min-w-[40px] min-h-[40px] lg:min-w-0 lg:min-h-0 flex items-center justify-center"
                title={t("editor.alignTR")}
              >
                <ArrowUpRight className="w-4 h-4 lg:w-3.5 lg:h-3.5" />
              </button>
              <button
                onClick={() => handleAlignCorner('bl')}
                disabled={!selectedDesignId}
                className="p-2 lg:p-1.5 rounded-md hover:bg-gray-200/80 text-gray-600 hover:text-cyan-400 transition-colors disabled:opacity-30 disabled:pointer-events-none min-w-[40px] min-h-[40px] lg:min-w-0 lg:min-h-0 flex items-center justify-center"
                title={t("editor.alignBL")}
              >
                <ArrowDownLeft className="w-4 h-4 lg:w-3.5 lg:h-3.5" />
              </button>
              <button
                onClick={() => handleAlignCorner('br')}
                disabled={!selectedDesignId}
                className="p-2 lg:p-1.5 rounded-md hover:bg-gray-200/80 text-gray-600 hover:text-cyan-400 transition-colors disabled:opacity-30 disabled:pointer-events-none min-w-[40px] min-h-[40px] lg:min-w-0 lg:min-h-0 flex items-center justify-center"
                title={t("editor.alignBR")}
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

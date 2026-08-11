import { useState, useEffect, useRef, useMemo, useCallback, memo } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ResizeSettings, ImageInfo } from "./image-editor";
import { Download, Layers, FileCheck, Palette, Eye, EyeOff, ChevronDown, ChevronUp, Info, ShoppingCart, Sparkles, Undo2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { formatLength } from "@/lib/format-length";
import { useIsMobile } from "@/hooks/use-mobile";
import { useMediaQuery } from "@/hooks/use-media-query";
import { formatVariantPriceForDisplay, getSelectedVariantPrice } from "@/lib/variant-price";

export interface SpotPreviewData {
  enabled: boolean;
  colors: ExtractedColor[];
  masks?: { FY: Uint8Array; FM: Uint8Array; FG: Uint8Array; FO: Uint8Array; width: number; height: number };
}

type ExtractedColor = {
  hex: string;
  name?: string;
  rgb: { r: number; g: number; b: number };
  percentage: number;
  spotWhite?: boolean;
  spotGloss?: boolean;
  spotFluorY?: boolean;
  spotFluorM?: boolean;
  spotFluorG?: boolean;
  spotFluorOrange?: boolean;
  regions?: Array<{
    id: number;
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
    pixelCount: number;
    percentage: number;
    pixelIndices: number[];
    spotFluorY?: boolean;
    spotFluorM?: boolean;
    spotFluorG?: boolean;
    spotFluorOrange?: boolean;
  }>;
  regionMap?: Int32Array;
};

interface ControlsSectionProps {
  resizeSettings: ResizeSettings;
  onResizeChange: (settings: Partial<ResizeSettings>) => void;
  onDownload: (downloadType?: string, format?: string, spotColorsByDesign?: Record<string, any[]>) => void;
  isProcessing: boolean;
  exportProgressLabel?: string;
  imageInfo: ImageInfo | null;
  artboardWidth?: number;
  artboardHeight?: number;
  onArtboardHeightChange?: (height: number) => void;
  downloadContainer?: HTMLDivElement | null;
  designCount?: number;
  gangsheetHeights?: number[];
  recommendedArtboardHeight?: number | null;
  downloadFormat?: 'png' | 'pdf';
  enableFluorescent?: boolean;
  selectedDesignId?: string | null;
  onSpotPreviewChange?: (data: SpotPreviewData) => void;
  fluorPanelContainer?: HTMLDivElement | null;
  copySpotSelectionsRef?: React.MutableRefObject<((fromId: string, toIds: string[]) => void) | null>;
  onActiveChannelChange?: (channel: string | null) => void;
  wandAssignRef?: React.MutableRefObject<((nx: number, ny: number) => void) | null>;
  panModeActive?: boolean;
  onPanModeChange?: (active: boolean) => void;
  clearActiveChannelRef?: React.MutableRefObject<(() => void) | null>;
  quantity?: number;
  onQuantityChange?: (qty: number) => void;
  shopifyVariants?: Array<{ id: string; title: string; price: string | null; height: number | null }>;
  onAddToCart?: () => void;
  hasVariantId?: boolean;
  isAddingToCart?: boolean;
  addToCartLabel?: string;
  addingStatusLabel?: string;
  lockGangsheetSize?: boolean;
  /** Edit mode only: current state of the "Regenerate file" checkbox. */
  regenerateProduction?: boolean;
  /** Edit mode only: when provided, renders the "Regenerate file" checkbox next to the update button. */
  onRegenerateProductionChange?: (value: boolean) => void;
  // NOTE: the White BG / Magic Wand card that used to render here moved to
  // the desktop toolbar's "Design tools" dropdown (see
  // `image-editor/editor-action-toolbar.tsx`), taking its tool props with
  // it. Wand tolerance lives in the Zustand `tool-store` and the toolbar's
  // slider subscribes directly — see `state/tool-store.ts`.
}

const DEFAULT_HEIGHTS: number[] = [];

function autoAssignChannel(rgb: { r: number; g: number; b: number }): 'spotFluorY' | 'spotFluorM' | 'spotFluorG' | 'spotFluorOrange' | null {
  const values = [rgb.r, rgb.g, rgb.b].map(v => v / 255);
  const max = Math.max(...values), min = Math.min(...values);
  const lightness = (max + min) / 2;
  if (max === min) return null;
  const saturation = lightness > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
  if (saturation < 0.6 || lightness < 0.08 || lightness > 0.93) return null;
  let hue = 0;
  if (max === values[0]) hue = ((values[1] - values[2]) / (max - min) + (values[1] < values[2] ? 6 : 0)) * 60;
  else if (max === values[1]) hue = ((values[2] - values[0]) / (max - min) + 2) * 60;
  else hue = ((values[0] - values[1]) / (max - min) + 4) * 60;
  if (hue >= 45 && hue < 80) return 'spotFluorY';
  if (hue >= 80 && hue < 165) return 'spotFluorG';
  if (hue >= 15 && hue < 45) return 'spotFluorOrange';
  if (hue < 15 || hue >= 285) return 'spotFluorM';
  return null;
}

function ControlsSection({
  onDownload,
  isProcessing,
  exportProgressLabel,
  imageInfo,
  artboardWidth = 24.5,
  artboardHeight = 12,
  onArtboardHeightChange,
  downloadContainer,
  designCount = 0,
  gangsheetHeights = DEFAULT_HEIGHTS,
  recommendedArtboardHeight,
  downloadFormat = 'png',
  enableFluorescent = false,
  selectedDesignId,
  onSpotPreviewChange,
  fluorPanelContainer,
  copySpotSelectionsRef,
  onActiveChannelChange,
  wandAssignRef,
  panModeActive = false,
  onPanModeChange,
  clearActiveChannelRef,
  quantity: _quantity = 1,
  onQuantityChange: _onQuantityChange,
  shopifyVariants,
  onAddToCart,
  hasVariantId = false,
  isAddingToCart = false,
  addToCartLabel,
  addingStatusLabel,
  lockGangsheetSize = false,
  regenerateProduction = false,
  onRegenerateProductionChange,
}: ControlsSectionProps) {
  const { t, lang } = useLanguage();
  const isMobile = useIsMobile();
  const isLgUp = useMediaQuery("(min-width: 1024px)");
  const canDownload = !!imageInfo || designCount > 0;

  const selectedVariantPrice = useMemo(
    () => getSelectedVariantPrice(shopifyVariants, artboardHeight),
    [shopifyVariants, artboardHeight]
  );

  const [showSpotColors, setShowSpotColors] = useState(true);
  const [showDetectedColors, setShowDetectedColors] = useState(true);
  const [showFluorInfo, setShowFluorInfo] = useState(false);
  const [extractedColors, setExtractedColors] = useState<ExtractedColor[]>([]);
  const [activeChannel, setActiveChannel] = useState<'spotFluorY' | 'spotFluorM' | 'spotFluorG' | 'spotFluorOrange' | null>(null);
  const [autoAssignActive, setAutoAssignActive] = useState(false);
  const preAutoAssignRef = useRef<ExtractedColor[] | null>(null);
  const autoAssignSnapshotsRef = useRef<Map<string, ExtractedColor[]>>(new Map());
  const pixelMapRef = useRef<{ pixelMap: Int16Array; width: number; height: number } | null>(null);
  const [spotPreviewEnabled, setSpotPreviewEnabled] = useState(true);
  const spotFluorYName = "FY";
  const spotFluorMName = "FM";
  const spotFluorGName = "FG";
  const spotFluorOrangeName = "FO";
  const colorCacheRef = useRef<Map<string, ExtractedColor[]>>(new Map());
  const spotSelectionsRef = useRef<Map<string, ExtractedColor[]>>(new Map());
  const prevDesignIdRef = useRef<string | null | undefined>(null);
  const imageIdentityByDesignRef = useRef<Map<string, HTMLImageElement>>(new Map());

  useEffect(() => {
    if (clearActiveChannelRef) clearActiveChannelRef.current = () => setActiveChannel(null);
  }, [clearActiveChannelRef]);
  useEffect(() => { onActiveChannelChange?.(activeChannel); }, [activeChannel, onActiveChannelChange]);

  useEffect(() => {
    if (!enableFluorescent) return;

    let cancelled = false;
    pixelMapRef.current = null;

    if (prevDesignIdRef.current && extractedColors.length > 0) {
      spotSelectionsRef.current.set(prevDesignIdRef.current, extractedColors);
    }
    prevDesignIdRef.current = selectedDesignId;
    if (selectedDesignId && imageInfo?.image) {
      const previousImage = imageIdentityByDesignRef.current.get(selectedDesignId);
      if (previousImage && previousImage !== imageInfo.image) {
        // Pixel-derived spot selections belong to the old raster. Do not
        // restore them after an upscale or another image replacement.
        spotSelectionsRef.current.delete(selectedDesignId);
        autoAssignSnapshotsRef.current.delete(selectedDesignId);
      }
      imageIdentityByDesignRef.current.set(selectedDesignId, imageInfo.image);
    }
    const savedAutoSnapshot = selectedDesignId
      ? autoAssignSnapshotsRef.current.get(selectedDesignId) ?? null
      : null;
    preAutoAssignRef.current = savedAutoSnapshot;
    setAutoAssignActive(Boolean(savedAutoSnapshot));

    if (imageInfo?.image) {
      if (selectedDesignId && spotSelectionsRef.current.has(selectedDesignId)) {
        const saved = spotSelectionsRef.current.get(selectedDesignId)!;
        setExtractedColors(saved);
        import("@/lib/color-extractor").then(({ buildPixelMapFromImage }) => {
          if (cancelled) return;
          const map = buildPixelMapFromImage(imageInfo.image, saved as any);
          if (map) pixelMapRef.current = map;
        }).catch(() => {});
      } else {
        const cacheKey = `${imageInfo.image.width}x${imageInfo.image.height}-${imageInfo.file?.name ?? 'unknown'}-${imageInfo.file?.size ?? 0}`;
        const cached = colorCacheRef.current.get(cacheKey);
        if (cached) {
          const restored = cached.map(c => ({ ...c }));
          setExtractedColors(restored);
          import("@/lib/color-extractor").then(({ buildPixelMapFromImage, detectColorRegionsAsync }) => {
            if (cancelled) return;
            const map = buildPixelMapFromImage(imageInfo.image, restored as any);
            if (map) {
              pixelMapRef.current = map;
              return detectColorRegionsAsync(map.pixelMap, map.width, map.height, restored as any)
                .then(() => { if (!cancelled) setExtractedColors([...restored]); });
            }
          }).catch(() => {});
        } else {
          import("@/lib/color-extractor").then(({ extractColorsFromImageAsync, extractColorsFromImage, buildPixelMapFromImage, detectColorRegionsAsync }) => {
            if (cancelled) return;
            const finish = async (colors: ExtractedColor[]) => {
              if (cancelled) return;
              const map = buildPixelMapFromImage(imageInfo.image, colors as any);
              if (map) {
                pixelMapRef.current = map;
                await detectColorRegionsAsync(map.pixelMap, map.width, map.height, colors as any);
              }
              if (!cancelled) setExtractedColors([...colors]);
            };
            extractColorsFromImageAsync(imageInfo.image, 999).then(colors => {
              if (cancelled) return;
              if (colors.length === 0) {
                try {
                  const fallback = extractColorsFromImage(imageInfo.image, 999);
                  if (fallback.length > 0) {
                    colorCacheRef.current.set(cacheKey, fallback);
                    void finish(fallback);
                    return;
                  }
                } catch { /* sync fallback failed */ }
              }
              colorCacheRef.current.set(cacheKey, colors);
              if (colorCacheRef.current.size > 20) {
                const firstKey = colorCacheRef.current.keys().next().value;
                if (firstKey) colorCacheRef.current.delete(firstKey);
              }
              void finish(colors);
            }).catch((err) => {
              if (cancelled) return;
              try {
                const fallback = extractColorsFromImage(imageInfo.image, 999);
                colorCacheRef.current.set(cacheKey, fallback);
                void finish(fallback);
              } catch {
                setExtractedColors([]);
              }
            });
          }).catch((err) => {
            if (cancelled) return;
            console.warn('[Fluorescent] color-extractor import failed:', err);
          });
        }
      }
    } else {
      setExtractedColors([]);
    }

    return () => { cancelled = true; };
  }, [imageInfo, selectedDesignId, enableFluorescent]);

  useEffect(() => {
    if (!enableFluorescent || !copySpotSelectionsRef) return;
    copySpotSelectionsRef.current = (fromId: string, toIds: string[]) => {
      if (selectedDesignId && extractedColors.length > 0) {
        spotSelectionsRef.current.set(selectedDesignId, extractedColors);
      }
      const source = spotSelectionsRef.current.get(fromId);
      if (!source) return;
      for (const toId of toIds) {
        spotSelectionsRef.current.set(toId, source.map(c => ({ ...c })));
      }
    };
    return () => { if (copySpotSelectionsRef) copySpotSelectionsRef.current = null; };
  }, [copySpotSelectionsRef, selectedDesignId, extractedColors, enableFluorescent]);

  useEffect(() => {
    if (!enableFluorescent) return;
    onSpotPreviewChange?.({ enabled: spotPreviewEnabled, colors: extractedColors });
  }, [spotPreviewEnabled, extractedColors, onSpotPreviewChange, enableFluorescent]);

  const computeChannelMasks = useCallback(() => {
    const map = pixelMapRef.current;
    if (!map) return undefined;
    const masks = {
      FY: new Uint8Array(map.pixelMap.length),
      FM: new Uint8Array(map.pixelMap.length),
      FG: new Uint8Array(map.pixelMap.length),
      FO: new Uint8Array(map.pixelMap.length),
      width: map.width,
      height: map.height,
    };
    for (let i = 0; i < map.pixelMap.length; i++) {
      const color = extractedColors[map.pixelMap[i]];
      if (!color) continue;
      const regionIndex = color.regionMap?.[i] ?? -1;
      const region = regionIndex >= 0 ? color.regions?.[regionIndex] : undefined;
      const flags = region ?? color;
      if (flags.spotFluorY) masks.FY[i] = 1;
      if (flags.spotFluorM) masks.FM[i] = 1;
      if (flags.spotFluorG) masks.FG[i] = 1;
      if (flags.spotFluorOrange) masks.FO[i] = 1;
    }
    return masks;
  }, [extractedColors]);

  useEffect(() => {
    if (!enableFluorescent) return;
    onSpotPreviewChange?.({
      enabled: spotPreviewEnabled,
      colors: extractedColors,
      masks: computeChannelMasks(),
    });
  }, [spotPreviewEnabled, extractedColors, computeChannelMasks, onSpotPreviewChange, enableFluorescent]);

  const updateSpotColor = useCallback((index: number, field: 'spotFluorY' | 'spotFluorM' | 'spotFluorG' | 'spotFluorOrange', value: boolean) => {
    setExtractedColors(prev => {
      const updated = prev.map((color, i) => {
        if (i === index) {
          const regions = color.regions?.map(region => ({
            ...region,
            spotFluorY: field === 'spotFluorY' ? value : value ? false : region.spotFluorY,
            spotFluorM: field === 'spotFluorM' ? value : value ? false : region.spotFluorM,
            spotFluorG: field === 'spotFluorG' ? value : value ? false : region.spotFluorG,
            spotFluorOrange: field === 'spotFluorOrange' ? value : value ? false : region.spotFluorOrange,
          }));
          if (value) {
            return { ...color, spotFluorY: false, spotFluorM: false, spotFluorG: false, spotFluorOrange: false, [field]: true, regions };
          }
          return { ...color, [field]: value, regions };
        }
        return color;
      });
      if (selectedDesignId) {
        spotSelectionsRef.current.set(selectedDesignId, updated);
      }
      return updated;
    });
  }, [selectedDesignId]);

  const handleAutoAssign = useCallback(() => {
    if (autoAssignActive && preAutoAssignRef.current) {
      const restored = preAutoAssignRef.current;
      preAutoAssignRef.current = null;
      setAutoAssignActive(false);
      setExtractedColors(restored);
      if (selectedDesignId) {
        autoAssignSnapshotsRef.current.delete(selectedDesignId);
        spotSelectionsRef.current.set(selectedDesignId, restored);
      }
      return;
    }
    setExtractedColors(prev => {
      const snapshot = prev.map(color => ({ ...color, regions: color.regions?.map(region => ({ ...region })) }));
      preAutoAssignRef.current = snapshot;
      if (selectedDesignId) autoAssignSnapshotsRef.current.set(selectedDesignId, snapshot);
      const updated = prev.map(color => {
        const field = autoAssignChannel(color.rgb);
        const flags = {
          spotFluorY: field === 'spotFluorY',
          spotFluorM: field === 'spotFluorM',
          spotFluorG: field === 'spotFluorG',
          spotFluorOrange: field === 'spotFluorOrange',
        };
        return { ...color, ...flags, regions: color.regions?.map(region => ({ ...region, ...flags })) };
      });
      if (selectedDesignId) spotSelectionsRef.current.set(selectedDesignId, updated);
      return updated;
    });
    setAutoAssignActive(true);
  }, [autoAssignActive, selectedDesignId]);

  const handleWandAssign = useCallback((nx: number, ny: number) => {
    if (!activeChannel || !pixelMapRef.current) return;
    const map = pixelMapRef.current;
    const x = Math.min(map.width - 1, Math.max(0, Math.floor(nx * map.width)));
    const y = Math.min(map.height - 1, Math.max(0, Math.floor(ny * map.height)));
    const pixelIndex = y * map.width + x;
    const colorIndex = map.pixelMap[pixelIndex];
    if (colorIndex < 0) return;
    const color = extractedColors[colorIndex];
    const regionIndex = color?.regionMap?.[pixelIndex] ?? -1;
    if (color?.regions?.[regionIndex]) {
      setExtractedColors(prev => {
        const updated = prev.map((entry, index) => index !== colorIndex ? entry : {
          ...entry,
          regions: entry.regions?.map(region => region.id !== color.regions?.[regionIndex]?.id
            ? region
            : { ...region, spotFluorY: activeChannel === 'spotFluorY', spotFluorM: activeChannel === 'spotFluorM', spotFluorG: activeChannel === 'spotFluorG', spotFluorOrange: activeChannel === 'spotFluorOrange' }),
        });
        if (selectedDesignId) spotSelectionsRef.current.set(selectedDesignId, updated);
        return updated;
      });
    } else {
      updateSpotColor(colorIndex, activeChannel, true);
    }
  }, [activeChannel, extractedColors, selectedDesignId, updateSpotColor]);

  useEffect(() => {
    if (wandAssignRef) wandAssignRef.current = handleWandAssign;
  }, [wandAssignRef, handleWandAssign]);

  const sortedColorIndices = useMemo(() => {
    const fluorPriority = (c: ExtractedColor) => {
      const r = c.rgb.r, g = c.rgb.g, b = c.rgb.b;
      const max = Math.max(r, g, b);
      const saturation = max === 0 ? 0 : 1 - Math.min(r, g, b) / max;
      const lightness = (r + g + b) / 3;
      if (saturation < 0.15 || lightness < 40 || lightness > 240) return 1;
      const isMagenta = r > 180 && b > 120 && g < 120;
      const isYellow = r > 180 && g > 160 && b < 100;
      const isGreen = g > 150 && r < 150 && b < 150;
      const isOrange = r > 200 && g > 80 && g < 180 && b < 80;
      const isPink = r > 180 && g < 130 && b > 100;
      const isRed = r > 180 && g < 80 && b < 80;
      if (isMagenta || isYellow || isGreen || isOrange || isPink || isRed) return 0;
      return 1;
    };
    return extractedColors
      .map((c, i) => ({ index: i, priority: fluorPriority(c), pct: c.percentage }))
      .sort((a, b) => a.priority - b.priority || b.pct - a.pct)
      .map(e => e.index);
  }, [extractedColors]);

  const buildSpotColorsForDesign = useCallback((colors: ExtractedColor[]) => colors.map(c => ({
    hex: c.hex,
    rgb: c.rgb,
    spotWhite: false,
    spotGloss: false,
    spotWhiteName: '',
    spotGlossName: '',
    spotFluorY: c.spotFluorY ?? false,
    spotFluorM: c.spotFluorM ?? false,
    spotFluorG: c.spotFluorG ?? false,
    spotFluorOrange: c.spotFluorOrange ?? false,
    spotFluorYName, spotFluorMName, spotFluorGName, spotFluorOrangeName,
  })), [spotFluorYName, spotFluorMName, spotFluorGName, spotFluorOrangeName]);

  const getAllDesignSpotColors = useCallback(() => {
    if (selectedDesignId && extractedColors.length > 0) {
      spotSelectionsRef.current.set(selectedDesignId, extractedColors);
    }
    const result: Record<string, ReturnType<typeof buildSpotColorsForDesign>> = {};
    for (const [designId, colors] of spotSelectionsRef.current.entries()) {
      result[designId] = buildSpotColorsForDesign(colors);
    }
    if (selectedDesignId && !result[selectedDesignId] && extractedColors.length > 0) {
      result[selectedDesignId] = buildSpotColorsForDesign(extractedColors);
    }
    return result;
  }, [selectedDesignId, extractedColors, buildSpotColorsForDesign]);

  const isPdf = downloadFormat === 'pdf';
  const dlLabel = t("controls.downloadGangsheet");
  const dlTitle = !canDownload ? t("controls.uploadFirst") : isProcessing ? t("editor.processing") : dlLabel;

  const handleDownloadClick = useCallback(() => {
    if (isPdf && enableFluorescent) {
      const spotColors = getAllDesignSpotColors();
      onDownload('standard', 'pdf', spotColors);
    } else {
      onDownload('standard', 'png');
    }
  }, [isPdf, enableFluorescent, getAllDesignSpotColors, onDownload]);

  const assignedCount = extractedColors.filter(c => c.spotFluorY || c.spotFluorM || c.spotFluorG || c.spotFluorOrange).length;
  const fluorChannels = [
    { field: 'spotFluorY' as const, label: 'FY', color: '#DFFF00' },
    { field: 'spotFluorM' as const, label: 'FM', color: '#FF00FF' },
    { field: 'spotFluorG' as const, label: 'FG', color: '#39FF14' },
    { field: 'spotFluorOrange' as const, label: 'FO', color: '#FF6600' },
  ];

  const INK_NAMES: Record<string, string> = {
    Yellow: t("controls.fluorYellow"),
    Magenta: t("controls.fluorMagenta"),
    Orange: t("controls.fluorOrange"),
    Green: t("controls.fluorGreen"),
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg border border-gray-200 overflow-visible">
        <div className="flex items-center gap-1 px-2 py-1 min-w-0 sm:gap-2 sm:px-3 sm:py-1.5 sm:pr-4">
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-cyan-500/10 sm:h-6 sm:w-6">
            <Layers className="h-3 w-3 text-cyan-600 sm:h-3.5 sm:w-3.5" />
          </div>
          <span className="min-w-0 max-w-[5.25rem] shrink truncate text-[11px] font-semibold text-gray-900 sm:max-w-none sm:text-sm">{t("controls.gangsheetSize")}</span>
          {!isLgUp ? (
            <div className="flex min-w-0 flex-1 items-center justify-end gap-0.5 sm:gap-1.5 -translate-x-[5px]">
              <div className="flex min-w-0 items-center gap-0.5 sm:gap-1">
                <span className={`shrink-0 font-semibold text-gray-800 tabular-nums ${lang === 'en' ? 'text-[11px] sm:text-xs' : 'text-[11px]'}`}>{formatLength(artboardWidth, lang)}{lang === "en" ? '"' : ""}</span>
                <span className={`shrink-0 font-medium text-gray-700 ${lang === 'en' ? 'text-[11px] sm:text-xs' : 'text-[11px]'}`}>×</span>
                {lockGangsheetSize ? (
                  <span className={`h-7 min-w-[3.5rem] shrink-0 rounded border border-gray-200 bg-gray-100 px-1.5 py-1 text-center font-semibold tabular-nums text-gray-900 sm:min-w-[4.5rem] sm:px-2 ${lang === 'en' ? 'text-[11px] sm:text-xs' : 'text-[11px]'}`}>{formatLength(artboardHeight, lang)}{lang === "en" ? '"' : ""}</span>
                ) : (
                  <Select
                    value={String(artboardHeight)}
                    onValueChange={(v) => onArtboardHeightChange?.(parseFloat(v))}
                  >
                    <SelectTrigger
                      className={`h-7 w-[3.5rem] shrink-0 gap-0.5 border-gray-200 bg-gray-100 pl-1.5 pr-1 font-semibold tabular-nums text-gray-900 sm:w-[4.5rem] sm:pl-2 sm:pr-1.5 [&>span]:min-w-0 [&>span]:truncate [&>svg]:h-3.5 [&>svg]:w-3.5 ${lang === 'en' ? 'text-[11px] sm:text-xs' : 'text-[11px]'}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="z-[100]" position="popper" sideOffset={4}>
                      {gangsheetHeights.map((h) => {
                        const label = `${formatLength(h, lang)}${lang === "en" ? '"' : ""}`;
                        return (
                          <SelectItem
                            key={h}
                            value={String(h)}
                            textValue={label}
                            className={`tabular-nums ${lang !== 'en' ? 'text-[11px]' : 'text-sm'}`}
                          >
                            <span className="flex items-center justify-between gap-3 w-full">
                              <span>{label}</span>
                              {recommendedArtboardHeight === h && (
                                <span className="text-[11px] text-blue-700 font-medium shrink-0">
                                  {t("controls.currentBounds")}
                                </span>
                              )}
                            </span>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                )}
              </div>
              {selectedVariantPrice != null && (
                <span className="ml-0.5 shrink-0 whitespace-nowrap rounded-full border border-emerald-600 bg-white px-1.5 py-[1px] text-[9px] font-bold leading-tight text-emerald-600 tabular-nums sm:px-2 sm:py-0.5 sm:text-[10px]">
                  {formatVariantPriceForDisplay(selectedVariantPrice)}
                </span>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-1 ml-auto shrink-0 max-w-[min(12rem,46%)]">
              <span className={`font-semibold text-gray-700 tabular-nums shrink-0 ${lang === 'en' ? 'text-xs' : 'text-[10px]'}`}>{formatLength(artboardWidth, lang)}{lang === "en" ? '"' : ""}</span>
               <span className={`text-gray-700 font-medium shrink-0 ${lang === 'en' ? 'text-xs' : 'text-[11px]'}`}>×</span>
              {lockGangsheetSize ? (
                <span className={`h-7 min-w-[4.5rem] rounded border border-gray-200 bg-gray-100 px-2 py-1 text-center font-semibold tabular-nums text-gray-900 shrink-0 ${lang === 'en' ? 'text-xs' : 'text-[10px]'}`}>{formatLength(artboardHeight, lang)}{lang === "en" ? '"' : ""}</span>
              ) : (
                <Select
                  value={String(artboardHeight)}
                  onValueChange={(v) => onArtboardHeightChange?.(parseFloat(v))}
                >
                  <SelectTrigger
                   className={`h-8 w-[4.5rem] shrink-0 pl-2 pr-1.5 gap-0.5 font-semibold text-gray-900 bg-gray-100 border-gray-200 tabular-nums [&>span]:min-w-0 [&>span]:truncate [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0 ${lang === 'en' ? 'text-sm' : 'text-[12px]'}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[100]" position="popper" sideOffset={4}>
                    {gangsheetHeights.map((h) => {
                      const label = `${formatLength(h, lang)}${lang === "en" ? '"' : ""}`;
                      return (
                        <SelectItem
                          key={h}
                          value={String(h)}
                          textValue={label}
                           className={`tabular-nums ${lang !== 'en' ? 'text-[12px]' : 'text-sm'}`}
                        >
                          <span className="flex items-center justify-between gap-3 w-full">
                            <span>{label}</span>
                            {recommendedArtboardHeight === h && (
                               <span className="text-[11px] text-blue-700 font-medium shrink-0">
                                {t("controls.currentBounds")}
                              </span>
                            )}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}
        </div>
      </div>

      {enableFluorescent && imageInfo && fluorPanelContainer && createPortal(
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <button
            onClick={() => setShowSpotColors(!showSpotColors)}
            className={`flex items-center justify-between w-full px-3 py-2 text-left hover:bg-gray-100 transition-colors ${showSpotColors ? 'bg-purple-50' : ''}`}
          >
            <div className="flex items-center gap-2">
              <Palette className="w-3.5 h-3.5 text-purple-400" />
              <span className="text-xs font-medium text-gray-900">{t("controls.fluorColors")}</span>
              {assignedCount > 0 && (
                <span className="text-[9px] bg-purple-500/20 text-purple-500 px-1.5 py-0.5 rounded-full">
                  {t("controls.assigned", { count: assignedCount })}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={(e) => { e.stopPropagation(); setSpotPreviewEnabled(!spotPreviewEnabled); }}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                  spotPreviewEnabled
                    ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                    : 'bg-gray-100 text-gray-600 border border-gray-200 hover:bg-gray-200'
                }`}
                title={spotPreviewEnabled ? t("controls.hideOverlay") : t("controls.showOverlay")}
              >
                {spotPreviewEnabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
              </button>
              <ChevronDown className={`w-3.5 h-3.5 text-gray-600 transition-transform ${showSpotColors ? 'rotate-180' : ''}`} />
            </div>
          </button>

          {showSpotColors && (
            <div className="px-3 pb-2.5 space-y-2">
              <div className="rounded-lg border border-purple-100 bg-purple-50/60 p-2">
                <div className="mb-1 flex items-center justify-between">
               <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-700">Color Select Wand</span>
                  {activeChannel && (
                    <button
                      type="button"
                      onClick={() => setActiveChannel(null)}
                       className="text-[11px] text-gray-600 hover:text-gray-900"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-4 gap-1">
                  {fluorChannels.map(channel => (
                    <button
                      key={channel.field}
                      type="button"
                      onClick={() => {
                        setActiveChannel(activeChannel === channel.field ? null : channel.field);
                        onPanModeChange?.(false);
                      }}
                     className={`rounded-md border py-1.5 text-[11px] font-bold transition-all ${
                        activeChannel === channel.field ? "scale-105 ring-2 ring-offset-1" : "opacity-70 hover:opacity-100"
                      }`}
                      style={{ backgroundColor: `${channel.color}${activeChannel === channel.field ? "" : "44"}`, borderColor: channel.color, color: "#111", ["--tw-ring-color" as string]: channel.color }}
                    >
                      {channel.label}
                    </button>
                  ))}
                </div>
                 <p className="mt-1 text-[11px] text-gray-600 leading-snug">
                  {activeChannel ? `Tap the preview to assign ${activeChannel.replace("spotFluor", "F")}.` : "Choose an ink, then tap a color in the preview."}
                </p>
                {activeChannel && panModeActive && (
                   <button type="button" onClick={() => onPanModeChange?.(false)} className="mt-1 text-[11px] text-amber-800 underline">
                    Return to paint mode
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={handleAutoAssign}
                 className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-[12px] font-bold shadow-sm transition-all hover:brightness-105"
                style={autoAssignActive
                  ? { background: "#e5e7eb", color: "#374151" }
                  : { background: "linear-gradient(135deg, #DFFF00, #39FF14 30%, #FF6600 65%, #FF00FF)", color: "#111" }}
              >
                {autoAssignActive ? <Undo2 className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                {autoAssignActive ? "Undo Auto Color" : "Auto Color it for me!"}
              </button>
              <div className="border-t border-gray-100 pt-1">
                <button type="button" onClick={() => setShowDetectedColors(value => !value)} className="flex w-full items-center justify-between py-1 text-left">
                   <span className="flex items-center gap-1.5 text-[12px] font-semibold text-gray-700">
                    <Palette className="h-3 w-3 text-gray-400" /> Detected Colors
                    <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] font-normal">{extractedColors.filter(c => c.percentage >= 0.1).length}</span>
                  </span>
                  <ChevronDown className={`h-3.5 w-3.5 text-gray-400 transition-transform ${showDetectedColors ? "rotate-180" : ""}`} />
                </button>
              </div>
              {extractedColors.length === 0 ? (
                <div className="text-xs text-gray-600 italic py-1">{t("controls.noColors")}</div>
              ) : showDetectedColors ? (
                <div className="flex flex-col gap-0.5 max-h-[240px] overflow-y-auto">
                  {sortedColorIndices
                    .filter((idx) => extractedColors[idx].percentage >= 0.5)
                    .map((idx) => {
                    const color = extractedColors[idx];
                    const isAssigned = color.spotFluorY || color.spotFluorM || color.spotFluorG || color.spotFluorOrange;
                    return (
                      <div key={idx} className={`flex items-center gap-2 px-2 py-1 rounded-md transition-colors ${
                        isAssigned
                          ? 'bg-purple-50 border border-purple-500/20'
                          : 'bg-gray-100/80 border border-transparent hover:border-gray-300'
                      }`}>
                        <div
                          className="w-3.5 h-3.5 rounded flex-shrink-0 border border-gray-300"
                          style={{ backgroundColor: color.hex }}
                          title={color.hex}
                        />
                        <span className="text-[10px] text-gray-700 truncate min-w-0 flex-1">{color.name || color.hex}</span>
                        <div className="flex gap-1 flex-shrink-0">
                          {([
                            { field: 'spotFluorY' as const, label: 'Y', bg: '#DFFF00' },
                            { field: 'spotFluorM' as const, label: 'M', bg: '#FF00FF' },
                            { field: 'spotFluorG' as const, label: 'G', bg: '#39FF14' },
                            { field: 'spotFluorOrange' as const, label: 'Or', bg: '#FF6600' },
                          ]).map(({ field, label, bg }) => (
                            <button
                              key={field}
                              onClick={() => updateSpotColor(idx, field, !color[field])}
                              className={`w-5 h-5 rounded text-[8px] font-bold flex items-center justify-center transition-all ${
                                color[field]
                                  ? 'ring-1 ring-offset-1 ring-offset-white scale-110'
                                  : 'opacity-40 hover:opacity-80'
                              }`}
                        style={{
                          backgroundColor: color[field] ? bg : 'transparent',
                          color: color[field] ? '#000' : bg,
                          border: `1.5px solid ${bg}`,
                          ['--tw-ring-color' as string]: bg,
                        }}
                              title={`Fluorescent ${label}`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}

            </div>
          )}
        </div>,
        fluorPanelContainer
      )}

      {enableFluorescent && imageInfo && fluorPanelContainer && createPortal(
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden mt-2">
          <button
            onClick={() => setShowFluorInfo(prev => !prev)}
            className="flex items-center justify-between w-full px-3 py-2 text-left hover:bg-gray-100 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Info className="w-3.5 h-3.5 text-cyan-600" />
              <span className="text-xs font-medium text-gray-700">{t("controls.howFluorWorks")}</span>
            </div>
            <ChevronDown className={`w-3.5 h-3.5 text-gray-600 transition-transform ${showFluorInfo ? 'rotate-180' : ''}`} />
          </button>

          {showFluorInfo && (
            <div className="px-3 pb-3">
              <div className="mb-3">
                <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-1.5">{t("controls.availableInks")}</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {[
                    { name: 'Yellow', color: '#DFFF00' },
                    { name: 'Magenta', color: '#FF00FF' },
                    { name: 'Orange', color: '#FF6600' },
                    { name: 'Green', color: '#39FF14' },
                  ].map(ink => (
                    <div key={ink.name} className="flex items-center gap-1.5 bg-gray-200/60 rounded px-2 py-1">
                      <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: ink.color }} />
                      <span className="text-[10px] font-medium text-gray-700">{INK_NAMES[ink.name]}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mb-3">
                <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-1.5">{t("controls.howItWorks")}</p>
                <div className="space-y-1.5 text-[10px] text-gray-600 leading-relaxed">
                  <div className="flex gap-2">
                    <span className="text-cyan-600 font-bold flex-shrink-0">1.</span>
                    <span>{t("controls.fluorStep1")}</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-cyan-600 font-bold flex-shrink-0">2.</span>
                    <span>{t("controls.fluorStep2")}</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-cyan-600 font-bold flex-shrink-0">3.</span>
                    <span>{t("controls.fluorStep3")}</span>
                  </div>
                </div>
              </div>

              <p className="text-[10px] text-gray-600 leading-relaxed mb-2">
                {t("controls.fluorNote")}
              </p>
            </div>
          )}
        </div>,
        fluorPanelContainer
      )}

      {downloadContainer && createPortal(
        <div
          /* `flex-wrap`: with the edit-mode "Regenerate file" checkbox in the
             row, a narrow phone in French can't fit checkbox + button side by
             side; wrapping drops the button to its own full-width line instead
             of overflowing. With no checkbox the single flex-1 button never
             wraps, so other layouts are unaffected. */
          className={`flex flex-wrap items-center gap-3 bg-white border-t border-gray-200 px-4 py-2 ${
            isMobile ? "fixed bottom-0 left-0 right-0 z-40 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)]" : ""
          }`}
          style={isMobile ? { paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" } : undefined}
        >
          <div className={`flex items-center gap-2 text-xs text-gray-600 flex-shrink-0 ${isMobile ? 'hidden' : ''}`}>
            <FileCheck className="w-3.5 h-3.5 text-gray-600" />
            <span className="tabular-nums">{designCount !== 1 ? t("controls.designsPlural", { count: designCount }) : t("controls.designs", { count: designCount })}</span>
            <span className="text-gray-600">·</span>
            <span className={`tabular-nums ${lang !== 'en' ? 'text-[10px]' : ''}`}>{formatLength(artboardWidth, lang)}{lang === 'en' ? '"' : ''} × {formatLength(artboardHeight, lang)}{lang === 'en' ? '"' : ''}</span>
          </div>
          {onRegenerateProductionChange && (
            <label
              className="flex flex-shrink-0 cursor-pointer select-none items-center gap-1.5 text-xs text-gray-700"
              title={t("controls.regenerateFileHint")}
            >
              <input
                type="checkbox"
                checked={!!regenerateProduction}
                onChange={(e) => onRegenerateProductionChange(e.target.checked)}
                className="h-4 w-4 accent-emerald-600"
              />
              <span className="whitespace-nowrap">{t("controls.regenerateFile")}</span>
            </label>
          )}
          {hasVariantId && onAddToCart ? (
            <Button
              onClick={onAddToCart}
              disabled={isProcessing || !canDownload}
              title={
                !canDownload
                  ? t("controls.uploadFirst")
                  : isAddingToCart
                      ? (exportProgressLabel || t("controls.addingToCart"))
                    : isProcessing
                    ? (exportProgressLabel || t("editor.processing"))
                      : (addToCartLabel || t("controls.addToCart"))
              }
              /* 44px on the phone: this bar is `position: fixed` inside a 64px
                 reserve, so the extra 4px costs no canvas. Keyed to `isMobile`
                 rather than `coarse:` because an iPad renders this bar inline
                 and its layout has to stay put. */
              className={`flex-1 ${isMobile ? "h-11" : "h-10"} bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-600 hover:to-green-700 text-white rounded-lg shadow-lg shadow-emerald-500/25 font-medium disabled:opacity-50`}
            >
              {isAddingToCart ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                  {addingStatusLabel || t("controls.addingToCart")}
                </>
              ) : isProcessing ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                  {exportProgressLabel || t("editor.processing")}
                </>
              ) : (
                <>
                  <ShoppingCart className="w-5 h-5 mr-2" />
                  {addToCartLabel || t("controls.addToCart")}
                </>
              )}
            </Button>
          ) : (
            <Button
              onClick={handleDownloadClick}
              disabled={isProcessing || !canDownload}
              title={dlTitle}
              className={`flex-1 ${isMobile ? "h-11" : "h-10"} bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-600 hover:to-blue-600 text-white rounded-lg shadow-lg shadow-cyan-500/25 font-medium disabled:opacity-50`}
            >
              {isProcessing ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                  {t("editor.processing")}
                </>
              ) : (
                <>
                  <Download className="w-5 h-5 mr-2" />
                  {dlLabel}
                </>
              )}
            </Button>
          )}
        </div>,
        downloadContainer
      )}
    </div>
  );
}

// Wrap in `React.memo` so unrelated view state changes (halftone menu
// open/close, mobile-panel toggle, spot-channel hover, etc.) skip
// re-rendering this ~900-line panel when all of its props are
// shallow-equal. Callback props at the call site are `useCallback`-
// wrapped so memo's shallow-compare has a real chance to short-circuit.
export default memo(ControlsSection);

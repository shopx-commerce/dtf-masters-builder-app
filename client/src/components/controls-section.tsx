import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ResizeSettings, ImageInfo } from "./image-editor";
import { Download, Layers, FileCheck, Palette, Eye, EyeOff, ChevronDown, Info } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { formatLength } from "@/lib/format-length";
import { useIsMobile } from "@/hooks/use-mobile";

export interface SpotPreviewData {
  enabled: boolean;
  colors: ExtractedColor[];
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
};

interface ControlsSectionProps {
  resizeSettings: ResizeSettings;
  onResizeChange: (settings: Partial<ResizeSettings>) => void;
  onDownload: (downloadType?: string, format?: string, spotColorsByDesign?: Record<string, any[]>) => void;
  isProcessing: boolean;
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
}

const DEFAULT_HEIGHTS = [12, 18, 24, 35, 40, 45, 48, 50, 55, 60, 65, 70, 80, 85, 95, 110, 120, 130, 140, 150];

export default function ControlsSection({
  onDownload,
  isProcessing,
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
}: ControlsSectionProps) {
  const { t, lang } = useLanguage();
  const isMobile = useIsMobile();
  const canDownload = !!imageInfo || designCount > 0;

  const [showSpotColors, setShowSpotColors] = useState(false);
  const [showFluorInfo, setShowFluorInfo] = useState(false);
  const [extractedColors, setExtractedColors] = useState<ExtractedColor[]>([]);
  const [spotPreviewEnabled, setSpotPreviewEnabled] = useState(true);
  const spotFluorYName = "FY";
  const spotFluorMName = "FM";
  const spotFluorGName = "FG";
  const spotFluorOrangeName = "FO";
  const colorCacheRef = useRef<Map<string, ExtractedColor[]>>(new Map());
  const spotSelectionsRef = useRef<Map<string, ExtractedColor[]>>(new Map());
  const prevDesignIdRef = useRef<string | null | undefined>(null);

  useEffect(() => {
    if (!enableFluorescent) return;

    let cancelled = false;

    if (prevDesignIdRef.current && extractedColors.length > 0) {
      spotSelectionsRef.current.set(prevDesignIdRef.current, extractedColors);
    }
    prevDesignIdRef.current = selectedDesignId;

    if (imageInfo?.image) {
      if (selectedDesignId && spotSelectionsRef.current.has(selectedDesignId)) {
        setExtractedColors(spotSelectionsRef.current.get(selectedDesignId)!);
      } else {
        const cacheKey = `${imageInfo.image.width}x${imageInfo.image.height}-${imageInfo.file?.name ?? 'unknown'}-${imageInfo.file?.size ?? 0}`;
        const cached = colorCacheRef.current.get(cacheKey);
        if (cached) {
          setExtractedColors(cached.map(c => ({ ...c })));
        } else {
          import("@/lib/color-extractor").then(({ extractColorsFromImageAsync, extractColorsFromImage }) => {
            if (cancelled) return;
            extractColorsFromImageAsync(imageInfo.image, 999).then(colors => {
              if (cancelled) return;
              if (colors.length === 0) {
                try {
                  const fallback = extractColorsFromImage(imageInfo.image, 999);
                  if (fallback.length > 0) {
                    colorCacheRef.current.set(cacheKey, fallback);
                    setExtractedColors(fallback);
                    return;
                  }
                } catch { /* sync fallback failed */ }
              }
              colorCacheRef.current.set(cacheKey, colors);
              if (colorCacheRef.current.size > 20) {
                const firstKey = colorCacheRef.current.keys().next().value;
                if (firstKey) colorCacheRef.current.delete(firstKey);
              }
              setExtractedColors(colors);
            }).catch((err) => {
              if (cancelled) return;
              try {
                const fallback = extractColorsFromImage(imageInfo.image, 999);
                colorCacheRef.current.set(cacheKey, fallback);
                setExtractedColors(fallback);
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

  const updateSpotColor = useCallback((index: number, field: 'spotFluorY' | 'spotFluorM' | 'spotFluorG' | 'spotFluorOrange', value: boolean) => {
    setExtractedColors(prev => {
      const updated = prev.map((color, i) => {
        if (i === index) {
          if (value) {
            return { ...color, spotFluorY: false, spotFluorM: false, spotFluorG: false, spotFluorOrange: false, [field]: true };
          }
          return { ...color, [field]: value };
        }
        return color;
      });
      if (selectedDesignId) {
        spotSelectionsRef.current.set(selectedDesignId, updated);
      }
      return updated;
    });
  }, [selectedDesignId]);

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

  const INK_NAMES: Record<string, string> = {
    Yellow: t("controls.fluorYellow"),
    Magenta: t("controls.fluorMagenta"),
    Orange: t("controls.fluorOrange"),
    Green: t("controls.fluorGreen"),
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <div className="w-6 h-6 rounded-md bg-cyan-500/10 flex items-center justify-center flex-shrink-0">
            <Layers className="w-3.5 h-3.5 text-cyan-600" />
          </div>
          <span className="text-xs font-medium text-gray-900 flex-shrink-0">{t("controls.gangsheetSize")}</span>
          <div className="flex items-center gap-1.5 ml-auto">
            <span className={`font-semibold text-gray-700 ${lang === 'en' ? 'text-xs' : 'text-[10px]'}`}>{formatLength(artboardWidth, lang)}{lang === "en" ? '"' : ""}</span>
            <span className={`text-gray-600 ${lang === 'en' ? 'text-xs' : 'text-[10px]'}`}>×</span>
            <Select value={String(artboardHeight)} onValueChange={(v) => onArtboardHeightChange?.(parseInt(v))}>
              <SelectTrigger className={`h-7 font-semibold text-gray-900 bg-gray-100 border-gray-200 ${lang === 'en' ? 'w-[68px] text-xs' : 'w-[80px] text-[10px]'}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {gangsheetHeights.map((h) => (
                  <SelectItem key={h} value={String(h)}>
                    <span className="flex items-center justify-between gap-3 w-full">
                      <span className={lang !== 'en' ? 'text-[10px]' : ''}>{formatLength(h, lang)}{lang === "en" ? '"' : ""}</span>
                      {recommendedArtboardHeight === h && (
                        <span className="text-[10px] text-blue-600 font-medium">
                          {t("controls.currentBounds")}
                        </span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
              {extractedColors.length === 0 ? (
                <div className="text-xs text-gray-600 italic py-1">{t("controls.noColors")}</div>
              ) : (
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
              )}

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
          className={`flex items-center gap-3 bg-white border-t border-gray-200 px-4 py-2 ${
            isMobile ? "fixed bottom-0 left-0 right-0 z-40 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)]" : ""
          }`}
          style={isMobile ? { paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" } : undefined}
        >
          <div className="flex items-center gap-2 text-xs text-gray-600 flex-shrink-0">
            <FileCheck className="w-3.5 h-3.5 text-gray-600" />
            <span className="tabular-nums">{designCount !== 1 ? t("controls.designsPlural", { count: designCount }) : t("controls.designs", { count: designCount })}</span>
            <span className="text-gray-600">·</span>
            <span className={`tabular-nums ${lang !== 'en' ? 'text-[10px]' : ''}`}>{formatLength(artboardWidth, lang)}{lang === 'en' ? '"' : ''} × {formatLength(artboardHeight, lang)}{lang === 'en' ? '"' : ''}</span>
          </div>
          <Button
            onClick={handleDownloadClick}
            disabled={isProcessing || !canDownload}
            title={dlTitle}
            className="flex-1 h-10 bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-600 hover:to-blue-600 text-white rounded-lg shadow-lg shadow-cyan-500/25 font-medium disabled:opacity-50"
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
        </div>,
        downloadContainer
      )}
    </div>
  );
}

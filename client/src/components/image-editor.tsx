import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { flushSync } from "react-dom";
import UploadSection from "./upload-section";
import PreviewSection from "./preview-section";
import ControlsSection, { type SpotPreviewData } from "./controls-section";
import CropModal from "./crop-modal";
import { cropImageToContent, cropImageToContentAsync, hasCleanAlpha, isOpaqueRasterUpload } from "@/lib/image-crop";

function inchesFromPixelsPair(pw: number, ph: number, dpi: number): { widthInches: number; heightInches: number } {
  const wIn = pw / dpi;
  const hIn = wIn * (ph / pw);
  return {
    widthInches: Math.max(0.01, parseFloat(wIn.toFixed(4))),
    heightInches: Math.max(0.01, parseFloat(hIn.toFixed(4))),
  };
}

const RASTER_DPI_FALLBACK = 144;

function normalizeRasterDpiForInches(dpi: number, image: HTMLImageElement): number {
  const w = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  const longEdge = Math.max(w, h);
  if (dpi >= 290 && longEdge > 0 && longEdge <= 2200) return RASTER_DPI_FALLBACK;
  return dpi;
}

function imageHasCleanAlpha(img: HTMLImageElement): boolean {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  if (!ctx) return false;
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  return hasCleanAlpha(data, width, height);
}
import { parsePDF, type ParsedPDFData } from "@/lib/pdf-parser";
import { useToast } from "@/hooks/use-toast";
import { useHistory, type HistorySnapshot } from "@/hooks/use-history";
import { useIsMobile } from "@/hooks/use-mobile";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useLanguage } from "@/lib/i18n";
import { formatDimensions, formatLength, useMetric, cmToInches, getUnitSuffix } from "@/lib/format-length";
import { formatVariantPriceForDisplay, getSelectedVariantPrice } from "@/lib/variant-price";
import { Trash2, Copy, ChevronDown, ChevronUp, Undo2, Redo2, RotateCw, ArrowUpLeft, ArrowUpRight, ArrowDownLeft, ArrowDownRight, LayoutGrid, Layers, Loader2, Plus, Minus, Droplets, Link, Unlink, FlipHorizontal2, FlipVertical2, MousePointerClick, XCircle, Stamp, Check, X, ScanSearch } from "lucide-react";

export type { ImageInfo, ResizeSettings, ImageTransform, DesignItem } from "@/lib/types";
import type { ImageInfo, ResizeSettings, ImageTransform, DesignItem } from "@/lib/types";
import { type ProfileConfig, HOT_PEEL_PROFILE } from "@/lib/profiles";

function SizeInput({
  value,
  onCommit,
  title,
  min = 0.1,
  max = 999,
  lang,
}: {
  value: number;
  onCommit: (v: number) => void;
  title: string;
  min?: number;
  max?: number;
  lang: "en" | "es" | "fr";
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const metric = useMetric(lang);
  const cm = value * 2.54;
  const useM = metric && cm >= 100;
  const display = metric
    ? useM
      ? (cm / 100).toFixed(2)
      : cm.toFixed(2)
    : value.toFixed(2);

  const commit = (raw: string) => {
    const v = parseFloat(raw);
    if (isNaN(v)) return;
    const inches = metric
      ? useM
        ? cmToInches(v * 100)
        : cmToInches(v)
      : v;
    onCommit(Math.max(min, Math.min(inches, max)));
  };

  if (editing) {
    return (
      <input
        type="text"
        inputMode="decimal"
        className={`h-5 bg-gray-100 border border-cyan-500 rounded font-semibold text-gray-900 text-center outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${metric ? 'w-16 text-[10px]' : 'w-14 text-[11px]'}`}
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          commit(draft);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit(draft);
            setEditing(false);
          } else if (e.key === "Escape") setEditing(false);
        }}
        title={title}
      />
    );
  }
  return (
    <input
      type="text"
      readOnly
      className={`h-5 bg-gray-100 border border-gray-300 rounded font-semibold text-gray-900 text-center outline-none cursor-pointer hover:border-gray-400 transition-colors ${metric ? 'w-16 text-[10px]' : 'w-14 text-[11px]'}`}
      value={display}
      onFocus={() => {
        setDraft(display);
        setEditing(true);
      }}
      title={title}
    />
  );
}

import ExportWorkerModule from '@/lib/export-worker?worker';
import ArrangeWorkerModule from '@/lib/arrange-worker?worker';

let _exportWorker: Worker | null = null;
function getExportWorker(): Worker | null {
  if (!_exportWorker) {
    try { _exportWorker = new ExportWorkerModule(); }
    catch { return null; }
  }
  return _exportWorker;
}

let _arrangeWorker: Worker | null = null;
function getArrangeWorker(): Worker | null {
  if (!_arrangeWorker) {
    try { _arrangeWorker = new ArrangeWorkerModule(); }
    catch { return null; }
  }
  return _arrangeWorker;
}

async function fetchImageDpi(file: File): Promise<number> {
  try {
    const form = new FormData();
    form.append('image', file);
    const res = await fetch('/api/image-info', { method: 'POST', body: form });
    if (!res.ok) return RASTER_DPI_FALLBACK;
    const data = await res.json();
    const d = Number(data.density);
    if (!Number.isFinite(d) || d <= 0) return RASTER_DPI_FALLBACK;
    return Math.min(d, 300);
  } catch {
    return RASTER_DPI_FALLBACK;
  }
}

let _exportReqCounter = 0;
let _arrangeReqCounter = 0;

function readU32(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

async function injectPngDpi(blob: Blob, dpi: number): Promise<Blob> {
  const ppm = Math.round(dpi / 0.0254);
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (buf.length < 8) return blob;
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return blob;

  const parts: Uint8Array[] = [];
  parts.push(buf.slice(0, 8));

  const ihdrDataLen = readU32(buf, 8);
  const ihdrTotal = 12 + ihdrDataLen;
  parts.push(buf.slice(8, 8 + ihdrTotal));
  let offset = 8 + ihdrTotal;

  const PHYS_DATA_LEN = 9;
  const physChunk = new Uint8Array(4 + 4 + PHYS_DATA_LEN + 4);
  const pv = new DataView(physChunk.buffer);
  pv.setUint32(0, PHYS_DATA_LEN);
  physChunk[4] = 0x70; physChunk[5] = 0x48; physChunk[6] = 0x59; physChunk[7] = 0x73;
  pv.setUint32(8, ppm);
  pv.setUint32(12, ppm);
  physChunk[16] = 1;
  pv.setUint32(17, crc32(physChunk.slice(4, 4 + 4 + PHYS_DATA_LEN)));
  parts.push(physChunk);

  while (offset + 12 <= buf.length) {
    const dataLen = readU32(buf, offset);
    const chunkTotal = 12 + dataLen;
    const isPHYs = buf[offset + 4] === 0x70 && buf[offset + 5] === 0x48 &&
                   buf[offset + 6] === 0x59 && buf[offset + 7] === 0x73;
    if (!isPHYs) parts.push(buf.slice(offset, offset + chunkTotal));
    offset += chunkTotal;
  }

  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(totalLen);
  let writePos = 0;
  for (const part of parts) { out.set(part, writePos); writePos += part.length; }
  return new Blob([out], { type: 'image/png' });
}

function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function getStampExtra(d: { heightInches: number; transform: ImageTransform; printFileName?: boolean }): number {
  if (!d.printFileName) return 0;
  return 0.1 + d.heightInches * d.transform.s * 0.05;
}

function getEffectiveHeight(d: { heightInches: number; transform: ImageTransform; printFileName?: boolean }): number {
  return d.heightInches * d.transform.s + getStampExtra(d);
}

function getRotatedBounds(
  d: { widthInches: number; heightInches: number; transform: ImageTransform; printFileName?: boolean },
): { minX: number; maxX: number; minY: number; maxY: number } {
  const t = d.transform;
  const w = d.widthInches * t.s;
  const h = d.heightInches * t.s;
  const stamp = getStampExtra(d);
  const rad = (t.rotation * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const corners = [
    { x: -w / 2, y: -h / 2 },
    { x:  w / 2, y: -h / 2 },
    { x:  w / 2, y:  h / 2 + stamp },
    { x: -w / 2, y:  h / 2 + stamp },
  ];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of corners) {
    const rx = c.x * cosA - c.y * sinA;
    const ry = c.x * sinA + c.y * cosA;
    if (rx < minX) minX = rx;
    if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry;
    if (ry > maxY) maxY = ry;
  }
  return { minX, maxX, minY, maxY };
}

function clampDesignToArtboard(
  d: { widthInches: number; heightInches: number; transform: ImageTransform; printFileName?: boolean },
  abW: number, abH: number,
): { nx: number; ny: number } {
  const t = d.transform;
  const { minX, maxX, minY, maxY } = getRotatedBounds(d);
  const minNx = -minX / abW;
  const maxNx = 1 - maxX / abW;
  const minNy = -minY / abH;
  const maxNy = 1 - maxY / abH;
  let nx = t.nx;
  let ny = t.ny;
  if (minNx <= maxNx) {
    nx = Math.max(minNx, Math.min(maxNx, nx));
  }
  if (minNy <= maxNy) {
    ny = Math.max(minNy, Math.min(maxNy, ny));
  }
  return { nx, ny };
}

export default function ImageEditor({ onDesignUploaded, profile = HOT_PEEL_PROFILE, initialWidth, initialHeight, initialGangsheetHeights, initialQuantity, shopifyVariants, variantId: initialVariantId, shopDomain, embedFromShopify }: { onDesignUploaded?: () => void; profile?: ProfileConfig; initialWidth?: number; initialHeight?: number; initialGangsheetHeights?: number[]; initialQuantity?: number; shopifyVariants?: Array<{ id: string; title: string; price: string | null; height: number | null }>; variantId?: string | null; shopDomain?: string | null; embedFromShopify?: boolean } = {}) {
  const { toast } = useToast();
  const { t, lang } = useLanguage();
  const isMobile = useIsMobile();
  const isLgUp = useMediaQuery("(min-width: 1024px)");
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const [resizeSettings, setResizeSettings] = useState<ResizeSettings>({
    widthInches: 5.0,
    heightInches: 3.8,
    maintainAspectRatio: true,
    outputDPI: 300,
  });
  const [isProcessing, setIsProcessing] = useState(false);
  /** True after Add to Cart until parent finishes upload/redirect (avoid double-submit). */
  const [isAddingToCart, setIsAddingToCart] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [artboardWidth, setArtboardWidth] = useState(initialWidth ?? profile.artboardWidth);
  const [artboardHeight, setArtboardHeight] = useState(initialHeight ?? profile.gangsheetHeights[0] ?? 12);
  const [quantity, setQuantity] = useState(initialQuantity ?? 1);
  useEffect(() => {
    if (initialQuantity != null && initialQuantity >= 1) setQuantity(initialQuantity);
  }, [initialQuantity]);
  const [designGap, setDesignGap] = useState<number | undefined>(0.25);
  const [duplicateCount, setDuplicateCount] = useState(1);
  const clampDuplicateCount = useCallback((value: number) => Math.max(1, Math.min(99, value)), []);
  const parseDuplicateCount = useCallback((raw: string) => clampDuplicateCount(parseInt(raw, 10) || 1), [clampDuplicateCount]);
  const handleDuplicateCountKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setDuplicateCount((prev) => clampDuplicateCount(prev + 1));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setDuplicateCount((prev) => clampDuplicateCount(prev - 1));
    }
  }, [clampDuplicateCount]);
  const [designTransform, setDesignTransform] = useState<ImageTransform>({ nx: 0.5, ny: 0.5, s: 1, rotation: 0 });
  const [designs, setDesigns] = useState<DesignItem[]>([]);
  const [selectedDesignId, setSelectedDesignId] = useState<string | null>(null);
  const [selectedDesignIds, setSelectedDesignIds] = useState<Set<string>>(new Set());
  const [mobilePanel, setMobilePanel] = useState<"controls" | "preview">("controls");
  const [showDesignInfo, setShowDesignInfo] = useState(false);
  const [selectionZoomActive, setSelectionZoomActive] = useState(false);
  const [editingLayerName, setEditingLayerName] = useState<string | null>(null);
  const [editingNameValue, setEditingNameValue] = useState('');
  const clipboardRef = useRef<DesignItem[]>([]);
  const [proportionalLock, setProportionalLock] = useState(true);
  const designInfoRef = useRef<HTMLDivElement>(null);
  const sidebarFileRef = useRef<HTMLInputElement>(null);
  const headerUploadInputRef = useRef<HTMLInputElement>(null);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [downloadContainer, setDownloadContainer] = useState<HTMLDivElement | null>(null);
  const [spotPreviewData, setSpotPreviewData] = useState<SpotPreviewData>({ enabled: false, colors: [] });
  const [fluorPanelContainer, setFluorPanelContainer] = useState<HTMLDivElement | null>(null);
  const [mobileToolbarContainer, setMobileToolbarContainer] = useState<HTMLDivElement | null>(null);
  const copySpotSelectionsRef = useRef<((fromId: string, toIds: string[]) => void) | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; designId: string } | null>(null);
  const [cropModalDesignId, setCropModalDesignId] = useState<string | null>(null);

  // Undo/Redo history
  const { pushSnapshot, undo, redo, clearIsUndoRedo, canUndo, canRedo } = useHistory();
  const mountedRef = useRef(true);
  useEffect(() => { return () => { mountedRef.current = false; }; }, []);
  const designsRef = useRef(designs);
  designsRef.current = designs;
  const nudgeSnapshotSavedRef = useRef(false);
  const nudgeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thumbnailCacheRef = useRef<Map<string, string>>(new Map());
  const multiDragAccumRef = useRef<{ totalDnx: number; totalDny: number; starts: Map<string, {nx: number; ny: number}> } | null>(null);
  const multiResizeStartRef = useRef<Map<string, { nx: number; ny: number; s: number }> | null>(null);
  const multiRotateStartRef = useRef<Map<string, { nx: number; ny: number; rotation: number }> | null>(null);

  const snapshotCacheRef = useRef<{designs: DesignItem[]; json: string; infoMap: Map<string, ImageInfo>} | null>(null);
  const getSnapshot = useCallback((): HistorySnapshot => {
    const currentDesigns = designsRef.current;
    let json: string;
    let infoMap: Map<string, ImageInfo>;
    const cache = snapshotCacheRef.current;
    if (cache && cache.designs === currentDesigns) {
      json = cache.json;
      infoMap = cache.infoMap;
    } else {
      json = JSON.stringify(currentDesigns.map(d => ({ id: d.id, transform: d.transform, widthInches: d.widthInches, heightInches: d.heightInches, name: d.name })));
      infoMap = new Map(currentDesigns.map(d => [d.id, d.imageInfo]));
      snapshotCacheRef.current = { designs: currentDesigns, json, infoMap };
    }
    return { designsJson: json, selectedDesignId, imageInfoMap: infoMap, artboardWidth: artboardWidthRef.current, artboardHeight: artboardHeightRef.current };
  }, [selectedDesignId]);

  const saveSnapshot = useCallback(() => {
    pushSnapshot(getSnapshot());
  }, [pushSnapshot, getSnapshot]);

  const applySnapshot = useCallback((snap: HistorySnapshot) => {
    let parsed: Array<{ id: string; transform: ImageTransform; widthInches: number; heightInches: number; name: string }>;
    try {
      parsed = JSON.parse(snap.designsJson);
    } catch {
      clearIsUndoRedo();
      return;
    }
    const infoMap = snap.imageInfoMap ?? new Map<string, unknown>();
    let restoredIds: Set<string> = new Set();
    setDesigns(prev => {
      const lookup = new Map(prev.map(d => [d.id, d]));
      const restored = parsed.map(p => {
        const existing = lookup.get(p.id);
        const savedInfo = infoMap.get(p.id) as ImageInfo | undefined;
        if (existing) {
          return {
            ...existing,
            imageInfo: savedInfo ?? existing.imageInfo,
            transform: p.transform,
            widthInches: p.widthInches,
            heightInches: p.heightInches,
            name: p.name,
            ...(savedInfo ? { alphaThresholded: undefined } : {}),
          };
        }
        if (savedInfo) {
          return { id: p.id, imageInfo: savedInfo, transform: p.transform, widthInches: p.widthInches, heightInches: p.heightInches, name: p.name, originalDPI: savedInfo.dpi } as DesignItem;
        }
        return null;
      }).filter(Boolean) as DesignItem[];
      restoredIds = new Set(restored.map(d => d.id));
      return restored;
    });
    const validSelectedId = restoredIds.has(snap.selectedDesignId) ? snap.selectedDesignId : null;
    setSelectedDesignId(validSelectedId);
    if (validSelectedId) {
      const sel = parsed.find(p => p.id === validSelectedId);
      if (sel) setDesignTransform(sel.transform);
    } else {
      setDesignTransform({ nx: 0.5, ny: 0.5, s: 1, rotation: 0 });
    }
    if (snap.artboardWidth !== undefined) setArtboardWidth(snap.artboardWidth);
    if (snap.artboardHeight !== undefined) setArtboardHeight(snap.artboardHeight);
    setSelectedDesignIds(new Set());
    clearIsUndoRedo();
  }, [clearIsUndoRedo]);

  const handleUndo = useCallback(() => {
    const snap = undo(getSnapshot());
    if (snap) applySnapshot(snap);
  }, [undo, getSnapshot, applySnapshot]);

  const handleRedo = useCallback(() => {
    const snap = redo(getSnapshot());
    if (snap) applySnapshot(snap);
  }, [redo, getSnapshot, applySnapshot]);

  // Called when a drag/resize/rotate interaction ends on the canvas
  const handleInteractionEnd = useCallback(() => {
    multiDragAccumRef.current = null;
    multiResizeStartRef.current = null;
    multiRotateStartRef.current = null;
    saveSnapshot();
  }, [saveSnapshot]);


  const selectedDesign = useMemo(() => designs.find(d => d.id === selectedDesignId) || null, [designs, selectedDesignId]);
  const activeImageInfo = useMemo(() => selectedDesign?.imageInfo ?? imageInfo, [selectedDesign, imageInfo]);
  const activeDesignTransform = useMemo(() => selectedDesign?.transform ?? designTransform, [selectedDesign, designTransform]);
  const activeWidthInches = useMemo(() => selectedDesign?.widthInches ?? resizeSettings.widthInches, [selectedDesign, resizeSettings.widthInches]);
  const activeHeightInches = useMemo(() => selectedDesign?.heightInches ?? resizeSettings.heightInches, [selectedDesign, resizeSettings.heightInches]);
  const activeResizeSettings = useMemo(() => ({
    ...resizeSettings,
    widthInches: activeWidthInches,
    heightInches: activeHeightInches,
  }), [resizeSettings, activeWidthInches, activeHeightInches]);

  const selectedVariantPrice = useMemo(
    () => getSelectedVariantPrice(shopifyVariants, artboardHeight),
    [shopifyVariants, artboardHeight]
  );

  const effectiveDPI = useMemo(() => {
    if (!activeImageInfo) return 300;
    return activeImageInfo.dpi;
  }, [activeImageInfo]);

  const layerRows = useMemo(() => {
    const baseNameOf = (name: string) => name.replace(/ copy( \d+)?$/, '');
    const sizeKeyOf = (d: DesignItem) => `${(d.widthInches * d.transform.s).toFixed(2)}x${(d.heightInches * d.transform.s).toFixed(2)}`;
    const firstSizeByBase = new Map<string, string>();
    const groups = new Map<string, DesignItem[]>();
    for (const d of designs) {
      const base = baseNameOf(d.name);
      const sk = sizeKeyOf(d);
      if (!firstSizeByBase.has(base)) firstSizeByBase.set(base, sk);
      const key = `${base}::${sk}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(d);
    }
    return Array.from(groups.entries()).map(([key, designsInGroup]) => {
      const [baseName, sizeKey] = key.split('::');
      const origSize = firstSizeByBase.get(baseName) ?? sizeKey;
      return {
        baseName,
        sizeKey,
        designs: designsInGroup,
        isResized: sizeKey !== origSize,
      };
    });
  }, [designs]);

  useEffect(() => {
    if (activeImageInfo && onDesignUploaded) {
      onDesignUploaded();
    }
  }, [activeImageInfo, onDesignUploaded]);

  const handleSelectDesign = useCallback((id: string | null) => {
    flushSync(() => {
      setSelectedDesignId(id);
      setSelectedDesignIds(id ? new Set([id]) : new Set());
    });
  }, []);

  const handleMultiSelect = useCallback((ids: string[]) => {
    setSelectedDesignIds(new Set(ids));
    if (ids.length === 1) {
      setSelectedDesignId(ids[0]);
    } else if (ids.length === 0) {
      setSelectedDesignId(null);
    } else {
      setSelectedDesignId(ids[ids.length - 1]);
    }
  }, []);

  const getLayerThumbnail = useCallback((design: DesignItem): string => {
    try {
      const cache = thumbnailCacheRef.current;
      const key = design.imageInfo?.image?.src ?? design.id;
      if (cache.has(key)) return cache.get(key)!;
      const THUMB_SIZE = 48;
      const img = design.imageInfo.image;
      if (!img || !img.width || !img.height) return '';
      const aspect = img.width / img.height;
      const tw = Math.max(1, aspect >= 1 ? THUMB_SIZE : Math.round(THUMB_SIZE * aspect));
      const th = Math.max(1, aspect >= 1 ? Math.round(THUMB_SIZE / aspect) : THUMB_SIZE);
      const c = document.createElement('canvas');
      c.width = tw;
      c.height = th;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, tw, th);
        const dataUrl = c.toDataURL('image/png');
        cache.set(key, dataUrl);
        return dataUrl;
      }
      return key;
    } catch {
      return '';
    }
  }, []);

  const handleDesignTransformChange = useCallback((transform: ImageTransform) => {
    setDesignTransform(transform);
    if (selectedDesignId) {
      setDesigns(prev => prev.map(d => d.id === selectedDesignId ? { ...d, transform } : d));
    }
  }, [selectedDesignId]);

  const handleMultiDragDelta = useCallback((dnx: number, dny: number) => {
    setDesigns(prev => {
      // On first call of a drag, capture starting positions
      if (!multiDragAccumRef.current) {
        multiDragAccumRef.current = {
          totalDnx: 0,
          totalDny: 0,
          starts: new Map(
            prev.filter(d => selectedDesignIds.has(d.id))
              .map(d => [d.id, { nx: d.transform.nx, ny: d.transform.ny }])
          ),
        };
      }

      const accum = multiDragAccumRef.current;
      accum.totalDnx += dnx;
      accum.totalDny += dny;

      // Find the max allowed cumulative delta so no selected design exits the artboard.
      // Using original positions ensures perfect mouse tracking when reversing direction.
      let allowedDnx = accum.totalDnx;
      let allowedDny = accum.totalDny;

      for (const d of prev) {
        if (!selectedDesignIds.has(d.id)) continue;
        const start = accum.starts.get(d.id);
        if (!start) continue;
        const t = d.transform;
        const rad = (t.rotation * Math.PI) / 180;
        const cos = Math.abs(Math.cos(rad));
        const sin = Math.abs(Math.sin(rad));
        const halfW = (d.widthInches * t.s * cos + d.heightInches * t.s * sin) / 2;
        const halfH = (d.widthInches * t.s * sin + d.heightInches * t.s * cos) / 2;
        const minNx = halfW / artboardWidth;
        const maxNx = 1 - halfW / artboardWidth;
        const minNy = halfH / artboardHeight;
        const maxNy = 1 - halfH / artboardHeight;

        if (minNx <= maxNx) {
          allowedDnx = Math.max(minNx - start.nx, Math.min(maxNx - start.nx, allowedDnx));
        }
        if (minNy <= maxNy) {
          allowedDny = Math.max(minNy - start.ny, Math.min(maxNy - start.ny, allowedDny));
        }
      }

      return prev.map(d => {
        if (!selectedDesignIds.has(d.id)) return d;
        const start = accum.starts.get(d.id);
        if (!start) return d;
        return {
          ...d,
          transform: {
            ...d.transform,
            nx: start.nx + allowedDnx,
            ny: start.ny + allowedDny,
          },
        };
      });
    });
  }, [selectedDesignIds, artboardWidth, artboardHeight]);

  const handleMultiResizeDelta = useCallback((scaleRatio: number, centerNx: number, centerNy: number) => {
    setDesigns(prev => {
      if (!multiResizeStartRef.current) {
        multiResizeStartRef.current = new Map(
          prev.filter(d => selectedDesignIds.has(d.id))
            .map(d => [d.id, { nx: d.transform.nx, ny: d.transform.ny, s: d.transform.s }])
        );
      }
      const starts = multiResizeStartRef.current;
      const centerX = centerNx * artboardWidth;
      const centerY = centerNy * artboardHeight;

      const unclamped = new Map<string, { nx: number; ny: number; s: number }>();
      for (const d of prev) {
        if (!selectedDesignIds.has(d.id)) continue;
        const start = starts.get(d.id);
        if (!start) continue;
        const newS = Math.max(0.05, start.s * scaleRatio);
        const px = start.nx * artboardWidth - centerX;
        const py = start.ny * artboardHeight - centerY;
        unclamped.set(d.id, {
          nx: (centerX + px * scaleRatio) / artboardWidth,
          ny: (centerY + py * scaleRatio) / artboardHeight,
          s: newS,
        });
      }

      let shiftR = 0, shiftL = 0, shiftD = 0, shiftU = 0;
      for (const d of prev) {
        if (!selectedDesignIds.has(d.id)) continue;
        const u = unclamped.get(d.id);
        if (!u) continue;
        const rad = (d.transform.rotation * Math.PI) / 180;
        const cos = Math.abs(Math.cos(rad));
        const sin = Math.abs(Math.sin(rad));
        const halfW = (d.widthInches * u.s * cos + d.heightInches * u.s * sin) / 2;
        const halfH = (d.widthInches * u.s * sin + d.heightInches * u.s * cos) / 2;
        const minNx = halfW / artboardWidth;
        const maxNx = 1 - halfW / artboardWidth;
        const minNy = halfH / artboardHeight;
        const maxNy = 1 - halfH / artboardHeight;
        if (minNx <= maxNx) {
          if (u.nx < minNx) shiftR = Math.max(shiftR, minNx - u.nx);
          if (u.nx > maxNx) shiftL = Math.max(shiftL, u.nx - maxNx);
        }
        if (minNy <= maxNy) {
          if (u.ny < minNy) shiftD = Math.max(shiftD, minNy - u.ny);
          if (u.ny > maxNy) shiftU = Math.max(shiftU, u.ny - maxNy);
        }
      }
      const groupDnx = shiftR - shiftL;
      const groupDny = shiftD - shiftU;

      return prev.map(d => {
        if (!selectedDesignIds.has(d.id)) return d;
        const u = unclamped.get(d.id);
        if (!u) return d;
        const rad = (d.transform.rotation * Math.PI) / 180;
        const cos = Math.abs(Math.cos(rad));
        const sin = Math.abs(Math.sin(rad));
        const halfW = (d.widthInches * u.s * cos + d.heightInches * u.s * sin) / 2;
        const halfH = (d.widthInches * u.s * sin + d.heightInches * u.s * cos) / 2;
        const adjNx = u.nx + groupDnx;
        const adjNy = u.ny + groupDny;
        const clampedNx = Math.max(halfW / artboardWidth, Math.min(1 - halfW / artboardWidth, adjNx));
        const clampedNy = Math.max(halfH / artboardHeight, Math.min(1 - halfH / artboardHeight, adjNy));
        return {
          ...d,
          transform: { ...d.transform, s: u.s, nx: clampedNx, ny: clampedNy },
        };
      });
    });
  }, [selectedDesignIds, artboardWidth, artboardHeight]);

  const handleMultiRotateDelta = useCallback((angleDeg: number, centerNx: number, centerNy: number) => {
    setDesigns(prev => {
      if (!multiRotateStartRef.current) {
        multiRotateStartRef.current = new Map(
          prev.filter(d => selectedDesignIds.has(d.id))
            .map(d => [d.id, { nx: d.transform.nx, ny: d.transform.ny, rotation: d.transform.rotation }])
        );
      }
      const starts = multiRotateStartRef.current;
      const radDelta = (angleDeg * Math.PI) / 180;
      const cosD = Math.cos(radDelta);
      const sinD = Math.sin(radDelta);
      const centerX = centerNx * artboardWidth;
      const centerY = centerNy * artboardHeight;

      const unclamped = new Map<string, { nx: number; ny: number; rotation: number }>();
      for (const d of prev) {
        if (!selectedDesignIds.has(d.id)) continue;
        const start = starts.get(d.id);
        if (!start) continue;
        const px = start.nx * artboardWidth - centerX;
        const py = start.ny * artboardHeight - centerY;
        const rotPx = px * cosD - py * sinD;
        const rotPy = px * sinD + py * cosD;
        let newRot = start.rotation + angleDeg;
        newRot = ((newRot % 360) + 360) % 360;
        unclamped.set(d.id, {
          nx: (centerX + rotPx) / artboardWidth,
          ny: (centerY + rotPy) / artboardHeight,
          rotation: newRot,
        });
      }

      let shiftR = 0, shiftL = 0, shiftD = 0, shiftU = 0;
      for (const d of prev) {
        if (!selectedDesignIds.has(d.id)) continue;
        const u = unclamped.get(d.id);
        if (!u) continue;
        const rad = (u.rotation * Math.PI) / 180;
        const cos = Math.abs(Math.cos(rad));
        const sin = Math.abs(Math.sin(rad));
        const halfW = (d.widthInches * d.transform.s * cos + d.heightInches * d.transform.s * sin) / 2;
        const halfH = (d.widthInches * d.transform.s * sin + d.heightInches * d.transform.s * cos) / 2;
        const minNx = halfW / artboardWidth;
        const maxNx = 1 - halfW / artboardWidth;
        const minNy = halfH / artboardHeight;
        const maxNy = 1 - halfH / artboardHeight;
        if (minNx <= maxNx) {
          if (u.nx < minNx) shiftR = Math.max(shiftR, minNx - u.nx);
          if (u.nx > maxNx) shiftL = Math.max(shiftL, u.nx - maxNx);
        }
        if (minNy <= maxNy) {
          if (u.ny < minNy) shiftD = Math.max(shiftD, minNy - u.ny);
          if (u.ny > maxNy) shiftU = Math.max(shiftU, u.ny - maxNy);
        }
      }
      const groupDnx = shiftR - shiftL;
      const groupDny = shiftD - shiftU;

      return prev.map(d => {
        if (!selectedDesignIds.has(d.id)) return d;
        const u = unclamped.get(d.id);
        if (!u) return d;
        const rad = (u.rotation * Math.PI) / 180;
        const cos = Math.abs(Math.cos(rad));
        const sin = Math.abs(Math.sin(rad));
        const halfW = (d.widthInches * d.transform.s * cos + d.heightInches * d.transform.s * sin) / 2;
        const halfH = (d.widthInches * d.transform.s * sin + d.heightInches * d.transform.s * cos) / 2;
        const adjNx = u.nx + groupDnx;
        const adjNy = u.ny + groupDny;
        const clampedNx = Math.max(halfW / artboardWidth, Math.min(1 - halfW / artboardWidth, adjNx));
        const clampedNy = Math.max(halfH / artboardHeight, Math.min(1 - halfH / artboardHeight, adjNy));
        return {
          ...d,
          transform: { ...d.transform, rotation: Math.round(u.rotation), nx: clampedNx, ny: clampedNy },
        };
      });
    });
  }, [selectedDesignIds, artboardWidth, artboardHeight]);

  const handleEffectiveSizeChange = useCallback((axis: 'width' | 'height', value: number) => {
    if (!selectedDesignId || value <= 0) return;
    const design = designs.find(d => d.id === selectedDesignId);
    if (!design) return;
    const currentS = design.transform.s;
    const currentW = design.widthInches;
    const currentH = design.heightInches;
    if (currentW <= 0 || currentH <= 0 || currentS <= 0) return;
    saveSnapshot();

    const rad = (design.transform.rotation * Math.PI) / 180;
    const cosR = Math.abs(Math.cos(rad));
    const sinR = Math.abs(Math.sin(rad));
    const maxEffW = artboardWidth / Math.max(0.001, cosR + (currentH / currentW) * sinR);
    const maxEffH = artboardHeight / Math.max(0.001, sinR * (currentW / currentH) + cosR);
    const clampedValue = axis === 'width'
      ? Math.min(value, maxEffW)
      : Math.min(value, maxEffH);

    if (proportionalLock) {
      const newS = axis === 'width' ? clampedValue / currentW : clampedValue / currentH;
      const updated = { ...design, transform: { ...design.transform, s: newS } };
      const { nx, ny } = clampDesignToArtboard(updated, artboardWidth, artboardHeight);
      const newTransform = { ...design.transform, s: newS, nx, ny };
      setDesignTransform(newTransform);
      setDesigns(prev => prev.map(d => d.id === selectedDesignId ? { ...d, transform: newTransform } : d));
    } else {
      if (axis === 'width') {
        const newW = Math.max(0.01, Math.min(artboardWidth, clampedValue / currentS));
        const updated = { ...design, widthInches: newW };
        const { nx, ny } = clampDesignToArtboard(updated, artboardWidth, artboardHeight);
        setResizeSettings(prev => ({ ...prev, widthInches: newW }));
        setDesigns(prev => prev.map(d => d.id === selectedDesignId ? { ...d, widthInches: newW, transform: { ...d.transform, nx, ny } } : d));
      } else {
        const newH = Math.max(0.01, Math.min(artboardHeight, clampedValue / currentS));
        const updated = { ...design, heightInches: newH };
        const { nx, ny } = clampDesignToArtboard(updated, artboardWidth, artboardHeight);
        setResizeSettings(prev => ({ ...prev, heightInches: newH }));
        setDesigns(prev => prev.map(d => d.id === selectedDesignId ? { ...d, heightInches: newH, transform: { ...d.transform, nx, ny } } : d));
      }
    }
  }, [selectedDesignId, designs, proportionalLock, saveSnapshot, artboardWidth, artboardHeight]);

  const isArtboardFull = useCallback((extraDesigns?: DesignItem[]) => {
    if (designs.length === 0) return false;
    const allDesigns = extraDesigns ? [...designs, ...extraDesigns] : designs;
    const usableW = artboardWidth;
    const usableH = artboardHeight;

    type Seg = { x: number; y: number; w: number };
    let sky: Seg[] = [{ x: 0, y: 0, w: usableW }];

    const placeSeg = (segs: Seg[], px: number, iw: number, ih: number): Seg[] => {
      let topY = 0;
      for (const s of segs) {
        if (s.x < px + iw && s.x + s.w >= px - 0.01) topY = Math.max(topY, s.y);
      }
      const next: Seg[] = [];
      for (const s of segs) {
        const sR = s.x + s.w, iR = px + iw;
        if (sR <= px || s.x >= iR) { next.push(s); continue; }
        if (s.x < px) next.push({ x: s.x, y: s.y, w: px - s.x });
        if (sR > iR) next.push({ x: iR, y: s.y, w: sR - iR });
      }
      next.push({ x: px, y: topY + ih, w: iw });
      next.sort((a, b) => a.x - b.x);
      const merged: Seg[] = [next[0]];
      for (let k = 1; k < next.length; k++) {
        const prev = merged[merged.length - 1];
        if (Math.abs(prev.y - next[k].y) < 0.001 && Math.abs((prev.x + prev.w) - next[k].x) < 0.001) {
          prev.w += next[k].w;
        } else {
          merged.push(next[k]);
        }
      }
      return merged;
    };

    const sorted = [...allDesigns].sort((a, b) => {
      const aw = a.widthInches * a.transform.s;
      const ah = a.heightInches * a.transform.s;
      const bw = b.widthInches * b.transform.s;
      const bh = b.heightInches * b.transform.s;
      return Math.max(bw, bh) - Math.max(aw, ah);
    });

    for (const d of sorted) {
      const w = d.widthInches * d.transform.s;
      const h = d.heightInches * d.transform.s;

      const tryFit = (iw: number, ih: number): boolean => {
        for (let i = 0; i < sky.length; i++) {
          let spanW = 0, maxY = 0, j = i;
          while (j < sky.length && spanW < iw) {
            maxY = Math.max(maxY, sky[j].y);
            spanW += sky[j].w;
            j++;
          }
          if (spanW >= iw - 0.001 && maxY + ih <= usableH + 0.001) {
            sky = placeSeg(sky, sky[i].x, iw, ih);
            return true;
          }
        }
        return false;
      };

      if (!tryFit(w, h) && !tryFit(h, w)) {
        return true;
      }
    }
    return false;
  }, [designs, artboardWidth, artboardHeight]);

  const handleDuplicateDesign = useCallback((count: number = 1) => {
    if (!selectedDesignId || count < 1) return;
    const design = designs.find(d => d.id === selectedDesignId);
    if (!design) return;
    const baseName = design.name.replace(/ copy( \d+)?$/, '');
    const newDesigns: DesignItem[] = [];
    for (let i = 0; i < count; i++) {
      const newId = crypto.randomUUID();
      const offsetT = { ...design.transform, nx: design.transform.nx + 0.03 * (i + 1), ny: design.transform.ny };
      const { nx, ny } = clampDesignToArtboard({ ...design, transform: offsetT }, artboardWidth, artboardHeight);
      newDesigns.push({
        ...design,
        id: newId,
        name: baseName,
        transform: { ...design.transform, nx, ny },
        printFileName: false,
      });
    }
    saveSnapshot();
    setDesigns(prev => [...prev, ...newDesigns]);
    setSelectedDesignId(newDesigns[newDesigns.length - 1].id);
    setDuplicateCount(1);
  }, [selectedDesignId, designs, saveSnapshot, artboardWidth, artboardHeight]);

  const handleDuplicateAndArrange = useCallback((count: number) => {
    if (!selectedDesignId || count < 1) return;
    const design = designs.find(d => d.id === selectedDesignId);
    if (!design) return;
    const baseName = design.name.replace(/ copy( \d+)?$/, '');
    const newDesigns: DesignItem[] = [];
    for (let i = 0; i < count; i++) {
      const newId = crypto.randomUUID();
      const offsetT = { ...design.transform, nx: design.transform.nx + 0.03 * (i + 1), ny: design.transform.ny };
      const { nx, ny } = clampDesignToArtboard({ ...design, transform: offsetT }, artboardWidth, artboardHeight);
      newDesigns.push({
        ...design,
        id: newId,
        name: baseName,
        transform: { ...design.transform, nx, ny },
        printFileName: false,
      });
    }
    saveSnapshot();
    setDesigns(prev => [...prev, ...newDesigns]);
    setSelectedDesignId(newDesigns[newDesigns.length - 1].id);
    setDuplicateCount(1);
    requestAnimationFrame(() => {
      handleAutoArrangeRef.current({ skipSnapshot: true, preserveSelection: true });
    });
  }, [selectedDesignId, designs, saveSnapshot, artboardWidth, artboardHeight]);

  const handleDuplicateSelected = useCallback((): string[] => {
    const toDup = designs.filter(d => selectedDesignIds.has(d.id));
    if (toDup.length === 0) return [];
    const newIds: string[] = [];
    const newDesigns: DesignItem[] = toDup.map((d, i) => {
      const newId = crypto.randomUUID();
      newIds.push(newId);
      const base = d.name.replace(/ copy( \d+)?$/, '');
      const offsetT = { ...d.transform, nx: d.transform.nx + 0.03 + i * 0.01, ny: d.transform.ny };
      const { nx, ny } = clampDesignToArtboard({ ...d, transform: offsetT }, artboardWidth, artboardHeight);
      return { ...d, id: newId, name: base, transform: { ...d.transform, nx, ny }, printFileName: false };
    });
    multiDragAccumRef.current = null;
    multiResizeStartRef.current = null;
    multiRotateStartRef.current = null;
    saveSnapshot();
    setDesigns(prev => [...prev, ...newDesigns]);
    setSelectedDesignIds(new Set(newIds));
    if (newIds.length === 1) setSelectedDesignId(newIds[0]);
    else setSelectedDesignId(newIds[newIds.length - 1]);
    return newIds;
  }, [designs, selectedDesignIds, saveSnapshot, artboardWidth, artboardHeight]);

  const handleDuplicateById = useCallback((designId: string) => {
    const design = designs.find(d => d.id === designId);
    if (!design) return;
    const newId = crypto.randomUUID();
    const baseName = design.name.replace(/ copy( \d+)?$/, '');
    const offsetT = { ...design.transform, nx: design.transform.nx + 0.03, ny: design.transform.ny };
    const { nx, ny } = clampDesignToArtboard({ ...design, transform: offsetT }, artboardWidth, artboardHeight);
    const newDesign: DesignItem = {
      ...design,
      id: newId,
      name: baseName,
      transform: { ...design.transform, nx, ny },
      printFileName: false,
    };
    saveSnapshot();
    setDesigns(prev => [...prev, newDesign]);
    setSelectedDesignId(newId);
  }, [designs, saveSnapshot, artboardWidth, artboardHeight]);

  const handleRemoveOneCopy = useCallback((baseName: string, sizeKey: string) => {
    const baseNameOf = (name: string) => name.replace(/ copy( \d+)?$/, '');
    const sizeKeyOf = (d: DesignItem) => `${(d.widthInches * d.transform.s).toFixed(2)}x${(d.heightInches * d.transform.s).toFixed(2)}`;
    const copies = designs.filter(d => baseNameOf(d.name) === baseName && sizeKeyOf(d) === sizeKey);
    if (copies.length <= 1) return;
    const last = copies[copies.length - 1];
    saveSnapshot();
    setDesigns(prev => prev.filter(d => d.id !== last.id));
    if (selectedDesignId === last.id) {
      setSelectedDesignId(copies.length > 1 ? copies[copies.length - 2].id : null);
    }
    const nextIds = new Set(selectedDesignIds);
    nextIds.delete(last.id);
    setSelectedDesignIds(nextIds);
    setTimeout(() => handleAutoArrangeRef.current({ skipSnapshot: true, preserveSelection: true }), 0);
  }, [designs, saveSnapshot, selectedDesignId, selectedDesignIds]);

  const handleCopySelected = useCallback(() => {
    const toCopy = designs.filter(d => selectedDesignIds.has(d.id));
    if (toCopy.length === 0) return;
    clipboardRef.current = toCopy.map(d => ({ ...d }));
    toast({ title: toCopy.length > 1 ? t("toast.copiedPlural", { count: toCopy.length }) : t("toast.copied", { count: toCopy.length }) });
  }, [designs, selectedDesignIds, toast]);

  const handlePaste = useCallback(() => {
    if (clipboardRef.current.length === 0) return;
    saveSnapshot();
    const newIds: string[] = [];
    const pasted: DesignItem[] = clipboardRef.current.map(d => {
      const newId = crypto.randomUUID();
      newIds.push(newId);
      const offsetT = { ...d.transform, nx: d.transform.nx + 0.03, ny: d.transform.ny + 0.03 };
      const { nx, ny } = clampDesignToArtboard({ ...d, transform: offsetT }, artboardWidth, artboardHeight);
      return {
        ...d,
        id: newId,
        name: d.name.replace(/ copy( \d+)?$/, ''),
        transform: { ...d.transform, nx, ny },
        printFileName: false,
      };
    });
    setDesigns(prev => [...prev, ...pasted]);
    setSelectedDesignIds(new Set(newIds));
    setSelectedDesignId(newIds[newIds.length - 1]);
  }, [saveSnapshot, artboardWidth, artboardHeight]);

  const handleDeleteGroup = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    saveSnapshot();
    const idSet = new Set(ids);
    const toDelete = designsRef.current.filter(d => idSet.has(d.id));
    const remaining = designsRef.current.filter(d => !idSet.has(d.id));
    for (const d of toDelete) {
      const srcStillUsed = remaining.some(r => r.imageInfo.image.src === d.imageInfo.image.src);
      if (!srcStillUsed) {
        thumbnailCacheRef.current.delete(d.imageInfo.image.src);
        contentFillCacheRef.current.delete(d.imageInfo.image.src);
      }
    }
    setDesigns(remaining);
    setSelectedDesignIds(prev => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    if (remaining.length === 0) {
      setSelectedDesignId(null);
      setImageInfo(null);
    } else if (ids.includes(selectedDesignId ?? '')) {
      setSelectedDesignId(remaining[remaining.length - 1].id);
    }
  }, [selectedDesignId, saveSnapshot]);

  const handleDeleteDesign = useCallback((id: string) => {
    saveSnapshot();
    const toDelete = designsRef.current.find(d => d.id === id);
    const remaining = designsRef.current.filter(d => d.id !== id);
    if (toDelete) {
      const srcStillUsed = remaining.some(d => d.imageInfo.image.src === toDelete.imageInfo.image.src);
      if (!srcStillUsed) {
        thumbnailCacheRef.current.delete(toDelete.imageInfo.image.src);
        contentFillCacheRef.current.delete(toDelete.imageInfo.image.src);
      }
    }
    setDesigns(remaining);
    setSelectedDesignIds(prev => {
      if (prev.has(id)) {
        const next = new Set(prev);
        next.delete(id);
        return next;
      }
      return prev;
    });
    if (remaining.length === 0) {
      setSelectedDesignId(null);
      setImageInfo(null);
    } else if (selectedDesignId === id) {
      setSelectedDesignId(remaining[remaining.length - 1].id);
    }
  }, [selectedDesignId, saveSnapshot]);

  const handleDeleteMulti = useCallback((ids: Set<string>) => {
    saveSnapshot();
    const remaining = designsRef.current.filter(d => !ids.has(d.id));
    const remainingSrcs = new Set(remaining.map(d => d.imageInfo.image.src));
    for (const d of designsRef.current) {
      if (ids.has(d.id) && !remainingSrcs.has(d.imageInfo.image.src)) {
        thumbnailCacheRef.current.delete(d.imageInfo.image.src);
        contentFillCacheRef.current.delete(d.imageInfo.image.src);
      }
    }
    setDesigns(remaining);
    setSelectedDesignIds(new Set());
    if (remaining.length > 0) {
      setSelectedDesignId(remaining[remaining.length - 1].id);
    } else {
      setSelectedDesignId(null);
      setImageInfo(null);
    }
  }, [saveSnapshot]);

  const handleRotate90 = useCallback(() => {
    if (!selectedDesignId) return;
    saveSnapshot();
    const idsToRotate = selectedDesignIds.size > 1 ? selectedDesignIds : new Set([selectedDesignId]);

    if (idsToRotate.size <= 1) {
      setDesigns(prev => prev.map(d => {
        if (!idsToRotate.has(d.id)) return d;
        const newRot = ((d.transform.rotation + 90) % 360);
        const rotated = { ...d, transform: { ...d.transform, rotation: newRot } };
        const { nx, ny } = clampDesignToArtboard(rotated, artboardWidth, artboardHeight);
        return { ...rotated, transform: { ...rotated.transform, nx, ny } };
      }));
    } else {
      setDesigns(prev => {
        const rotatedMap = new Map<string, { nx: number; ny: number; rotation: number }>();
        for (const d of prev) {
          if (!idsToRotate.has(d.id)) continue;
          rotatedMap.set(d.id, {
            nx: d.transform.nx,
            ny: d.transform.ny,
            rotation: (d.transform.rotation + 90) % 360,
          });
        }

        let shiftR = 0, shiftL = 0, shiftD = 0, shiftU = 0;
        for (const d of prev) {
          const u = rotatedMap.get(d.id);
          if (!u) continue;
          const rad = (u.rotation * Math.PI) / 180;
          const cos = Math.abs(Math.cos(rad));
          const sin = Math.abs(Math.sin(rad));
          const halfW = (d.widthInches * d.transform.s * cos + d.heightInches * d.transform.s * sin) / 2;
          const halfH = (d.widthInches * d.transform.s * sin + d.heightInches * d.transform.s * cos) / 2;
          const minNx = halfW / artboardWidth;
          const maxNx = 1 - halfW / artboardWidth;
          const minNy = halfH / artboardHeight;
          const maxNy = 1 - halfH / artboardHeight;
          if (minNx <= maxNx) {
            if (u.nx < minNx) shiftR = Math.max(shiftR, minNx - u.nx);
            if (u.nx > maxNx) shiftL = Math.max(shiftL, u.nx - maxNx);
          }
          if (minNy <= maxNy) {
            if (u.ny < minNy) shiftD = Math.max(shiftD, minNy - u.ny);
            if (u.ny > maxNy) shiftU = Math.max(shiftU, u.ny - maxNy);
          }
        }
        const groupDnx = shiftR - shiftL;
        const groupDny = shiftD - shiftU;

        return prev.map(d => {
          const u = rotatedMap.get(d.id);
          if (!u) return d;
          const rad = (u.rotation * Math.PI) / 180;
          const cos = Math.abs(Math.cos(rad));
          const sin = Math.abs(Math.sin(rad));
          const halfW = (d.widthInches * d.transform.s * cos + d.heightInches * d.transform.s * sin) / 2;
          const halfH = (d.widthInches * d.transform.s * sin + d.heightInches * d.transform.s * cos) / 2;
          const adjNx = u.nx + groupDnx;
          const adjNy = u.ny + groupDny;
          const clampedNx = Math.max(halfW / artboardWidth, Math.min(1 - halfW / artboardWidth, adjNx));
          const clampedNy = Math.max(halfH / artboardHeight, Math.min(1 - halfH / artboardHeight, adjNy));
          return { ...d, transform: { ...d.transform, rotation: u.rotation, nx: clampedNx, ny: clampedNy } };
        });
      });
    }

    setDesignTransform(prev => {
      const newRot = ((prev.rotation + 90) % 360);
      return { ...prev, rotation: newRot };
    });
  }, [selectedDesignId, selectedDesignIds, saveSnapshot, artboardWidth, artboardHeight]);

  const handleFlipX = useCallback(() => {
    if (!selectedDesignId) return;
    saveSnapshot();
    const ids = selectedDesignIds.size > 0 ? selectedDesignIds : new Set([selectedDesignId]);
    setDesigns(prev => prev.map(d => ids.has(d.id) ? { ...d, transform: { ...d.transform, flipX: !d.transform.flipX } } : d));
    if (ids.has(selectedDesignId)) {
      setDesignTransform(prev => ({ ...prev, flipX: !prev.flipX }));
    }
  }, [selectedDesignId, selectedDesignIds, saveSnapshot]);

  const handleFlipY = useCallback(() => {
    if (!selectedDesignId) return;
    saveSnapshot();
    const ids = selectedDesignIds.size > 0 ? selectedDesignIds : new Set([selectedDesignId]);
    setDesigns(prev => prev.map(d => ids.has(d.id) ? { ...d, transform: { ...d.transform, flipY: !d.transform.flipY } } : d));
    if (ids.has(selectedDesignId)) {
      setDesignTransform(prev => ({ ...prev, flipY: !prev.flipY }));
    }
  }, [selectedDesignId, selectedDesignIds, saveSnapshot]);

  const handleCanvasContextMenu = useCallback((x: number, y: number, designId: string | null) => {
    if (designId) {
      if (!selectedDesignIds.has(designId) && selectedDesignId !== designId) {
        handleSelectDesign(designId);
      }
      setContextMenu({ x, y, designId });
    } else {
      setContextMenu(null);
    }
  }, [selectedDesignId, selectedDesignIds, handleSelectDesign]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); window.removeEventListener('keydown', onKey); };
  }, [contextMenu]);

  const getAlignNxNy = useCallback((corner: 'tl' | 'tr' | 'bl' | 'br') => {
    const design = designsRef.current.find(d => d.id === selectedDesignId);
    if (!design) return null;
    const t = design.transform;
    const rad = (t.rotation * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const halfW = (design.widthInches * t.s * cos + design.heightInches * t.s * sin) / 2;
    const halfH = (design.widthInches * t.s * sin + design.heightInches * t.s * cos) / 2;
    const left = halfW / artboardWidth;
    const right = 1 - halfW / artboardWidth;
    const top = halfH / artboardHeight;
    const bottom = 1 - halfH / artboardHeight;
    switch (corner) {
      case 'tl': return { nx: left, ny: top };
      case 'tr': return { nx: right, ny: top };
      case 'bl': return { nx: left, ny: bottom };
      case 'br': return { nx: right, ny: bottom };
    }
  }, [selectedDesignId, artboardWidth, artboardHeight]);

  const handleAlignCorner = useCallback((corner: 'tl' | 'tr' | 'bl' | 'br') => {
    if (!selectedDesignId) return;
    const pos = getAlignNxNy(corner);
    if (!pos) return;
    saveSnapshot();
    setDesigns(prev => prev.map(d => d.id === selectedDesignId
      ? { ...d, transform: { ...d.transform, nx: pos.nx, ny: pos.ny } }
      : d
    ));
    setDesignTransform(prev => ({ ...prev, nx: pos.nx, ny: pos.ny }));
  }, [selectedDesignId, saveSnapshot, getAlignNxNy]);

  const contentFillCacheRef = useRef<Map<string, number>>(new Map());

  const handleAutoArrange = useCallback((opts?: { skipSnapshot?: boolean; preserveSelection?: boolean }) => {
    const currentDesigns = designsRef.current;
    if (currentDesigns.length === 0) { console.warn('[autoArrange] no designs'); return; }
    if (!opts?.skipSnapshot) saveSnapshot();

    const usableW = artboardWidthRef.current;
    const usableH = artboardHeightRef.current;
    console.log('[autoArrange] starting', { designCount: currentDesigns.length, usableW, usableH });

    const arrangeSelection = selectedDesignIds.size >= 2;
    const designsToArrange = arrangeSelection
      ? currentDesigns.filter(d => selectedDesignIds.has(d.id))
      : currentDesigns;

    if (designsToArrange.length === 1 && !arrangeSelection) {
      const d = currentDesigns[0];
      setDesigns([{ ...d, transform: { ...d.transform, nx: 0.5, ny: 0.5 } }]);
      if (!opts?.preserveSelection) {
        setSelectedDesignId(null);
        setSelectedDesignIds(new Set());
      }
      return;
    }

    if (designsToArrange.length < 2) return;

    const fillCache = contentFillCacheRef.current;
    const getContentFill = (d: DesignItem): number => {
      const key = d.imageInfo.image.src;
      const cached = fillCache.get(key);
      if (cached !== undefined) return cached;
      const img = d.imageInfo.image;
      let fill = 1.0;
      try {
        const sampleSize = 64;
        const c = document.createElement('canvas');
        c.width = sampleSize;
        c.height = sampleSize;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(img, 0, 0, sampleSize, sampleSize);
          const data = ctx.getImageData(0, 0, sampleSize, sampleSize).data;
          let opaque = 0;
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] > 20) opaque++;
          }
          fill = opaque / (sampleSize * sampleSize);
        }
      } catch { /* keep default 1.0 */ }
      fillCache.set(key, fill);
      return fill;
    };

    const items = designsToArrange.map(d => {
      const w = d.widthInches * d.transform.s;
      const h = getEffectiveHeight(d);
      return { id: d.id, w, h, fill: getContentFill(d) };
    });

    const fixedRects: Array<{ x: number; y: number; w: number; h: number }> | undefined = arrangeSelection
      ? currentDesigns.filter(d => !selectedDesignIds.has(d.id)).map(d => {
          const t = d.transform;
          const bounds = getRotatedBounds(d);
          const cx = t.nx * usableW;
          const cy = t.ny * usableH;
          return { x: cx + bounds.minX, y: cy + bounds.minY, w: bounds.maxX - bounds.minX, h: bounds.maxY - bounds.minY };
        })
      : undefined;

    type PlacedItem = { id: string; nx: number; ny: number; rotation: number; overflows: boolean };

    const applyResult = (bestResult: PlacedItem[], anyRotated: boolean, hasOverflow: boolean) => {
      if (hasOverflow) {
        toast({ title: t("toast.noSpace"), description: t("toast.noSpaceDesc"), variant: "destructive" });
      } else if (anyRotated) {
        toast({ title: t("toast.autoArranged"), description: t("toast.autoArrangedDesc") });
      }
      const abW = artboardWidthRef.current;
      const abH = artboardHeightRef.current;
      setDesigns(prev => prev.map(d => {
        const p = bestResult.find(r => r.id === d.id);
        if (!p) return d;
        const finalRotation = p.rotation % 360;
        const stampExtra = getStampExtra(d);
        let adjustedNx = p.nx;
        let adjustedNy = p.ny;
        if (stampExtra > 0) {
          const rad = (finalRotation * Math.PI) / 180;
          adjustedNx -= (stampExtra / 2) * Math.sin(rad) / abW;
          adjustedNy -= (stampExtra / 2) * Math.cos(rad) / abH;
        }
        const newTransform = { ...d.transform, nx: adjustedNx, ny: adjustedNy, rotation: finalRotation };
        const { nx, ny } = clampDesignToArtboard({ ...d, transform: newTransform }, abW, abH);
        return { ...d, transform: { ...newTransform, nx, ny } };
      }));
      if (!opts?.preserveSelection) {
        setSelectedDesignId(null);
        setSelectedDesignIds(new Set());
      }
    };

    const worker = getArrangeWorker();
    if (fixedRects && fixedRects.length > 0 && !worker) {
      toast({ title: t("toast.arrangeUnavailable"), description: t("toast.arrangeUnavailableDesc"), variant: "destructive" });
      return;
    }
    if (worker) {
      console.log('[autoArrange] using worker');
      const requestId = ++_arrangeReqCounter;
      let settled = false;
      const cleanup = () => { worker.removeEventListener('message', handler); clearTimeout(timer); };
      const handler = (e: MessageEvent) => {
        if (e.data.requestId !== requestId) return;
        if (settled) return;
        settled = true;
        cleanup();
        if (!mountedRef.current) return;
        if (e.data.type === 'error') { console.warn('[autoArrange] worker error:', e.data.error); toast({ title: "Arrange failed", variant: "destructive" }); return; }
        const bestResult: PlacedItem[] = e.data.result;
        console.log('[autoArrange] worker result:', bestResult.length, 'items, overflows:', bestResult.filter(p => p.overflows).length);
        const anyRotated = bestResult.some(p => p.rotation !== 0);
        const hasOverflow = bestResult.some(p => p.overflows);
        applyResult(bestResult, anyRotated, hasOverflow);
      };
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          console.warn('[autoArrange] worker timed out, using fallback');
          runFallbackArrange();
        }
      }, 10_000);
      worker.addEventListener('message', handler);
      worker.postMessage({
        type: 'arrange',
        requestId,
        items,
        usableW,
        usableH,
        artboardWidth: usableW,
        artboardHeight: usableH,
        isAggressive: true,
        customGap: designGap,
        fixedRects,
      });
    } else {
      console.log('[autoArrange] no worker, using fallback');
      runFallbackArrange();
    }

    function runFallbackArrange() {
      const hasCustomGap = designGap !== undefined && designGap >= 0;
      const GAP = hasCustomGap ? designGap : 0.25;
      const getItemGapVal = (_fill: number) => GAP;

      type SkylineSeg = { x: number; y: number; w: number };
      type PackItem = { id: string; w: number; h: number; rotation: number; gap: number };

      const findBestPos = (sky: SkylineSeg[], itemW: number, itemH: number): { x: number; y: number; waste: number } | null => {
        let bestX = -1, bestY = Infinity, bestWaste = Infinity, found = false;
        for (let i = 0; i < sky.length; i++) {
          let spanW = 0, maxY = 0, j = i;
          while (j < sky.length && spanW < itemW) { maxY = Math.max(maxY, sky[j].y); spanW += sky[j].w; j++; }
          if (spanW < itemW - 0.001) continue;
          if (maxY + itemH > usableH + 0.001) continue;
          let waste = 0;
          const rb = sky[i].x + itemW;
          for (let k = i; k < j; k++) { waste += (maxY - sky[k].y) * Math.max(0, Math.min(sky[k].x + sky[k].w, rb) - Math.max(sky[k].x, sky[i].x)); }
          if (maxY < bestY - 0.001 || (Math.abs(maxY - bestY) < 0.001 && sky[i].x < bestX - 0.001) || (Math.abs(maxY - bestY) < 0.001 && Math.abs(sky[i].x - bestX) < 0.001 && waste < bestWaste)) {
            bestY = maxY; bestX = sky[i].x; bestWaste = waste; found = true;
          }
        }
        return found ? { x: bestX, y: bestY, waste: bestWaste } : null;
      };
      const placeSeg = (sky: SkylineSeg[], px: number, iw: number, ih: number): SkylineSeg[] => {
        let topY = 0;
        for (const s of sky) { if (s.x < px + iw && s.x + s.w >= px - 0.01) topY = Math.max(topY, s.y); }
        const next: SkylineSeg[] = [];
        for (const s of sky) { const sR = s.x + s.w, iR = px + iw; if (sR <= px || s.x >= iR) { next.push(s); continue; } if (s.x < px) next.push({ x: s.x, y: s.y, w: px - s.x }); if (sR > iR) next.push({ x: iR, y: s.y, w: sR - iR }); }
        next.push({ x: px, y: topY + ih, w: iw }); next.sort((a, b) => a.x - b.x);
        const merged: SkylineSeg[] = [next[0]];
        for (let k = 1; k < next.length; k++) { const p = merged[merged.length - 1]; if (Math.abs(p.y - next[k].y) < 0.001 && Math.abs((p.x + p.w) - next[k].x) < 0.001) p.w += next[k].w; else merged.push(next[k]); }
        return merged;
      };
      const toNxNy = (ax: number, ay: number, w: number, h: number) => ({
        nx: Math.max(w / 2 / artboardWidth, Math.min((artboardWidth - w / 2) / artboardWidth, ax / artboardWidth)),
        ny: Math.max(h / 2 / artboardHeight, Math.min((artboardHeight - h / 2) / artboardHeight, ay / artboardHeight)),
      });
      const skylinePack = (pi: PackItem[]) => {
        let sky: SkylineSeg[] = [{ x: 0, y: 0, w: usableW }]; const res: PlacedItem[] = []; let tw = 0;
        for (const it of pi) {
          const g = it.gap, hg = g / 2;
          let pos = findBestPos(sky, it.w + g, it.h + g); let rw = it.w + g, rh = it.h + g;
          if (!pos) { pos = findBestPos(sky, it.w + hg, it.h + hg); if (pos) { rw = it.w + hg; rh = it.h + hg; } }
          if (pos) { tw += pos.waste; sky = placeSeg(sky, pos.x, rw, rh); const p = toNxNy(pos.x + it.w / 2, pos.y + it.h / 2, it.w, it.h); res.push({ id: it.id, nx: p.nx, ny: p.ny, rotation: it.rotation, overflows: false }); }
          else { const sm = sky.length > 0 ? Math.max(...sky.map(s => s.y)) : 0; const ph = it.h + hg; sky = placeSeg(sky, 0, Math.min(it.w + hg, usableW), ph); const p = toNxNy(it.w / 2, sm + ph / 2, it.w, it.h); res.push({ id: it.id, nx: p.nx, ny: p.ny, rotation: it.rotation, overflows: true }); }
        }
        return { result: res, maxHeight: sky.length > 0 ? Math.max(...sky.map(s => s.y)) : 0, wastedArea: tw };
      };
      const mkPi = (order: typeof items, orient: string, go?: number): PackItem[] => order.map(d => {
        const g = go !== undefined ? go : getItemGapVal(d.fill); let w = d.w, h = d.h, rot = 0;
        if (orient === 'landscape' && h > w) { const t = w; w = h; h = t; rot = 90; }
        if (orient === 'portrait' && w > h) { const t = w; w = h; h = t; rot = 90; }
        return { id: d.id, w, h, rotation: rot, gap: g };
      });
      const greedyOrientPack = (sortedItems: Array<{ id: string; w: number; h: number; gap: number }>) => {
        let sky: SkylineSeg[] = [{ x: 0, y: 0, w: usableW }]; const res: PlacedItem[] = []; let tw = 0;
        for (const it of sortedItems) {
          const g = it.gap;
          const orients: Array<{ w: number; h: number; rot: number }> = [{ w: it.w, h: it.h, rot: 0 }];
          if (Math.abs(it.w - it.h) > 0.1) orients.push({ w: it.h, h: it.w, rot: 90 });
          let bp: { x: number; y: number; waste: number } | null = null, bo = orients[0], bs = sky;
          for (const o of orients) { const hg = g / 2; for (const a of [{ w: o.w + g, h: o.h + g }, { w: o.w + hg, h: o.h + hg }]) { const pos = findBestPos(sky, a.w, a.h); if (!pos) continue; const sc = pos.y * 10000 + pos.x * 10 + pos.waste; if (!bp || sc < bp.y * 10000 + bp.x * 10 + bp.waste) { bp = pos; bo = o; bs = placeSeg(sky.map(s => ({ ...s })), pos.x, a.w, a.h); } break; } }
          if (bp) { tw += bp.waste; sky = bs; const p = toNxNy(bp.x + bo.w / 2, bp.y + bo.h / 2, bo.w, bo.h); res.push({ id: it.id, nx: p.nx, ny: p.ny, rotation: bo.rot, overflows: false }); }
          else { const sm = sky.length > 0 ? Math.max(...sky.map(s => s.y)) : 0; const ph = it.h + g; sky = placeSeg(sky, 0, Math.min(it.w + g, usableW), ph); const p = toNxNy(it.w / 2, sm + ph / 2, it.w, it.h); res.push({ id: it.id, nx: p.nx, ny: p.ny, rotation: 0, overflows: true }); }
        }
        return { result: res, maxHeight: sky.length > 0 ? Math.max(...sky.map(s => s.y)) : 0, wastedArea: tw };
      };
      const mixedOrientPack = (pi: PackItem[]) => {
        const halfW = usableW / 2;
        const adj: PackItem[] = pi.map(it => (it.w > halfW && it.h < it.w && it.h <= halfW) ? { ...it, w: it.h, h: it.w, rotation: it.rotation === 0 ? 90 : 0 } : it);
        return skylinePack(adj);
      };
      type FreeRect = { x: number; y: number; w: number; h: number };
      const maxRectsPack = (pi: PackItem[], heuristic: 'bssf' | 'baf') => {
        let freeRects: FreeRect[] = [{ x: 0, y: 0, w: usableW, h: usableH }];
        const res: PlacedItem[] = []; let mH = 0, tia = 0;
        for (const it of pi) {
          const g = it.gap, iw = it.w + g, ih = it.h + g;
          let bsc = Infinity, bse = Infinity, bx = 0, by = 0, found = false;
          for (const fr of freeRects) {
            if (iw > fr.w + 0.001 || ih > fr.h + 0.001) continue;
            let sc: number, se: number;
            if (heuristic === 'bssf') { sc = Math.min(fr.w - iw, fr.h - ih); se = Math.max(fr.w - iw, fr.h - ih); }
            else { sc = fr.w * fr.h - iw * ih; se = Math.min(fr.w - iw, fr.h - ih); }
            if (sc < bsc - 0.001 || (Math.abs(sc - bsc) < 0.001 && se < bse - 0.001)) { bsc = sc; bse = se; bx = fr.x; by = fr.y; found = true; }
          }
          if (found) {
            mH = Math.max(mH, by + ih); tia += it.w * it.h;
            const p = toNxNy(bx + it.w / 2, by + it.h / 2, it.w, it.h);
            res.push({ id: it.id, nx: p.nx, ny: p.ny, rotation: it.rotation, overflows: false });
            const pl = { x: bx, y: by, w: iw, h: ih };
            const nf: FreeRect[] = [];
            for (const fr of freeRects) {
              if (pl.x >= fr.x + fr.w - 0.001 || pl.x + pl.w <= fr.x + 0.001 || pl.y >= fr.y + fr.h - 0.001 || pl.y + pl.h <= fr.y + 0.001) { nf.push(fr); continue; }
              if (pl.x > fr.x + 0.001) nf.push({ x: fr.x, y: fr.y, w: pl.x - fr.x, h: fr.h });
              if (pl.x + pl.w < fr.x + fr.w - 0.001) nf.push({ x: pl.x + pl.w, y: fr.y, w: fr.x + fr.w - pl.x - pl.w, h: fr.h });
              if (pl.y > fr.y + 0.001) nf.push({ x: fr.x, y: fr.y, w: fr.w, h: pl.y - fr.y });
              if (pl.y + pl.h < fr.y + fr.h - 0.001) nf.push({ x: fr.x, y: pl.y + pl.h, w: fr.w, h: fr.y + fr.h - pl.y - pl.h });
            }
            freeRects = [];
            for (let i = 0; i < nf.length; i++) {
              if (nf[i].w < 0.01 || nf[i].h < 0.01) continue;
              let cont = false;
              for (let j = 0; j < nf.length; j++) { if (i !== j && nf[i].x >= nf[j].x - 0.001 && nf[i].y >= nf[j].y - 0.001 && nf[i].x + nf[i].w <= nf[j].x + nf[j].w + 0.001 && nf[i].y + nf[i].h <= nf[j].y + nf[j].h + 0.001) { cont = true; break; } }
              if (!cont) freeRects.push(nf[i]);
            }
          } else {
            const p = toNxNy(it.w / 2, mH + ih / 2, it.w, it.h);
            res.push({ id: it.id, nx: p.nx, ny: p.ny, rotation: it.rotation, overflows: true }); mH += ih;
          }
        }
        return { result: res, maxHeight: mH, wastedArea: Math.max(0, usableW * mH - tia) };
      };
      const shelfPack = (pi: PackItem[]) => {
        const res: PlacedItem[] = []; let cY = 0, cX = 0, sH = 0, tia = 0;
        for (const it of pi) {
          const g = it.gap, iw = it.w + g, ih = it.h + g;
          if (cX + iw > usableW + 0.001) { cY += sH + g; cX = 0; sH = 0; }
          sH = Math.max(sH, ih); tia += it.w * it.h;
          const ov = cX + iw > usableW + 0.001 || cY + ih > usableH + 0.001;
          const p = toNxNy(cX + it.w / 2, cY + it.h / 2, it.w, it.h);
          res.push({ id: it.id, nx: p.nx, ny: p.ny, rotation: it.rotation, overflows: ov }); cX += iw;
        }
        const mH = cY + sH;
        return { result: res, maxHeight: mH, wastedArea: Math.max(0, usableW * mH - tia) };
      };
      const gridPack = (g: number) => {
        if (items.length < 2) return null;
        const ref = items[0];
        if (!items.every(d => Math.abs(d.w - ref.w) < 0.2 && Math.abs(d.h - ref.h) < 0.2)) return null;
        const tryGrid = (iw: number, ih: number, rot: number) => {
          const cols = Math.max(1, Math.floor((usableW + g) / (iw + g)));
          const rows = Math.ceil(items.length / cols);
          const totalH = rows * ih + (rows - 1) * g;
          const totalWUsed = cols * iw + (cols - 1) * g;
          const res: PlacedItem[] = [];
          for (let idx = 0; idx < items.length; idx++) {
            const col = idx % cols, row = Math.floor(idx / cols);
            const ax = col * (iw + g) + iw / 2, ay = row * (ih + g) + ih / 2;
            const ov = ax + iw / 2 > usableW + 0.001 || ay + ih / 2 > usableH + 0.001;
            const p = toNxNy(ax, ay, iw, ih);
            res.push({ id: items[idx].id, nx: p.nx, ny: p.ny, rotation: rot, overflows: ov });
          }
          return { result: res, maxHeight: totalH, wastedArea: (usableW - totalWUsed) * totalH };
        };
        const ng = tryGrid(ref.w, ref.h, 0);
        if (Math.abs(ref.w - ref.h) < 0.2) return ng;
        const rg = tryGrid(ref.h, ref.w, 90);
        const no = ng.result.filter(r => r.overflows).length, ro = rg.result.filter(r => r.overflows).length;
        if (no !== ro) return no < ro ? ng : rg;
        if (Math.abs(ng.maxHeight - rg.maxHeight) > 0.01) return ng.maxHeight < rg.maxHeight ? ng : rg;
        return ng.wastedArea <= rg.wastedArea ? ng : rg;
      };
      const ev = (p: { result: PlacedItem[]; maxHeight: number; wastedArea: number }) => ({ ...p, overflows: p.result.filter(r => r.overflows).length });
      const totalItemArea = items.reduce((sum, d) => sum + d.w * d.h, 0);
      const byAreaDesc = [...items].sort((a, b) => (b.w * b.h) - (a.w * a.h));
      const altArr: typeof items = [];
      for (let lo = 0, hi = byAreaDesc.length - 1; lo <= hi;) { altArr.push(byAreaDesc[lo++]); if (lo <= hi) altArr.push(byAreaDesc[hi--]); }
      const sorts = [
        [...items].sort((a, b) => b.w - a.w || b.h - a.h),
        [...items].sort((a, b) => Math.max(b.h, b.w) - Math.max(a.h, a.w)),
        byAreaDesc,
        [...items].sort((a, b) => (b.w + b.h) - (a.w + a.h)),
        [...items].sort((a, b) => a.fill - b.fill || (b.w * b.h) - (a.w * a.h)),
        [...items].sort((a, b) => (b.w / Math.max(b.h, 0.01)) - (a.w / Math.max(a.h, 0.01))),
        [...items].sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || (b.w * b.h) - (a.w * a.h)),
        altArr,
        [...items].sort((a, b) => (a.w * a.h) - (b.w * b.h)),
      ];
      type Candidate = { result: PlacedItem[]; maxHeight: number; wastedArea: number; overflows: number };
      const cands: Candidate[] = [];
      for (const go of hasCustomGap ? [undefined] : [undefined, 0.125, 0.0625]) {
        const g = go !== undefined ? go : GAP;
        for (const s of sorts) {
          const npi = mkPi(s, 'normal', go);
          cands.push(ev(skylinePack(npi)));
          const greedyItems = s.map(d => ({ id: d.id, w: d.w, h: d.h, gap: go !== undefined ? go : getItemGapVal(d.fill) }));
          cands.push(ev(greedyOrientPack(greedyItems)));
          cands.push(ev(mixedOrientPack(npi)));
          cands.push(ev(maxRectsPack(npi, 'bssf')));
          cands.push(ev(maxRectsPack(npi, 'baf')));
          cands.push(ev(shelfPack(npi)));
          cands.push(ev(skylinePack(mkPi(s, 'landscape', go)))); cands.push(ev(skylinePack(mkPi(s, 'portrait', go))));
        }
        const gr = gridPack(g);
        if (gr) cands.push(ev(gr));
      }
      cands.sort((a, b) => {
        if (a.overflows !== b.overflows) return a.overflows - b.overflows;
        const af = a.maxHeight <= usableH ? 0 : 1, bf = b.maxHeight <= usableH ? 0 : 1;
        if (af !== bf) return af - bf;
        const aU = totalItemArea / (usableW * Math.max(a.maxHeight, 0.01));
        const bU = totalItemArea / (usableW * Math.max(b.maxHeight, 0.01));
        if (Math.abs(aU - bU) > 0.02) return bU - aU;
        if (Math.abs(a.maxHeight - b.maxHeight) > 0.01) return a.maxHeight - b.maxHeight;
        return a.wastedArea - b.wastedArea;
      });
      const best = cands[0].result;
      applyResult(best, best.some(p => p.rotation !== 0), best.some(p => p.overflows));
    }
  }, [selectedDesignIds, saveSnapshot, toast, designGap]);

  const handleArtboardResize = useCallback((newWidth: number, newHeight: number) => {
    if (newWidth <= 0 || newHeight <= 0) return;

    if (designs.length === 0) {
      setArtboardWidth(newWidth);
      setArtboardHeight(newHeight);
      return;
    }

    saveSnapshot();
    const oldW = artboardWidth;
    const oldH = artboardHeight;

    setDesigns(prev => prev.map(d => {
      const absCx = d.transform.nx * oldW;
      const absCy = d.transform.ny * oldH;
      const newTransform = { ...d.transform, nx: absCx / newWidth, ny: absCy / newHeight };
      const { nx, ny } = clampDesignToArtboard({ ...d, transform: newTransform }, newWidth, newHeight);
      return { ...d, transform: { ...newTransform, nx, ny } };
    }));

    setArtboardWidth(newWidth);
    setArtboardHeight(newHeight);
  }, [designs.length, saveSnapshot, artboardWidth, artboardHeight]);

  const GANGSHEET_HEIGHTS = useMemo(() => {
    if (initialGangsheetHeights && initialGangsheetHeights.length > 0) return initialGangsheetHeights;
    const base = profile.gangsheetHeights;
    if (!initialHeight || base.includes(initialHeight)) return base;
    return [...base, initialHeight].sort((a, b) => a - b);
  }, [profile.gangsheetHeights, initialHeight, initialGangsheetHeights]);
  const MAX_ARTBOARD_HEIGHT = GANGSHEET_HEIGHTS[GANGSHEET_HEIGHTS.length - 1];
  const recommendedArtboardHeight = useMemo(() => {
    if (designs.length === 0) return null;
    let minY = Infinity, maxY = -Infinity;
    for (const d of designs) {
      const bounds = getRotatedBounds(d);
      const cy = d.transform.ny * artboardHeight;
      minY = Math.min(minY, cy + bounds.minY);
      maxY = Math.max(maxY, cy + bounds.maxY);
    }
    const requiredH = maxY - minY + (designGap ?? 0.25) * 2;
    return GANGSHEET_HEIGHTS.find(h => h >= requiredH) ?? null;
  }, [designs, artboardHeight, designGap, GANGSHEET_HEIGHTS]);
  const handleExpandArtboard = useCallback(() => {
    if (artboardHeight >= MAX_ARTBOARD_HEIGHT) return;
    const nextHeight = GANGSHEET_HEIGHTS.find(h => h > artboardHeight) ?? MAX_ARTBOARD_HEIGHT;
    handleArtboardResize(artboardWidth, nextHeight);
  }, [artboardHeight, artboardWidth, handleArtboardResize]);

  // Stable refs for keyboard handler to avoid frequent re-registration
  const handleUndoRef = useRef(handleUndo);
  handleUndoRef.current = handleUndo;
  const handleRedoRef = useRef(handleRedo);
  handleRedoRef.current = handleRedo;
  const handleAutoArrangeRef = useRef(handleAutoArrange);
  handleAutoArrangeRef.current = handleAutoArrange;
  const handleDuplicateDesignRef = useRef(handleDuplicateDesign);
  handleDuplicateDesignRef.current = handleDuplicateDesign;
  const handleDeleteDesignRef = useRef(handleDeleteDesign);
  handleDeleteDesignRef.current = handleDeleteDesign;
  const handleDeleteMultiRef = useRef(handleDeleteMulti);
  handleDeleteMultiRef.current = handleDeleteMulti;
  const handleDuplicateSelectedRef = useRef(handleDuplicateSelected);
  handleDuplicateSelectedRef.current = handleDuplicateSelected;
  const handleCopySelectedRef = useRef(handleCopySelected);
  handleCopySelectedRef.current = handleCopySelected;
  const handlePasteRef = useRef(handlePaste);
  handlePasteRef.current = handlePaste;
  const handleRotate90Ref = useRef(handleRotate90);
  handleRotate90Ref.current = handleRotate90;
  const selectedDesignIdRef = useRef(selectedDesignId);
  selectedDesignIdRef.current = selectedDesignId;
  const showDesignInfoRef = useRef(showDesignInfo);
  showDesignInfoRef.current = showDesignInfo;
  const saveSnapshotRef = useRef(saveSnapshot);
  saveSnapshotRef.current = saveSnapshot;
  const artboardWidthRef = useRef(artboardWidth);
  artboardWidthRef.current = artboardWidth;
  const artboardHeightRef = useRef(artboardHeight);
  artboardHeightRef.current = artboardHeight;
  const selectedDesignIdsRef = useRef(selectedDesignIds);
  selectedDesignIdsRef.current = selectedDesignIds;

  // Keyboard shortcuts — registered once, uses refs for latest handlers
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) return;

      const ctrl = e.ctrlKey || e.metaKey;
      const selId = selectedDesignIdRef.current;

      if (ctrl && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndoRef.current();
        return;
      }
      if (ctrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        handleRedoRef.current();
        return;
      }
      if (ctrl && e.key === 'c') {
        e.preventDefault();
        handleCopySelectedRef.current();
        return;
      }
      if (ctrl && e.key === 'v') {
        e.preventDefault();
        handlePasteRef.current();
        return;
      }
      if (ctrl && e.key === 'a') {
        e.preventDefault();
        const allIds = designsRef.current.map(d => d.id);
        if (allIds.length > 0) {
          setSelectedDesignIds(new Set(allIds));
          setSelectedDesignId(allIds[allIds.length - 1]);
        }
        return;
      }
      if (ctrl && e.key === 'd') {
        e.preventDefault();
        if (selectedDesignIdsRef.current.size > 1) {
          const newIds = handleDuplicateSelectedRef.current();
          if (newIds.length > 0) {
            setTimeout(() => handleAutoArrangeRef.current({ skipSnapshot: true, preserveSelection: true }), 0);
          }
        } else {
          handleDuplicateDesignRef.current();
        }
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && (selId || selectedDesignIdsRef.current.size > 0)) {
        e.preventDefault();
        const idsToDelete = selectedDesignIdsRef.current;
        if (idsToDelete.size > 1) {
          handleDeleteMultiRef.current(idsToDelete);
        } else if (selId) {
          handleDeleteDesignRef.current(selId);
        } else if (idsToDelete.size === 1) {
          handleDeleteDesignRef.current([...idsToDelete][0]);
        }
        return;
      }

      if (selId && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        if (!nudgeSnapshotSavedRef.current) {
          saveSnapshotRef.current();
          nudgeSnapshotSavedRef.current = true;
        }
        if (nudgeTimeoutRef.current) clearTimeout(nudgeTimeoutRef.current);
        nudgeTimeoutRef.current = setTimeout(() => { nudgeSnapshotSavedRef.current = false; }, 500);
        const step = e.shiftKey ? 0.02 : 0.005;
        let dnx = 0, dny = 0;
        if (e.key === 'ArrowUp') dny = -step;
        if (e.key === 'ArrowDown') dny = step;
        if (e.key === 'ArrowLeft') dnx = -step;
        if (e.key === 'ArrowRight') dnx = step;

        const multiIds = selectedDesignIdsRef.current;
        if (multiIds.size > 1) {
          // Nudge all selected designs with uniform group clamping
          const abW = artboardWidthRef.current;
          const abH = artboardHeightRef.current;
          let allowedDnx = dnx, allowedDny = dny;
          for (const d of designsRef.current) {
            if (!multiIds.has(d.id)) continue;
            const t = d.transform;
            const rad = (t.rotation * Math.PI) / 180;
            const cos = Math.abs(Math.cos(rad));
            const sin = Math.abs(Math.sin(rad));
            const halfW = (d.widthInches * t.s * cos + d.heightInches * t.s * sin) / 2;
            const halfH = (d.widthInches * t.s * sin + d.heightInches * t.s * cos) / 2;
            const minNx = halfW / abW, maxNx = 1 - halfW / abW;
            const minNy = halfH / abH, maxNy = 1 - halfH / abH;
            if (minNx <= maxNx) allowedDnx = Math.max(minNx - t.nx, Math.min(maxNx - t.nx, allowedDnx));
            if (minNy <= maxNy) allowedDny = Math.max(minNy - t.ny, Math.min(maxNy - t.ny, allowedDny));
          }
          setDesigns(prev => prev.map(d => {
            if (!multiIds.has(d.id)) return d;
            return { ...d, transform: { ...d.transform, nx: d.transform.nx + allowedDnx, ny: d.transform.ny + allowedDny } };
          }));
        } else {
          const current = designsRef.current.find(d => d.id === selId);
          if (!current) return;
          const tentative = { ...current.transform, nx: current.transform.nx + dnx, ny: current.transform.ny + dny };
          const { nx: clNx, ny: clNy } = clampDesignToArtboard(
            { ...current, transform: tentative },
            artboardWidthRef.current, artboardHeightRef.current,
          );
          const newTransform = { ...tentative, nx: clNx, ny: clNy };
          setDesignTransform(newTransform);
          setDesigns(prev => prev.map(d => d.id === selId ? { ...d, transform: newTransform } : d));
        }
      }

      if (e.key === 'Escape') {
        if (showDesignInfoRef.current) setShowDesignInfo(false);
        setSelectedDesignId(null);
        setSelectedDesignIds(new Set());
      }
      if (selId && !ctrl && e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        handleRotate90Ref.current();
        return;
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (nudgeTimeoutRef.current) clearTimeout(nudgeTimeoutRef.current);
    };
  }, []);


  const applyImageDirectly = useCallback((newImageInfo: ImageInfo, widthInches: number, heightInches: number, alphaThresholded?: boolean) => {
    saveSnapshot();
    const currentAbH = artboardHeightRef.current;
    const currentAbW = artboardWidthRef.current;
    const currentDesignCount = designsRef.current.length;
    let effectiveAbH = currentAbH;
    const widthScale = Math.min(1, currentAbW / widthInches);
    const fittedHeight = heightInches * widthScale;
    if (fittedHeight > currentAbH) {
      const bestHeight = GANGSHEET_HEIGHTS.find(h => h >= fittedHeight);
      if (bestHeight && bestHeight > currentAbH) {
        effectiveAbH = bestHeight;
        if (currentDesignCount > 0) {
          setDesigns(prev => prev.map(d => ({
            ...d,
            transform: { ...d.transform, ny: (d.transform.ny * currentAbH) / bestHeight },
          })));
        }
        setArtboardHeight(bestHeight);
        toast({
          title: t("toast.gangsheetExpanded"),
          description: t("toast.gangsheetExpandedDesc", { dimensions: formatDimensions(currentAbW, bestHeight, lang) }),
        });
      } else if (!bestHeight) {
        const maxH = GANGSHEET_HEIGHTS[GANGSHEET_HEIGHTS.length - 1];
        if (maxH > currentAbH) {
          effectiveAbH = maxH;
          if (currentDesignCount > 0) {
            setDesigns(prev => prev.map(d => ({
              ...d,
              transform: { ...d.transform, ny: (d.transform.ny * currentAbH) / maxH },
            })));
          }
          setArtboardHeight(maxH);
          toast({
            title: t("toast.gangsheetMax"),
            description: t("toast.gangsheetMaxDesc", { dimensions: formatDimensions(currentAbW, maxH, lang) }),
          });
        }
      }
    }

    const maxSx = currentAbW / widthInches;
    const maxSy = effectiveAbH / heightInches;
    const initialS = Math.min(1, maxSx, maxSy);

    if (initialS < 1) {
      const origDims = formatDimensions(widthInches, heightInches, lang);
      const fitDims = formatDimensions(widthInches * initialS, heightInches * initialS, lang);
      toast({
        title: t("toast.imageResized"),
        description: t("toast.imageResizedDesc", { origDims, fitDims }),
        variant: "destructive",
      });
    }

    const scaledW = widthInches * initialS;
    const scaledH = heightInches * initialS;
    const gap = 0.25;

    let baseNx: number;
    let baseNy: number;
    const existingDesigns = designsRef.current;
    if (existingDesigns.length === 0) {
      baseNx = (scaledW / 2) / currentAbW;
      baseNy = (scaledH / 2) / effectiveAbH;
    } else {
      const occupied: { left: number; top: number; right: number; bottom: number }[] = existingDesigns.map(d => {
        const cx = d.transform.nx * currentAbW;
        const cy = d.transform.ny * effectiveAbH;
        const bounds = getRotatedBounds(d);
        return { left: cx + bounds.minX, top: cy + bounds.minY, right: cx + bounds.maxX, bottom: cy + bounds.maxY };
      });

      let placed = false;
      const sortedRows: number[] = [0, ...occupied.map(r => r.bottom + gap)].sort((a, b) => a - b);
      const uniqueRows = [...new Set(sortedRows.map(v => Math.round(v * 100) / 100))];

      for (const tryY of uniqueRows) {
        const candidateTop = tryY;
        const candidateBottom = tryY + scaledH;
        if (candidateBottom > effectiveAbH + 0.01) continue;

        const sortedCols: number[] = [0, ...occupied.map(r => r.right + gap)].sort((a, b) => a - b);
        const uniqueCols = [...new Set(sortedCols.map(v => Math.round(v * 100) / 100))];

        for (const tryX of uniqueCols) {
          const candidateLeft = tryX;
          const candidateRight = tryX + scaledW;
          if (candidateRight > currentAbW + 0.01) continue;

          const overlaps = occupied.some(r =>
            candidateLeft < r.right + gap &&
            candidateRight > r.left - gap &&
            candidateTop < r.bottom + gap &&
            candidateBottom > r.top - gap
          );
          if (!overlaps) {
            baseNx = (candidateLeft + scaledW / 2) / currentAbW;
            baseNy = (candidateTop + scaledH / 2) / effectiveAbH;
            placed = true;
            break;
          }
        }
        if (placed) break;
      }

      if (!placed) {
        const maxBottom = Math.max(...occupied.map(r => r.bottom));
        baseNx = (scaledW / 2) / currentAbW;
        baseNy = (maxBottom + gap + scaledH / 2) / effectiveAbH;
      }
    }

    const newTransform = { nx: Math.min(baseNx, 0.95), ny: Math.min(baseNy, 0.95), s: initialS, rotation: 0 };

    setImageInfo(newImageInfo);
    setDesignTransform(newTransform);
    setResizeSettings(prev => ({
      ...prev,
      widthInches,
      heightInches,
    }));

    const newDesignId = crypto.randomUUID();
    const newDesignItem: DesignItem = {
      id: newDesignId,
      imageInfo: newImageInfo,
      transform: newTransform,
      widthInches,
      heightInches,
      name: newImageInfo.file.name,
      originalDPI: newImageInfo.dpi,
      ...(alphaThresholded ? { alphaThresholded: true } : {}),
    };
    setDesigns(prev => [...prev, newDesignItem]);
    setSelectedDesignId(newDesignId);
  }, [saveSnapshot, toast]);

  const handleFallbackImage = useCallback(async (
    file: File,
    image: HTMLImageElement,
    opts?: { dpi?: number; skipCrop?: boolean }
  ) => {
    const dpiRaw = opts?.dpi ?? (await fetchImageDpi(file).catch((err) => { console.warn('[fetchImageDpi] failed:', err); return RASTER_DPI_FALLBACK; }));

    let croppedCanvas: HTMLCanvasElement | null = null;
    if (opts?.skipCrop) {
      const fullCanvas = document.createElement("canvas");
      fullCanvas.width = image.width;
      fullCanvas.height = image.height;
      const ctx = fullCanvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(image, 0, 0);
        croppedCanvas = fullCanvas;
      }
    }
    if (!croppedCanvas) {
      try { croppedCanvas = cropImageToContent(image); } catch { /* use original */ }
    }

    const processImage = (finalImage: HTMLImageElement) => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      setIsUploading(false);

      const dpi = normalizeRasterDpiForInches(dpiRaw, finalImage);

      const { widthInches, heightInches } = inchesFromPixelsPair(
        finalImage.naturalWidth || finalImage.width,
        finalImage.naturalHeight || finalImage.height,
        dpi,
      );

      const newImageInfo: ImageInfo = {
        file,
        image: finalImage,
        originalWidth: finalImage.width,
        originalHeight: finalImage.height,
        dpi,
      };

      applyImageDirectly(newImageInfo, widthInches, heightInches, imageHasCleanAlpha(finalImage));
      if (isMobile) setMobilePanel("preview");

      const effectiveDPI = Math.min(finalImage.width / widthInches, finalImage.height / heightInches);
      if (effectiveDPI < 278) {
        toast({
          title: t("toast.lowRes"),
          description: t("toast.lowResDesc"),
          variant: "warning",
        });
      }
    };

    if (croppedCanvas) {
      const img = new Image();
      img.onload = () => processImage(img);
      img.onerror = () => { setIsUploading(false); processImage(image); };
      img.src = croppedCanvas.toDataURL();
    } else {
      processImage(image);
    }
  }, [applyImageDirectly, isMobile, toast]);

  const handleImageUpload = useCallback(async (file: File, image: HTMLImageElement) => {
    try {
      if (image.width * image.height > 1000000000) {
        toast({ title: t("toast.imageTooLarge"), description: t("toast.imageTooLargeDesc"), variant: "destructive" });
        return;
      }
      
      if (image.width <= 0 || image.height <= 0) {
        toast({ title: t("toast.invalidImage"), description: t("toast.invalidImageDesc"), variant: "destructive" });
        return;
      }
      
      setIsUploading(true);
      setUploadProgress(10);
      
      await new Promise(r => setTimeout(r, 0));
      setUploadProgress(25);
      
      const dpiRaw = await fetchImageDpi(file).catch((err) => { console.warn('[fetchImageDpi] failed:', err); return RASTER_DPI_FALLBACK; });
      const dpi = normalizeRasterDpiForInches(dpiRaw, image);
      const imgWidthInches = image.width / dpi;
      const imgHeightInches = image.height / dpi;
      const ARTBOARD_MATCH_TOLERANCE = 0.05;
      const matchesArtboard =
        Math.abs(imgWidthInches - artboardWidth) / Math.max(artboardWidth, 0.1) <= ARTBOARD_MATCH_TOLERANCE &&
        Math.abs(imgHeightInches - artboardHeight) / Math.max(artboardHeight, 0.1) <= ARTBOARD_MATCH_TOLERANCE;

      let croppedCanvas: HTMLCanvasElement | null = null;
      if (matchesArtboard) {
        const fullCanvas = document.createElement("canvas");
        fullCanvas.width = image.width;
        fullCanvas.height = image.height;
        const ctx = fullCanvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(image, 0, 0);
          croppedCanvas = fullCanvas;
        }
      }
      if (!croppedCanvas) {
        if (isOpaqueRasterUpload(image)) {
          const fullCanvas = document.createElement('canvas');
          fullCanvas.width = image.width;
          fullCanvas.height = image.height;
          const fctx = fullCanvas.getContext('2d');
          if (fctx) {
            fctx.drawImage(image, 0, 0);
            croppedCanvas = fullCanvas;
          }
        } else {
          croppedCanvas = await cropImageToContentAsync(image);
        }
      }
      if (!croppedCanvas) {
        console.error("Failed to crop image, using original");
        await handleFallbackImage(file, image, { dpi, skipCrop: matchesArtboard });
        return;
      }
      
      setUploadProgress(60);
      const MAX_STORED_DIMENSION = 4000;

      const loadImageFromBlob = (blob: Blob): Promise<HTMLImageElement> =>
        new Promise((res, rej) => {
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => { URL.revokeObjectURL(url); res(img); };
          img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Image load failed')); };
          img.src = url;
        });

      const canvasToBlob = (cvs: HTMLCanvasElement): Promise<Blob | null> =>
        new Promise(res => cvs.toBlob(res, 'image/png'));

      const blob = await canvasToBlob(croppedCanvas);
      setUploadProgress(70);
      if (!blob) { await handleFallbackImage(file, image, { dpi, skipCrop: matchesArtboard }); return; }

      let croppedImg: HTMLImageElement;
      try {
        croppedImg = await loadImageFromBlob(blob);
      } catch {
        await handleFallbackImage(file, image, { dpi, skipCrop: matchesArtboard }); return;
      }

      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }

      const intrinsicW = croppedImg.naturalWidth || croppedImg.width;
      const intrinsicH = croppedImg.naturalHeight || croppedImg.height;
      let storedWidth = intrinsicW;
      let storedHeight = intrinsicH;
      const maxDim = Math.max(intrinsicW, intrinsicH);

      if (maxDim > MAX_STORED_DIMENSION) {
        setUploadProgress(75);
        const scale = MAX_STORED_DIMENSION / maxDim;
        storedWidth = Math.round(intrinsicW * scale);
        storedHeight = Math.round(intrinsicH * scale);
        const downsampleCanvas = document.createElement('canvas');
        downsampleCanvas.width = storedWidth;
        downsampleCanvas.height = storedHeight;
        const dsCtx = downsampleCanvas.getContext('2d');
        if (!dsCtx) throw new Error('Could not create canvas context for downsampling');
        const preserveCleanAlpha = imageHasCleanAlpha(croppedImg);
        dsCtx.imageSmoothingEnabled = !preserveCleanAlpha;
        if (!preserveCleanAlpha) dsCtx.imageSmoothingQuality = 'high';
        dsCtx.drawImage(croppedImg, 0, 0, storedWidth, storedHeight);
        const dsBlob = await canvasToBlob(downsampleCanvas);
        setUploadProgress(85);
        if (dsBlob) {
          try {
            croppedImg = await loadImageFromBlob(dsBlob);
          } catch { /* keep original croppedImg */ }
        }
      } else {
        setUploadProgress(85);
      }

      setUploadProgress(95);
      const { widthInches, heightInches } = inchesFromPixelsPair(intrinsicW, intrinsicH, dpi);
      const bw = croppedImg.naturalWidth || croppedImg.width;
      const bh = croppedImg.naturalHeight || croppedImg.height;
      const newImageInfo: ImageInfo = { file, image: croppedImg, originalWidth: bw, originalHeight: bh, dpi };
      applyImageDirectly(newImageInfo, widthInches, heightInches, imageHasCleanAlpha(croppedImg));
      if (isMobile) setMobilePanel("preview");
      if (matchesArtboard) {
        toast({ title: t("toast.gangsheetDetected"), description: t("toast.gangsheetDetectedDesc") });
      }
      setUploadProgress(100);
      setTimeout(() => { setIsUploading(false); setUploadProgress(0); }, 300);

      const effectiveDPI = Math.min(intrinsicW / widthInches, intrinsicH / heightInches);
      if (effectiveDPI < 278) {
        toast({
          title: t("toast.lowRes"),
          description: t("toast.lowResDesc"),
          variant: "warning",
        });
      }
      } catch (error) {
        console.error('Error processing uploaded image:', error);
        setIsUploading(false);
        setUploadProgress(0);
        try {
          const dpiFallbackRaw = await fetchImageDpi(file).catch((err) => { console.warn('[fetchImageDpi] failed:', err); return RASTER_DPI_FALLBACK; });
          const dpiFallback = normalizeRasterDpiForInches(dpiFallbackRaw, image);
          const wIn = image.width / dpiFallback;
          const hIn = image.height / dpiFallback;
          const match = Math.abs(wIn - artboardWidth) / Math.max(artboardWidth, 0.1) <= 0.05 &&
            Math.abs(hIn - artboardHeight) / Math.max(artboardHeight, 0.1) <= 0.05;
          await handleFallbackImage(file, image, { dpi: dpiFallback, skipCrop: match });
        } catch (fallbackErr) {
        console.error('Fallback image processing also failed:', fallbackErr);
        toast({ title: t("toast.uploadFailed"), description: t("toast.uploadFailedDesc"), variant: "destructive" });
      }
    }
  }, [applyImageDirectly, isMobile, toast, handleFallbackImage, artboardWidth, artboardHeight]);

  const handlePDFUpload = useCallback((file: File, pdfData: ParsedPDFData) => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    
    const { image, originalPdfData, dpi } = pdfData;
    
    const newImageInfo: ImageInfo = {
      file,
      image,
      originalWidth: image.width,
      originalHeight: image.height,
      dpi,
      isPDF: true,
      originalPdfData,
    };
    
    const { widthInches, heightInches } = inchesFromPixelsPair(
      image.naturalWidth || image.width,
      image.naturalHeight || image.height,
      dpi,
    );

    applyImageDirectly(newImageInfo, widthInches, heightInches);
    if (isMobile) setMobilePanel("preview");
  }, [applyImageDirectly, isMobile]);

  const handleBatchStart = useCallback((fileCount: number) => {
    const targetHeight = Math.min(48, GANGSHEET_HEIGHTS[GANGSHEET_HEIGHTS.length - 1]);
    const validHeight = GANGSHEET_HEIGHTS.reduce((best, h) => h <= targetHeight && h > best ? h : best, GANGSHEET_HEIGHTS[0]);
    if (fileCount > 1 && artboardHeightRef.current < validHeight) {
      setArtboardHeight(validHeight);
    }
  }, [GANGSHEET_HEIGHTS]);

  const handleFileUploadUnified = useCallback(async (file: File, image: HTMLImageElement | null) => {
    const ext = file.name.toLowerCase();
    const isPdf = file.type === 'application/pdf' || ext.endsWith('.pdf');
    if (isPdf) {
      try {
        setIsUploading(true);
        const pdfData = await parsePDF(file);
        handlePDFUpload(file, pdfData);
        if (isMobile) setMobilePanel("preview");
      } catch (err) {
        console.error('PDF parse error:', err);
        toast({ title: t("toast.pdfFailed"), description: t("toast.pdfFailedDesc"), variant: "destructive" });
      } finally {
        setIsUploading(false);
      }
      return;
    }
    if (image) {
      await handleImageUpload(file, image);
      if (isMobile) setMobilePanel("preview");
    }
  }, [handleImageUpload, handlePDFUpload, isMobile, toast]);

  const processSidebarFile = useCallback((file: File): Promise<void> => {
    const ext = file.name.toLowerCase();
    const isPdf = file.type === 'application/pdf' || ext.endsWith('.pdf');
    const isImage = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || ['.png', '.jpg', '.jpeg', '.webp'].some(x => ext.endsWith(x));
    if (!isImage && !isPdf) {
      toast({ title: t("toast.unsupportedFormat"), description: t("toast.formatOnly"), variant: "destructive" });
      return Promise.resolve();
    }
    if (isPdf) {
      return (async () => {
        try {
          setIsUploading(true);
          const pdfData = await parsePDF(file);
          handlePDFUpload(file, pdfData);
        } catch (err) {
          console.error('PDF parse error:', err);
          toast({ title: t("toast.pdfFailed"), description: t("toast.pdfFailedShort"), variant: "destructive" });
        } finally {
          setIsUploading(false);
        }
      })();
    }
    return new Promise<void>((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const isPng = file.type === 'image/png' || ext.endsWith('.png');
        if (!isPng) {
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          const ctx = c.getContext('2d');
          if (!ctx) { handleImageUpload(file, img).finally(resolve); return; }
          ctx.drawImage(img, 0, 0);
          c.toBlob(blob => {
            if (!blob) { handleImageUpload(file, img).finally(resolve); return; }
            const pf = new File([blob], file.name.replace(/\.\w+$/, '.png'), { type: 'image/png' });
            const pi = new Image();
            const u2 = URL.createObjectURL(blob);
            pi.onload = () => { URL.revokeObjectURL(u2); handleImageUpload(pf, pi).finally(resolve); };
            pi.onerror = () => { URL.revokeObjectURL(u2); handleImageUpload(file, img).finally(resolve); };
            pi.src = u2;
          }, 'image/png');
        } else {
          handleImageUpload(file, img).finally(resolve);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        toast({ title: t("toast.failedLoad"), description: t("toast.failedLoadFile", { name: file.name }), variant: "destructive" });
        resolve();
      };
      img.src = url;
    });
  }, [handleImageUpload, handlePDFUpload, toast]);

  const handleSidebarFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    if (files.length > 1) {
      const targetHeight = Math.min(48, GANGSHEET_HEIGHTS[GANGSHEET_HEIGHTS.length - 1]);
      const validHeight = GANGSHEET_HEIGHTS.reduce((best, h) => h <= targetHeight && h > best ? h : best, GANGSHEET_HEIGHTS[0]);
      if (artboardHeightRef.current < validHeight) {
        setArtboardHeight(validHeight);
      }
    }
    for (const file of files) {
      await processSidebarFile(file);
    }
  }, [processSidebarFile, GANGSHEET_HEIGHTS]);

  useEffect(() => {
    const onOpenUpload = () => {
      headerUploadInputRef.current?.click();
    };
    window.addEventListener("dtf:open-upload", onOpenUpload);
    return () => {
      window.removeEventListener("dtf:open-upload", onOpenUpload);
    };
  }, []);

  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    if (files.length > 1) {
      const targetHeight = Math.min(48, GANGSHEET_HEIGHTS[GANGSHEET_HEIGHTS.length - 1]);
      const validHeight = GANGSHEET_HEIGHTS.reduce((best, h) => h <= targetHeight && h > best ? h : best, GANGSHEET_HEIGHTS[0]);
      if (artboardHeightRef.current < validHeight) {
        setArtboardHeight(validHeight);
      }
    }
    for (const file of files) {
      await processSidebarFile(file);
    }
  }, [processSidebarFile, profile.gangsheetHeights]);

  const handleResizeChange = useCallback((newSettings: Partial<ResizeSettings>) => {
    const currentImageInfo = selectedDesign?.imageInfo || imageInfo;
    const hasSizeChange = newSettings.widthInches !== undefined || newSettings.heightInches !== undefined;
    if (hasSizeChange && selectedDesignId) saveSnapshot();

    const canComputeAspect = currentImageInfo?.originalWidth && currentImageInfo?.originalHeight;
    let finalSettings: ResizeSettings = resizeSettings;
    setResizeSettings(prev => {
      const updated = { ...prev, ...newSettings };

      if (updated.maintainAspectRatio && canComputeAspect && newSettings.widthInches !== undefined) {
        const aspectRatio = currentImageInfo!.originalHeight / currentImageInfo!.originalWidth;
        updated.heightInches = Math.max(0.01, parseFloat((newSettings.widthInches! * aspectRatio).toFixed(1)));
      } else if (updated.maintainAspectRatio && canComputeAspect && newSettings.heightInches !== undefined) {
        const aspectRatio = currentImageInfo!.originalWidth / currentImageInfo!.originalHeight;
        updated.widthInches = Math.max(0.01, parseFloat((newSettings.heightInches! * aspectRatio).toFixed(1)));
      }

      finalSettings = updated;
      return updated;
    });

    if (hasSizeChange && selectedDesignId) {
      const abW = artboardWidthRef.current;
      const abH = artboardHeightRef.current;
      setDesigns(prev => prev.map(d => {
        if (d.id !== selectedDesignId) return d;
        const updated = { ...d, widthInches: finalSettings.widthInches, heightInches: finalSettings.heightInches };
        const { nx, ny } = clampDesignToArtboard(updated, abW, abH);
        return { ...updated, transform: { ...updated.transform, nx, ny } };
      }));
    }
  }, [imageInfo, selectedDesign, selectedDesignId, saveSnapshot, resizeSettings]);


  const thresholdAlphaForDesign = useCallback((info: ImageInfo): Promise<ImageInfo | null> => {
    return new Promise(resolve => {
      try {
        const src = info.image;
        const w = src.naturalWidth || src.width;
        const h = src.naturalHeight || src.height;
        if (!w || !h) { resolve(null); return; }
        const cvs = document.createElement('canvas');
        cvs.width = w; cvs.height = h;
        const ctx = cvs.getContext('2d');
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(src, 0, 0);
        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;
        for (let i = 3; i < data.length; i += 4) {
          data[i] = data[i] >= 128 ? 255 : 0;
        }
        ctx.putImageData(imgData, 0, 0);
        cvs.toBlob(blob => {
          if (!blob) { resolve(null); return; }
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => { URL.revokeObjectURL(url); resolve({ ...info, image: img }); };
          img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
          img.src = url;
        }, 'image/png');
      } catch { resolve(null); }
    });
  }, []);

  const handleThresholdAlpha = useCallback(async () => {
    try {
      const targetIds = selectedDesignIds.size > 0 ? Array.from(selectedDesignIds) : (selectedDesignId ? [selectedDesignId] : []);
      if (targetIds.length === 0) return;
      saveSnapshot();
      const targetDesigns = designs.filter(d => targetIds.includes(d.id));
      const results = await Promise.all(targetDesigns.map(d => thresholdAlphaForDesign(d.imageInfo)));
      const updates = new Map<string, ImageInfo>();
      targetDesigns.forEach((d, i) => { if (results[i]) updates.set(d.id, results[i]!); });
      if (updates.size === 0) { toast({ title: t("toast.alphaFailed"), description: t("toast.alphaFailedDesc"), variant: "destructive" }); return; }
      setDesigns(prev => prev.map(d => {
        const newInfo = updates.get(d.id);
        return newInfo ? { ...d, imageInfo: newInfo, alphaThresholded: true } : d;
      }));
      if (selectedDesignId && updates.has(selectedDesignId)) setImageInfo(updates.get(selectedDesignId)!);
      toast({ title: t("toast.alphaApplied"), description: updates.size !== 1 ? t("toast.alphaAppliedDescPlural", { count: updates.size }) : t("toast.alphaAppliedDesc", { count: updates.size }) });
    } catch (err) {
      console.error('Alpha threshold failed:', err);
      toast({ title: t("toast.alphaFailed"), description: t("toast.alphaFailedDesc"), variant: "destructive" });
    }
  }, [designs, selectedDesignId, selectedDesignIds, saveSnapshot, toast, thresholdAlphaForDesign]);

  const handleThresholdAlphaAll = useCallback(async () => {
    try {
      if (designs.length === 0) return;
      saveSnapshot();
      const results = await Promise.all(designs.map(d => thresholdAlphaForDesign(d.imageInfo)));
      const updates = new Map<string, ImageInfo>();
      designs.forEach((d, i) => { if (results[i]) updates.set(d.id, results[i]!); });
      if (updates.size === 0) { toast({ title: t("toast.alphaFailed"), description: t("toast.alphaFailedAllDesc"), variant: "destructive" }); return; }
      setDesigns(prev => prev.map(d => {
        const newInfo = updates.get(d.id);
        return newInfo ? { ...d, imageInfo: newInfo, alphaThresholded: true } : d;
      }));
      if (selectedDesignId && updates.has(selectedDesignId)) setImageInfo(updates.get(selectedDesignId)!);
      toast({ title: t("toast.alphaAllApplied"), description: updates.size !== 1 ? t("toast.alphaAppliedDescPlural", { count: updates.size }) : t("toast.alphaAppliedDesc", { count: updates.size }) });
    } catch (err) {
      console.error('Alpha threshold all failed:', err);
      toast({ title: t("toast.alphaFailed"), description: t("toast.alphaFailedAllDesc"), variant: "destructive" });
    }
  }, [designs, selectedDesignId, saveSnapshot, toast, thresholdAlphaForDesign]);

  const handleCropDesign = useCallback(() => {
    const id = contextMenu?.designId ?? selectedDesignId;
    if (id) {
      setCropModalDesignId(id);
      setContextMenu(null);
    }
  }, [contextMenu, selectedDesignId]);

  const handleCropApply = useCallback((designId: string, newImageInfo: ImageInfo) => {
    saveSnapshot();
    const design = designs.find(d => d.id === designId);
    if (!design) return;
    const aspect = design.widthInches / design.heightInches;
    const newAspect = newImageInfo.image.naturalWidth / newImageInfo.image.naturalHeight;
    let widthInches = design.widthInches;
    let heightInches = design.heightInches;
    if (Math.abs(newAspect - aspect) > 0.01) {
      heightInches = widthInches / newAspect;
    }
    setDesigns(prev => prev.map(d =>
      d.id === designId
        ? { ...d, imageInfo: newImageInfo, widthInches, heightInches }
        : d
    ));
    if (selectedDesignId === designId) setImageInfo(newImageInfo);
    setResizeSettings(prev => ({ ...prev, widthInches, heightInches }));
    setCropModalDesignId(null);
    toast({ title: t("toast.cropApplied"), description: t("toast.cropAppliedDesc") });
  }, [designs, selectedDesignId, saveSnapshot, toast, setImageInfo]);

  const handleDownload = useCallback(async (downloadType: string = 'standard', format: string = 'png', spotColorsByDesign?: Record<string, any[]>) => {
    if (designs.length === 0) {
      toast({ title: t("toast.noDesigns"), description: t("toast.noDesignsDesc"), variant: "destructive" });
      return;
    }

    setIsProcessing(true);

    try {
      const firstName = (designs[0]?.name || imageInfo?.file.name || 'gangsheet').replace(/\.[^/.]+$/, '');

      await new Promise(r => setTimeout(r, 50));

      if (format === 'pdf') {
        const { PDFDocument, degrees } = await import('pdf-lib');
        const { addSpotColorVectorsToPDF } = await import('@/lib/spot-color-vectors');

        const exportDpi = 300;
        const pageWidthPt = artboardWidth * 72;
        const pageHeightPt = artboardHeight * 72;
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);

        for (const design of designs) {
          const img = design.imageInfo.image;
          const cvs = document.createElement('canvas');
          const drawW = Math.round(design.widthInches * design.transform.s * exportDpi);
          const drawH = Math.round(design.heightInches * design.transform.s * exportDpi);
          cvs.width = drawW;
          cvs.height = drawH;
          const cctx = cvs.getContext('2d');
          if (!cctx) continue;
          if (design.transform.flipX || design.transform.flipY) {
            cctx.save();
            cctx.translate(design.transform.flipX ? drawW : 0, design.transform.flipY ? drawH : 0);
            cctx.scale(design.transform.flipX ? -1 : 1, design.transform.flipY ? -1 : 1);
            cctx.drawImage(img, 0, 0, drawW, drawH);
            cctx.restore();
          } else {
            cctx.drawImage(img, 0, 0, drawW, drawH);
          }
          let pngDataUrl: string;
          try {
            pngDataUrl = cvs.toDataURL('image/png');
          } catch (err) {
            console.warn('Canvas toDataURL failed for design', design.id, err);
            continue;
          }
          const base64 = pngDataUrl.split(',')[1];
          if (!base64) {
            console.warn('Invalid PNG data URL for design', design.id);
            continue;
          }
          const pngBytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
          const pdfImage = await pdfDoc.embedPng(pngBytes);

          const designWidthPt = design.widthInches * design.transform.s * 72;
          const designHeightPt = design.heightInches * design.transform.s * 72;
          const centerXPt = design.transform.nx * pageWidthPt;
          const centerYPt = pageHeightPt - design.transform.ny * pageHeightPt;
          const rotDeg = design.transform.rotation ?? 0;
          const rotRad = (-rotDeg * Math.PI) / 180;
          const cosR = Math.cos(rotRad);
          const sinR = Math.sin(rotRad);

          page.drawImage(pdfImage, {
            x: centerXPt - (designWidthPt / 2) * cosR + (designHeightPt / 2) * sinR,
            y: centerYPt - (designWidthPt / 2) * sinR - (designHeightPt / 2) * cosR,
            width: designWidthPt,
            height: designHeightPt,
            rotate: degrees(-rotDeg),
          });

          if (design.printFileName) {
            const { StandardFonts } = await import('pdf-lib');
            const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
            const displayName = design.name.replace(/\.[^/.]+$/, '');
            const fontSize = Math.max(4, Math.round(0.08 * 72));
            const textWidth = font.widthOfTextAtSize(displayName, fontSize);
            const margin = 0.02 * 72;
            const textX = centerXPt + (designWidthPt / 2) * cosR - (designHeightPt / 2) * sinR - textWidth - margin;
            const textY = centerYPt - (designWidthPt / 2) * sinR - (designHeightPt / 2) * cosR + margin;
            page.drawText(displayName, {
              x: textX,
              y: textY,
              size: fontSize,
              font,
              rotate: degrees(-rotDeg),
            });
          }

          if (spotColorsByDesign) {
            const designSpotColors = spotColorsByDesign[design.id];
            if (designSpotColors && designSpotColors.length > 0) {
              const hasFluor = designSpotColors.some((c: any) => c.spotFluorY || c.spotFluorM || c.spotFluorG || c.spotFluorOrange);
              if (hasFluor) {
                const offsetXInches = design.transform.nx * artboardWidth - (design.widthInches * design.transform.s) / 2;
                const offsetYInches = design.transform.ny * artboardHeight - (design.heightInches * design.transform.s) / 2;
                await addSpotColorVectorsToPDF(
                  pdfDoc, page, img, designSpotColors,
                  design.widthInches * design.transform.s,
                  design.heightInches * design.transform.s,
                  artboardHeight,
                  offsetXInches,
                  offsetYInches,
                  design.transform.rotation ?? 0,
                );
              }
            }
          }
          cvs.width = 0;
          cvs.height = 0;
        }

        const pdfBytes = await pdfDoc.save();
        const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(pdfBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${firstName}.pdf`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } else {
        const filename = `${firstName}.png`;

        const worker = getExportWorker();
        const useWorker = worker && typeof OffscreenCanvas !== 'undefined';

        let exportDpi: number;
        if (useWorker) {
          exportDpi = 300;
        } else {
          const MAX_FALLBACK_PIXELS = 80_000_000;
          const MAX_FALLBACK_DIM = 12_000;
          const dpiByArea = Math.sqrt(MAX_FALLBACK_PIXELS / Math.max(1e-6, artboardWidth * artboardHeight));
          const dpiByDim = Math.min(MAX_FALLBACK_DIM / artboardWidth, MAX_FALLBACK_DIM / artboardHeight);
          exportDpi = Math.min(300, dpiByArea, dpiByDim);
          if (exportDpi < 300) {
            toast({
              title: t("toast.largeSheet"),
              description: t("toast.largeSheetDesc", { dpi: Math.floor(exportDpi) }),
            });
          }
        }

        const outW = Math.max(1, Math.round(artboardWidth * exportDpi));
        const outH = Math.max(1, Math.round(artboardHeight * exportDpi));

        let pngBlob: Blob;

        if (useWorker) {
          const bitmaps = await Promise.all(
            designs.map(d => createImageBitmap(d.imageInfo.image))
          );
          const exportDesigns = designs.map((d, i) => ({
            widthInches: d.widthInches,
            heightInches: d.heightInches,
            nx: d.transform.nx,
            ny: d.transform.ny,
            s: d.transform.s,
            rotation: d.transform.rotation,
            flipX: d.transform.flipX,
            flipY: d.transform.flipY,
            bitmap: bitmaps[i],
            alphaThresholded: d.alphaThresholded,
            printFileName: d.printFileName,
            name: d.name,
          }));
          const requestId = ++_exportReqCounter;
          pngBlob = await new Promise<Blob>((resolve, reject) => {
            const EXPORT_TIMEOUT_MS = 300_000;
            let settled = false;
            const cleanup = () => {
              worker.removeEventListener('message', handler);
              worker.removeEventListener('error', errorHandler);
              clearTimeout(timer);
            };
            const handler = (e: MessageEvent) => {
              if (e.data.requestId !== requestId) return;
              settled = true;
              cleanup();
              if (e.data.type === 'error') reject(new Error(e.data.error));
              else resolve(e.data.blob);
            };
            const errorHandler = (ev: ErrorEvent) => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(new Error(ev.message || 'Export worker crashed'));
            };
            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(new Error('Export timed out — the gangsheet may be too large. Try a smaller size.'));
            }, EXPORT_TIMEOUT_MS);
            worker.addEventListener('message', handler);
            worker.addEventListener('error', errorHandler);
            worker.postMessage(
              { type: 'export', requestId, designs: exportDesigns, outW, outH, exportDpi },
              bitmaps,
            );
          });
        } else {
          const exportCanvas = document.createElement('canvas');
          exportCanvas.width = outW;
          exportCanvas.height = outH;
          const ctx = exportCanvas.getContext('2d');
          if (!ctx) throw new Error('Failed to prepare export canvas');
          ctx.clearRect(0, 0, outW, outH);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          for (const design of designs) {
            const img = design.imageInfo.image;
            const drawW = Math.max(1, Math.round(design.widthInches * design.transform.s * exportDpi));
            const drawH = Math.max(1, Math.round(design.heightInches * design.transform.s * exportDpi));
            const centerX = design.transform.nx * outW;
            const centerY = design.transform.ny * outH;
            if (design.alphaThresholded) ctx.imageSmoothingEnabled = false;
            ctx.save();
            ctx.translate(centerX, centerY);
            ctx.rotate((design.transform.rotation * Math.PI) / 180);
            ctx.scale(design.transform.flipX ? -1 : 1, design.transform.flipY ? -1 : 1);
            ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
            if (design.printFileName) {
              ctx.scale(design.transform.flipX ? -1 : 1, design.transform.flipY ? -1 : 1);
              const fontSize = Math.max(8, Math.round(drawH * 0.045));
              ctx.font = `bold ${fontSize}px sans-serif`;
              ctx.fillStyle = '#000000';
              ctx.textAlign = 'right';
              ctx.textBaseline = 'bottom';
              const margin = Math.round(fontSize * 0.3);
              const displayName = design.name.replace(/\.[^/.]+$/, '');
              ctx.fillText(displayName, drawW / 2 - margin, drawH / 2 - margin);
              ctx.scale(design.transform.flipX ? -1 : 1, design.transform.flipY ? -1 : 1);
            }
            ctx.restore();
            if (design.alphaThresholded) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; }
          }
          const rawBlob: Blob = await new Promise((res, rej) =>
            exportCanvas.toBlob((b) => b ? res(b) : rej(new Error('toBlob failed')), 'image/png'));
          exportCanvas.width = 0;
          exportCanvas.height = 0;
          pngBlob = await injectPngDpi(rawBlob, exportDpi);
        }

        const url = URL.createObjectURL(pngBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        const revokeMs = Math.max(5000, Math.round(pngBlob.size / 100000));
        setTimeout(() => URL.revokeObjectURL(url), revokeMs);
      }
    } catch (error) {
      console.error("Download failed:", error);
      toast({ title: t("toast.downloadFailed"), description: error instanceof Error ? error.message : t("toast.downloadFailedDesc"), variant: "destructive" });
    } finally {
      setIsProcessing(false);
    }
  }, [imageInfo, designs, artboardWidth, artboardHeight, toast]);

  const handleAddToCart = useCallback(async () => {
    if (designs.length === 0) {
      toast({ title: "No designs", description: "Add at least one design before adding to cart.", variant: "destructive" });
      return;
    }
    setIsAddingToCart(true);
    setIsProcessing(true);
    try {
      const exportDpi = 72;
      const outW = Math.round(artboardWidth * exportDpi);
      const outH = Math.round(artboardHeight * exportDpi);
      const previewCanvas = document.createElement('canvas');
      previewCanvas.width = outW;
      previewCanvas.height = outH;
      const ctx = previewCanvas.getContext('2d');
      if (!ctx) throw new Error('Canvas not supported');
      ctx.clearRect(0, 0, outW, outH);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, outW, outH);
      for (const design of designs) {
        const img = design.imageInfo.image;
        const drawW = Math.max(1, Math.round(design.widthInches * design.transform.s * exportDpi));
        const drawH = Math.max(1, Math.round(design.heightInches * design.transform.s * exportDpi));
        const centerX = design.transform.nx * outW;
        const centerY = design.transform.ny * outH;
        ctx.save();
        ctx.translate(centerX, centerY);
        ctx.rotate((design.transform.rotation * Math.PI) / 180);
        ctx.scale(design.transform.flipX ? -1 : 1, design.transform.flipY ? -1 : 1);
        ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
        ctx.restore();
      }
      const dataUrl = previewCanvas.toDataURL('image/png');
      const base64 = dataUrl.split(',')[1];
      previewCanvas.width = 0;
      previewCanvas.height = 0;

      const selectedVariant = shopifyVariants?.find((v) => v.height != null && Math.abs(v.height - artboardHeight) < 0.01);
      const vid = selectedVariant?.id || initialVariantId || '';
      const vidDigits = vid.replace(/\D/g, '');

      if (!vidDigits) throw new Error('No variant ID available');
      if (!shopDomain) throw new Error('Shop domain missing — open the builder from the storefront product page.');

      const message = {
        type: 'dtf-builder-add-to-cart',
        variantId: vidDigits,
        quantity: quantity,
        gangsheetSize: artboardWidth + '" x ' + artboardHeight + '"',
        shop: shopDomain || '',
        imageBase64: base64,
        filename: 'gangsheet-' + Date.now() + '.png',
      };
      window.parent.postMessage(message, '*');
      // Keep loading state until parent redirects (upload runs in parent). Do not clear in finally.
    } catch (error) {
      console.error('Add to cart failed:', error);
      toast({ title: "Failed", description: error instanceof Error ? error.message : "Could not add to cart", variant: "destructive" });
      setIsAddingToCart(false);
      setIsProcessing(false);
    }
  }, [designs, artboardWidth, artboardHeight, quantity, shopifyVariants, initialVariantId, shopDomain, toast]);

  const renderActionToolbar = () => (
    <>
  {/* Top bar: three rows on mobile, wraps on desktop when metric to avoid overlap */}
  <div className="flex-shrink-0 flex flex-col lg:flex-row lg:flex-wrap lg:items-center gap-1.5 lg:gap-2 bg-white border-b border-gray-200 px-2 py-1 lg:px-3 lg:py-1.5">
    {/* Row 1: Upload, file info, Auto-Arrange, Undo/Redo/Dup/Del */}
    <div className="flex items-center gap-1.5 lg:gap-2 min-w-0 flex-wrap flex-shrink-0">
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
            className={`flex items-center gap-1 px-2 py-1 rounded-md transition-all whitespace-nowrap text-[11px] font-medium shadow-sm min-h-[36px] lg:min-h-0 ${
              selectedDesignId || selectedDesignIds.size > 0
                ? 'bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#2563EB] border border-[#CBD5E1] shadow-none'
                : 'bg-gray-200 text-gray-500 opacity-30 pointer-events-none'
            }`}
            title={t("editor.cleanAlphaTitle")}
          >
            <Droplets className="w-3 h-3" />
            {t("editor.cleanAlpha")}
          </button>
          <button
            onClick={handleThresholdAlphaAll}
            disabled={designs.length === 0}
            className={`flex items-center gap-1 px-2 py-1 rounded-md transition-all whitespace-nowrap text-[11px] font-medium shadow-sm min-h-[36px] lg:min-h-0 ${
              designs.length > 0
                ? 'bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#2563EB] border border-[#CBD5E1] shadow-none'
                : 'bg-gray-200 text-gray-500 opacity-30 pointer-events-none'
            }`}
            title={t("editor.cleanAlphaAllTitle")}
          >
            <Droplets className="w-3 h-3" />
            {t("editor.cleanAlphaAll")}
          </button>
          {!isMobile && (
            <button
              onClick={() => handleAutoArrange({ preserveSelection: selectedDesignIds.size >= 2 })}
              disabled={designs.length < 2 && selectedDesignIds.size < 2}
              className={`flex items-center gap-1 px-2 py-1 rounded-md transition-all whitespace-nowrap font-medium shadow-sm min-h-[36px] lg:min-h-0 ${lang !== 'en' ? 'text-[10px]' : 'text-[11px]'} ${
                designs.length >= 2 || selectedDesignIds.size >= 2
                  ? 'bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#0891B2] border border-[#CBD5E1] shadow-none'
                  : 'bg-gray-200 text-gray-500 opacity-30 pointer-events-none'
              }`}
              title={selectedDesignIds.size >= 2 ? t("editor.autoArrangeSelected") : t("editor.autoArrangeAll")}
            >
              <LayoutGrid className="w-3 h-3 flex-shrink-0" />
              {t("editor.autoArrange")}
            </button>
          )}
        </div>
        {!isMobile && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => handleDuplicateDesign(duplicateCount)}
              disabled={!selectedDesignId}
              className={`flex items-center gap-1 px-2 py-1 rounded-md transition-all whitespace-nowrap text-[11px] font-medium shadow-sm min-h-[36px] lg:min-h-0 ${
                selectedDesignId
                  ? 'bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#7C3AED] border border-[#CBD5E1] shadow-none'
                  : 'bg-gray-200 text-gray-500 opacity-30 pointer-events-none'
              }`}
              title={t("editor.duplicate")}
            >
              <Copy className="w-3 h-3" />
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
              className={`flex items-center gap-1 px-2 py-1 rounded-md transition-all whitespace-nowrap ${lang !== 'en' ? 'text-[10px]' : 'text-[11px]'} font-medium shadow-sm min-h-[36px] lg:min-h-0 ${
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
      </div>
      <div className="flex min-w-0 items-center justify-end gap-0.5 flex-wrap">
        <button
          onClick={handleUndo}
          disabled={!canUndo()}
          className="w-8 h-8 lg:w-7 lg:h-7 rounded border border-gray-300 bg-white hover:bg-gray-100 text-gray-600 hover:text-gray-900 transition-colors disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center shadow-sm"
          title={t("editor.undo")}
        >
          <Undo2 className="w-4 h-4" />
        </button>
        <button
          onClick={handleRedo}
          disabled={!canRedo()}
          className="w-8 h-8 lg:w-7 lg:h-7 rounded border border-gray-300 bg-white hover:bg-gray-100 text-gray-600 hover:text-gray-900 transition-colors disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center shadow-sm"
          title={t("editor.redo")}
        >
          <Redo2 className="w-4 h-4" />
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
          className="p-2 lg:p-1.5 rounded-md hover:bg-gray-200/80 text-red-500 hover:text-red-600 transition-colors disabled:opacity-30 disabled:pointer-events-none min-w-[40px] min-h-[40px] lg:min-w-0 lg:min-h-0 flex items-center justify-center"
          title={t("editor.delete")}
        >
          <Trash2 className="w-4 h-4 lg:w-3.5 lg:h-3.5" />
        </button>
        {isLgUp && selectedVariantPrice != null && (
          <>
            <div className="w-px h-4 bg-gray-200 mx-0.5 flex-shrink-0" aria-hidden />
            <span className="shrink-0 whitespace-nowrap rounded-full border border-emerald-600 bg-white px-2 py-0.5 text-[11px] font-bold leading-none text-emerald-600 tabular-nums lg:text-xs">
              {formatVariantPriceForDisplay(selectedVariantPrice)}
            </span>
          </>
        )}
        {isMobile && (
          <button
            onClick={() => handleAutoArrange({ preserveSelection: selectedDesignIds.size >= 2 })}
            disabled={designs.length < 2 && selectedDesignIds.size < 2}
            className={`flex items-center gap-1 px-2 py-1 rounded-md transition-all whitespace-nowrap font-medium shadow-sm min-h-[36px] ${lang !== 'en' ? 'text-[10px]' : 'text-[11px]'} ml-auto ${
              designs.length >= 2 || selectedDesignIds.size >= 2
                ? 'bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#0891B2] border border-[#CBD5E1] shadow-none'
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
    {/* Row 2: Size, DPI, Margin, Rotate, Align — always on its own line */}
    <div className="flex items-center gap-1.5 lg:gap-2 flex-wrap lg:basis-full">
      {activeImageInfo && (
        <>
          <div className="w-px h-5 bg-gray-100 flex-shrink-0 hidden lg:block" />
          <div className="flex items-center gap-1.5 min-w-0 flex-shrink-0">
            <div className="flex items-center gap-0.5 flex-shrink-0 flex-wrap">
              <span className="text-[10px] text-gray-600">W</span>
              <SizeInput
                value={activeResizeSettings.widthInches * activeDesignTransform.s}
                onCommit={(v) => handleEffectiveSizeChange("width", v)}
                title={useMetric(lang) ? t("editor.widthTitleCm") : t("editor.widthTitle")}
                max={artboardWidth}
                lang={lang}
              />
              <span className={`text-gray-600 ${lang === 'en' ? 'text-[10px]' : 'text-[9px]'}`}>{getUnitSuffix(activeResizeSettings.widthInches * activeDesignTransform.s, lang)}</span>
              <button
                onClick={() => setProportionalLock(prev => !prev)}
                className={`p-0.5 rounded transition-colors ${proportionalLock ? 'text-cyan-400 hover:text-cyan-300' : 'text-gray-600 hover:text-gray-700'}`}
                title={proportionalLock ? 'Proportions locked – click to unlock' : 'Proportions unlocked – click to lock'}
              >
                {proportionalLock ? <Link className="w-3 h-3" /> : <Unlink className="w-3 h-3" />}
              </button>
              <span className="text-[10px] text-gray-600">H</span>
              <SizeInput
                value={activeResizeSettings.heightInches * activeDesignTransform.s}
                onCommit={(v) => handleEffectiveSizeChange("height", v)}
                title={useMetric(lang) ? t("editor.heightTitleCm") : t("editor.heightTitle")}
                max={artboardHeight}
                lang={lang}
              />
              <span className={`text-gray-600 ${lang === 'en' ? 'text-[10px]' : 'text-[9px]'}`}>{getUnitSuffix(activeResizeSettings.heightInches * activeDesignTransform.s, lang)}</span>
            </div>
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
  if (!activeImageInfo && !embedFromShopify) {
    return (
      <div
        className="h-full flex items-center justify-center bg-gray-50 relative"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
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
            <div className="grid grid-cols-2 gap-1 rounded-md bg-gray-100 p-1">
              <button
                type="button"
                onClick={() => setMobilePanel("controls")}
                className={`rounded px-2 py-1 text-xs font-medium transition-colors ${mobilePanel === "controls" ? "bg-white text-gray-900 shadow-sm" : "text-gray-600"}`}
              >
                Controls
              </button>
              <button
                type="button"
                onClick={() => setMobilePanel("preview")}
                className={`rounded px-2 py-1 text-xs font-medium transition-colors ${mobilePanel === "preview" ? "bg-white text-gray-900 shadow-sm" : "text-gray-600"}`}
              >
                Preview
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
            quantity={quantity}
            onQuantityChange={setQuantity}
            shopifyVariants={shopifyVariants}
            onAddToCart={handleAddToCart}
            hasVariantId={!!(initialVariantId || shopifyVariants?.length)}
            isAddingToCart={isAddingToCart}
          />

          {/* Fluorescent panel portal target */}
          {profile.enableFluorescent && <div ref={setFluorPanelContainer} />}

          {/* Layers Panel */}
          {designs.length > 0 && (
            <div ref={designInfoRef} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-1.5 min-w-0">
                <button
                  onClick={() => setShowDesignInfo(!showDesignInfo)}
                  className="flex items-center gap-2 flex-1 min-w-0 text-sm text-gray-700 hover:text-gray-900 transition-colors overflow-hidden"
                >
                  <Layers className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />
                  <span className="font-medium text-xs truncate">{t("editor.layers")}</span>
                  <span className="text-[10px] text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded-full flex-shrink-0">{designs.length}</span>
                  {showDesignInfo ? <ChevronUp className="w-3 h-3 text-gray-600 flex-shrink-0" /> : <ChevronDown className="w-3 h-3 text-gray-600 flex-shrink-0" />}
                </button>
                <button
                  onClick={() => sidebarFileRef.current?.click()}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-600 font-medium transition-colors flex-shrink-0 whitespace-nowrap"
                  title={t("editor.addDesignTitle")}
                >
                  <Plus className="w-3 h-3 flex-shrink-0" />
                  <span className={lang !== 'en' ? 'text-[10px]' : 'text-[11px]'}>{t("editor.addDesigns")}</span>
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
                      className={`flex items-center gap-2 px-2.5 py-1.5 cursor-pointer transition-colors ${isSelected ? 'bg-cyan-50 border-l-2 border-cyan-400' : 'hover:bg-gray-100/70 border-l-2 border-transparent'}`}
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
                      <div className="w-7 h-7 rounded bg-gray-100 border border-gray-300 flex-shrink-0 overflow-hidden flex items-center justify-center">
                        <img
                          src={getLayerThumbnail(first)}
                          alt=""
                          className="max-w-full max-h-full object-contain"
                          loading="lazy"
                          style={{ transform: `${first.transform.flipX ? 'scaleX(-1)' : ''} ${first.transform.flipY ? 'scaleY(-1)' : ''}` }}
                        />
                      </div>
                      <div className="min-w-0 flex-1 overflow-hidden">
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
                      <div className="flex items-center gap-0.5 flex-shrink-0">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleRemoveOneCopy(row.baseName, row.sizeKey); }}
                          disabled={count <= 1}
                          className={`w-4 h-4 rounded-full flex items-center justify-center transition-colors ${count > 1 ? 'bg-gray-200 hover:bg-red-100 text-gray-600 hover:text-red-600' : 'bg-gray-100 text-gray-300 cursor-not-allowed'}`}
                          title={t("editor.removeOne")}
                        >
                          <Minus className="w-2.5 h-2.5" strokeWidth={3} />
                        </button>
                        <span className="text-[10px] text-cyan-400 font-semibold min-w-[18px] text-center tabular-nums">x{count}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDuplicateById(first.id); }}
                          className="w-4 h-4 rounded-full bg-gray-200 hover:bg-cyan-100 text-gray-600 hover:text-cyan-600 flex items-center justify-center transition-colors"
                          title={t("editor.addOneMore")}
                        >
                          <Plus className="w-2.5 h-2.5" strokeWidth={3} />
                        </button>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const hasPrint = first.printFileName ?? false;
                          setDesigns(prev => prev.map(d =>
                            row.designs.some(rd => rd.id === d.id) ? { ...d, printFileName: !hasPrint } : d
                          ));
                        }}
                        className={`p-0.5 rounded transition-colors flex-shrink-0 ${first.printFileName ? 'text-cyan-500 hover:text-cyan-600 bg-cyan-50' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-200'}`}
                        title={first.printFileName ? t("editor.printNameOn") : t("editor.printName")}
                      >
                        <Stamp className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteGroup(row.designs.map(d => d.id)); }}
                        className="p-0.5 rounded hover:bg-gray-200 text-red-500 hover:text-red-600 transition-colors flex-shrink-0"
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
        {!isMobile && renderActionToolbar()}

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
                  onExpandArtboard={artboardHeight < MAX_ARTBOARD_HEIGHT ? handleExpandArtboard : undefined}
                  onDesignContextMenu={handleCanvasContextMenu}
                  spotPreviewData={profile.enableFluorescent ? spotPreviewData : undefined}
                  selectionZoomActive={selectionZoomActive}
                  onSelectionZoomChange={setSelectionZoomActive}
                  bottomToolbarContainer={mobileToolbarContainer}
                />
              </div>
            </div>

            <div className="min-h-0 h-full basis-[47%] shrink-0 border-l border-gray-200 bg-gray-100 p-2">
              <div className="flex h-full flex-col gap-2 overflow-y-auto">
                <button onClick={handleThresholdAlpha} disabled={!selectedDesignId && selectedDesignIds.size === 0} className={`flex items-center justify-center gap-1 rounded-md border px-2 py-2 text-[11px] font-medium transition-all ${selectedDesignId || selectedDesignIds.size > 0 ? "border-[#CBD5E1] bg-[#F1F5F9] text-[#2563EB]" : "pointer-events-none bg-gray-200 text-gray-500 opacity-30"}`} title={t("editor.cleanAlphaTitle")}><Droplets className="h-3 w-3" />{t("editor.cleanAlpha")}</button>
                <button onClick={handleThresholdAlphaAll} disabled={designs.length === 0} className={`flex items-center justify-center gap-1 rounded-md border px-2 py-2 text-[11px] font-medium transition-all ${designs.length > 0 ? "border-[#CBD5E1] bg-[#F1F5F9] text-[#2563EB]" : "pointer-events-none bg-gray-200 text-gray-500 opacity-30"}`} title={t("editor.cleanAlphaAllTitle")}><Droplets className="h-3 w-3" />{t("editor.cleanAlphaAll")}</button>
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
                        className="w-full h-full text-center text-[11px] leading-none p-0 pr-3 bg-white outline-none disabled:opacity-30 disabled:pointer-events-none"
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
                      className={`w-full rounded-md px-2 py-2 text-[11px] font-medium transition-all ${selectedDesignId ? "border border-[#CBD5E1] bg-[#F1F5F9] text-[#0891B2]" : "pointer-events-none bg-gray-200 text-gray-500 opacity-30"}`}
                      title={t("editor.duplicateArrange")}
                    >
                      <span className="inline-flex w-full items-center justify-center gap-1 text-center whitespace-normal break-words leading-snug">
                        <Copy className="h-3.5 w-3.5 flex-shrink-0" />
                        <span>{t("editor.duplicateArrange")}</span>
                      </span>
                    </button>
                    {designs.length >= 2 && (
                      <div className="mt-1 flex items-center justify-center gap-1">
                        <span className="text-[10px] text-gray-600">{t("editor.margin")}</span>
                        <select
                          value={designGap === undefined ? "auto" : String(designGap)}
                          onChange={(e) => {
                            const v = e.target.value;
                            const newGap = v === "auto" ? undefined : parseFloat(v);
                            setDesignGap(newGap);
                            setTimeout(() => handleAutoArrangeRef.current({ skipSnapshot: false, preserveSelection: true }), 0);
                          }}
                          className="h-8 px-1.5 bg-gray-100 border border-gray-300 rounded text-[11px] text-gray-700 outline-none cursor-pointer hover:border-gray-400 focus:border-cyan-500 transition-colors"
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
                <span className={`mx-auto inline-flex rounded px-2 py-1 text-[9px] font-semibold ${effectiveDPI < 277 ? "border border-amber-400 bg-amber-100 text-amber-600" : "border border-emerald-700 bg-emerald-100 text-emerald-600"}`} title={t("editor.effectiveRes", { dpi: effectiveDPI })}>{effectiveDPI} DPI</span>
                <div className={`rounded-md border border-gray-200 bg-white p-2 ${isMobile ? "mx-auto w-fit max-w-full" : ""}`}>
                  <div className="mx-auto mb-1 inline-flex items-center justify-center gap-1">
                    <span className="text-[10px] text-gray-600">W</span>
                    <SizeInput value={activeResizeSettings.widthInches * activeDesignTransform.s} onCommit={(v) => handleEffectiveSizeChange("width", v)} title={useMetric(lang) ? t("editor.widthTitleCm") : t("editor.widthTitle")} max={artboardWidth} lang={lang} />
                    <span className="text-[9px] text-gray-600">{getUnitSuffix(activeResizeSettings.widthInches * activeDesignTransform.s, lang)}</span>
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
                    <span className="text-[10px] text-gray-600">H</span>
                    <SizeInput value={activeResizeSettings.heightInches * activeDesignTransform.s} onCommit={(v) => handleEffectiveSizeChange("height", v)} title={useMetric(lang) ? t("editor.heightTitleCm") : t("editor.heightTitle")} max={artboardHeight} lang={lang} />
                    <span className="text-[9px] text-gray-600">{getUnitSuffix(activeResizeSettings.heightInches * activeDesignTransform.s, lang)}</span>
                  </div>
                </div>
                <button onClick={() => handleAutoArrange({ preserveSelection: selectedDesignIds.size >= 2 })} disabled={designs.length < 2 && selectedDesignIds.size < 2} className={`mx-auto rounded-md px-2 py-2 text-[11px] font-medium transition-all ${designs.length >= 2 || selectedDesignIds.size >= 2 ? "border border-[#CBD5E1] bg-[#F1F5F9] text-[#0891B2]" : "pointer-events-none bg-gray-200 text-gray-500 opacity-30"}`} title={selectedDesignIds.size >= 2 ? t("editor.autoArrangeSelected") : t("editor.autoArrangeAll")}><span className="inline-flex items-center justify-center gap-1"><LayoutGrid className="h-3.5 w-3.5" />{t("editor.autoArrange")}</span></button>
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
              onExpandArtboard={artboardHeight < MAX_ARTBOARD_HEIGHT ? handleExpandArtboard : undefined}
              onDesignContextMenu={handleCanvasContextMenu}
              spotPreviewData={profile.enableFluorescent ? spotPreviewData : undefined}
              selectionZoomActive={selectionZoomActive}
              onSelectionZoomChange={setSelectionZoomActive}
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

      {/* Processing Modal (downloads only — add-to-cart uses the bottom button state) */}
      {isProcessing && !isAddingToCart && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-lg p-6 max-w-sm mx-4">
            <div className="flex items-center space-x-3">
              <div className="animate-spin rounded-full h-5 w-5 border-2 border-cyan-500 border-t-transparent"></div>
              <span className="text-white">{t("editor.processing")}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

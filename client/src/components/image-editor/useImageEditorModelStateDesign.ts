import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { flushSync } from "react-dom";
import { useToast } from "@/hooks/use-toast";
import { useHistory, type HistorySnapshot } from "@/hooks/use-history";
import { useIsMobile } from "@/hooks/use-mobile";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useLanguage } from "@/lib/i18n";
import { getSelectedVariantPrice } from "@/lib/variant-price";
import {
  DEFAULT_DESIGN_TRANSFORM,
  EXPORT_DPI,
  LAYER_THUMBNAIL_SIZE,
} from "./constants";
import { clampDesignToArtboard, getRotatedBounds } from "./utils";
import { useAddToCartStall } from "./use-add-to-cart-stall";
import { useRestoreDesignState } from "./use-restore-design-state";
import type { ImageInfo, ResizeSettings, ImageTransform, DesignItem } from "@/lib/types";
import { HOT_PEEL_PROFILE } from "@/lib/profiles";
import type { ImageEditorProps } from "./types";
import type { SpotPreviewData } from "../controls-section";
import {
  buildEditorDraft,
  deleteCurrentEditorDraft,
  getCurrentEditorDraft,
  requestPersistentEditorStorage,
  restoreEditorDraft,
  saveCurrentEditorDraft,
} from "@/lib/editor-draft-storage";

export function useImageEditorModelStateDesign(props: ImageEditorProps) {
  const {
    onDesignUploaded,
    profile = HOT_PEEL_PROFILE,
    initialWidth,
    initialHeight,
    initialGangsheetHeights,
    initialQuantity,
    shopifyVariants,
    variantId: initialVariantId,
    shopDomain,
    embedFromShopify,
    initialDesignState,
    initialDesignId,
    isEditMode = false,
  } = props;

  const { toast } = useToast();
  const { t, lang } = useLanguage();
  const isMobile = useIsMobile();
  const isLgUp = useMediaQuery("(min-width: 1024px)");
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const [resizeSettings, setResizeSettings] = useState<ResizeSettings>({
    widthInches: 5.0,
    heightInches: 3.8,
    maintainAspectRatio: true,
    outputDPI: EXPORT_DPI,
  });
  const [isProcessing, setIsProcessing] = useState(false);
  /** True after Add to Cart until parent finishes upload/redirect (avoid double-submit). */
  const [isAddingToCart, setIsAddingToCart] = useState(false);
  const [isUpdateFlow, setIsUpdateFlow] = useState(false);
  const [addToCartProgressLabel, setAddToCartProgressLabel] = useState<string | undefined>();
  /** Synchronous re-entrancy guard for handleAddToCart; reset wherever isAddingToCart resets. */
  const addToCartInFlightRef = useRef(false);
  const {
    addToCartStallTimeoutRef,
    lastAddToCartPngBytesRef,
    shellUploadUrlRef,
    refreshAddToCartStallTimeout,
  } = useAddToCartStall({
    toast,
    isUpdateFlow,
    setIsAddingToCart,
    setIsProcessing,
    setIsUpdateFlow,
    addToCartInFlightRef,
    setAddToCartProgressLabel,
  });
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [artboardWidth, setArtboardWidth] = useState(initialWidth ?? profile.artboardWidth);
  const [artboardHeight, setArtboardHeight] = useState(initialHeight ?? profile.gangsheetHeights[0] ?? 12);
  const artboardWidthRef = useRef(artboardWidth);
  artboardWidthRef.current = artboardWidth;
  const artboardHeightRef = useRef(artboardHeight);
  artboardHeightRef.current = artboardHeight;
  const availableGangsheetHeights = useMemo(() => {
    if (initialGangsheetHeights && initialGangsheetHeights.length > 0) {
      return initialGangsheetHeights;
    }
    const base = profile.gangsheetHeights;
    if (!initialHeight || base.includes(initialHeight)) return base;
    return [...base, initialHeight].sort((a, b) => a - b);
  }, [profile.gangsheetHeights, initialHeight, initialGangsheetHeights]);
  const contentFillCacheRef = useRef<Map<string, number>>(new Map());
  const handleAutoArrangeRef = useRef<(
    opts?: { skipSnapshot?: boolean; preserveSelection?: boolean; arrangeAll?: boolean }
  ) => void>(() => {});
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
  const [designTransform, setDesignTransform] = useState<ImageTransform>(DEFAULT_DESIGN_TRANSFORM);
  const [designs, setDesigns] = useState<DesignItem[]>([]);
  const [draftRecoveryAvailable, setDraftRecoveryAvailable] = useState(false);
  const [isRecoveringDraft, setIsRecoveringDraft] = useState(false);
  const draftFileKeysRef = useRef<Set<string>>(new Set());
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (designs.length > 0) return;
    if (initialWidth != null && initialWidth > 0) setArtboardWidth(initialWidth);
    if (initialHeight != null && initialHeight > 0) setArtboardHeight(initialHeight);
  }, [initialWidth, initialHeight, designs.length]);
  const [selectedDesignId, setSelectedDesignId] = useState<string | null>(null);
  const [selectedDesignIds, setSelectedDesignIds] = useState<Set<string>>(new Set());
  const lastActiveDesignIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (selectedDesignId !== null) {
      lastActiveDesignIdRef.current = selectedDesignId;
    }
  }, [selectedDesignId]);
  const [mobilePanel, setMobilePanel] = useState<"controls" | "preview">("controls");
  const [showDesignInfo, setShowDesignInfo] = useState(true);
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
  const [wandDeleteModeActive, setWandDeleteModeActive] = useState(false);
  const [wandTolerance, setWandTolerance] = useState(30);
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
  const assetDataUrlCacheRef = useRef<
    Map<string, { sig: string; dataUrl: string; filename?: string; mimeType?: string }>
  >(new Map());
  /** R2 refs captured on admin restore — reuse on update when layer pixels unchanged. */
  const restoredLayerAssetRef = useRef<
    Map<string, { url: string; key?: string; mimeType?: string; fileSig: string }>
  >(new Map());

  useRestoreDesignState({
    initialDesignState,
    restoredLayerAssetRef,
    setIsProcessing,
    setDesigns,
    setSelectedDesignId,
    setImageInfo,
    setDesignTransform,
    setArtboardWidth,
    setArtboardHeight,
    setQuantity,
    setDesignGap,
  });

  useEffect(() => {
    void requestPersistentEditorStorage();
    void getCurrentEditorDraft().then(draft => {
      if (!draft || draft.designs.length === 0) return;
      // A remotely saved design/edit flow is authoritative and should never
      // be replaced by an older browser-local draft.
      if (initialDesignState?.designId || isEditMode) return;
      setDraftRecoveryAvailable(true);
    }).catch(error => {
      console.warn("[editor-draft] availability check failed", error);
    });
  }, [initialDesignState?.designId, isEditMode]);

  const discardEditorDraft = useCallback(async () => {
    try {
      await deleteCurrentEditorDraft();
    } catch (error) {
      console.warn("[editor-draft] discard failed", error);
    } finally {
      draftFileKeysRef.current.clear();
      setDraftRecoveryAvailable(false);
    }
  }, []);

  const recoverEditorDraft = useCallback(async () => {
    if (isRecoveringDraft) return;
    setIsRecoveringDraft(true);
    try {
      const draft = await getCurrentEditorDraft();
      if (!draft) {
        setDraftRecoveryAvailable(false);
        return;
      }
      const restored = await restoreEditorDraft(draft);
      if (restored.designs.length === 0) {
        await discardEditorDraft();
        return;
      }
      setIsProcessing(true);
      setArtboardWidth(restored.artboardWidth);
      setArtboardHeight(restored.artboardHeight);
      setQuantity(restored.quantity);
      setDesignGap(restored.designGap);
      setDesigns(restored.designs);
      setSelectedDesignId(restored.selectedDesignId);
      setSelectedDesignIds(restored.selectedDesignIds);
      const selected = restored.designs.find(design => design.id === restored.selectedDesignId);
      setImageInfo(selected?.imageInfo ?? null);
      setDesignTransform(selected?.transform ?? DEFAULT_DESIGN_TRANSFORM);
      draftFileKeysRef.current = new Set(draft.designs.map(design => design.fileKey));
      setDraftRecoveryAvailable(false);
      setIsProcessing(false);
    } catch (error) {
      console.error("[editor-draft] restore failed", error);
      setIsProcessing(false);
    } finally {
      setIsRecoveringDraft(false);
    }
  }, [
    discardEditorDraft,
    isRecoveringDraft,
    setArtboardHeight,
    setArtboardWidth,
    setDesignGap,
    setQuantity,
  ]);

  // Keep a browser-local recovery point while editing. The first save waits
  // until designs exist, so initial setup and remote restore are not captured
  // as accidental blank drafts.
  useEffect(() => {
    if (draftRecoveryAvailable || isRecoveringDraft || isProcessing || designs.length === 0) return;
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      const { draft, files } = buildEditorDraft(
        profile.id,
        designs,
        artboardWidth,
        artboardHeight,
        quantity,
        designGap ?? 0,
        selectedDesignId,
        selectedDesignIds,
      );
      const newFiles = files.filter(file => !draftFileKeysRef.current.has(file.key));
      void saveCurrentEditorDraft(draft, newFiles)
        .then(() => {
          for (const file of newFiles) draftFileKeysRef.current.add(file.key);
        })
        .catch(error => console.warn("[editor-draft] save failed", error));
    }, 750);
    return () => {
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
    };
  }, [
    artboardHeight,
    artboardWidth,
    designGap,
    designs,
    draftRecoveryAvailable,
    isProcessing,
    isRecoveringDraft,
    profile.id,
    quantity,
    selectedDesignId,
    selectedDesignIds,
  ]);

  useEffect(() => {
    if (!draftRecoveryAvailable || designs.length === 0 || isRecoveringDraft) return;
    // Starting a fresh upload while the recovery banner is visible means the
    // user chose new work. Remove the old draft so it cannot return later.
    void discardEditorDraft();
  }, [discardEditorDraft, draftRecoveryAvailable, designs.length, isRecoveringDraft]);

  useEffect(() => () => {
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
  }, []);

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
       json = JSON.stringify(currentDesigns.map(d => ({
         id: d.id,
         transform: d.transform,
         widthInches: d.widthInches,
         heightInches: d.heightInches,
         name: d.name,
         halftoned: d.halftoned,
         halftoneSettings: d.halftoneSettings,
       })));
      infoMap = new Map(currentDesigns.map(d => [d.id, d.imageInfo]));
      snapshotCacheRef.current = { designs: currentDesigns, json, infoMap };
    }
    return { designsJson: json, selectedDesignId, imageInfoMap: infoMap, artboardWidth: artboardWidthRef.current, artboardHeight: artboardHeightRef.current };
  }, [selectedDesignId]);

  const saveSnapshot = useCallback(() => {
    pushSnapshot(getSnapshot());
  }, [pushSnapshot, getSnapshot]);

  const applySnapshot = useCallback((snap: HistorySnapshot) => {
    let parsed: Array<{
      id: string;
      transform: ImageTransform;
      widthInches: number;
      heightInches: number;
      name: string;
      halftoned?: boolean;
      halftoneSettings?: DesignItem["halftoneSettings"];
    }>;
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
             alphaThresholded: savedInfo ? undefined : existing.alphaThresholded,
             halftoned: p.halftoned,
             halftoneSettings: p.halftoneSettings,
             // The original source image is retained in-memory when possible;
             // restored layers reload their original asset before rebuilding.
             halftoneSourceImage: p.halftoned ? existing.halftoneSourceImage : undefined,
          };
        }
        if (savedInfo) {
           return {
             id: p.id,
             imageInfo: savedInfo,
             transform: p.transform,
             widthInches: p.widthInches,
             heightInches: p.heightInches,
             name: p.name,
             originalDPI: savedInfo.dpi,
             halftoned: p.halftoned,
             halftoneSettings: p.halftoneSettings,
           } as DesignItem;
        }
        return null;
      }).filter(Boolean) as DesignItem[];
      restoredIds = new Set(restored.map(d => d.id));
      return restored;
    });
    const validSelectedId = snap.selectedDesignId != null && restoredIds.has(snap.selectedDesignId) ? snap.selectedDesignId : null;
    setSelectedDesignId(validSelectedId);
    if (validSelectedId) {
      const sel = parsed.find(p => p.id === validSelectedId);
      if (sel) setDesignTransform(sel.transform);
    } else {
      setDesignTransform(DEFAULT_DESIGN_TRANSFORM);
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

  const handleRemoveWhiteBackground = useCallback(async () => {
    const targetIds = selectedDesignIds.size > 0
      ? Array.from(selectedDesignIds)
      : (selectedDesignId ? [selectedDesignId] : []);
    if (targetIds.length === 0) return;
    saveSnapshot();
    const { removeBackgroundFromImage } = await import("@/lib/background-removal");
    const targetDesigns = designsRef.current.filter(d => targetIds.includes(d.id));
    const results = await Promise.all(
      targetDesigns.map(d => removeBackgroundFromImage(d.imageInfo.image, 75).catch(() => null))
    );
    const updates = new Map<string, ImageInfo>();
    targetDesigns.forEach((d, i) => {
      if (results[i]) updates.set(d.id, { ...d.imageInfo, image: results[i]! });
    });
    if (updates.size === 0) {
      toast({ title: "Remove failed", description: "Could not remove white background.", variant: "destructive" });
      return;
    }
    setDesigns(prev => prev.map(d => {
      const next = updates.get(d.id);
      return next ? { ...d, imageInfo: next } : d;
    }));
    if (selectedDesignId && updates.has(selectedDesignId)) {
      setImageInfo(updates.get(selectedDesignId)!);
    }
    setWandDeleteModeActive(false);
    toast({ title: "White background removed", description: `Applied to ${updates.size} design${updates.size !== 1 ? "s" : ""}.` });
  }, [selectedDesignId, selectedDesignIds, saveSnapshot, setDesigns, toast]);

  const handleWandDelete = useCallback((nx: number, ny: number, designId: string) => {
    const design = designsRef.current.find(d => d.id === designId);
    if (!design) return;
    const src = design.imageInfo.image;
    const w = src.naturalWidth || src.width;
    const h = src.naturalHeight || src.height;
    if (!w || !h) return;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(src, 0, 0);
    const px = Math.min(Math.max(0, Math.round(nx * w)), w - 1);
    const py = Math.min(Math.max(0, Math.round(ny * h)), h - 1);
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    const start = (py * w + px) * 4;
    if (data[start + 3] < 10) return;
    const sr = data[start], sg = data[start + 1], sb = data[start + 2];
    const maxDiff = Math.round((wandTolerance / 100) * 255);
    const visited = new Uint8Array(w * h);
    const queue = [py * w + px];
    visited[py * w + px] = 1;
    let qi = 0;
    while (qi < queue.length) {
      const pos = queue[qi++];
      const idx = pos * 4;
      if (data[idx + 3] < 10) continue;
      if (Math.max(Math.abs(data[idx] - sr), Math.abs(data[idx + 1] - sg), Math.abs(data[idx + 2] - sb)) > maxDiff) continue;
      data[idx + 3] = 0;
      const x = pos % w, y = Math.floor(pos / w);
      if (x > 0 && !visited[pos - 1]) { visited[pos - 1] = 1; queue.push(pos - 1); }
      if (x < w - 1 && !visited[pos + 1]) { visited[pos + 1] = 1; queue.push(pos + 1); }
      if (y > 0 && !visited[pos - w]) { visited[pos - w] = 1; queue.push(pos - w); }
      if (y < h - 1 && !visited[pos + w]) { visited[pos + w] = 1; queue.push(pos + w); }
    }
    ctx.putImageData(imageData, 0, 0);
    saveSnapshot();
    canvas.toBlob(blob => {
      if (!blob) return;
      const nextImage = new Image();
      nextImage.onload = () => {
        const nextInfo = { ...design.imageInfo, image: nextImage };
        setDesigns(prev => prev.map(d => d.id === designId ? { ...d, imageInfo: nextInfo } : d));
        if (selectedDesignId === designId) setImageInfo(nextInfo);
      };
      nextImage.src = URL.createObjectURL(blob);
    }, "image/png");
  }, [wandTolerance, saveSnapshot, selectedDesignId]);


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
    if (!activeImageInfo) return EXPORT_DPI;
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
    if (id) lastActiveDesignIdRef.current = id;
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
      const THUMB_SIZE = LAYER_THUMBNAIL_SIZE;
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

      // Derive the largest legal group scale analytically. Every selected
      // design shares the same ratio, so each artboard edge produces a
      // linear upper bound on that ratio.
      let maxScale = Number.POSITIVE_INFINITY;
      for (const d of prev) {
        if (!selectedDesignIds.has(d.id)) continue;
        const start = starts.get(d.id);
        if (!start) continue;
        const rad = (d.transform.rotation * Math.PI) / 180;
        const cos = Math.abs(Math.cos(rad));
        const sin = Math.abs(Math.sin(rad));
        const halfW = (d.widthInches * start.s * cos + d.heightInches * start.s * sin) / 2;
        const halfH = (d.widthInches * start.s * sin + d.heightInches * start.s * cos) / 2;
        const dx = start.nx * artboardWidth - centerX;
        const dy = start.ny * artboardHeight - centerY;
        const cap = (a: number, b: number) => {
          if (b > 0) maxScale = Math.min(maxScale, a / b);
        };
        cap(centerX, halfW - dx);
        cap(artboardWidth - centerX, halfW + dx);
        cap(centerY, halfH - dy);
        cap(artboardHeight - centerY, halfH + dy);
      }
      const appliedRatio = Math.max(0.05, Math.min(scaleRatio, maxScale));

      return prev.map(d => {
        if (!selectedDesignIds.has(d.id)) return d;
        const start = starts.get(d.id);
        if (!start) return d;
        const px = start.nx * artboardWidth - centerX;
        const py = start.ny * artboardHeight - centerY;
        return {
          ...d,
          transform: {
            ...d.transform,
            s: Math.max(0.05, start.s * appliedRatio),
            nx: (centerX + px * appliedRatio) / artboardWidth,
            ny: (centerY + py * appliedRatio) / artboardHeight,
          },
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

      let groupMinX = Infinity;
      let groupMaxX = -Infinity;
      let groupMinY = Infinity;
      let groupMaxY = -Infinity;
      for (const d of prev) {
        if (!selectedDesignIds.has(d.id)) continue;
        const u = unclamped.get(d.id);
        if (!u) continue;
        const bounds = getRotatedBounds({
          ...d,
          transform: {
            ...d.transform,
            nx: u.nx,
            ny: u.ny,
            rotation: u.rotation,
          },
        });
        const centerX = u.nx * artboardWidth;
        const centerY = u.ny * artboardHeight;
        groupMinX = Math.min(groupMinX, centerX + bounds.minX);
        groupMaxX = Math.max(groupMaxX, centerX + bounds.maxX);
        groupMinY = Math.min(groupMinY, centerY + bounds.minY);
        groupMaxY = Math.max(groupMaxY, centerY + bounds.maxY);
      }
      // Rotation is bounded as one group. Do not shift or independently clamp
      // designs at the edge: reject the invalid angle and keep the last valid
      // group position/rotation intact.
      if (
        groupMinX < 0 ||
        groupMaxX > artboardWidth ||
        groupMinY < 0 ||
        groupMaxY > artboardHeight
      ) {
        return prev;
      }

      return prev.map(d => {
        if (!selectedDesignIds.has(d.id)) return d;
        const u = unclamped.get(d.id);
        if (!u) return d;
        return {
          ...d,
          transform: {
            ...d.transform,
            rotation: Math.round(u.rotation),
            nx: u.nx,
            ny: u.ny,
          },
        };
      });
    });
  }, [selectedDesignIds, artboardWidth, artboardHeight]);

  const handleEffectiveSizeChange = useCallback((axis: 'width' | 'height', value: number) => {
    const targetId = selectedDesignId ?? lastActiveDesignIdRef.current;
    if ((!targetId && selectedDesignIds.size === 0) || value <= 0) return;
    const ids = selectedDesignIds.size > 0
      ? selectedDesignIds
      : new Set([targetId!]);
    const targets = designs.filter(d => ids.has(d.id));
    if (targets.length === 0) return;
    saveSnapshot();
    const requested = Math.max(0.01, value);
    const resizedDesigns = designs.map(design => {
      if (!ids.has(design.id)) return design;
      const currentS = design.transform.s;
      const currentW = design.widthInches;
      const currentH = design.heightInches;
      if (currentW <= 0 || currentH <= 0 || currentS <= 0) return design;
      const next = { ...design };
      if (proportionalLock) {
        const newS = axis === 'width' ? requested / currentW : requested / currentH;
        next.transform = { ...design.transform, s: newS };
      } else if (axis === 'width') {
        next.widthInches = Math.min(artboardWidth, requested / currentS);
      } else {
        // Height can exceed the current sheet. The sheet is promoted to the
        // next configured bound below so the requested value is not silently
        // reduced to the current artboard height.
        next.heightInches = requested / currentS;
      }
      return next;
    });

    // Match copy-count expansion: choose the smallest configured gangsheet
    // bound that can contain the resized design(s), then repack the sheet.
    const requiredHeight = resizedDesigns.reduce((maxHeight, design) => {
      const bounds = getRotatedBounds(design);
      return Math.max(maxHeight, bounds.maxY - bounds.minY);
    }, artboardHeight);
    const nextHeight = availableGangsheetHeights.find(h => h >= requiredHeight) ?? artboardHeight;
    const expanded = nextHeight > artboardHeight;

    const positionedDesigns = resizedDesigns.map(design => {
      const absCy = design.transform.ny * artboardHeight;
      const resizedTransform = expanded
        ? { ...design.transform, ny: absCy / nextHeight }
        : design.transform;
      const clamped = clampDesignToArtboard(
        { ...design, transform: resizedTransform },
        artboardWidth,
        nextHeight,
      );
      return {
        ...design,
        transform: { ...resizedTransform, nx: clamped.nx, ny: clamped.ny },
      };
    });

    setDesigns(() => positionedDesigns);
    if (expanded) {
      setArtboardHeight(nextHeight);
      // Give React time to commit the new dimensions before arranging, just
      // like the copy-count flow does when it expands the gangsheet.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          handleAutoArrangeRef.current({
            skipSnapshot: true,
            preserveSelection: true,
            arrangeAll: true,
          });
        });
      });
    }

    const active = targets.find(d => d.id === targetId);
    if (active) {
      if (proportionalLock) {
        setDesignTransform(prev => ({ ...prev, s: axis === 'width' ? value / active.widthInches : value / active.heightInches }));
      } else {
        setResizeSettings(prev => axis === 'width'
          ? { ...prev, widthInches: Math.min(artboardWidth, value / active.transform.s) }
          : { ...prev, heightInches: value / active.transform.s });
      }
    }
  }, [
    selectedDesignId,
    selectedDesignIds,
    designs,
    proportionalLock,
    saveSnapshot,
    artboardWidth,
    artboardHeight,
    availableGangsheetHeights,
  ]);

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

  const handleDuplicateDesign = useCallback((count: number = 1) => {
    if (selectedDesignIds.size > 1) {
      handleDuplicateSelected();
      return;
    }
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
  }, [selectedDesignId, designs, saveSnapshot, artboardWidth, artboardHeight, selectedDesignIds, handleDuplicateSelected]);

  const handleDuplicateAndArrange = useCallback((count: number) => {
    if (selectedDesignIds.size > 1) {
      const newIds = handleDuplicateSelected();
      if (newIds.length > 0) {
        setTimeout(() => handleAutoArrangeRef.current({ skipSnapshot: true, preserveSelection: true }), 0);
      }
      return;
    }
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
  }, [selectedDesignId, designs, saveSnapshot, artboardWidth, artboardHeight, selectedDesignIds, handleDuplicateSelected]);

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


  // Base editor state; arrange/upload/export/cart hooks extend this bag in image-editor-provider.
  return { onDesignUploaded, profile, initialWidth, initialHeight, initialGangsheetHeights, initialQuantity, shopifyVariants, initialVariantId, shopDomain, embedFromShopify, initialDesignState, initialDesignId, isEditMode, toast, t, lang, isMobile, isLgUp, imageInfo, setImageInfo, resizeSettings, setResizeSettings, isProcessing, setIsProcessing, isAddingToCart, setIsAddingToCart, isUpdateFlow, setIsUpdateFlow, addToCartProgressLabel, setAddToCartProgressLabel, addToCartInFlightRef, addToCartStallTimeoutRef, lastAddToCartPngBytesRef, shellUploadUrlRef, refreshAddToCartStallTimeout, isUploading, setIsUploading, uploadProgress, setUploadProgress, artboardWidth, setArtboardWidth, artboardHeight, setArtboardHeight, artboardWidthRef, artboardHeightRef, contentFillCacheRef, handleAutoArrangeRef, quantity, setQuantity, designGap, setDesignGap, duplicateCount, setDuplicateCount, clampDuplicateCount, parseDuplicateCount, handleDuplicateCountKeyDown, designTransform, setDesignTransform, designs, setDesigns, selectedDesignId, setSelectedDesignId, selectedDesignIds, setSelectedDesignIds, mobilePanel, setMobilePanel, showDesignInfo, setShowDesignInfo, selectionZoomActive, setSelectionZoomActive, editingLayerName, setEditingLayerName, editingNameValue, setEditingNameValue, clipboardRef, proportionalLock, setProportionalLock, designInfoRef, sidebarFileRef, headerUploadInputRef, canvasRef, downloadContainer, setDownloadContainer, spotPreviewData, setSpotPreviewData, fluorPanelContainer, setFluorPanelContainer, mobileToolbarContainer, setMobileToolbarContainer, copySpotSelectionsRef, contextMenu, setContextMenu, cropModalDesignId, setCropModalDesignId, pushSnapshot, undo, redo, clearIsUndoRedo, canUndo, canRedo, mountedRef, designsRef, nudgeSnapshotSavedRef, nudgeTimeoutRef, thumbnailCacheRef, assetDataUrlCacheRef, restoredLayerAssetRef, multiDragAccumRef, multiResizeStartRef, multiRotateStartRef, snapshotCacheRef, getSnapshot, saveSnapshot, applySnapshot, handleUndo, handleRedo, handleInteractionEnd, handleRemoveWhiteBackground, handleWandDelete, wandDeleteModeActive, setWandDeleteModeActive, wandTolerance, setWandTolerance, selectedDesign, activeImageInfo, activeDesignTransform, activeWidthInches, activeHeightInches, activeResizeSettings, selectedVariantPrice, effectiveDPI, layerRows, draftRecoveryAvailable, isRecoveringDraft, recoverEditorDraft, discardEditorDraft, handleSelectDesign, handleMultiSelect, getLayerThumbnail, handleDesignTransformChange, handleMultiDragDelta, handleMultiResizeDelta, handleMultiRotateDelta, handleEffectiveSizeChange, isArtboardFull, handleDuplicateDesign, handleDuplicateAndArrange, handleDuplicateSelected, handleDuplicateById, handleRemoveOneCopy, handleCopySelected, handlePaste, handleDeleteGroup, handleDeleteDesign, handleDeleteMulti, handleRotate90, handleFlipX, handleFlipY, handleCanvasContextMenu };
}

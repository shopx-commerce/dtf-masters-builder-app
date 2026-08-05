import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { useToast } from "@/hooks/use-toast";
import {
  useSelectedDesignId,
  useSelectedDesignIds,
  useSelectionActions,
} from "@/state/selection-store";
import {
  useDesignTransform,
  useTransformActions,
} from "@/state/transform-store";
import { getToolSnapshot } from "@/state/tool-store";
import { useUiActions } from "@/state/ui-store";
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
import {
  clampDesignToArtboard,
  getDesignSelectionUnits,
  rotateDesignSelection,
  getRotatedBounds,
} from "./utils";
import { useAddToCartStall } from "./use-add-to-cart-stall";
import { useRestoreDesignState } from "./use-restore-design-state";
import type { ImageInfo, ResizeSettings, ImageTransform, DesignItem } from "@/lib/types";
import { HOT_PEEL_PROFILE } from "@/lib/profiles";
import type { ImageEditorProps } from "./types";
import {
  buildEditorDraft,
  computeDraftSignature,
  deleteCurrentEditorDraft,
  getCurrentEditorDraft,
  isRecoverableImageInfo,
  rehydrateDesignImageFromDraft,
  requestPersistentEditorStorage,
  restoreEditorDraft,
  saveCurrentEditorDraft,
} from "@/lib/editor-draft-storage";
import ThumbnailWorker from "@/lib/thumbnail-worker?worker";
import {
  getThumbnailCacheEntry,
  revokeThumbnailCacheEntry,
  setThumbnailCacheEntry,
} from "@/lib/thumbnail-cache";

const THUMBNAIL_PLACEHOLDER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'%3E%3Crect width='48' height='48' fill='%23f3f4f6'/%3E%3C/svg%3E";

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
  const [exportProgressLabel, setExportProgressLabel] = useState<string | undefined>();
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
  // Transform state lives in the Zustand transform store — see
  // `state/transform-store.ts` for the rationale. Consumers that only
  // need one transform field (rotation, flipX, etc.) can subscribe with
  // `useActiveTransformField(field)` and skip re-renders on unrelated
  // model changes.
  const designTransform = useDesignTransform();
  const { setDesignTransform, setActive: setActiveTransformInStore } =
    useTransformActions();
  const [designs, setDesigns] = useState<DesignItem[]>([]);
  const [draftRecoveryAvailable, setDraftRecoveryAvailable] = useState(false);
  const [isRecoveringDraft, setIsRecoveringDraft] = useState(false);
  const draftFileKeysRef = useRef<Set<string>>(new Set());
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Signature of the last state we serialized to IndexedDB. React re-renders
  // often produce new Array/Set references without any observable field
  // changing (e.g. selection toggles, thumbnail-version bumps). If the
  // signature matches the previous save we skip the debounced write entirely.
  const lastDraftSignatureRef = useRef<string | null>(null);
  const draftSaveIdleHandleRef = useRef<number | null>(null);
  // Snapshot of every input `computeDraftSignature` / `buildEditorDraft`
  // need, refreshed on every render. Held in a ref so the imperative
  // `flushDraftSaveNow` (bound to `visibilitychange`/`pagehide`/unmount)
  // can read the latest values *without* depending on them in its
  // `useEffect` deps — otherwise the listener would be re-bound on every
  // state change, which is both wasteful and racy during unload.
  //
  // We only include values that participate in the draft; UI-only state
  // (context menu, mobile panel, etc.) is intentionally omitted.
  const latestDraftInputsRef = useRef<{
    profileId: string;
    designs: DesignItem[];
    artboardWidth: number;
    artboardHeight: number;
    quantity: number;
    designGap: number;
    selectedDesignId: string | null;
    selectedDesignIds: Set<string>;
    /**
     * `true` while we should refuse to save — recovery banner is showing,
     * a recovery restore is in progress, or a heavy processing job (e.g.
     * add-to-cart) is running. The same gate as the debounced effect.
     */
    saveGated: boolean;
  } | null>(null);
  const rehydrationAttemptedRef = useRef<Set<string>>(new Set());
  const rehydrationInFlightRef = useRef<Map<string, Promise<ImageInfo | null>>>(new Map());
  useEffect(() => {
    if (designs.length > 0) return;
    if (initialWidth != null && initialWidth > 0) setArtboardWidth(initialWidth);
    if (initialHeight != null && initialHeight > 0) setArtboardHeight(initialHeight);
  }, [initialWidth, initialHeight, designs.length]);
  // Selection state lives in the Zustand store (`state/selection-store.ts`)
  // so leaf components (layer rows, per-design badges, etc.) can subscribe
  // with granular selectors and skip re-renders on unrelated model
  // changes. These local hooks give the rest of this hook the same
  // read/write ergonomics as the previous `useState` pair.
  const selectedDesignId = useSelectedDesignId();
  const selectedDesignIds = useSelectedDesignIds();
  const {
    setSelectedDesignId,
    setSelectedDesignIds,
    selectOne: selectOneInStore,
    selectMany: selectManyInStore,
  } = useSelectionActions();
  const lastActiveDesignIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (selectedDesignId !== null) {
      lastActiveDesignIdRef.current = selectedDesignId;
    }
  }, [selectedDesignId]);
  // UI-mode state (contextMenu, mobilePanel, showDesignInfo,
  // selectionZoomActive, wandDeleteModeActive, spotPreviewData,
  // activeSpotChannel, panModeActive, cropModalDesignId) lives in the
  // Zustand `ui-store` — see `state/ui-store.ts`. Removing it from the
  // model means toggling any of it does *not* re-run the model hook or
  // invalidate the `useCallback` identities of its handlers, so
  // preview-section / cart-flow / etc. keep their memoization across
  // right-clicks, mode flips, fluorescent channel hovers, etc.
  const uiActions = useUiActions();
  const clipboardRef = useRef<DesignItem[]>([]);
  const [proportionalLock, setProportionalLock] = useState(true);
  const designInfoRef = useRef<HTMLDivElement>(null);
  const sidebarFileRef = useRef<HTMLInputElement>(null);
  const headerUploadInputRef = useRef<HTMLInputElement>(null);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [downloadContainer, setDownloadContainer] = useState<HTMLDivElement | null>(null);
  // `wandTolerance` lives in the Zustand `tool-store` — see
  // `state/tool-store.ts`. It's a 60Hz slider drag that used to
  // regenerate the whole context bag on every tick; the store hooks
  // isolate the slider re-renders and the wand-delete callback reads the
  // current value imperatively so its identity stays stable.
  const [fluorPanelContainer, setFluorPanelContainer] = useState<HTMLDivElement | null>(null);
  const [mobileToolbarContainer, setMobileToolbarContainer] = useState<HTMLDivElement | null>(null);
  const copySpotSelectionsRef = useRef<((fromId: string, toIds: string[]) => void) | null>(null);

  // Undo/Redo history
  const { pushSnapshot, undo, redo, clearIsUndoRedo, canUndo, canRedo } = useHistory();
  const mountedRef = useRef(true);
  useEffect(() => { return () => { mountedRef.current = false; }; }, []);
  const designsRef = useRef(designs);
  designsRef.current = designs;
  const nudgeSnapshotSavedRef = useRef(false);
  const nudgeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thumbnailCacheRef = useRef<Map<string, string>>(new Map());
  const thumbnailWorkerRef = useRef<Worker | null>(null);
  const thumbnailWorkerRequestIdRef = useRef(0);
  const thumbnailPendingRef = useRef<Map<number, { key: string }>>(new Map());
  const thumbnailPendingKeysRef = useRef<Set<string>>(new Set());
  const thumbnailWorkerFailedRef = useRef(false);
  const [, setThumbnailVersion] = useState(0);
  const assetDataUrlCacheRef = useRef<
    Map<string, { sig: string; dataUrl: string; filename?: string; mimeType?: string }>
  >(new Map());
  /** R2 refs captured on admin restore — reuse on update when layer pixels unchanged. */
  const restoredLayerAssetRef = useRef<
    Map<string, { url: string; key?: string; mimeType?: string; fileSig: string; needsUpload?: boolean }>
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

  const rehydrateDesignImage = useCallback((designId: string): Promise<ImageInfo | null> => {
    const inFlight = rehydrationInFlightRef.current.get(designId);
    if (inFlight) return inFlight;
    const request = rehydrateDesignImageFromDraft(designId).finally(() => {
      rehydrationInFlightRef.current.delete(designId);
    });
    rehydrationInFlightRef.current.set(designId, request);
    return request;
  }, []);

  const getRehydrationAttemptKey = useCallback((design: DesignItem): string => {
    const file = design.imageInfo?.file;
    return [
      design.id,
      file?.name ?? "",
      file?.size ?? 0,
      file?.lastModified ?? 0,
    ].join(":");
  }, []);

  useEffect(() => {
    if (isProcessing || isUploading || designs.length === 0) return;

    for (const design of designs) {
      if (isRecoverableImageInfo(design.imageInfo)) continue;
      const attemptKey = getRehydrationAttemptKey(design);
      if (rehydrationAttemptedRef.current.has(attemptKey)) continue;
      rehydrationAttemptedRef.current.add(attemptKey);

      void rehydrateDesignImage(design.id).then(rehydratedImageInfo => {
        if (!rehydratedImageInfo) {
          console.warn("[editor-draft] could not rehydrate design image", design.id);
          return;
        }
        setDesigns(currentDesigns => currentDesigns.map(current =>
          current.id === design.id
            ? { ...current, imageInfo: rehydratedImageInfo }
            : current,
        ));
        if (selectedDesignId === design.id) setImageInfo(rehydratedImageInfo);
      }).catch(error => {
        console.warn("[editor-draft] image rehydration failed", error);
      });
    }
  }, [
    designs,
    isProcessing,
    isUploading,
    getRehydrationAttemptKey,
    rehydrateDesignImage,
    selectedDesignId,
    setImageInfo,
    setDesigns,
  ]);

  const ensureDesignImagesAvailable = useCallback(async (
    sourceDesigns: DesignItem[] = designsRef.current,
    forceRepairIds?: Set<string>,
  ): Promise<DesignItem[]> => {
    const replacements = new Map<string, ImageInfo>();
    await Promise.all(sourceDesigns.map(async design => {
      const forceRepair = forceRepairIds?.has(design.id) ?? false;
      if (!forceRepair && isRecoverableImageInfo(design.imageInfo)) return;
      const attemptKey = getRehydrationAttemptKey(design);
      if (rehydrationAttemptedRef.current.has(attemptKey)) {
        const inFlight = rehydrationInFlightRef.current.get(design.id);
        if (inFlight) {
          const rehydrated = await inFlight;
          if (rehydrated) replacements.set(design.id, rehydrated);
        }
        return;
      }
      rehydrationAttemptedRef.current.add(attemptKey);
      const rehydrated = await rehydrateDesignImage(design.id);
      if (rehydrated) replacements.set(design.id, rehydrated);
    }));
    if (replacements.size === 0) return sourceDesigns;

    const nextDesigns = sourceDesigns.map(design => {
      const imageInfo = replacements.get(design.id);
      if (imageInfo) {
        revokeThumbnailCacheEntry(thumbnailCacheRef.current, design.imageInfo.image.src);
        contentFillCacheRef.current.delete(design.imageInfo.image.src);
        assetDataUrlCacheRef.current.delete(design.id);
        restoredLayerAssetRef.current.delete(design.id);
      }
      return imageInfo ? { ...design, imageInfo } : design;
    });
    designsRef.current = nextDesigns;
    setDesigns(currentDesigns => currentDesigns.map(design => {
      const imageInfo = replacements.get(design.id);
      return imageInfo ? { ...design, imageInfo } : design;
    }));
    nextDesigns.forEach(design => {
      if (design.id === selectedDesignId && replacements.has(design.id)) {
        setImageInfo(design.imageInfo);
      }
    });
    return nextDesigns;
  }, [getRehydrationAttemptKey, rehydrateDesignImage, selectedDesignId, setImageInfo, setDesigns]);

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
      lastDraftSignatureRef.current = null;
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
      // Force the next save-effect to write, since the debounced-save signature
      // check would otherwise compare against a stale value from a prior draft.
      lastDraftSignatureRef.current = null;
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

  // Refresh the imperative save-inputs snapshot every render. Cheap: one
  // object allocation with 8 primitive/reference fields. `flushDraftSaveNow`
  // reads from this ref during page-hide / unmount, so we don't need to
  // add those state values as `useEffect` deps for the listener effect
  // (that would rebind the listener on every keystroke and produce a
  // race where the listener detaches mid-hide).
  latestDraftInputsRef.current = {
    profileId: profile.id,
    designs,
    artboardWidth,
    artboardHeight,
    quantity,
    designGap: designGap ?? 0,
    selectedDesignId,
    selectedDesignIds,
    saveGated:
      draftRecoveryAvailable ||
      isRecoveringDraft ||
      isProcessing ||
      designs.length === 0,
  };

  // Extracted synchronous save so both the debounced idle callback *and*
  // the unload-flush code path share exactly one code path. Reading from
  // the ref (rather than closing over reactive state) means the function
  // identity can be stable — see `flushDraftSaveNow` below.
  //
  // The IndexedDB transaction is started synchronously here even though
  // the promise is not awaited: by web spec, transactions opened before
  // `visibilitychange:hidden` / `pagehide` / `unload` are guaranteed to
  // commit before the browser terminates the page. That is the only
  // reason this approach is safe during tab close.
  const performDraftSave = useCallback((reason: string) => {
    const inputs = latestDraftInputsRef.current;
    if (!inputs) return;
    if (inputs.saveGated) return;
    const signature = computeDraftSignature(
      inputs.profileId,
      inputs.designs,
      inputs.artboardWidth,
      inputs.artboardHeight,
      inputs.quantity,
      inputs.designGap,
      inputs.selectedDesignId,
      inputs.selectedDesignIds,
    );
    if (signature === lastDraftSignatureRef.current) return;
    const { draft, files } = buildEditorDraft(
      inputs.profileId,
      inputs.designs,
      inputs.artboardWidth,
      inputs.artboardHeight,
      inputs.quantity,
      inputs.designGap,
      inputs.selectedDesignId,
      inputs.selectedDesignIds,
    );
    const newFiles = files.filter(
      (file) => !draftFileKeysRef.current.has(file.key),
    );
    lastDraftSignatureRef.current = signature;
    void saveCurrentEditorDraft(draft, newFiles)
      .then(() => {
        for (const file of newFiles) draftFileKeysRef.current.add(file.key);
      })
      .catch((error) => {
        lastDraftSignatureRef.current = null;
        console.warn(`[editor-draft] save failed (${reason})`, error);
      });
  }, []);

  // Imperative flush entrypoint. Callable from any code path that needs
  // to guarantee the latest draft is persisted *before* the current
  // execution completes: page-hide, pagehide, beforeunload, unmount,
  // client-side navigation.
  //
  // Cancels any scheduled debounce/idle callback first so we don't race
  // with them (they would otherwise fire against a possibly-stale
  // signature and log a spurious "save failed" warning if the tab tore
  // down between our synchronous save and their scheduled run).
  const flushDraftSaveNow = useCallback((reason: string) => {
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }
    const idleHandle = draftSaveIdleHandleRef.current;
    if (idleHandle != null) {
      const w = window as Window & {
        cancelIdleCallback?: (handle: number) => void;
      };
      if (typeof w.cancelIdleCallback === "function") {
        w.cancelIdleCallback(idleHandle);
      } else {
        w.clearTimeout(idleHandle);
      }
      draftSaveIdleHandleRef.current = null;
    }
    performDraftSave(reason);
  }, [performDraftSave]);

  // Bind the browser lifecycle listeners *once*. Empty deps + ref-based
  // reads inside the handler are what keep this attach/detach out of
  // the hot path — nothing rebinds while the user is editing.
  //
  // Coverage matrix:
  //   `visibilitychange:hidden` — tab switch, backgrounding on desktop &
  //     mobile, and often fires before actual close. Broad coverage on
  //     Chrome/Edge/Firefox.
  //   `pagehide` — the *only* reliable "about to unload" signal on
  //     iOS Safari. Also fires on bfcache entry.
  //   `beforeunload` — third safety net for desktop browsers. We don't
  //     `preventDefault` (that would show an unwanted confirmation
  //     prompt); we only use it as another chance to flush.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        flushDraftSaveNow("visibilitychange");
      }
    };
    const onPageHide = () => flushDraftSaveNow("pagehide");
    const onBeforeUnload = () => flushDraftSaveNow("beforeunload");

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("beforeunload", onBeforeUnload);
    }
    return () => {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("beforeunload", onBeforeUnload);
      }
    };
  }, [flushDraftSaveNow]);

  // Keep a browser-local recovery point while editing. The first save waits
  // until designs exist, so initial setup and remote restore are not captured
  // as accidental blank drafts.
  //
  // Two-stage coalescing:
  //   1. 750 ms debounce collapses bursts of state updates (typing, dragging,
  //      selection toggles) into a single scheduled write.
  //   2. `computeDraftSignature` compares the debounced state against the
  //      last write and short-circuits when they match — React re-renders
  //      often produce a new `designs` Array reference without any field
  //      actually differing.
  //   3. `requestIdleCallback` (when available) waits for a quiet main-thread
  //      slot before serializing and hitting IndexedDB, so a save never
  //      contends with an active user interaction. `setTimeout(0)` fallback
  //      preserves behavior on Safari.
  useEffect(() => {
    if (draftRecoveryAvailable || isRecoveringDraft || isProcessing || designs.length === 0) return;

    const signature = computeDraftSignature(
      profile.id,
      designs,
      artboardWidth,
      artboardHeight,
      quantity,
      designGap ?? 0,
      selectedDesignId,
      selectedDesignIds,
    );
    if (signature === lastDraftSignatureRef.current) return;

    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      const idleCb = typeof window !== "undefined" && "requestIdleCallback" in window
        ? window.requestIdleCallback.bind(window)
        : (fn: () => void) => window.setTimeout(fn, 0);
      const cancelIdleCb = typeof window !== "undefined" && "cancelIdleCallback" in window
        ? window.cancelIdleCallback.bind(window)
        : (id: number) => window.clearTimeout(id);
      if (draftSaveIdleHandleRef.current != null) cancelIdleCb(draftSaveIdleHandleRef.current);
      draftSaveIdleHandleRef.current = idleCb(() => {
        draftSaveIdleHandleRef.current = null;
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
        // Optimistically mark the signature as saved. If the write fails we
        // reset it so the next state change retries; if it succeeds we keep
        // the file-key set aligned with what actually landed on disk.
        lastDraftSignatureRef.current = signature;
        void saveCurrentEditorDraft(draft, newFiles)
          .then(() => {
            for (const file of newFiles) draftFileKeysRef.current.add(file.key);
          })
          .catch(error => {
            lastDraftSignatureRef.current = null;
            console.warn("[editor-draft] save failed", error);
          });
      }) as number;
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

  // Unmount cleanup — covers client-side navigation (Wouter link click),
  // route swap, or React re-parenting. The visibilitychange/pagehide
  // listeners already handle actual browser-level tab close/refresh;
  // this catches the case where the editor unmounts while the page
  // itself stays alive. `flushDraftSaveNow` cancels the pending
  // debounce/idle callbacks internally, then does the synchronous save.
  useEffect(() => () => {
    flushDraftSaveNow("unmount");
  }, [flushDraftSaveNow]);

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
    uiActions.setWandDeleteModeActive(false);
    toast({ title: "White background removed", description: `Applied to ${updates.size} design${updates.size !== 1 ? "s" : ""}.` });
  }, [selectedDesignId, selectedDesignIds, saveSnapshot, setDesigns, toast, uiActions]);

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
    // Read the slider value at click time so the callback identity
    // doesn't depend on `wandTolerance` — the slider can drag freely
    // without invalidating this `useCallback` or its downstream memos.
    const { wandTolerance } = getToolSnapshot();
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
      const url = URL.createObjectURL(blob);
      // Blob URL leaks accumulate quickly with repeated wand-fill actions —
      // each leak also pins the decoded pixel copy, which on mobile Safari
      // pushes the tab over its memory ceiling. Revoke on load or error.
      nextImage.onload = () => {
        URL.revokeObjectURL(url);
        const nextInfo = { ...design.imageInfo, image: nextImage };
        setDesigns(prev => prev.map(d => d.id === designId ? { ...d, imageInfo: nextInfo } : d));
        if (selectedDesignId === designId) setImageInfo(nextInfo);
      };
      nextImage.onerror = () => { URL.revokeObjectURL(url); };
      nextImage.src = url;
    }, "image/png");
  }, [saveSnapshot, selectedDesignId]);


  const selectedDesign = useMemo(() => designs.find(d => d.id === selectedDesignId) || null, [designs, selectedDesignId]);
  const activeImageInfo = useMemo(() => selectedDesign?.imageInfo ?? imageInfo, [selectedDesign, imageInfo]);
  const activeDesignTransform = useMemo(() => selectedDesign?.transform ?? designTransform, [selectedDesign, designTransform]);

  // Mirror the derived active transform into the Zustand transform store
  // so leaf consumers (rotation badge, flip buttons, DPI readout, size
  // input) can subscribe via `useActiveTransformField(field)` and re-render
  // only when *their* field changes — rather than on every editor bag
  // regeneration.
  //
  // `setActive` short-circuits on identical references, so this effect is
  // essentially free when nothing changed: the useMemo above returns the
  // same object identity between renders, so `setActive` bails.
  useEffect(() => {
    setActiveTransformInStore(
      selectedDesignId != null ? activeDesignTransform : null,
    );
  }, [activeDesignTransform, selectedDesignId, setActiveTransformInStore]);
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

  // Selection updates are atomic in the store — a single `set(...)` writes
  // both fields, so downstream effects observing `(selectedDesignId,
  // selectedDesignIds)` never see a torn pair. This replaces the previous
  // `flushSync` wrapper that was necessary with React state to force both
  // `useState` setters to commit in the same microtask.
  // Selection now auto-expands to include every member of a design's
  // group (see `DesignItem.groupId`). This mirrors PowerPoint / Figma /
  // Illustrator behaviour where grouped items feel like a single object:
  // clicking any member selects the whole group; multi-drag then moves
  // them all in lockstep via the existing multi-drag path.
  //
  // Both entry points (`handleSelectDesign` — single click, and
  // `handleMultiSelect` — shift-click / marquee) share the expansion
  // helper. `designsRef` is read imperatively so the expansion is always
  // against the freshest design list without adding a render-time
  // dependency to the callback.
  const expandSelectionToGroups = useCallback((ids: readonly string[]): string[] => {
    if (ids.length === 0) return [];
    const src = designsRef.current;
    if (src.length === 0) return [...ids];
    const idToGroup = new Map<string, string | undefined>();
    const groupToMembers = new Map<string, string[]>();
    for (const d of src) {
      idToGroup.set(d.id, d.groupId);
      if (d.groupId) {
        const arr = groupToMembers.get(d.groupId);
        if (arr) arr.push(d.id);
        else groupToMembers.set(d.groupId, [d.id]);
      }
    }
    const expanded = new Set<string>();
    for (const id of ids) {
      const gid = idToGroup.get(id);
      if (gid) {
        const members = groupToMembers.get(gid);
        if (members) for (const m of members) expanded.add(m);
      } else {
        expanded.add(id);
      }
    }
    return Array.from(expanded);
  }, []);

  const handleSelectDesign = useCallback(
    (id: string | null) => {
      if (!id) {
        selectOneInStore(null);
        return;
      }
      lastActiveDesignIdRef.current = id;
      const expanded = expandSelectionToGroups([id]);
      if (expanded.length <= 1) {
        selectOneInStore(id);
      } else {
        // Preserve the clicked design as the "active" one so keyboard nudge
        // / transform-badge readouts still make sense; the store's
        // `selectMany` uses the last id as the primary — we reorder so
        // the clicked one lands there.
        const reordered = expanded.filter(x => x !== id).concat(id);
        selectManyInStore(reordered);
      }
    },
    [selectOneInStore, selectManyInStore, expandSelectionToGroups],
  );

  const handleMultiSelect = useCallback(
    (ids: string[]) => {
      selectManyInStore(expandSelectionToGroups(ids));
    },
    [selectManyInStore, expandSelectionToGroups],
  );

  // Group / Ungroup — data-only operations. Neither changes any
  // transform, size, or visibility, so undo/redo, draft persistence, and
  // export pipelines all "just work" via the existing snapshot machinery.
  //
  // `handleGroupSelected` requires 2+ selected designs. It mints a fresh
  // UUID and stamps it into every selected design's `groupId`. If some
  // (but not all) of the selected designs are already in a *different*
  // group, they are moved into this new group — matching how PowerPoint /
  // Illustrator handle re-grouping.
  const handleGroupSelected = useCallback(() => {
    const idsToGroup = selectedDesignIds.size > 1
      ? selectedDesignIds
      : (selectedDesignId && selectedDesignIds.size === 1
          ? selectedDesignIds
          : null);
    if (!idsToGroup || idsToGroup.size < 2) return;
    saveSnapshot();
    const newGroupId = crypto.randomUUID();
    setDesigns(prev => prev.map(d =>
      idsToGroup.has(d.id) ? { ...d, groupId: newGroupId } : d,
    ));
  }, [selectedDesignId, selectedDesignIds, saveSnapshot]);

  // `handleUngroupSelected` clears `groupId` on every selected design.
  // If the selection includes members from multiple groups, all of them
  // are ungrouped in the same operation (a single snapshot). That matches
  // user expectation when they've deliberately reached into several
  // groups to break them apart at once.
  const handleUngroupSelected = useCallback(() => {
    const anyGrouped = designsRef.current.some(d =>
      selectedDesignIds.has(d.id) && d.groupId,
    );
    if (!anyGrouped) return;
    saveSnapshot();
    setDesigns(prev => prev.map(d => {
      if (!selectedDesignIds.has(d.id) || !d.groupId) return d;
      const { groupId: _drop, ...rest } = d;
      return rest;
    }));
  }, [selectedDesignIds, saveSnapshot]);

  // Cheap "is any grouped design selected" flag for the context-menu
  // enable state. Kept as a regular value so React re-renders it when
  // `designs` / `selectedDesignIds` change — the context menu opens
  // rarely and this doesn't sit on a hot path.
  const selectedHasGroup = designs.some(d =>
    selectedDesignIds.has(d.id) && d.groupId,
  );

  const getLayerThumbnail = useCallback((design: DesignItem): string => {
    const cache = thumbnailCacheRef.current;
    const key = design.imageInfo?.image?.src ?? design.id;
    const cached = getThumbnailCacheEntry(cache, key);
    if (cached !== undefined) return cached;

    const img = design.imageInfo.image;
    if (!img || !img.width || !img.height) return "";
    const aspect = img.width / img.height;
    const tw = Math.max(1, aspect >= 1 ? LAYER_THUMBNAIL_SIZE : Math.round(LAYER_THUMBNAIL_SIZE * aspect));
    const th = Math.max(1, aspect >= 1 ? Math.round(LAYER_THUMBNAIL_SIZE / aspect) : LAYER_THUMBNAIL_SIZE);

    const getWorker = (): Worker | null => {
      if (thumbnailWorkerRef.current) return thumbnailWorkerRef.current;
      try {
        const worker = new ThumbnailWorker();
        worker.onmessage = (event: MessageEvent<{ type: string; requestId: number; blob?: Blob }>) => {
          const request = thumbnailPendingRef.current.get(event.data.requestId);
          if (!request) return;
          thumbnailPendingRef.current.delete(event.data.requestId);
          thumbnailPendingKeysRef.current.delete(request.key);
          if (event.data.type !== "result" || !event.data.blob) {
            thumbnailWorkerFailedRef.current = true;
            setThumbnailVersion(version => version + 1);
            return;
          }
          // `setThumbnailCacheEntry` revokes the prior blob URL for `request.key`
          // internally, so the manual revoke that used to precede this call is
          // no longer needed. It also enforces the LRU bound.
          setThumbnailCacheEntry(cache, request.key, URL.createObjectURL(event.data.blob));
          setThumbnailVersion(version => version + 1);
        };
        worker.onerror = () => {
          thumbnailWorkerFailedRef.current = true;
          thumbnailWorkerRef.current?.terminate();
          thumbnailWorkerRef.current = null;
          thumbnailPendingRef.current.clear();
          thumbnailPendingKeysRef.current.clear();
          setThumbnailVersion(version => version + 1);
        };
        thumbnailWorkerRef.current = worker;
        return worker;
      } catch {
        return null;
      }
    };

    const worker = !thumbnailWorkerFailedRef.current &&
      typeof createImageBitmap === "function" && typeof OffscreenCanvas !== "undefined"
      ? getWorker()
      : null;
    if (worker) {
      if (!thumbnailPendingKeysRef.current.has(key)) {
        thumbnailPendingKeysRef.current.add(key);
        const requestId = ++thumbnailWorkerRequestIdRef.current;
        thumbnailPendingRef.current.set(requestId, { key });
        void createImageBitmap(img).then(bitmap => {
          if (!thumbnailPendingRef.current.has(requestId)) {
            bitmap.close();
            return;
          }
          worker.postMessage({ type: "thumbnail", requestId, bitmap, width: tw, height: th }, [bitmap]);
        }).catch(() => {
          thumbnailPendingRef.current.delete(requestId);
          thumbnailPendingKeysRef.current.delete(key);
          thumbnailWorkerFailedRef.current = true;
          setThumbnailVersion(version => version + 1);
        });
      }
      return THUMBNAIL_PLACEHOLDER;
    }

    // Compatibility fallback for older browsers or worker initialization
    // failures. This preserves the existing thumbnail behavior.
    try {
      const canvas = document.createElement("canvas");
      canvas.width = tw;
      canvas.height = th;
      const context = canvas.getContext("2d");
      if (!context) return "";
      context.drawImage(img, 0, 0, tw, th);
      const dataUrl = canvas.toDataURL("image/png");
      setThumbnailCacheEntry(cache, key, dataUrl);
      return dataUrl;
    } catch {
      return "";
    }
  }, []);

  useEffect(() => () => {
    thumbnailWorkerRef.current?.terminate();
    thumbnailWorkerRef.current = null;
    thumbnailPendingRef.current.clear();
    thumbnailPendingKeysRef.current.clear();
    for (const value of thumbnailCacheRef.current.values()) {
      if (value.startsWith("blob:")) URL.revokeObjectURL(value);
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
      // Move selection units, not individual layers. A grouped unit's
      // bounding box is the obstacle used for clamping, so a member cannot
      // be clamped independently and separated from its siblings.
      const units = getDesignSelectionUnits(prev, selectedDesignIds, artboardWidth, artboardHeight);
      let allowedDnx = dnx;
      let allowedDny = dny;
      for (const unit of units) {
        allowedDnx = Math.max(-unit.minX / artboardWidth, Math.min((artboardWidth - unit.maxX) / artboardWidth, allowedDnx));
        allowedDny = Math.max(-unit.minY / artboardHeight, Math.min((artboardHeight - unit.maxY) / artboardHeight, allowedDny));
      }

      return prev.map(d => {
        if (!units.some(unit => unit.members.some(member => member.id === d.id))) return d;
        return {
          ...d,
          transform: {
            ...d.transform,
            nx: d.transform.nx + allowedDnx,
            ny: d.transform.ny + allowedDny,
          },
        };
      });
    });
  }, [selectedDesignIds, artboardWidth, artboardHeight]);

  const handleMultiResizeDelta = useCallback((scaleRatio: number, centerNx: number, centerNy: number) => {
    setDesigns(prev => {
      if (!multiResizeStartRef.current) {
        const units = getDesignSelectionUnits(prev, selectedDesignIds, artboardWidth, artboardHeight);
        const memberIds = new Set(units.flatMap(unit => unit.members.map(member => member.id)));
        multiResizeStartRef.current = new Map(
          prev.filter(d => memberIds.has(d.id))
            .map(d => [d.id, { nx: d.transform.nx, ny: d.transform.ny, s: d.transform.s }])
        );
      }
      const starts = multiResizeStartRef.current;
      const centerX = centerNx * artboardWidth;
      const centerY = centerNy * artboardHeight;
      const startDesigns = prev.map(d => {
        const start = starts.get(d.id);
        return start
          ? { ...d, transform: { ...d.transform, nx: start.nx, ny: start.ny, s: start.s } }
          : d;
      });
      const units = getDesignSelectionUnits(startDesigns, selectedDesignIds, artboardWidth, artboardHeight);

      // Derive the largest legal group scale analytically. Every selected
      // design shares the same ratio, so each artboard edge produces a
      // linear upper bound on that ratio.
      let maxScale = Number.POSITIVE_INFINITY;
      for (const unit of units) {
        const left = centerX - unit.minX;
        const right = unit.maxX - centerX;
        const top = centerY - unit.minY;
        const bottom = unit.maxY - centerY;
        if (unit.minX < centerX && left > 0) maxScale = Math.min(maxScale, centerX / left);
        if (unit.maxX > centerX && right > 0) maxScale = Math.min(maxScale, (artboardWidth - centerX) / right);
        if (unit.minY < centerY && top > 0) maxScale = Math.min(maxScale, centerY / top);
        if (unit.maxY > centerY && bottom > 0) maxScale = Math.min(maxScale, (artboardHeight - centerY) / bottom);
      }
      const appliedRatio = Math.max(0.05, Math.min(scaleRatio, maxScale));

      return prev.map(d => {
        if (!units.some(unit => unit.members.some(member => member.id === d.id))) return d;
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
        const units = getDesignSelectionUnits(prev, selectedDesignIds, artboardWidth, artboardHeight);
        const memberIds = new Set(units.flatMap(unit => unit.members.map(member => member.id)));
        multiRotateStartRef.current = new Map(
          prev.filter(d => memberIds.has(d.id))
            .map(d => [d.id, { nx: d.transform.nx, ny: d.transform.ny, rotation: d.transform.rotation }])
        );
      }
      const starts = multiRotateStartRef.current;
      const centerX = centerNx * artboardWidth;
      const centerY = centerNy * artboardHeight;
      // Rotate from the immutable drag-start snapshot. This keeps the
      // pointer delta non-accumulating while the helper treats each group as
      // one unit and preserves all group membership.
      const startDesigns = prev.map(d => {
        const start = starts.get(d.id);
        return start
          ? { ...d, transform: { ...d.transform, nx: start.nx, ny: start.ny, rotation: start.rotation } }
          : d;
      });
      const rotated = rotateDesignSelection(
        startDesigns,
        selectedDesignIds,
        angleDeg,
        artboardWidth,
        artboardHeight,
      );
      if (!rotated) return prev;
      return prev.map(d => {
        const next = rotated.get(d.id);
        return next ? { ...d, transform: { ...d.transform, ...next } } : d;
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
    // Group-remap: when a whole group is duplicated, the copies should
    // form a *new* group with the same intra-group structure — not join
    // the source group. Otherwise auto-arrange would try to keep 2x
    // items in one cluster which never matches user intent. Mint one
    // fresh id per source groupId and rewrite as we go.
    const groupRemap = new Map<string, string>();
    const newIds: string[] = [];
    const newDesigns: DesignItem[] = toDup.map((d, i) => {
      const newId = crypto.randomUUID();
      newIds.push(newId);
      const base = d.name.replace(/ copy( \d+)?$/, '');
      const offsetT = { ...d.transform, nx: d.transform.nx + 0.03 + i * 0.01, ny: d.transform.ny };
      const { nx, ny } = clampDesignToArtboard({ ...d, transform: offsetT }, artboardWidth, artboardHeight);
      let nextGroupId: string | undefined;
      if (d.groupId) {
        let remapped = groupRemap.get(d.groupId);
        if (!remapped) {
          remapped = crypto.randomUUID();
          groupRemap.set(d.groupId, remapped);
        }
        nextGroupId = remapped;
      }
      return {
        ...d,
        id: newId,
        name: base,
        transform: { ...d.transform, nx, ny },
        printFileName: false,
        groupId: nextGroupId,
      };
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
    // Copies of a single grouped item are *independent* — they are not
    // reasonable siblings of the source group (a group of "the same
    // thing repeated N times" is not a useful cluster to auto-arrange
    // together). Strip `groupId` so each copy behaves as its own item.
    const { groupId: _dropGid, ...designNoGroup } = design;
    const newDesigns: DesignItem[] = [];
    for (let i = 0; i < count; i++) {
      const newId = crypto.randomUUID();
      const offsetT = { ...design.transform, nx: design.transform.nx + 0.03 * (i + 1), ny: design.transform.ny };
      const { nx, ny } = clampDesignToArtboard({ ...design, transform: offsetT }, artboardWidth, artboardHeight);
      newDesigns.push({
        ...designNoGroup,
        id: newId,
        name: baseName,
        transform: { ...design.transform, nx, ny },
        printFileName: false,
      });
    }
    saveSnapshot();
    setDesigns(prev => [...prev, ...newDesigns]);
    // `selectOneInStore` writes both `selectedDesignId` and
    // `selectedDesignIds` in one store transaction. `setSelectedDesignId`
    // alone would leave any prior multi-selection sitting in
    // `selectedDesignIds`, and the next auto-arrange / multi-resize /
    // multi-delete would silently target that stale set instead of
    // the newly-duplicated design. See applyImageDirectly for the
    // full symptom description.
    selectOneInStore(newDesigns[newDesigns.length - 1].id);
    setDuplicateCount(1);
  }, [selectedDesignId, designs, saveSnapshot, artboardWidth, artboardHeight, selectedDesignIds, handleDuplicateSelected, selectOneInStore]);

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
    // See handleDuplicateDesign for rationale — single-source copies
    // strip the source's groupId to remain independent.
    const { groupId: _dropGid, ...designNoGroup } = design;
    const newDesigns: DesignItem[] = [];
    for (let i = 0; i < count; i++) {
      const newId = crypto.randomUUID();
      const offsetT = { ...design.transform, nx: design.transform.nx + 0.03 * (i + 1), ny: design.transform.ny };
      const { nx, ny } = clampDesignToArtboard({ ...design, transform: offsetT }, artboardWidth, artboardHeight);
      newDesigns.push({
        ...designNoGroup,
        id: newId,
        name: baseName,
        transform: { ...design.transform, nx, ny },
        printFileName: false,
      });
    }
    saveSnapshot();
    setDesigns(prev => [...prev, ...newDesigns]);
    // See handleDuplicateDesign for the torn-state rationale.
    selectOneInStore(newDesigns[newDesigns.length - 1].id);
    setDuplicateCount(1);
    requestAnimationFrame(() => {
      handleAutoArrangeRef.current({ skipSnapshot: true, preserveSelection: true });
    });
  }, [selectedDesignId, designs, saveSnapshot, artboardWidth, artboardHeight, selectedDesignIds, handleDuplicateSelected, selectOneInStore]);

  const handleDuplicateById = useCallback((designId: string) => {
    const design = designs.find(d => d.id === designId);
    if (!design) return;
    const newId = crypto.randomUUID();
    const baseName = design.name.replace(/ copy( \d+)?$/, '');
    const offsetT = { ...design.transform, nx: design.transform.nx + 0.03, ny: design.transform.ny };
    const { nx, ny } = clampDesignToArtboard({ ...design, transform: offsetT }, artboardWidth, artboardHeight);
    const { groupId: _dropGid, ...designNoGroup } = design;
    const newDesign: DesignItem = {
      ...designNoGroup,
      id: newId,
      name: baseName,
      transform: { ...design.transform, nx, ny },
      printFileName: false,
    };
    saveSnapshot();
    setDesigns(prev => [...prev, newDesign]);
    // See handleDuplicateDesign for the torn-state rationale.
    selectOneInStore(newId);
  }, [designs, saveSnapshot, artboardWidth, artboardHeight, selectOneInStore]);

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
    // Paste of a copied group should preserve the group *relationship*
    // (so the paste stays clustered under auto-arrange) but under a
    // *fresh* group id, so it doesn't merge into the source group. Same
    // remap approach as `handleDuplicateSelected`.
    const groupRemap = new Map<string, string>();
    const pasted: DesignItem[] = clipboardRef.current.map(d => {
      const newId = crypto.randomUUID();
      newIds.push(newId);
      const offsetT = { ...d.transform, nx: d.transform.nx + 0.03, ny: d.transform.ny + 0.03 };
      const { nx, ny } = clampDesignToArtboard({ ...d, transform: offsetT }, artboardWidth, artboardHeight);
      let nextGroupId: string | undefined;
      if (d.groupId) {
        let remapped = groupRemap.get(d.groupId);
        if (!remapped) {
          remapped = crypto.randomUUID();
          groupRemap.set(d.groupId, remapped);
        }
        nextGroupId = remapped;
      }
      return {
        ...d,
        id: newId,
        name: d.name.replace(/ copy( \d+)?$/, ''),
        transform: { ...d.transform, nx, ny },
        printFileName: false,
        groupId: nextGroupId,
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
        revokeThumbnailCacheEntry(thumbnailCacheRef.current, d.imageInfo.image.src);
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
        revokeThumbnailCacheEntry(thumbnailCacheRef.current, toDelete.imageInfo.image.src);
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
        revokeThumbnailCacheEntry(thumbnailCacheRef.current, d.imageInfo.image.src);
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

    // Rotate selection units as complete objects. In particular, a selected
    // group must rotate around the group's bounding-box center instead of
    // rotating each member around its own center.
    setDesigns(prev => {
      const rotated = rotateDesignSelection(
        prev,
        idsToRotate,
        90,
        artboardWidth,
        artboardHeight,
      );
      if (!rotated) return prev;
      return prev.map(d => {
        const next = rotated.get(d.id);
        return next ? { ...d, transform: { ...d.transform, ...next } } : d;
      });
    });
    setDesignTransform(prev => ({
      ...prev,
      rotation: (prev.rotation + 90) % 360,
    }));
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
      uiActions.setContextMenu({ x, y, designId });
    } else {
      uiActions.setContextMenu(null);
    }
  }, [selectedDesignId, selectedDesignIds, handleSelectDesign, uiActions]);
  // NOTE: the global click / scroll / Escape auto-close listener that
  // used to live here now lives in `image-editor-view.tsx` where it can
  // subscribe to `useContextMenu()` directly. That way opening or
  // closing the menu no longer re-runs the model hook.


  // Base editor state; arrange/upload/export/cart hooks extend this bag in image-editor-provider.
  return { onDesignUploaded, profile, initialWidth, initialHeight, initialGangsheetHeights, initialQuantity, shopifyVariants, initialVariantId, shopDomain, embedFromShopify, initialDesignState, initialDesignId, isEditMode, toast, t, lang, isMobile, isLgUp, imageInfo, setImageInfo, resizeSettings, setResizeSettings, isProcessing, setIsProcessing, isAddingToCart, setIsAddingToCart, isUpdateFlow, setIsUpdateFlow, addToCartProgressLabel, setAddToCartProgressLabel, exportProgressLabel, setExportProgressLabel, addToCartInFlightRef, addToCartStallTimeoutRef, lastAddToCartPngBytesRef, shellUploadUrlRef, refreshAddToCartStallTimeout, isUploading, setIsUploading, uploadProgress, setUploadProgress, artboardWidth, setArtboardWidth, artboardHeight, setArtboardHeight, artboardWidthRef, artboardHeightRef, contentFillCacheRef, handleAutoArrangeRef, quantity, setQuantity, designGap, setDesignGap, duplicateCount, setDuplicateCount, clampDuplicateCount, parseDuplicateCount, handleDuplicateCountKeyDown, designTransform, setDesignTransform, designs, setDesigns, selectedDesignId, setSelectedDesignId, selectedDesignIds, setSelectedDesignIds, clipboardRef, proportionalLock, setProportionalLock, designInfoRef, sidebarFileRef, headerUploadInputRef, canvasRef, downloadContainer, setDownloadContainer, fluorPanelContainer, setFluorPanelContainer, mobileToolbarContainer, setMobileToolbarContainer, copySpotSelectionsRef, pushSnapshot, undo, redo, clearIsUndoRedo, canUndo, canRedo, mountedRef, designsRef, nudgeSnapshotSavedRef, nudgeTimeoutRef, thumbnailCacheRef, assetDataUrlCacheRef, restoredLayerAssetRef, multiDragAccumRef, multiResizeStartRef, multiRotateStartRef, snapshotCacheRef, getSnapshot, saveSnapshot, applySnapshot, handleUndo, handleRedo, handleInteractionEnd, handleRemoveWhiteBackground, handleWandDelete, selectedDesign, activeImageInfo, activeDesignTransform, activeWidthInches, activeHeightInches, activeResizeSettings, selectedVariantPrice, effectiveDPI, layerRows, draftRecoveryAvailable, isRecoveringDraft, recoverEditorDraft, discardEditorDraft, rehydrateDesignImage, ensureDesignImagesAvailable, handleSelectDesign, handleMultiSelect, handleGroupSelected, handleUngroupSelected, selectedHasGroup, getLayerThumbnail, handleDesignTransformChange, handleMultiDragDelta, handleMultiResizeDelta, handleMultiRotateDelta, handleEffectiveSizeChange, isArtboardFull, handleDuplicateDesign, handleDuplicateAndArrange, handleDuplicateSelected, handleDuplicateById, handleRemoveOneCopy, handleCopySelected, handlePaste, handleDeleteGroup, handleDeleteDesign, handleDeleteMulti, handleRotate90, handleFlipX, handleFlipY, handleCanvasContextMenu };
}

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
  getStampExtra,
  rotateDesignSelection,
  getRotatedBounds,
} from "./utils";
import { useAddToCartStall } from "./use-add-to-cart-stall";
import { useRestoreDesignState } from "./use-restore-design-state";
import { useLayerAssetUploader } from "./use-layer-asset-uploader";
import type { ImageInfo, ResizeSettings, ImageTransform, DesignItem } from "@/lib/types";
import { baseNameOf, sizeKeyOf, rowKeyOf } from "@/lib/edit-split";
import { HOT_PEEL_PROFILE } from "@/lib/profiles";
import type { ImageEditorProps } from "./types";
import {
  buildEditorDraft,
  computeDraftSignature,
  deleteCurrentEditorDraft,
  getCurrentEditorDraft,
  isDraftQuotaError,
  isEditorDraftExpired,
  isEditorDraftForProfile,
  isEditorDraftSubmitted,
  isRecoverableImageInfo,
  markCurrentEditorDraftSubmitted,
  rehydrateDesignImageFromDraft,
  requestPersistentEditorStorage,
  restoreEditorDraft,
  saveCurrentEditorDraft,
} from "@/lib/editor-draft-storage";
import { isTrustedShellMessage } from "@/lib/shell-message";
import { isTrustedCartStatus } from "@/lib/cart-submit-token";
import {
  acquireDraftOwnership,
  getDraftOwnership,
  isDraftOwner,
  subscribeDraftOwnership,
  subscribeDraftPurge,
  whenDraftOwnershipSettled,
} from "@/lib/draft-tab-ownership";
import ThumbnailWorker from "@/lib/thumbnail-worker?worker";
import {
  getThumbnailCacheEntry,
  revokeThumbnailCacheEntry,
  setThumbnailCacheEntry,
} from "@/lib/thumbnail-cache";

/**
 * Ceiling on how long a scheduled draft write may wait for an idle slot. An
 * un-timed `requestIdleCallback` can be starved indefinitely while the editor
 * is busy, and a delete that has not reached disk is lost outright if the tab
 * is killed rather than closed (OOM on mobile, crash), since only an orderly
 * close runs the unload flush.
 */
const DRAFT_SAVE_IDLE_TIMEOUT_MS = 2000;

/**
 * How long a save paused by a full origin quota waits before it is allowed one
 * more attempt.
 *
 * There has to be *some* clock here. The condition can clear for reasons nothing
 * in this app can observe — the customer clears another site's data, the browser
 * evicts a different origin — and the alternative to a periodic probe is a
 * session that never saves again however much space is freed. One doomed
 * multi-megabyte write a minute is a cost worth paying for that; one per
 * keystroke, which is what the bare `console.warn` produced, is not.
 */
const DRAFT_QUOTA_RETRY_COOLDOWN_MS = 60_000;

/**
 * How the sheet is packed after the copy count changes.
 *
 * Identical to what the Auto-Arrange button asks for, which is the point: adding a copy used to
 * pack with the stable-layout pass, so it kept designs where they already were and left film on
 * the sheet the button could then recover. Two ways to nest the same artwork meant the customer
 * had to know to press the button afterwards to get the tighter result — so copies now get the
 * same pack the button gives, and there is only one answer.
 *
 * `arrangeAll` because every copy path leaves the new copies selected for layer feedback, and
 * selected-only mode would treat the rest of the sheet as fixed obstacles and stack the copies
 * into a column. `skipSnapshot` because the caller already took the undo point that covers both
 * the copies and their placement.
 */
const COPY_ARRANGE_OPTS = {
  skipSnapshot: true,
  preserveSelection: true,
  arrangeAll: true,
  fullRepack: true,
} as const;

/**
 * Rough size of what a draft save would write, from data already to hand.
 *
 * Only ever compared against another reading of itself, to answer "is there less
 * to write than there was when we ran out of room" — so it needs to move in the
 * right direction, not to be accurate. Deliberately cheap enough to call on the
 * save path, which is the point: the expensive part of a save is
 * `buildEditorDraft` minting a `Blob` per design, and this is what decides
 * whether to bother.
 */
function estimateDraftPayloadBytes(designs: DesignItem[]): number {
  let bytes = 0;
  for (const design of designs) {
    const info = design.imageInfo;
    if (!info) continue;
    bytes += info.file?.size ?? 0;
    if (info.svgSource) {
      bytes += info.svgSource.length;
      continue;
    }
    try {
      // A buffer pdf.js has transferred reports 0, which is the right answer:
      // there are no bytes left for a save to write either.
      bytes += info.originalPdfData?.byteLength ?? 0;
    } catch {
      /* detached */
    }
  }
  return bytes;
}

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
    shellShopKeyRef,
    shellConfigReady,
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
  // Stable per-design id: minted once client-side, or taken from a loaded design's saved state.
  // Used only to build deterministic R2 object keys (design-object-keys.ts) — never sent anywhere
  // that treats it as a secret.
  const mintedDesignIdRef = useRef("");
  if (!mintedDesignIdRef.current) mintedDesignIdRef.current = crypto.randomUUID();
  const designIdRef = useRef("");
  designIdRef.current =
    String(initialDesignState?.designId || initialDesignId || "").trim() || mintedDesignIdRef.current;
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [artboardWidth, setArtboardWidth] = useState(initialWidth ?? profile.artboardWidth);
  const [artboardHeight, setArtboardHeight] = useState(initialHeight ?? profile.gangsheetHeights[0] ?? 12);
  const artboardWidthRef = useRef(artboardWidth);
  artboardWidthRef.current = artboardWidth;
  const artboardHeightRef = useRef(artboardHeight);
  artboardHeightRef.current = artboardHeight;
  const availableGangsheetHeights = useMemo(() => {
    // Height lists can arrive from Shopify variants in arbitrary order
    // (variant position / alphabetical). Every "next size up" lookup and
    // the MAX height assume ascending numeric order, so normalize here.
    if (initialGangsheetHeights && initialGangsheetHeights.length > 0) {
      return Array.from(new Set(initialGangsheetHeights)).sort((a, b) => a - b);
    }
    const base = profile.gangsheetHeights;
    const merged = !initialHeight || base.includes(initialHeight) ? base : [...base, initialHeight];
    return Array.from(new Set(merged)).sort((a, b) => a - b);
  }, [profile.gangsheetHeights, initialHeight, initialGangsheetHeights]);
  const contentFillCacheRef = useRef<Map<string, number>>(new Map());
  const handleAutoArrangeRef = useRef<(
    opts?: {
      skipSnapshot?: boolean;
      preserveSelection?: boolean;
      arrangeAll?: boolean;
      fullRepack?: boolean;
      /** Delete overflowing designs listed in `fillIds` instead of growing the sheet for them. */
      trimOverflow?: boolean;
      /** Ids of expendable Fill Sheet copies — the only designs `trimOverflow` may delete. */
      fillIds?: Set<string>;
      /**
       * How to undo a run that cannot honour `noGrow`: delete exactly these designs from the
       * sheet as it stands, rather than restoring a layout captured before it started, which
       * would also revert whatever the customer did while it packed.
       */
      revertIds?: Set<string>;
      /**
       * Forbid the height ladder for this run. Stronger than `trimOverflow`, which only
       * withholds growth on behalf of the listed copies; this withholds it outright, and a
       * run that cannot honour it undoes itself rather than buying film.
       */
      noGrow?: boolean;
      /**
       * Skip the auto-shrink that follows a clean pack. For Fill Sheet, whose whole purpose
       * is to use up the film the customer already has — measuring a half-filled sheet and
       * cropping it to the artwork is the opposite of filling it.
       */
      noShrink?: boolean;
      /**
       * Called exactly once when the run ends, however it ends. For callers that pack
       * repeatedly and need to know what the last pack achieved before deciding on the next.
       */
      onSettled?: (outcome: { trimmed: number; reverted: boolean; packed: boolean; frozenMs: number }) => void;
      /** Internal to the arrange hook: a height-ladder step continuing the run in flight. */
      continuation?: boolean;
      /** Internal to the arrange hook: the full-repack retry that precedes a growth step. */
      repacked?: boolean;
    }
  ) => void>(() => {});
  /**
   * Say the sheet is about to be repacked, before the designs that need repacking are committed.
   *
   * Copies are seeded on a provisional grid so they never appear stacked on their original, and
   * the pack that turns that grid into a real layout only starts a frame or two later. Both of
   * those states get painted, so what the customer sees is a rough grid, then a jump. Raising the
   * veil in the same commit as the copies hides the whole transition and shows them one settled
   * result instead. Assigned by `useImageEditorModelArrangeKeyboard`.
   */
  const beginArrangeRef = useRef<() => void>(() => {});
  // Assigned by `useImageEditorModelArrangeKeyboard`, which owns the height list. Held here so
  // the delete handlers below can drop the sheet to the smallest size the remaining artwork
  // needs, the same way they already reach auto-arrange.
  const shrinkSheetToFitRef = useRef<(opts?: { snapshot?: boolean }) => void>(() => {});
  /**
   * Height the customer last chose from the Gangsheet Size dropdown. Auto-shrink refuses to
   * go below it, so picking 120" is not silently undone by the next arrange or delete.
   *
   * It lives here, beside the history, rather than with the rest of the arrange logic that
   * reads and writes it, because it is snapshotted: `getSnapshot` captures it alongside
   * `artboardHeight` and `applySnapshot` restores it, which is what makes undo step back
   * through height picks in order instead of quietly releasing them. It used to be cleared
   * by an effect watching `designs.length` rise, which cannot tell a customer adding artwork
   * from history putting artwork back, and so dropped the pin on the first Ctrl+Z.
   */
  const manualHeightFloorRef = useRef<number | null>(null);
  /**
   * Forget the pick. Called from the delete handlers when the last design goes, because a
   * height chosen for a sheet is meaningless once that sheet is empty — without this, a
   * customer who pinned 120", cleared the sheet and uploaded one small design would be held
   * at 120" with no way back but the dropdown. Undoing back across the delete restores the
   * floor from the snapshot, so clearing it here loses nothing.
   */
  const clearManualHeightFloor = useCallback(() => {
    manualHeightFloorRef.current = null;
  }, []);
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
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Signature of the last state we serialized to IndexedDB. React re-renders
  // often produce new Array/Set references without any observable field
  // changing (e.g. selection toggles, thumbnail-version bumps). If the
  // signature matches the previous save we skip the debounced write entirely.
  const lastDraftSignatureRef = useRef<string | null>(null);
  const draftSaveIdleHandleRef = useRef<number | null>(null);
  /**
   * Set when a save was rejected because the origin is out of storage, together
   * with how much there was to write at the time.
   *
   * Both halves matter. Without the pause, every subsequent edit reissued a
   * doomed multi-megabyte write, because the failure handler resets
   * `lastDraftSignatureRef` and so nothing short-circuits the retry. Without the
   * measurements, the pause would be indefinite, and a customer who deleted half
   * their designs to make room would still never be saved — which is exactly the
   * action the toast is asking them to consider.
   *
   * Not `disableDraftSaves`, despite the overlap. That flag is module-scope and
   * unconditional, and the crash boundary owns both setting and clearing it: a
   * quota pause parked there would be cleared by an unrelated "Try to Recover"
   * click, and would meanwhile suppress the `pagehide` flush for every tab in the
   * page — including the one write most likely to fit, the one made after the
   * customer deletes designs. A pause that has to reconsider itself needs the
   * per-attempt state above, so it lives beside the save it gates.
   */
  const draftQuotaBlockRef = useRef<{ designCount: number; bytes: number; at: number } | null>(null);
  /** Once per session. A full quota fails every save, so the news does not improve
   *  by being repeated. */
  const draftQuotaToastShownRef = useRef(false);
  /**
   * True once this session has held at least one design. It is what separates
   * the two states that both look like "zero designs": a page that has only
   * just loaded (nothing to save, and writing would destroy the draft the
   * customer is about to be offered) from a sheet the customer has emptied
   * (a deliberate act, which must reach disk — otherwise the newest record
   * stays the pre-delete draft and gets offered back as "previous work").
   *
   * Set from any route into a non-empty sheet — upload, draft recovery, remote
   * restore, paste, undo — because in every one of them the customer can see
   * designs on screen, so clearing them is intentional.
   */
  const sessionHadDesignsRef = useRef(false);
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
    manualHeightFloor: number | null;
    quantity: number;
    /** `undefined` is the "Auto" margin, and must stay distinguishable from 0. */
    designGap: number | undefined;
    selectedDesignId: string | null;
    selectedDesignIds: Set<string>;
    /**
     * `true` while we should refuse to save — recovery banner is showing,
     * a recovery restore is in progress, a heavy processing job (e.g.
     * add-to-cart) is running, or the sheet has been empty for this whole
     * session. Literally the same `draftSaveGated` value the debounced
     * effect uses.
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

  const { getLayerAssetRef, getLayerScreenedAssetRef, releaseLayerAssetOwnership } = useLayerAssetUploader({
    designs,
    designIdRef,
    restoredLayerAssetRef,
    shellUploadUrlRef,
    shellShopKeyRef,
    shellConfigReady,
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

  // Only one tab may write draft storage — see `lib/draft-tab-ownership`. Two
  // tabs are two writers to one `current` record and one shared blob store, and
  // the observed consequence was total: tab B starting a fresh upload cleared
  // the file store, tab A carried on saving `fileKey`s that pointed at nothing,
  // and restore recovered zero designs without being able to say why.
  const [draftOwnership, setDraftOwnership] = useState(getDraftOwnership);
  useEffect(() => {
    const release = acquireDraftOwnership();
    setDraftOwnership(getDraftOwnership());
    const unsubscribe = subscribeDraftOwnership(next => {
      // Whatever is on disk was written by the tab that just went away, so this
      // tab's own state has never been saved. Dropping the cached signature is
      // what makes the first save after a handover actually write.
      if (next.isOwner) lastDraftSignatureRef.current = null;
      setDraftOwnership(next);
    });
    return () => {
      unsubscribe();
      release();
    };
  }, []);

  /**
   * A tab that is not saving says so. The alternative — standing down silently —
   * is precisely the failure this whole area is being audited for: the customer
   * builds a sheet, closes the tab, and finds nothing waiting for them. Held
   * back until the sheet is actually non-empty, because a tab with nothing on it
   * has nothing at stake and does not need interrupting. Reset on promotion, so
   * a tab that later loses ownership again warns again.
   */
  const nonOwnerWarnedRef = useRef(false);
  useEffect(() => {
    if (!draftOwnership.settled) return;
    if (draftOwnership.isOwner) {
      nonOwnerWarnedRef.current = false;
      return;
    }
    if (designs.length === 0 || nonOwnerWarnedRef.current) return;
    nonOwnerWarnedRef.current = true;
    toast({
      title: t("toast.draftNotSavingHere"),
      description: t("toast.draftNotSavingHereDesc"),
      variant: "warning",
    });
  }, [draftOwnership, designs.length, t, toast]);

  useEffect(() => {
    void requestPersistentEditorStorage();
    void (async () => {
      // Both branches below write to shared storage — one deletes a record, the
      // other offers a record this tab would then start overwriting — so neither
      // may run until the election has decided. A non-owner also must not offer
      // recovery at all: the record on disk is another tab's *live* sheet, not
      // unsent work from a previous session.
      if (!(await whenDraftOwnershipSettled())) return;
      const draft = await getCurrentEditorDraft();
      if (!draft) return;
      // Expiry is enforced here, on the consumer side, rather than inside
      // `getCurrentEditorDraft`: the same read backs `rehydrateDesignImageFromDraft`,
      // which repairs artwork for designs already on screen, and that must keep
      // working in a session that has outlived the cutoff. This effect runs once
      // per mount, before any save, so the record it judges is always a previous
      // session's. The purge is deliberately ahead of the edit-mode return below
      // so a stale draft's blobs are reclaimed in every flow, not just the ones
      // that would have offered it.
      if (isEditorDraftExpired(draft)) {
        void deleteCurrentEditorDraft().catch(error => {
          console.warn("[editor-draft] expired draft cleanup failed", error);
        });
        return;
      }
      if (draft.designs.length === 0) return;
      // Already sent to the cart. Not offered — the customer ordered this sheet,
      // and being asked to recover it reads as though the order did not go
      // through — but deliberately still on disk, so a checkout that later fails
      // has not already cost them the work. Placed after the expiry purge, like
      // the profile check below, so a submitted record ages out on exactly the
      // normal schedule instead of becoming the one thing nothing reclaims.
      if (isEditorDraftSubmitted(draft)) return;
      // Deliberately *after* the expiry purge: a draft belonging to another
      // product is hidden rather than deleted, and leaving it out of the purge
      // would make it the one record nothing on this origin can ever reclaim.
      if (!isEditorDraftForProfile(draft, profile.id)) {
        console.warn(
          "[editor-draft] not offering a draft built for another product",
          draft.profileId,
          "!=",
          profile.id,
        );
        return;
      }
      // A remotely saved design/edit flow is authoritative and should never
      // be replaced by an older browser-local draft.
      if (initialDesignState?.designId || isEditMode) return;
      setDraftRecoveryAvailable(true);
    })().catch(error => {
      console.warn("[editor-draft] availability check failed", error);
    });
  }, [initialDesignState?.designId, isEditMode, profile.id]);

  const discardEditorDraft = useCallback(async () => {
    try {
      // A non-owner clears its own banner but never the store: the record it
      // would be deleting belongs to whichever tab is actually saving.
      if (isDraftOwner()) await deleteCurrentEditorDraft();
    } catch (error) {
      console.warn("[editor-draft] discard failed", error);
    } finally {
      lastDraftSignatureRef.current = null;
      setDraftRecoveryAvailable(false);
    }
  }, []);

  const recoverEditorDraft = useCallback(async () => {
    if (isRecoveringDraft) return;
    setIsRecoveringDraft(true);
    try {
      const draft = await getCurrentEditorDraft();
      // Re-checked rather than assumed from the banner: the record can have been
      // replaced between the offer and the click, and restoring another product's
      // geometry onto this sheet is a wrong-order risk, not a cosmetic one.
      if (!draft || !isEditorDraftForProfile(draft, profile.id)) {
        setDraftRecoveryAvailable(false);
        return;
      }
      const restored = await restoreEditorDraft(draft);
      if (restored.designs.length === 0) {
        // Nothing came back. Silently clearing the banner would look like the
        // recover button did nothing at all — and when everything was withheld
        // for quality, "could not recover" would hide the actual instruction:
        // upload the originals again.
        await discardEditorDraft();
        if (restored.reducedQualityDesignCount > 0) {
          toast({
            title: t("toast.draftQualityReduced"),
            description: t("toast.draftQualityReducedDesc", {
              count: restored.reducedQualityDesignCount,
            }),
            variant: "destructive",
          });
        } else {
          toast({
            title: t("toast.draftRestoreFailed"),
            description: t("toast.draftRestoreFailedDesc"),
            variant: "destructive",
          });
        }
        return;
      }
      if (restored.missingDesignCount > 0) {
        toast({
          title: t("toast.draftPartial"),
          description: t("toast.draftPartialDesc", { count: restored.missingDesignCount }),
          variant: "warning",
        });
      }
      // Withheld for quality: the stored copy could no longer print at the
      // resolution it was built at, so it was deliberately left off the sheet.
      // Told separately from the missing-artwork case so the message can say
      // exactly what to do — upload those originals again.
      if (restored.reducedQualityDesignCount > 0) {
        toast({
          title: t("toast.draftQualityReduced"),
          description: t("toast.draftQualityReducedDesc", {
            count: restored.reducedQualityDesignCount,
          }),
          variant: "warning",
        });
      }
      setIsProcessing(true);
      setArtboardWidth(restored.artboardWidth);
      setArtboardHeight(restored.artboardHeight);
      // In step with the height, for the reason `applySnapshot` restores the two together:
      // a recovered 120" sheet with no floor behind it is one delete away from being
      // shrunk to whatever the artwork happens to need.
      manualHeightFloorRef.current = restored.manualHeightFloor;
      setQuantity(restored.quantity);
      setDesignGap(restored.designGap);
      setDesigns(restored.designs);
      setSelectedDesignId(restored.selectedDesignId);
      setSelectedDesignIds(restored.selectedDesignIds);
      const selected = restored.designs.find(design => design.id === restored.selectedDesignId);
      setImageInfo(selected?.imageInfo ?? null);
      setDesignTransform(selected?.transform ?? DEFAULT_DESIGN_TRANSFORM);
      // Force the next save-effect to write, since the debounced-save signature
      // check would otherwise compare against a stale value from a prior draft.
      lastDraftSignatureRef.current = null;
      setDraftRecoveryAvailable(false);
      setIsProcessing(false);
    } catch (error) {
      console.error("[editor-draft] restore failed", error);
      setIsProcessing(false);
      // The banner stays up so the customer can retry, but without this they
      // get no signal that anything went wrong.
      toast({
        title: t("toast.draftRestoreFailed"),
        description: t("toast.draftRestoreFailedDesc"),
        variant: "destructive",
      });
    } finally {
      setIsRecoveringDraft(false);
    }
  }, [
    discardEditorDraft,
    isRecoveringDraft,
    profile.id,
    setArtboardHeight,
    setArtboardWidth,
    setDesignGap,
    setQuantity,
    t,
    toast,
  ]);

  // Set from an effect, not during render. A render React throws away — a discarded
  // concurrent attempt, StrictMode's double invocation — still ran the render-time write, and
  // this flag's dangerous direction is being set spuriously: that is what turns "the page has
  // only just loaded" into "the customer emptied their sheet" and lets a blank draft overwrite
  // work they were about to be offered back.
  //
  // Deferring the write to commit introduces no lag where it matters, because `draftSaveGated`
  // below only consults the flag when `designs.length === 0`, and the flag can only be true if
  // some *committed* render had designs on screen. On the render where designs first appear the
  // length check short-circuits, so the gate does not need the flag yet.
  useEffect(() => {
    if (designs.length > 0) sessionHadDesignsRef.current = true;
  }, [designs.length]);
  // One expression for both save paths — the debounced effect and the
  // imperative unload flush. They previously each spelled the gate out, and
  // an empty sheet reached neither of them.
  const draftSaveGated =
    !draftOwnership.isOwner ||
    draftRecoveryAvailable ||
    isRecoveringDraft ||
    isProcessing ||
    (designs.length === 0 && !sessionHadDesignsRef.current);

  // Refresh the imperative save-inputs snapshot every render. Cheap: one
  // object allocation of primitive/reference fields. `flushDraftSaveNow`
  // reads from this ref during page-hide / unmount, so we don't need to
  // add those state values as `useEffect` deps for the listener effect
  // (that would rebind the listener on every keystroke and produce a
  // race where the listener detaches mid-hide).
  latestDraftInputsRef.current = {
    profileId: profile.id,
    designs,
    artboardWidth,
    artboardHeight,
    manualHeightFloor: manualHeightFloorRef.current,
    quantity,
    designGap,
    selectedDesignId,
    selectedDesignIds,
    saveGated: draftSaveGated,
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
  // reason this approach is safe during tab close, and it holds only
  // because `saveCurrentEditorDraft` reaches its `transaction()` call
  // without awaiting — see the note on it. The one case that still can't
  // be guaranteed is a cold connection (no read or write yet this
  // session), where opening the database is itself asynchronous.
  /**
   * Whether to skip this save because the last one ran out of storage and nothing
   * has changed that could make this one fit.
   *
   * Clears the pause — and so allows the attempt — on any of three grounds: fewer
   * designs than when it failed, less to write than when it failed, or the
   * cooldown has elapsed. The first two are the customer acting on the toast; the
   * third is everything we cannot see. A cleared pause is re-armed by the next
   * failure, so a genuinely full quota costs one write per cooldown and no more.
   */
  const draftSaveBlockedByQuota = useCallback((currentDesigns: DesignItem[]): boolean => {
    const blocked = draftQuotaBlockRef.current;
    if (!blocked) return false;
    const shrank =
      currentDesigns.length < blocked.designCount ||
      estimateDraftPayloadBytes(currentDesigns) < blocked.bytes;
    if (shrank || Date.now() - blocked.at >= DRAFT_QUOTA_RETRY_COOLDOWN_MS) {
      draftQuotaBlockRef.current = null;
      return false;
    }
    return true;
  }, []);

  const handleDraftSaveFailure = useCallback((
    error: unknown,
    attemptedDesigns: DesignItem[],
    reason: string,
  ) => {
    // Unchanged for every other failure: dropping the signature is what makes
    // the next state change retry.
    lastDraftSignatureRef.current = null;
    if (!isDraftQuotaError(error)) {
      console.warn(`[editor-draft] save failed (${reason})`, error);
      return;
    }
    draftQuotaBlockRef.current = {
      designCount: attemptedDesigns.length,
      bytes: estimateDraftPayloadBytes(attemptedDesigns),
      at: Date.now(),
    };
    console.warn(`[editor-draft] storage full, pausing draft saves (${reason})`, error);
    if (draftQuotaToastShownRef.current) return;
    draftQuotaToastShownRef.current = true;
    // The customer has no draft protection at all from here, and until this they
    // were never told — they closed the tab believing their work was safe. Said
    // once, and phrased around the two things they can actually do about it.
    toast({
      title: t("toast.draftStorageFull"),
      description: t("toast.draftStorageFullDesc"),
      variant: "destructive",
    });
  }, [t, toast]);
  /**
   * Reached through a ref so `performDraftSave` can keep empty deps. Its identity
   * is what keeps `flushDraftSaveNow` stable, and that in turn is what stops the
   * `pagehide` / `visibilitychange` listeners being rebound while the customer
   * edits — see the effect that binds them.
   */
  const draftSaveFailureRef = useRef(handleDraftSaveFailure);
  draftSaveFailureRef.current = handleDraftSaveFailure;

  const performDraftSave = useCallback((reason: string) => {
    const inputs = latestDraftInputsRef.current;
    if (!inputs) return;
    if (inputs.saveGated) return;
    if (draftSaveBlockedByQuota(inputs.designs)) return;
    const signature = computeDraftSignature(
      inputs.profileId,
      inputs.designs,
      inputs.artboardWidth,
      inputs.artboardHeight,
      inputs.manualHeightFloor,
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
      inputs.manualHeightFloor,
      inputs.quantity,
      inputs.designGap,
      inputs.selectedDesignId,
      inputs.selectedDesignIds,
    );
    lastDraftSignatureRef.current = signature;
    const attemptedDesigns = inputs.designs;
    void saveCurrentEditorDraft(draft, files).catch((error) => {
      draftSaveFailureRef.current(error, attemptedDesigns, reason);
    });
  }, [draftSaveBlockedByQuota]);

  // Drops any write that has been scheduled but not yet run — the 750 ms
  // debounce and the idle callback it hands off to. Needed by anything that
  // has to be the last word on what is (or is not) on disk.
  const cancelScheduledDraftSave = useCallback(() => {
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
    cancelScheduledDraftSave();
    performDraftSave(reason);
  }, [cancelScheduledDraftSave, performDraftSave]);

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
  // as accidental blank drafts; after that an empty sheet *is* saved, because
  // by then it means the customer deleted their work (see `draftSaveGated`).
  //
  // Two-stage coalescing:
  //   1. 750 ms debounce collapses bursts of state updates (typing, dragging,
  //      selection toggles) into a single scheduled write.
  //   2. `computeDraftSignature` compares the settled state against the
  //      last write and short-circuits when they match — React re-renders
  //      often produce a new `designs` Array reference without any field
  //      actually differing.
  //   3. `requestIdleCallback` (when available) waits for a quiet main-thread
  //      slot before serializing and hitting IndexedDB, so a save never
  //      contends with an active user interaction. `setTimeout(0)` fallback
  //      preserves behavior on Safari.
  //
  // The signature is computed after the debounce rather than before it. It walks the metadata
  // of every design to build a string, and `designs` is committed on every pointer move of a
  // multi-select drag, so computing it up front meant paying for that walk sixty times a
  // second to answer a question that only matters once the sheet stops moving.
  useEffect(() => {
    if (draftSaveGated) return;

    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      // `manualHeightFloorRef` is read rather than depended on, and that is sound because
      // every route that moves the floor also replaces the `designs` array: the height
      // dropdown goes through `handleArtboardResize`, the delete handlers clear it while
      // removing designs, and undo restores it while restoring designs. So this effect always
      // re-runs after a floor change — and the floor being *inside* the signature is what
      // makes the one case that changes nothing else (picking the height the sheet is already
      // on) still reach disk.
      const signature = computeDraftSignature(
        profile.id,
        designs,
        artboardWidth,
        artboardHeight,
        manualHeightFloorRef.current,
        quantity,
        designGap,
        selectedDesignId,
        selectedDesignIds,
      );
      if (signature === lastDraftSignatureRef.current) return;

      const idleCb: (cb: IdleRequestCallback, opts?: IdleRequestOptions) => number =
        typeof window !== "undefined" && "requestIdleCallback" in window
          ? window.requestIdleCallback.bind(window)
          : cb => window.setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 0 }), 0);
      const cancelIdleCb = typeof window !== "undefined" && "cancelIdleCallback" in window
        ? window.cancelIdleCallback.bind(window)
        : (id: number) => window.clearTimeout(id);
      if (draftSaveIdleHandleRef.current != null) cancelIdleCb(draftSaveIdleHandleRef.current);
      draftSaveIdleHandleRef.current = idleCb(() => {
        draftSaveIdleHandleRef.current = null;
        // Checked here rather than in `draftSaveGated` because the gate is a
        // render-time value and the pause lives in a ref: this is the last point
        // before the expensive part, and skipping it is the whole saving.
        if (draftSaveBlockedByQuota(designs)) return;
        const { draft, files } = buildEditorDraft(
          profile.id,
          designs,
          artboardWidth,
          artboardHeight,
          manualHeightFloorRef.current,
          quantity,
          designGap,
          selectedDesignId,
          selectedDesignIds,
        );
        // Optimistically mark the signature as saved. If the write fails we
        // reset it so the next state change retries. Blobs already on disk are
        // skipped inside the write transaction, so every file record can be
        // handed over on every save.
        lastDraftSignatureRef.current = signature;
        void saveCurrentEditorDraft(draft, files).catch(error => {
          draftSaveFailureRef.current(error, designs, "debounced");
        });
      }, { timeout: DRAFT_SAVE_IDLE_TIMEOUT_MS }) as number;
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
    draftSaveBlockedByQuota,
    draftSaveGated,
    draftRecoveryAvailable,
    isProcessing,
    isRecoveringDraft,
    profile.id,
    quantity,
    selectedDesignId,
    selectedDesignIds,
  ]);

  /**
   * Another tab has emptied the draft record and the whole blob store — the
   * escape hatch on the crash screen, which is deliberately not ownership-gated
   * because the crashed tab may be the non-owner and would otherwise be trapped
   * (see `purgeEditorDraftStorage`).
   *
   * So this tab is the healthy one, working normally, whose record has just been
   * deleted under it. Two things have to happen. The cached signature is now a
   * lie — it says the current state is on disk when nothing is — and dropping it
   * is what lets a save write again. And the save has to happen *now* rather than
   * whenever the customer next touches something, because they may simply close
   * the tab; `flushDraftSaveNow` re-writes the record and every blob, since the
   * skip-what-is-already-there check in the write transaction finds an empty
   * store. Then they are told, because their work was briefly gone and a silent
   * repair is indistinguishable from not noticing.
   */
  useEffect(() => subscribeDraftPurge(() => {
    lastDraftSignatureRef.current = null;
    // Whatever was being offered has just been deleted, so the banner would
    // recover nothing.
    setDraftRecoveryAvailable(false);
    const inputs = latestDraftInputsRef.current;
    // A tab with an empty sheet has nothing to put back, and a non-owner never
    // had anything on disk to lose.
    if (!inputs || inputs.designs.length === 0 || !isDraftOwner()) return;
    flushDraftSaveNow("peer purge");
    toast({
      title: t("toast.draftClearedElsewhere"),
      description: t("toast.draftClearedElsewhereDesc"),
      variant: "warning",
    });
  }), [flushDraftSaveNow, t, toast]);

  // A sheet that reached the cart is no longer unsent work, so its draft stops
  // being offered back. The storefront shell reports the outcome as
  // `dtf-builder-cart-status`, and `done` is the only status that means the cart
  // (or, in the edit flow, the saved design) actually took it — `handleAddToCart`
  // returning means only that the payload was posted to the shell, so acting
  // there would be optimistic and an upload that then fails, times out, or is
  // rejected would have cost the customer their only copy. `error` and the stall
  // watchdog deliberately leave the draft alone.
  //
  // `postMessage` is addressed to a *window*, not to a script, so before any of
  // that: every frame, popup and third-party embed on the storefront page can
  // deliver a message indistinguishable from the shell's. Both guards below sit
  // ahead of every state change in this handler — including the signature write,
  // which a rejected message would otherwise poison into claiming the live sheet
  // was already saved.
  useEffect(() => {
    const onCartStatus = (event: MessageEvent) => {
      const data = event.data as
        | { type?: unknown; status?: unknown; requestId?: unknown }
        | null
        | undefined;
      if (data?.type !== "dtf-builder-cart-status" || data.status !== "done") return;
      // Who sent it: `event.source` is set by the browser and cannot be forged,
      // so this excludes every window that is not our embedder.
      if (!isTrustedShellMessage(event, "draft-clear")) return;
      // Whether we asked: honoured only against a submit this tab actually made,
      // which is what stops the genuine shell's own spontaneous or replayed
      // `done` from counting. This is the primary defence — the origin half of
      // the check above degrades to advisory on browsers without
      // `location.ancestorOrigins`.
      if (!isTrustedCartStatus(data.requestId, data.status)) return;
      // Nothing may put the record back afterwards, and two writers could.
      // One is a save that is scheduled but has not run — cancelled here. The
      // other is the debounced effect re-running because this same status
      // message drops `isProcessing` to false: starting add-to-cart cancelled
      // the pending save for the current state, so the last-saved signature is
      // stale and the effect would write it straight back. Claiming the
      // submitted state as already-saved makes that re-run a no-op, while any
      // *later* real edit still changes the signature and correctly begins a
      // new draft.
      cancelScheduledDraftSave();
      const inputs = latestDraftInputsRef.current;
      if (inputs) {
        lastDraftSignatureRef.current = computeDraftSignature(
          inputs.profileId,
          inputs.designs,
          inputs.artboardWidth,
          inputs.artboardHeight,
          inputs.manualHeightFloor,
          inputs.quantity,
          inputs.designGap,
          inputs.selectedDesignId,
          inputs.selectedDesignIds,
        );
      }
      // Stamped, not deleted. `done` is the shell telling us the cart request
      // came back — not that the order is paid for — so destroying the record
      // here would take the sheet away at the exact moment the evidence is
      // weakest, and a customer whose checkout then failed would have nothing.
      // The stamp suppresses the recovery offer, which is the whole of what the
      // customer should notice, and the record ages out through the ordinary
      // 7-day expiry with its blobs. An explicit discard still deletes outright
      // — see `discardEditorDraft`.
      //
      // Only the owning tab may write. A non-owner submitting its sheet would
      // otherwise stamp the *other* tab's in-progress draft — and it has
      // nothing of its own on disk to mark, since it was never saving.
      if (isDraftOwner()) {
        void markCurrentEditorDraftSubmitted().catch(error => {
          console.warn("[editor-draft] marking the draft submitted failed", error);
        });
      }
      setDraftRecoveryAvailable(false);
    };
    window.addEventListener("message", onCartStatus);
    return () => window.removeEventListener("message", onCartStatus);
  }, [cancelScheduledDraftSave]);

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

  const snapshotCacheRef = useRef<{
    designs: DesignItem[];
    json: string;
    infoMap: Map<string, ImageInfo>;
    halftoneSourceMap: Map<string, HTMLImageElement>;
  } | null>(null);
  const getSnapshot = useCallback((): HistorySnapshot => {
    const currentDesigns = designsRef.current;
    let json: string;
    let infoMap: Map<string, ImageInfo>;
    let halftoneSourceMap: Map<string, HTMLImageElement>;
    const cache = snapshotCacheRef.current;
    if (cache && cache.designs === currentDesigns) {
      json = cache.json;
      infoMap = cache.infoMap;
      halftoneSourceMap = cache.halftoneSourceMap;
    } else {
       json = JSON.stringify(currentDesigns.map(d => ({
         id: d.id,
         transform: d.transform,
         widthInches: d.widthInches,
         heightInches: d.heightInches,
         name: d.name,
         printFileName: d.printFileName,
         halftoned: d.halftoned,
         halftoneSettings: d.halftoneSettings,
         editSplit: d.editSplit,
       })));
      infoMap = new Map(currentDesigns.map(d => [d.id, d.imageInfo]));
      halftoneSourceMap = new Map(
        currentDesigns.flatMap(d => d.halftoneSourceImage ? [[d.id, d.halftoneSourceImage]] : []),
      );
      snapshotCacheRef.current = { designs: currentDesigns, json, infoMap, halftoneSourceMap };
    }
    return {
      designsJson: json,
      selectedDesignId,
      imageInfoMap: infoMap,
      halftoneSourceMap,
      artboardWidth: artboardWidthRef.current,
      artboardHeight: artboardHeightRef.current,
      manualHeightFloor: manualHeightFloorRef.current,
    };
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
      printFileName?: boolean;
      halftoned?: boolean;
      halftoneSettings?: DesignItem["halftoneSettings"];
      editSplit?: string;
    }>;
    try {
      parsed = JSON.parse(snap.designsJson);
    } catch {
      clearIsUndoRedo();
      return;
    }
    const infoMap = snap.imageInfoMap ?? new Map<string, unknown>();
    const halftoneSourceMap = snap.halftoneSourceMap ?? new Map<string, HTMLImageElement>();
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
             // Written back explicitly: the spread above carries the live flag, so an undo of a
             // label toggle would otherwise leave the label on.
             printFileName: p.printFileName,
             alphaThresholded: savedInfo ? undefined : existing.alphaThresholded,
             halftoned: p.halftoned,
             halftoneSettings: p.halftoneSettings,
             // Explicit for the same reason as printFileName: undoing past the
             // pixel edit that split this copy off must also clear its tag so
             // the copy re-joins its original row (and redo re-splits it).
             editSplit: p.editSplit,
             // Prefer the source captured with this exact history entry. Falling
             // back to the live source keeps old snapshots compatible, while
             // the captured map is what lets redo cross a non-halftoned entry
             // without screening the already-screened `imageInfo.image`.
             halftoneSourceImage: p.halftoned
               ? (halftoneSourceMap.get(p.id) ?? existing.halftoneSourceImage)
               : undefined,
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
             printFileName: p.printFileName,
             originalDPI: savedInfo.dpi,
             halftoned: p.halftoned,
             halftoneSettings: p.halftoneSettings,
              halftoneSourceImage: p.halftoned ? halftoneSourceMap.get(p.id) : undefined,
             editSplit: p.editSplit,
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
    // Restored unconditionally, and in step with the height above. Leaving the live value
    // in place is what stranded a 120" floor on a sheet an undo had just put back to 60".
    manualHeightFloorRef.current = snap.manualHeightFloor ?? null;
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
    const { removeBackgroundFromCanvas } = await import("@/lib/background-removal");
    const {
      applyEditAtPrintResolution,
      applyEditToPreviewSource,
      printSourceFieldsAfterEdit,
    } = await import("@/lib/print-source-edit");
    const { createTrimmingEdit, geometryAfterTrim } = await import("@/lib/trim-after-edit");
    const targetDesigns = designsRef.current.filter(d => targetIds.includes(d.id));

    // Run the removal against the full-resolution print source so it reaches
    // the printed sheet. Only designs with no separate print source fall back
    // to editing the preview, where the preview *is* what prints.
    //
    // One design at a time, deliberately. Each pass rasterises its design at print
    // resolution, which is ~137 MB of pixels for a 36 MP artwork, so removing the background
    // from a selection of eight in parallel would ask the device for a gigabyte of canvas
    // before the first flood fill finished. The removal worker processes them serially
    // regardless, so the parallelism bought nothing but the memory spike.
    const updates = new Map<string, { info: ImageInfo; fields: Partial<DesignItem> }>();
    let trimmedCount = 0;
    for (const d of targetDesigns) {
      // A fresh wrapper per attempt: each one records what its trim took, and a
      // retry against a different source must not read the first one's answer.
      const printPass = createTrimmingEdit(canvas => removeBackgroundFromCanvas(canvas, 75));
      let edited = await applyEditAtPrintResolution(
        d.imageInfo,
        d.widthInches,
        d.heightInches,
        printPass.edit,
      ).catch(() => null);
      let trim = edited ? printPass.trim() : null;

      if (!edited) {
        // The preview is the only source this design has. Editing it and
        // promoting the result keeps what prints identical to what the customer
        // approved on screen, which is the whole point of the path above.
        const preview = d.imageInfo.image;
        const previewMaxEdge = Math.max(
          1,
          preview?.naturalWidth || preview?.width || 0,
          preview?.naturalHeight || preview?.height || 0,
        );
        const previewPass = createTrimmingEdit(canvas => removeBackgroundFromCanvas(canvas, 75));
        edited = await applyEditToPreviewSource(d.imageInfo, previewMaxEdge, previewPass.edit)
          .catch(() => null);
        trim = edited ? previewPass.trim() : null;
      }
      if (!edited) continue;

      const fields: Partial<DesignItem> = {};
      const geometry = trim
        ? geometryAfterTrim(d, trim, artboardWidthRef.current, artboardHeightRef.current)
        : null;
      if (geometry) {
        fields.widthInches = geometry.widthInches;
        fields.heightInches = geometry.heightInches;
        fields.transform = geometry.transform;
        trimmedCount++;
      }
      // The halftone rebuild watches the design's inches and re-screens from
      // `halftoneSourceImage`. Trimming changes those inches, so a source left
      // pointing at the pre-removal artwork would repaint it over this edit a
      // moment later. Halftoning never touches the print source, so the edited
      // one is exactly the un-screened artwork to rebuild from.
      //
      // A halftoned design with no source at all is a restored draft, and the
      // rebuild keys off that absence to heal itself. Filling it in without also
      // changing the geometry would take away its trigger and leave the design
      // unscreened, so that case is left for the rebuild to sort out.
      if (d.halftoneSourceImage || (d.halftoned && geometry)) {
        fields.halftoneSourceImage = edited.previewImage;
      }
      updates.set(d.id, { info: { ...d.imageInfo, ...printSourceFieldsAfterEdit(edited) }, fields });
    }
    if (updates.size === 0) {
      toast({ title: "Remove failed", description: "Could not remove white background.", variant: "destructive" });
      return;
    }
    setDesigns(prev => prev.map(d => {
      const next = updates.get(d.id);
      return next ? { ...d, ...next.fields, imageInfo: next.info } : d;
    }));
    const selected = selectedDesignId ? updates.get(selectedDesignId) : undefined;
    if (selected) {
      setImageInfo(selected.info);
      const { widthInches, heightInches } = selected.fields;
      if (widthInches !== undefined && heightInches !== undefined) {
        setResizeSettings(prev => ({ ...prev, widthInches, heightInches }));
      }
    }
    uiActions.setWandDeleteModeActive(false);
    const designCount = `${updates.size} design${updates.size !== 1 ? "s" : ""}`;
    toast({
      title: "White background removed",
      description: trimmedCount > 0
        ? `Applied to ${designCount}, and trimmed the empty space it left behind.`
        : `Applied to ${designCount}.`,
    });
  }, [selectedDesignId, selectedDesignIds, saveSnapshot, setDesigns, setResizeSettings, toast, uiActions]);

  const handleWandDelete = useCallback(async (nx: number, ny: number, designId: string) => {
    const design = designsRef.current.find(d => d.id === designId);
    if (!design) return;
    // Read the slider value at click time so the callback identity
    // doesn't depend on `wandTolerance` — the slider can drag freely
    // without invalidating this `useCallback` or its downstream memos.
    const { wandTolerance } = getToolSnapshot();
    const maxDiff = Math.round((wandTolerance / 100) * 255);

    // Normalised coordinates, so the same fill can run at whatever resolution
    // the canvas happens to be — preview or full print source.
    //
    // Scanline fill: each step claims a whole horizontal run at once and only
    // pushes one seed per adjacent run, rather than pushing every pixel. On a
    // print-resolution source that is the difference between a stack of a few
    // thousand entries and a queue of millions. A per-pixel queue was costing
    // more than its own runtime in knock-on effects — holding hundreds of
    // megabytes live made the PNG encode that follows several times slower.
    //
    // Erased pixels get alpha 0, and `matches` rejects anything transparent, so
    // a filled pixel can never match again. That is what a `visited` array
    // would have tracked, so there is no need to allocate one.
    const floodFillDelete = (canvas: HTMLCanvasElement): boolean => {
      const w = canvas.width, h = canvas.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx || !w || !h) return false;
      const px = Math.min(Math.max(0, Math.round(nx * w)), w - 1);
      const py = Math.min(Math.max(0, Math.round(ny * h)), h - 1);
      const imageData = ctx.getImageData(0, 0, w, h);
      const data = imageData.data;
      const start = (py * w + px) * 4;
      if (data[start + 3] < 10) return false;
      const sr = data[start], sg = data[start + 1], sb = data[start + 2];

      const matches = (pos: number): boolean => {
        const idx = pos << 2;
        if (data[idx + 3] < 10) return false;
        const dr = data[idx] - sr, dg = data[idx + 1] - sg, db = data[idx + 2] - sb;
        return (dr < 0 ? -dr : dr) <= maxDiff
          && (dg < 0 ? -dg : dg) <= maxDiff
          && (db < 0 ? -db : db) <= maxDiff;
      };

      let stack = new Int32Array(1024);
      let sp = 0;
      const push = (pos: number) => {
        if (sp === stack.length) {
          const grown = new Int32Array(stack.length * 2);
          grown.set(stack);
          stack = grown;
        }
        stack[sp++] = pos;
      };

      // Seed rows adjacent to a just-filled run, one push per contiguous run.
      const seedRow = (rowStart: number, from: number, to: number) => {
        let x = from;
        while (x <= to) {
          if (!matches(rowStart + x)) { x++; continue; }
          push(rowStart + x);
          while (x <= to && matches(rowStart + x)) x++;
        }
      };

      push(py * w + px);
      while (sp > 0) {
        const pos = stack[--sp];
        const y = (pos / w) | 0;
        const rowStart = y * w;
        // Another run may have swallowed this seed since it was pushed.
        if (!matches(pos)) continue;

        let left = pos - rowStart;
        while (left > 0 && matches(rowStart + left - 1)) left--;
        let right = pos - rowStart;
        while (right < w - 1 && matches(rowStart + right + 1)) right++;

        for (let x = left; x <= right; x++) data[((rowStart + x) << 2) + 3] = 0;

        if (y > 0) seedRow(rowStart - w, left, right);
        if (y < h - 1) seedRow(rowStart + w, left, right);
      }

      ctx.putImageData(imageData, 0, 0);
      return true;
    };

    const commit = (fields: Partial<ImageInfo>) => {
      const nextInfo = { ...design.imageInfo, ...fields };
      setDesigns(prev => prev.map(d => d.id === designId ? { ...d, imageInfo: nextInfo } : d));
      if (selectedDesignId === designId) setImageInfo(nextInfo);
    };

    // Fill the full-resolution print source, so the erased area is actually
    // absent from the printed sheet rather than just from the preview.
    const { applyEditAtPrintResolution, printSourceFieldsAfterEdit } = await import("@/lib/print-source-edit");
    let hit = true;
    const edited = await applyEditAtPrintResolution(
      design.imageInfo,
      design.widthInches,
      design.heightInches,
      canvas => { hit = floodFillDelete(canvas); },
    ).catch(() => null);
    if (edited) {
      // A tap on empty space is a no-op; don't burn an undo step on it.
      if (!hit) return;
      saveSnapshot();
      commit(printSourceFieldsAfterEdit(edited));
      return;
    }

    // No separate print source: the preview is what prints, so edit it directly.
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
    if (!floodFillDelete(canvas)) return;
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
        commit({ image: nextImage });
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
    // Row identity (name + size + edit-split tag) lives in lib/edit-split.ts so this
    // grouping and the split stamping inside the edit tools can never disagree. The
    // tag segment is what moves a pixel-edited copy (halftone/upscale/clean/crop on
    // one of several copies) into its own row, mirroring how a resize already does.
    const firstSizeByBase = new Map<string, string>();
    const groups = new Map<string, DesignItem[]>();
    for (const d of designs) {
      const base = baseNameOf(d.name);
      const sk = sizeKeyOf(d);
      if (!firstSizeByBase.has(base)) firstSizeByBase.set(base, sk);
      const key = rowKeyOf(d);
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
        editSplit: designsInGroup[0].editSplit,
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
      beginArrangeRef.current();
      const newIds = handleDuplicateSelected();
      if (newIds.length > 0) {
        setTimeout(() => handleAutoArrangeRef.current(COPY_ARRANGE_OPTS), 0);
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
      });
    }
    saveSnapshot();
    beginArrangeRef.current();
    setDesigns(prev => [...prev, ...newDesigns]);
    // See handleDuplicateDesign for the torn-state rationale.
    selectOneInStore(newDesigns[newDesigns.length - 1].id);
    setDuplicateCount(1);
    requestAnimationFrame(() => {
      handleAutoArrangeRef.current(COPY_ARRANGE_OPTS);
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
    beginArrangeRef.current();
    setTimeout(() => handleAutoArrangeRef.current(COPY_ARRANGE_OPTS), 0);
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
        groupId: nextGroupId,
      };
    });
    setDesigns(prev => [...prev, ...pasted]);
    setSelectedDesignIds(new Set(newIds));
    setSelectedDesignId(newIds[newIds.length - 1]);
  }, [saveSnapshot, artboardWidth, artboardHeight]);

  /**
   * Turns the printed filename on or off for every copy of an artwork.
   *
   * Scoped to the artwork rather than to the row the button lives in. The label identifies a file
   * to whoever is pressing the garments, so wanting it on one copy and not another is not a real
   * intention — and a row only covers copies at one size, so a resized copy would silently print
   * without a name. Copies are matched by source image and base name, which is what makes a
   * resized copy or one added later still count as the same design.
   *
   * Enabling it grows the design's footprint — by a band under the artwork, or by nothing at all
   * when the label fits in the artwork's own empty corner — so the designs are re-clamped
   * afterwards. Without that, switching the label on for a design already sitting against the
   * bottom edge would put its label off the film, which is the one failure the customer cannot
   * see in the preview until it comes back from the printer.
   *
   * Clamping alone is not enough when the label costs a band. This used to leave positions
   * otherwise untouched, on the grounds that re-nesting moves work the customer placed
   * deliberately — but the sheet was packed with these designs at their unlabelled height, so
   * the band has nowhere to go except over the neighbour beneath. Sliding the design back onto
   * the film only relocates the collision. So a toggle that changes the footprint re-arranges;
   * one that does not (a label that fits in the artwork's own corner, or the label being
   * switched off) still leaves every position alone.
   */
  const handleTogglePrintName = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    saveSnapshot();
    const asked = new Set(ids);
    const baseNameOf = (name: string) => name.replace(/ copy( \d+)?$/, '');
    const family = new Set(
      designsRef.current
        .filter(d => asked.has(d.id))
        .map(d => `${d.imageInfo.image.src}\u0000${baseNameOf(d.name)}`),
    );
    const idSet = new Set(
      designsRef.current
        .filter(d => family.has(`${d.imageInfo.image.src}\u0000${baseNameOf(d.name)}`))
        .map(d => d.id),
    );
    const turningOn = !designsRef.current.some(d => idSet.has(d.id) && d.printFileName);
    // Only a label that lands in a band below the artwork asks for film the pack did not
    // reserve. Measured before the flag is written, on the design as it will be.
    const needsRoom = turningOn && designsRef.current.some(d =>
      idSet.has(d.id) && getStampExtra({ ...d, printFileName: true }) > 0,
    );
    setDesigns(prev => {
      const labelled = prev.map(d => (idSet.has(d.id) ? { ...d, printFileName: turningOn } : d));
      if (!turningOn) return labelled;
      return labelled.map(d => {
        if (!idSet.has(d.id)) return d;
        const { nx, ny } = clampDesignToArtboard(d, artboardWidthRef.current, artboardHeightRef.current);
        return { ...d, transform: { ...d.transform, nx, ny } };
      });
    });
    if (needsRoom && designsRef.current.length >= 2) {
      beginArrangeRef.current();
      requestAnimationFrame(() => {
        handleAutoArrangeRef.current({ skipSnapshot: true, preserveSelection: true, arrangeAll: true });
      });
    }
  }, [saveSnapshot]);

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
      clearManualHeightFloor();
    } else if (ids.includes(selectedDesignId ?? '')) {
      setSelectedDesignId(remaining[remaining.length - 1].id);
    }
    // Give back any film the deleted copies were holding open. Deferred so it measures the
    // remaining designs; no snapshot, so the delete and the resize undo as one step.
    setTimeout(() => shrinkSheetToFitRef.current(), 0);
  }, [selectedDesignId, saveSnapshot, clearManualHeightFloor]);

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
      clearManualHeightFloor();
    } else if (selectedDesignId === id) {
      setSelectedDesignId(remaining[remaining.length - 1].id);
    }
    setTimeout(() => shrinkSheetToFitRef.current(), 0);
  }, [selectedDesignId, saveSnapshot, clearManualHeightFloor]);

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
      clearManualHeightFloor();
    }
    setTimeout(() => shrinkSheetToFitRef.current(), 0);
  }, [saveSnapshot, clearManualHeightFloor]);

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
  return { onDesignUploaded, profile, initialWidth, initialHeight, initialGangsheetHeights, initialQuantity, shopifyVariants, initialVariantId, shopDomain, embedFromShopify, initialDesignState, initialDesignId, isEditMode, toast, t, lang, isMobile, isLgUp, imageInfo, setImageInfo, resizeSettings, setResizeSettings, isProcessing, setIsProcessing, isAddingToCart, setIsAddingToCart, isUpdateFlow, setIsUpdateFlow, addToCartProgressLabel, setAddToCartProgressLabel, exportProgressLabel, setExportProgressLabel, addToCartInFlightRef, addToCartStallTimeoutRef, lastAddToCartPngBytesRef, shellUploadUrlRef, shellShopKeyRef, shellConfigReady, designIdRef, refreshAddToCartStallTimeout, isUploading, setIsUploading, uploadProgress, setUploadProgress, artboardWidth, setArtboardWidth, artboardHeight, setArtboardHeight, artboardWidthRef, artboardHeightRef, contentFillCacheRef, handleAutoArrangeRef, beginArrangeRef, shrinkSheetToFitRef, manualHeightFloorRef, clearManualHeightFloor, quantity, setQuantity, designGap, setDesignGap, duplicateCount, setDuplicateCount, clampDuplicateCount, parseDuplicateCount, handleDuplicateCountKeyDown, designTransform, setDesignTransform, designs, setDesigns, selectedDesignId, setSelectedDesignId, selectedDesignIds, setSelectedDesignIds, clipboardRef, proportionalLock, setProportionalLock, designInfoRef, sidebarFileRef, headerUploadInputRef, canvasRef, downloadContainer, setDownloadContainer, fluorPanelContainer, setFluorPanelContainer, mobileToolbarContainer, setMobileToolbarContainer, copySpotSelectionsRef, pushSnapshot, undo, redo, clearIsUndoRedo, canUndo, canRedo, mountedRef, designsRef, nudgeSnapshotSavedRef, nudgeTimeoutRef, thumbnailCacheRef, assetDataUrlCacheRef, restoredLayerAssetRef, getLayerAssetRef, getLayerScreenedAssetRef, releaseLayerAssetOwnership, multiDragAccumRef, multiResizeStartRef, multiRotateStartRef, snapshotCacheRef, getSnapshot, saveSnapshot, applySnapshot, handleUndo, handleRedo, handleInteractionEnd, handleRemoveWhiteBackground, handleWandDelete, selectedDesign, activeImageInfo, activeDesignTransform, activeWidthInches, activeHeightInches, activeResizeSettings, selectedVariantPrice, effectiveDPI, layerRows, draftRecoveryAvailable, isRecoveringDraft, recoverEditorDraft, discardEditorDraft, rehydrateDesignImage, ensureDesignImagesAvailable, handleSelectDesign, handleMultiSelect, handleGroupSelected, handleUngroupSelected, selectedHasGroup, getLayerThumbnail, handleDesignTransformChange, handleMultiDragDelta, handleMultiResizeDelta, handleMultiRotateDelta, handleEffectiveSizeChange, isArtboardFull, handleDuplicateDesign, handleDuplicateAndArrange, handleDuplicateSelected, handleDuplicateById, handleRemoveOneCopy, handleCopySelected, handlePaste, handleTogglePrintName, handleDeleteGroup, handleDeleteDesign, handleDeleteMulti, handleRotate90, handleFlipX, handleFlipY, handleCanvasContextMenu };
}

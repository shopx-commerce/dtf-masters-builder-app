import { useRef, useCallback, useEffect, useMemo, useState } from "react";
import { formatDimensions } from "@/lib/format-length";
import {
  clampDesignToArtboard,
  getArrangeWorker,
  discardArrangeWorker,
  getDesignNestSilhouette,
  getEffectiveHeight,
  getDesignSelectionBounds,
  getDesignSelectionUnits,
  fitGangsheetHeight,
  getContentInkBandY,
  getRotatedBounds,
  getStampExtra,
  nextArrangeRequestId,
  sanitizeDesignInches,
} from "./utils";
import { DEFAULT_LAYER_CENTER_NX, DEFAULT_LAYER_CENTER_NY } from "./constants";
import { runArrange } from "@/lib/arrange-core";
import { DEFAULT_SHEET_MARGIN, planBandReseat, planLadderJump, planSheetShrink } from "@/lib/sheet-fit";
import { isUploadBatchActive } from "@/lib/upload-queue";
import { keepPositionsNest, type NestMask } from "@/lib/nest-core";
import { getDesignNestMask } from "@/lib/nest-mask";
import type { ImageInfo, DesignItem } from "@/lib/types";
import type { ImageEditorBagAfterDesign } from "./image-editor-hook-bag.types";
import { useSelectionActions } from "@/state/selection-store";

/**
 * Id prefix for the synthetic item that stands in for a user-defined group while packing.
 * Both auto-arrange and import placement collapse a group's members into one rectangle
 * under this id, so the group is packed and avoided as a single entity.
 */
const GROUP_PREFIX = "group:";

/**
 * How often a pending import re-seat re-checks whether the upload batch has drained.
 *
 * Polling rather than a plain debounce because the thing being waited for is not "the user
 * stopped typing" but "the queue emptied", and a single large file can take seconds to
 * decode — long enough that any debounce short enough to feel immediate would fire in the
 * middle of a twenty-file drop and re-seat the sheet twenty times.
 */
const IMPORT_RESEAT_POLL_MS = 150;

/** Fill Sheet never pushes the design count past this — the editor has to stay interactive. */
const MAX_FILL_TOTAL_DESIGNS = 500;

/**
 * The gap the packer falls back to when no margin is chosen — a mirror of
 * `GAP` in arrange-core's `runArrange`. Fill Sheet's capacity math has to
 * assume the same spacing the packer will actually use, or the copy count
 * and the packing disagree.
 */
const ARRANGE_DEFAULT_GAP = 0.25;

/**
 * The design Fill Sheet clones: the selected one, else the smallest on the
 * sheet — the smallest is the one most likely to squeeze into leftover gaps.
 */
function pickFillReference(designs: DesignItem[], selectedDesignId: string | null): DesignItem | null {
  if (designs.length === 0) return null;
  if (selectedDesignId) {
    const selected = designs.find(d => d.id === selectedDesignId);
    if (selected) return selected;
  }
  return designs.reduce((a, b) =>
    a.widthInches * a.transform.s * getEffectiveHeight(a) <=
    b.widthInches * b.transform.s * getEffectiveHeight(b) ? a : b
  );
}

/**
 * How many copies of `ref` Fill Sheet should add: exact grid capacity of the
 * sheet in whichever orientation holds more, minus an area-weighted estimate
 * of the slots existing designs consume, plus a 5% overshoot. Deliberately
 * optimistic — the packer beats a naive grid often enough that undercounting
 * leaves visible empty strips, while extra copies cost nothing because the
 * arrange that follows deletes overflowing fill copies (`trimOverflow`).
 */
function computeFillCount(
  ref: DesignItem,
  designs: DesignItem[],
  gap: number,
  sheetW: number,
  sheetH: number,
): number {
  const rw = ref.widthInches * ref.transform.s;
  const rh = getEffectiveHeight(ref);
  const g = Math.max(0, gap);
  if (!(rw > 0) || !(rh > 0) || !(sheetW > 0) || !(sheetH > 0)) return 0;
  const colsN = Math.floor((sheetW + g) / (rw + g));
  const rowsN = Math.floor((sheetH + g) / (rh + g));
  let totalCapacity = colsN * rowsN;
  // Non-square designs may pack better rotated 90°.
  if (Math.abs(rw - rh) > 0.01) {
    const colsR = Math.floor((sheetW + g) / (rh + g));
    const rowsR = Math.floor((sheetH + g) / (rw + g));
    totalCapacity = Math.max(totalCapacity, colsR * rowsR);
  }
  if (totalCapacity <= 0) return 0;
  const refCellArea = (rw + g) * (rh + g);
  const consumedSlots = designs.reduce((acc, d) => {
    const dw = d.widthInches * d.transform.s;
    const dh = getEffectiveHeight(d);
    return acc + ((dw + g) * (dh + g)) / refCellArea;
  }, 0);
  return Math.max(0, Math.round((totalCapacity - consumedSlots) * 1.05) + 1);
}

/**
 * Collapses designs into the rectangles the packer should reason about: one per ungrouped
 * design, and one covering the whole bounding box of each user-defined group.
 *
 * `usableW`/`usableH` are the dimensions the designs' normalised transforms are relative to.
 */
function toPackRects(
  designs: DesignItem[],
  usableW: number,
  usableH: number,
  maskFor: (d: DesignItem) => NestMask | undefined,
): Array<{ id: string; x: number; y: number; w: number; h: number; rotation: number; mask?: NestMask; isGroup: boolean }> {
  const solo: Array<{ id: string; x: number; y: number; w: number; h: number; rotation: number; mask?: NestMask; isGroup: boolean }> = [];
  const groups = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
  for (const d of designs) {
    const bounds = getRotatedBounds(d);
    const cx = d.transform.nx * usableW;
    const cy = d.transform.ny * usableH;
    const minX = cx + bounds.minX, maxX = cx + bounds.maxX;
    const minY = cy + bounds.minY, maxY = cy + bounds.maxY;
    if (!d.groupId) {
      solo.push({
        id: d.id, x: minX, y: minY, w: maxX - minX, h: maxY - minY,
        rotation: d.transform.rotation, mask: maskFor(d), isGroup: false,
      });
      continue;
    }
    const g = groups.get(d.groupId);
    if (g) {
      if (minX < g.minX) g.minX = minX;
      if (minY < g.minY) g.minY = minY;
      if (maxX > g.maxX) g.maxX = maxX;
      if (maxY > g.maxY) g.maxY = maxY;
    } else {
      groups.set(d.groupId, { minX, minY, maxX, maxY });
    }
  }
  return [
    ...solo,
    // No mask, so the group reserves its whole bounding box. The gaps a customer left
    // between members are part of the arrangement they built, not room to fill.
    ...Array.from(groups.entries()).map(([gid, g]) => ({
      id: `${GROUP_PREFIX}${gid}`,
      x: g.minX, y: g.minY, w: g.maxX - g.minX, h: g.maxY - g.minY,
      rotation: 0, mask: undefined, isGroup: true,
    })),
  ];
}

export function useImageEditorModelArrangeKeyboard(bag: ImageEditorBagAfterDesign) {
  // Only the bag fields this hook's arrange/keyboard/artboard logic actually uses are
  // destructured here; the full bag is still re-spread into the return so downstream
  // consumers are unaffected.
  const {
    profile,
    initialHeight,
    initialGangsheetHeights,
    isEditMode,
    shrinkSheetToFitRef,
    manualHeightFloorRef,
    toast,
    t,
    lang,
    imageInfo,
    setImageInfo,
    setResizeSettings,
    artboardWidth,
    setArtboardWidth,
    artboardHeight,
    setArtboardHeight,
    artboardWidthRef,
    artboardHeightRef,
    contentFillCacheRef,
    handleAutoArrangeRef,
    beginArrangeRef,
    designGap,
    setDesignTransform,
    designs,
    setDesigns,
    selectedDesignId,
    setSelectedDesignId,
    selectedDesignIds,
    setSelectedDesignIds,
    mountedRef,
    designsRef,
    ensureDesignImagesAvailable,
    nudgeSnapshotSavedRef,
    nudgeTimeoutRef,
    saveSnapshot,
    handleUndo,
    handleRedo,
    handleDuplicateDesign,
    handleDuplicateSelected,
    handleCopySelected,
    handlePaste,
    handleDeleteDesign,
    handleDeleteMulti,
    handleRotate90,
    handleGroupSelected,
    handleUngroupSelected,
  } = bag;
  // Atomic single-select action from the Zustand store. We reach into
  // the store directly (rather than routing through
  // `useImageEditorModelStateDesign`'s `handleSelectDesign`) because
  // `handleSelectDesign` auto-expands to group members — the wrong
  // behaviour for `applyImageDirectly`, which needs to select *only*
  // the newly-created design and stomp any stale ids from a prior
  // group selection.
  const { selectOne } = useSelectionActions();
  const handleArtboardResizeRef = useRef<(newWidth: number, newHeight: number, opts?: { skipSnapshot?: boolean }) => void>(() => {});
  /** How many rungs the arrange currently in flight has already climbed. */
  const ladderStepRef = useRef(0);
  /** Armed by an expansion so the next arrange knows it is a continuation, not a new one. */
  const ladderChainRef = useRef(false);

  /**
   * Arrange runs one at a time.
   *
   * Every duplicate, copy-count change and resize schedules its own arrange, and a pack of
   * a full sheet takes long enough that a customer clicking "+" a few times in a second
   * used to have several in flight at once. They all shared one worker, so they came back
   * in whatever order they finished, and each result only carried placements for the
   * designs that existed when it was posted. An older result landing last therefore shoved
   * designs back to where they were *and* left every copy made in the meantime sitting on
   * top of its original — the "arrange is thinking a step behind" report.
   *
   * So: while a run is in flight, a new request does not start a second pack, it just
   * records that another run is wanted. Whatever asked last wins, and it packs the design
   * list as it stands when it finally runs, which is the layout the customer was going to
   * get anyway. Bursts of clicks now cost two packs rather than one per click.
   */
  const arrangeInFlightRef = useRef(false);
  /**
   * What the sheet is busy doing, for the indicator over the preview. `null` when idle.
   *
   * This mirrors `arrangeInFlightRef` rather than replacing it. The lock has to be read and
   * written synchronously within a single call, which state cannot do, and the indicator has
   * to cause a render, which a ref cannot do.
   *
   * It deliberately stays set across the height ladder. Growing the sheet is several packs
   * with a paint between each, and reporting them separately is what makes one operation look
   * like the editor stuttering three times.
   */
  const [arrangeStage, setArrangeStage] = useState<'nesting' | 'expanding' | null>(null);
  /**
   * Bumped whenever an arrange commits new positions.
   *
   * The preview animates designs into their new places, and to do that it needs to know the
   * move came from an arrange rather than from a drag it was already following frame by
   * frame. A counter says that unambiguously; diffing the design list could not tell the two
   * apart.
   */
  const [arrangeEpoch, setArrangeEpoch] = useState(0);
  /** Bumped per externally-requested arrange, so a stale result can be recognised and dropped. */
  const arrangeGenerationRef = useRef(0);
  type ArrangeOpts = {
    skipSnapshot?: boolean;
    preserveSelection?: boolean;
    arrangeAll?: boolean;
    fullRepack?: boolean;
    /** Delete overflowing designs listed in `fillIds` instead of growing the sheet for them. */
    trimOverflow?: boolean;
    /** Ids of expendable Fill Sheet copies — the only designs `trimOverflow` may delete. */
    fillIds?: Set<string>;
    /** Internal: a ladder step continuing the run that is already in flight. */
    continuation?: boolean;
  };
  const pendingArrangeRef = useRef<ArrangeOpts | null>(null);
  /**
   * Fold a superseded request into the one already waiting. Work flags are unioned so a
   * coalesced burst never does *less* than the requests it stands in for; `skipSnapshot`
   * is intersected, because a request that wanted an undo point never got to take one.
   */
  const mergeArrangeOpts = (a: ArrangeOpts | null, b: ArrangeOpts | undefined): ArrangeOpts => ({
    skipSnapshot: (a?.skipSnapshot ?? true) && (b?.skipSnapshot ?? false),
    preserveSelection: (a?.preserveSelection ?? false) || (b?.preserveSelection ?? false),
    arrangeAll: (a?.arrangeAll ?? false) || (b?.arrangeAll ?? false),
    fullRepack: (a?.fullRepack ?? false) || (b?.fullRepack ?? false),
    trimOverflow: (a?.trimOverflow ?? false) || (b?.trimOverflow ?? false),
    // Unioned like the work flags: every copy both requests marked as
    // expendable stays expendable, or a coalesced fill would leak
    // untrimmable overflow copies onto the sheet.
    fillIds: a?.fillIds || b?.fillIds
      ? new Set([...(a?.fillIds ?? []), ...(b?.fillIds ?? [])])
      : undefined,
  });
  /**
   * Release the lock and start whatever queued up behind the run that just finished.
   *
   * Every way out of an arrange has to reach this, including the guards that bail before
   * any packing happens — a ladder step that finds the sheet emptied under it would
   * otherwise hold the lock forever and the editor would never arrange again. Safe to call
   * when the lock is already clear, which is what makes it usable from those guards without
   * each one having to know whether this call was the one that took it.
   */
  /**
   * How long the veil waits for an arrange to actually start before giving up on it.
   *
   * `beginArrange` is called by whoever is about to commit designs, a frame or two ahead of the
   * pack itself, so for that gap nothing holds the arrange lock. If the pack then never arrives —
   * a caller that bailed after committing, a throw between the two — the veil would stay over the
   * preview for the rest of the session with no way for the customer to clear it.
   */
  const ARRANGE_START_GRACE_MS = 2000;
  const arrangeStartWatchdogRef = useRef<number | null>(null);

  /**
   * Raise the busy veil now, for work whose designs are about to be committed.
   *
   * Separate from taking the arrange lock: the lock serialises packs, and taking it here would
   * make the pack that follows look like a competing request and queue it behind itself.
   */
  const beginArrange = useCallback(() => {
    setArrangeStage(stage => stage ?? 'nesting');
    if (arrangeStartWatchdogRef.current != null) window.clearTimeout(arrangeStartWatchdogRef.current);
    arrangeStartWatchdogRef.current = window.setTimeout(() => {
      arrangeStartWatchdogRef.current = null;
      if (!mountedRef.current) return;
      if (arrangeInFlightRef.current || pendingArrangeRef.current) return;
      setArrangeStage(null);
    }, ARRANGE_START_GRACE_MS);
  }, []);
  useEffect(() => () => {
    if (arrangeStartWatchdogRef.current != null) window.clearTimeout(arrangeStartWatchdogRef.current);
  }, []);

  const settleArrange = () => {
    arrangeInFlightRef.current = false;
    const next = pendingArrangeRef.current;
    pendingArrangeRef.current = null;
    // Only report idle when nothing is queued, or a burst of clicks would flash the
    // indicator off and straight back on between the packs it coalesced into.
    setArrangeStage(next ? 'nesting' : null);
    if (next) setTimeout(() => handleAutoArrangeRef.current(next), 0);
  };

  const getAlignDelta = useCallback((corner: 'tl' | 'tr' | 'bl' | 'br') => {
    const ids = selectedDesignIds.size > 0
      ? selectedDesignIds
      : (selectedDesignId ? new Set([selectedDesignId]) : new Set<string>());
    const bounds = getDesignSelectionBounds(
      designsRef.current,
      ids,
      artboardWidth,
      artboardHeight,
    );
    if (!bounds) return null;
    const targetX = corner.endsWith('l') ? 0 : artboardWidth;
    const targetY = corner.startsWith('t') ? 0 : artboardHeight;
    const currentX = corner.endsWith('l') ? bounds.minX : bounds.maxX;
    const currentY = corner.startsWith('t') ? bounds.minY : bounds.maxY;
    return {
      dnx: (targetX - currentX) / artboardWidth,
      dny: (targetY - currentY) / artboardHeight,
    };
  }, [selectedDesignId, selectedDesignIds, artboardWidth, artboardHeight]);

  const GANGSHEET_HEIGHTS = useMemo(() => {
    // Height lists can arrive from Shopify variants in arbitrary order
    // (variant position / alphabetical). `find(h => h > current)` and
    // `GANGSHEET_HEIGHTS[length - 1]` (MAX) both require ascending numeric
    // order — an unsorted list makes "add one copy" jump 12" straight to
    // the largest size instead of the next one up.
    if (initialGangsheetHeights && initialGangsheetHeights.length > 0) {
      return Array.from(new Set(initialGangsheetHeights)).sort((a, b) => a - b);
    }
    const base = profile.gangsheetHeights;
    const merged = !initialHeight || base.includes(initialHeight) ? base : [...base, initialHeight];
    return Array.from(new Set(merged)).sort((a, b) => a - b);
  }, [profile.gangsheetHeights, initialHeight, initialGangsheetHeights]);
  const MAX_ARTBOARD_HEIGHT = GANGSHEET_HEIGHTS[GANGSHEET_HEIGHTS.length - 1];

  const handleAlignCorner = useCallback((corner: 'tl' | 'tr' | 'bl' | 'br') => {
    const ids = selectedDesignIds.size > 0
      ? selectedDesignIds
      : (selectedDesignId ? new Set([selectedDesignId]) : new Set<string>());
    const delta = getAlignDelta(corner);
    if (!delta) return;
    saveSnapshot();
    const units = getDesignSelectionUnits(
      designsRef.current,
      ids,
      artboardWidth,
      artboardHeight,
    );
    const memberIds = new Set(units.flatMap(unit => unit.members.map(member => member.id)));
    setDesigns(prev => prev.map(d => memberIds.has(d.id)
      ? {
          ...d,
          transform: {
            ...d.transform,
            nx: d.transform.nx + delta.dnx,
            ny: d.transform.ny + delta.dny,
          },
        }
      : d
    ));
    if (selectedDesignId) {
      setDesignTransform(prev => ({
        ...prev,
        nx: prev.nx + delta.dnx,
        ny: prev.ny + delta.dny,
      }));
    }
  }, [
    selectedDesignId,
    selectedDesignIds,
    saveSnapshot,
    getAlignDelta,
    artboardWidth,
    artboardHeight,
  ]);

  const handleAutoArrange = useCallback((opts?: {
    skipSnapshot?: boolean;
    preserveSelection?: boolean;
    /** Ignore multi-selection and pack every design on the sheet. */
    arrangeAll?: boolean;
    /**
     * Pack from scratch and accept the best layout even if that relocates settled designs.
     * Set this only when the user explicitly asked to re-arrange; leave it off for the
     * arranges that happen as a side effect of adding or duplicating a design, where
     * moving everything else is the behaviour users complain about.
     */
    fullRepack?: boolean;
    /** Delete overflowing designs listed in `fillIds` instead of growing the sheet for them. */
    trimOverflow?: boolean;
    /** Ids of expendable Fill Sheet copies — the only designs `trimOverflow` may delete. */
    fillIds?: Set<string>;
    /** Internal: a ladder step continuing the run that is already in flight. */
    continuation?: boolean;
  }) => {
    const currentDesigns = designsRef.current;
    if (currentDesigns.length === 0) {
      console.warn('[autoArrange] no designs');
      // Only does anything for a ladder step that arrives to find the sheet cleared; a
      // fresh call has not taken the lock yet and this is a no-op.
      settleArrange();
      return;
    }
    if (currentDesigns.some(d =>
      !d.imageInfo?.image?.complete ||
      !(d.imageInfo.image.naturalWidth || d.imageInfo.image.width) ||
      !d.imageInfo.file ||
      d.imageInfo.file.size <= 0
    )) {
      void ensureDesignImagesAvailable(currentDesigns).then(repairedDesigns => {
        const hasInvalidImage = repairedDesigns.some(d =>
          !d.imageInfo?.image?.complete ||
          !(d.imageInfo.image.naturalWidth || d.imageInfo.image.width) ||
          !d.imageInfo.file ||
          d.imageInfo.file.size <= 0
        );
        if (hasInvalidImage) {
          toast({
            title: t("toast.arrangeUnavailable"),
            description: "Your progress is saved, but one design could not be reloaded. Please recover the draft and try again.",
            variant: "destructive",
          });
          settleArrange();
          return;
        }
        handleAutoArrangeRef.current(opts);
      }).catch(error => {
        console.warn("[autoArrange] image rehydration failed", error);
        settleArrange();
        toast({
          title: t("toast.arrangeUnavailable"),
          description: "Your progress is saved, but one design could not be reloaded. Please recover the draft and try again.",
          variant: "destructive",
        });
      });
      return;
    }
    // A ladder step is the same logical arrange continuing, so it runs straight through;
    // anything else queues behind whatever is already packing. See `arrangeInFlightRef`.
    if (!opts?.continuation) {
      if (arrangeInFlightRef.current) {
        pendingArrangeRef.current = mergeArrangeOpts(pendingArrangeRef.current, opts);
        return;
      }
      arrangeInFlightRef.current = true;
      arrangeGenerationRef.current++;
      setArrangeStage('nesting');
    }
    const generation = arrangeGenerationRef.current;

    // Claim this entry's place in the expansion chain. The step count cannot ride in `opts`
    // because the type of `handleAutoArrangeRef` is declared with the rest of the editor
    // state, so it travels in a ref that the recursion arms and the next entry consumes.
    // Anything the user starts themselves finds the flag clear and begins a fresh chain.
    const ladderStep = ladderChainRef.current ? ladderStepRef.current : 0;
    ladderChainRef.current = false;
    ladderStepRef.current = ladderStep;

    if (!opts?.skipSnapshot) saveSnapshot();

    const usableW = artboardWidthRef.current;
    const usableH = artboardHeightRef.current;

    const arrangeSelection = !opts?.arrangeAll && selectedDesignIds.size >= 2;
    const designsToArrange = arrangeSelection
      ? currentDesigns.filter(d => selectedDesignIds.has(d.id))
      : currentDesigns;

    if (designsToArrange.length === 1 && !arrangeSelection) {
      const d = currentDesigns[0];
      setDesigns([{ ...d, transform: { ...d.transform, nx: DEFAULT_LAYER_CENTER_NX, ny: DEFAULT_LAYER_CENTER_NY } }]);
      if (!opts?.preserveSelection) {
        setSelectedDesignId(null);
        setSelectedDesignIds(new Set());
      }
      // One design left on a sheet sized for many is the clearest case of paying for blank film.
      setTimeout(() => shrinkSheetToFitRef.current(), 0);
      settleArrange();
      return;
    }

    if (designsToArrange.length < 2) { settleArrange(); return; }

    const fillCache = contentFillCacheRef.current;
    /**
     * Ink coverage, taken from the design's nesting silhouette so the artwork is only
     * rasterised once per design rather than separately for packing and for sorting. The
     * coarse 64x64 sample is kept as a fallback for artwork the silhouette pass cannot read,
     * such as a cross-origin image that taints a canvas.
     */
    const getContentFill = (d: DesignItem): number => {
      const key = d.imageInfo.image.src;
      const cached = fillCache.get(key);
      if (cached !== undefined) return cached;
      const img = d.imageInfo.image;
      let fill = 1.0;
      const silhouette = getDesignNestMask({
        image: img,
        artW: d.widthInches * d.transform.s,
        artH: d.heightInches * d.transform.s,
        labelName: d.printFileName ? d.name : undefined,
        flipX: d.transform.flipX,
        flipY: d.transform.flipY,
        sourceKey: img.src,
      });
      if (silhouette) {
        fillCache.set(key, silhouette.inkRatio);
        return silhouette.inkRatio;
      }
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

    // Group-aware item construction.
    //
    // A `DesignItem.groupId` marks user-defined groups (see types.ts).
    // Auto-arrange treats each group as a single "super-item" so the
    // packer preserves the intra-group layout while still packing the
    // group as a unit against the rest of the sheet.
    //
    // Super-item id convention: `group:${groupId}`. Post-processing keys
    // off this prefix to map the returned placement back to every group
    // member and apply the same translation delta.
    //
    // Super-items are passed with rotation 0 and marked `noRotate`, because the only thing
    // `applyResult` can do with a group's placement is translate its members — their
    // individual rotations are preserved, matching what multi-drag already does. Letting the
    // packer turn a super-item and then dropping that rotation, which is what used to
    // happen, reserved an h-by-w slot for a group that arrived w-by-h: any group whose
    // bounding box was not square overflowed its slot and overlapped its neighbour.
    type GroupBBox = {
      minX: number; minY: number; maxX: number; maxY: number;
      members: DesignItem[];
    };
    const groups = new Map<string, GroupBBox>();
    const nonGrouped: DesignItem[] = [];
    for (const d of designsToArrange) {
      if (d.groupId) {
        const t = d.transform;
        const bounds = getRotatedBounds(d);
        const cx = t.nx * usableW;
        const cy = t.ny * usableH;
        const minX = cx + bounds.minX, maxX = cx + bounds.maxX;
        const minY = cy + bounds.minY, maxY = cy + bounds.maxY;
        const g = groups.get(d.groupId);
        if (g) {
          if (minX < g.minX) g.minX = minX;
          if (minY < g.minY) g.minY = minY;
          if (maxX > g.maxX) g.maxX = maxX;
          if (maxY > g.maxY) g.maxY = maxY;
          g.members.push(d);
        } else {
          groups.set(d.groupId, { minX, minY, maxX, maxY, members: [d] });
        }
      } else {
        nonGrouped.push(d);
      }
    }

    const items = [
      ...nonGrouped.map(d => ({
        id: d.id,
        w: d.widthInches * d.transform.s,
        h: getEffectiveHeight(d),
        fill: getContentFill(d),
        // Lets the bitmap nester compete with the rectangle packers for this design. A
        // group has no single silhouette, so super-items below stay rectangles.
        mask: getDesignNestSilhouette(d),
      })),
      ...Array.from(groups.entries()).map(([gid, g]) => ({
        id: `${GROUP_PREFIX}${gid}`,
        w: g.maxX - g.minX,
        h: g.maxY - g.minY,
        // Fill=1.0 keeps groups from being treated as sparse; empty regions
        // between group members are intentional and shouldn't invite the
        // packer to slot other items in.
        fill: 1.0,
        // The group is put back on its members as a translation, so a rotation chosen here
        // could not be carried out — see the note above `GROUP_PREFIX`.
        noRotate: true,
      })),
    ];

    const fixedRects = arrangeSelection
      ? currentDesigns.filter(d => !selectedDesignIds.has(d.id)).map(d => {
          const t = d.transform;
          const bounds = getRotatedBounds(d);
          const cx = t.nx * usableW;
          const cy = t.ny * usableH;
          return {
            x: cx + bounds.minX,
            y: cy + bounds.minY,
            w: bounds.maxX - bounds.minX,
            h: bounds.maxY - bounds.minY,
            mask: getDesignNestSilhouette(d),
            rotation: t.rotation,
          };
        })
      : undefined;

    // Where everything sits right now, in the same top-left inch space the packer uses, so
    // it can offer a layout that leaves already-settled designs where they are.
    const currentRects = [
      ...nonGrouped.map(d => {
        const bounds = getRotatedBounds(d);
        const cx = d.transform.nx * usableW;
        const cy = d.transform.ny * usableH;
        return {
          id: d.id,
          x: cx + bounds.minX,
          y: cy + bounds.minY,
          w: bounds.maxX - bounds.minX,
          h: bounds.maxY - bounds.minY,
          rotation: d.transform.rotation,
        };
      }),
      ...Array.from(groups.entries()).map(([gid, g]) => ({
        id: `${GROUP_PREFIX}${gid}`,
        x: g.minX,
        y: g.minY,
        w: g.maxX - g.minX,
        h: g.maxY - g.minY,
        rotation: 0,
      })),
    ];
    const preferStable = !opts?.fullRepack;

    type PlacedItem = { id: string; nx: number; ny: number; rotation: number; overflows: boolean; anchored?: boolean };

    /**
     * What the pack cost, as reported by whichever of the worker or the fallback ran it.
     * `minRequiredHeight` is the load-bearing one: a height below which no arrangement of
     * this artwork exists, which is what lets the expansion below skip rungs.
     */
    type PackSizing = { packedExtent?: number; minRequiredHeight?: number };

    // Each step strictly increases the height and the ladder is finite, so the expansion
    // terminates on its own. The cap is here because the loop reads the height back through
    // a ref, and a render that never lands would leave that ref stale and the recursion
    // spinning. One step per rung, plus slack for the initial pack.
    const maxLadderSteps = GANGSHEET_HEIGHTS.length + 2;

    const applyResult = (bestResult: PlacedItem[], anyRotated: boolean, hasOverflow: boolean, sizing?: PackSizing) => {
      // Fill Sheet deliberately overshoots its copy count and lets this trim
      // settle the difference: copies the packer could not fit are deleted
      // here, before overflow can grow the sheet or raise the "no space"
      // toast. Only ids in `fillIds` are expendable — designs the customer
      // placed are never deleted, so if one of *them* still overflows after
      // the trim, the ordinary growth/toast path below handles it. Group
      // super-items never match: fill copies are always created groupless.
      if (opts?.trimOverflow && opts.fillIds && opts.fillIds.size > 0 && hasOverflow) {
        const fillIds = opts.fillIds;
        const removeIds = new Set(
          bestResult
            .filter(p => p.overflows && !p.anchored && fillIds.has(p.id))
            .map(p => p.id),
        );
        if (removeIds.size > 0) {
          setDesigns(prev => prev.filter(d => !removeIds.has(d.id)));
          bestResult = bestResult.filter(p => !removeIds.has(p.id));
          hasOverflow = bestResult.some(p => p.overflows);
        }
      }
      if (hasOverflow && artboardHeightRef.current < MAX_ARTBOARD_HEIGHT && ladderStep < maxLadderSteps) {
        // Jump to the shortest rung the artwork could possibly fit on rather than the next
        // one up. `planLadderJump` only skips rungs a lower bound rules out, so it lands on
        // the same rung the one-at-a-time walk would have reached — and when the bound says
        // nothing useful it returns exactly that next rung, so this degrades into the old
        // behaviour instead of failing.
        const nextHeight = planLadderJump({
          currentHeight: artboardHeightRef.current,
          minRequiredHeight: sizing?.minRequiredHeight ?? 0,
          heights: GANGSHEET_HEIGHTS,
        }) ?? MAX_ARTBOARD_HEIGHT;
        // Only the first growth of an arrange records an undo point. The rest are steps of
        // one operation as far as the customer is concerned, and each one snapshotting is
        // what made a single Auto-Arrange take nine presses of Ctrl+Z to undo.
        //
        // And when the *caller* already snapshotted — duplicate, copy-count, Fill Sheet
        // all snapshot once and then arrange with `skipSnapshot` — even the first growth
        // stays silent, or one Ctrl+Z after a fill would stop at a half-grown sheet with
        // the copies still on it instead of restoring the pre-fill state.
        handleArtboardResizeRef.current(artboardWidthRef.current, nextHeight, { skipSnapshot: ladderStep > 0 || !!opts?.skipSnapshot });
        // Forward the caller's `arrangeAll` flag on the expansion recursion.
        //
        // Without this, the caller's `arrangeAll: true` (set by
        // `handleSetGroupCount` when copies are added via the layer "+N"
        // control, and by `handleEffectiveSizeChange` when a resize
        // grows the sheet) is silently dropped on the recursive call.
        // Because `selectedDesignIds.size >= 2` after +N copies —
        // `handleSetGroupCount` puts every row member into the
        // selection — the recursive `handleAutoArrange` re-enters in
        // `arrangeSelection` mode: it treats the *non*-selected
        // designs as fixed obstacles and only re-packs the selected
        // copies around them. Those obstacles were placed on the old
        // (smaller) sheet, so on the newly-expanded sheet they leave
        // weird gaps that the selected copies rarely fit into — hasOverflow
        // stays true, the sheet grows to the next height, the same
        // logic recurses, and the sheet walks all the way up
        // `GANGSHEET_HEIGHTS` to `MAX_ARTBOARD_HEIGHT`, exactly what
        // users report as "adding one copy exploded the gangsheet to
        // 340""." Forwarding `arrangeAll` keeps the re-pack in
        // whole-sheet mode when the caller asked for it, so the
        // expansion loop converges as soon as everything fits (or hits
        // MAX with a real, non-phantom overflow).
        ladderStepRef.current = ladderStep + 1;
        ladderChainRef.current = true;
        setArrangeStage('expanding');
        setTimeout(() => handleAutoArrangeRef.current({
          skipSnapshot: true,
          preserveSelection: true,
          arrangeAll: opts?.arrangeAll,
          fullRepack: opts?.fullRepack,
          // Trim intent rides the whole ladder: a rung that re-packs on the
          // taller sheet can overflow a copy that fit before, and that copy
          // must stay deletable rather than force yet another rung.
          trimOverflow: opts?.trimOverflow,
          fillIds: opts?.fillIds,
          // Keeps the lock held across the climb: a rung is part of this arrange, not a
          // competing one, and releasing here would let a queued request interleave with
          // a half-finished expansion.
          continuation: true,
        }), 0);
        return;
      }
      if (hasOverflow) {
        toast({ title: t("toast.noSpace"), description: t("toast.noSpaceDesc"), variant: "destructive" });
      } else if (anyRotated) {
        toast({ title: t("toast.autoArranged"), description: t("toast.autoArrangedDesc") });
      }
      const abW = artboardWidthRef.current;
      const abH = artboardHeightRef.current;

      // Build a per-design delta map from the worker's placements.
      // Non-grouped: identify by exact id, adopt the worker's rotation.
      // Grouped   : identify via the `group:` prefix, adopt only the
      //             translation delta so intra-group layout survives.
      type DesignDelta = {
        nx: number;
        ny: number;
        rotation: number | null; // null → keep the design's current rotation
        overflows: boolean;
        /** The packer kept this where it was; leave the design object alone entirely. */
        anchored?: boolean;
      };
      const deltas = new Map<string, DesignDelta>();
      for (const placed of bestResult) {
        if (placed.anchored) {
          // Deliberately not re-deriving nx/ny from the packer's rounded normalised
          // values, and not applying the stamp offset below: an anchored design must come
          // out of an arrange bit-for-bit unmoved, or repeated arranges walk it across the
          // sheet a hundredth of an inch at a time.
          continue;
        }
        if (placed.id.startsWith(GROUP_PREFIX)) {
          const gid = placed.id.slice(GROUP_PREFIX.length);
          const g = groups.get(gid);
          if (!g) continue;
          // Worker returns the *center* of the super-item's bounding box
          // in normalised coords. Compute the delta between the group's
          // old and new bbox centers in normalised space, then shift
          // every member by that delta. `noRotate` on the super-item means the returned
          // placement is always rotation 0, so a pure translation reproduces exactly the
          // footprint the packer reserved.
          const oldCx = (g.minX + g.maxX) / 2;
          const oldCy = (g.minY + g.maxY) / 2;
          const newCx = placed.nx * abW;
          const newCy = placed.ny * abH;
          const dnx = (newCx - oldCx) / abW;
          const dny = (newCy - oldCy) / abH;
          for (const m of g.members) {
            deltas.set(m.id, {
              nx: m.transform.nx + dnx,
              ny: m.transform.ny + dny,
              rotation: null,
              overflows: placed.overflows,
            });
          }
        } else {
          deltas.set(placed.id, {
            nx: placed.nx,
            ny: placed.ny,
            rotation: placed.rotation,
            overflows: placed.overflows,
          });
        }
      }

      setDesigns(prev => prev.map(d => {
        const delta = deltas.get(d.id);
        if (!delta) return d;
        const finalRotation = delta.rotation === null
          ? d.transform.rotation
          : delta.rotation % 360;
        const stampExtra = getStampExtra(d);
        let adjustedNx = delta.nx;
        let adjustedNy = delta.ny;
        if (stampExtra > 0 && delta.rotation !== null) {
          // Stamp-extra offset only makes sense when the packer chose the
          // rotation. For group members (rotation preserved), skip it —
          // the design's current position already accounts for its stamp.
          const rad = (finalRotation * Math.PI) / 180;
          adjustedNx -= (stampExtra / 2) * Math.sin(rad) / abW;
          adjustedNy -= (stampExtra / 2) * Math.cos(rad) / abH;
        }
        const newTransform = { ...d.transform, nx: adjustedNx, ny: adjustedNy, rotation: finalRotation };
        const { nx, ny } = clampDesignToArtboard({ ...d, transform: newTransform }, abW, abH);
        return { ...d, transform: { ...newTransform, nx, ny } };
      }));
      // Let the preview slide the designs into place. An arrange where every design was
      // anchored produced no deltas and moved nothing, so there is nothing to animate.
      if (deltas.size > 0) setArrangeEpoch(e => e + 1);
      if (!opts?.preserveSelection) {
        setSelectedDesignId(null);
        setSelectedDesignIds(new Set());
      }
      // Packing tighter — a smaller margin, fewer copies, a deleted design — can free up
      // whole sizes worth of film. Deferred so it measures the layout we just committed
      // rather than the one it replaced. Never snapshots: whatever asked for this arrange
      // already did, so one undo takes the arrange and the resize back together.
      if (!hasOverflow) setTimeout(() => shrinkSheetToFitRef.current(), 0);
      settleArrange();
    };

    const worker = getArrangeWorker();
    if (fixedRects && fixedRects.length > 0 && !worker) {
      toast({ title: t("toast.arrangeUnavailable"), description: t("toast.arrangeUnavailableDesc"), variant: "destructive" });
      settleArrange();
      return;
    }
    if (worker) {
      const requestId = nextArrangeRequestId();
      let settled = false;
      const cleanup = () => { worker.removeEventListener('message', handler); clearTimeout(timer); };
      const handler = (e: MessageEvent) => {
        if (e.data.requestId !== requestId) return;
        if (settled) return;
        settled = true;
        cleanup();
        if (!mountedRef.current) return;
        // A result from a superseded run would undo placements the current one has already
        // made, and would carry nothing at all for designs added since it was posted.
        //
        // Dropping it still has to release the lock. This is not reachable today, because the
        // generation only advances when a run takes a lock nobody was holding — but
        // `settleArrange` is documented as being on every way out of an arrange, and a return
        // that kept the lock would stop the editor arranging again for the rest of the
        // session. The unmount check above needs no such treatment: there is nothing left to
        // release once the hook is gone.
        if (generation !== arrangeGenerationRef.current) { settleArrange(); return; }
        if (e.data.type === 'error') {
          console.warn('[autoArrange] worker error:', e.data.error);
          toast({ title: "Arrange failed", variant: "destructive" });
          settleArrange();
          return;
        }
        const bestResult: PlacedItem[] = e.data.result;
        const anyRotated = bestResult.some(p => p.rotation !== 0);
        const hasOverflow = bestResult.some(p => p.overflows);
        applyResult(bestResult, anyRotated, hasOverflow, {
          packedExtent: e.data.packedExtent,
          minRequiredHeight: e.data.minRequiredHeight,
        });
      };
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          console.warn('[autoArrange] worker timed out, using fallback');
          // Terminate before packing again here, or the abandoned worker spends the whole
          // fallback competing with it for a CPU that already proved too slow.
          discardArrangeWorker();
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
        current: currentRects,
        preferStable,
        heightSteps: GANGSHEET_HEIGHTS,
      });
    } else {
      runFallbackArrange();
    }

    // Synchronous path for when the worker is unavailable or has timed out. It calls the
    // same `runArrange` the worker does, so the two can no longer drift apart.
    function runFallbackArrange() {
      const { result, packedExtent, minRequiredHeight } = runArrange({
        type: 'arrange',
        requestId: 0,
        items,
        usableW,
        usableH,
        artboardWidth: usableW,
        artboardHeight: usableH,
        isAggressive: true,
        customGap: designGap,
        fixedRects,
        current: currentRects,
        preferStable,
        heightSteps: GANGSHEET_HEIGHTS,
      });
      applyResult(
        result,
        result.some(p => p.rotation !== 0),
        result.some(p => p.overflows),
        { packedExtent, minRequiredHeight },
      );
    }

  }, [selectedDesignIds, saveSnapshot, toast, t, designGap, GANGSHEET_HEIGHTS, MAX_ARTBOARD_HEIGHT, ensureDesignImagesAvailable, handleAutoArrangeRef]);

  /**
   * True from the moment a fill batch is appended until its arrange request
   * has been handed off. Together with `arrangeInFlightRef` this serializes
   * fills: a second batch computed against a design list the first has not
   * finished settling would double-count the remaining capacity (two clicks
   * ≈ 1000 designs), and its copies would not be in the in-flight run's
   * `fillIds` — the packer would treat them as customer originals and grow
   * the sheet for them, which a fill must never do.
   */
  const fillPendingRef = useRef(false);

  /**
   * Whether Fill Sheet has anything to do. Mirrors `handleFillEmptySpace`'s
   * own guards so the button's disabled state and the click behaviour can
   * never disagree.
   */
  const canFill = useMemo(() => {
    if (designs.length === 0 || designs.length >= MAX_FILL_TOTAL_DESIGNS) return false;
    const ref = pickFillReference(designs, selectedDesignId);
    if (!ref) return false;
    const gap = designGap !== undefined && designGap >= 0 ? designGap : ARRANGE_DEFAULT_GAP;
    return computeFillCount(ref, designs, gap, artboardWidth, artboardHeight) >= 1;
  }, [designs, selectedDesignId, designGap, artboardWidth, artboardHeight]);

  /**
   * Fill Sheet: pack the empty film with copies of the reference design.
   *
   * Adds `computeFillCount` clones (stacked at the sheet center — placement
   * is entirely the packer's job) and runs a whole-sheet arrange that may
   * delete whichever of those clones do not fit (`trimOverflow` +
   * `fillIds`). Snapshots once before mutating, so a single undo removes
   * every copy the fill added. Copies follow the duplicate conventions:
   * fresh id, stripped groupId, no filename stamp, " copy" suffix trimmed.
   */
  const handleFillEmptySpace = useCallback(() => {
    // One fill at a time — see `fillPendingRef`. Ignoring the click is safe:
    // the sheet is being packed full this very moment, so there is nothing
    // useful a queued second fill could add.
    if (fillPendingRef.current || arrangeInFlightRef.current) return;
    const currentDesigns = designsRef.current;
    const ref = pickFillReference(currentDesigns, selectedDesignId);
    if (!ref) return;
    const gap = designGap !== undefined && designGap >= 0 ? designGap : ARRANGE_DEFAULT_GAP;
    const fillCount = Math.min(
      computeFillCount(ref, currentDesigns, gap, artboardWidthRef.current, artboardHeightRef.current),
      Math.max(0, MAX_FILL_TOTAL_DESIGNS - currentDesigns.length),
    );
    if (fillCount < 1) return;
    // See handleDuplicateDesign for rationale — copies strip the source's
    // groupId to remain independent (and so the packer never sees them as
    // part of a group super-item, which would defeat the overflow trim).
    const { groupId: _dropGid, ...refNoGroup } = ref;
    const baseName = ref.name.replace(/ copy( \d+)?$/, '');
    const copies: DesignItem[] = Array.from({ length: fillCount }, () => ({
      ...refNoGroup,
      id: crypto.randomUUID(),
      name: baseName,
      transform: { ...ref.transform, nx: 0.5, ny: 0.5 },
    }));
    fillPendingRef.current = true;
    saveSnapshot();
    setDesigns(prev => [...prev, ...copies]);
    requestAnimationFrame(() => {
      // Cleared before the hand-off: from here `arrangeInFlightRef` takes
      // over as the gate, and clearing first means a throw inside arrange
      // cannot leave the fill button dead for the rest of the session.
      fillPendingRef.current = false;
      handleAutoArrangeRef.current({
        skipSnapshot: true,
        // Selection survives for feedback, but `arrangeAll` keeps the packer
        // in whole-sheet mode — selected-only mode treats everything else as
        // fixed obstacles and would stack the new copies into a column.
        preserveSelection: true,
        arrangeAll: true,
        fullRepack: true,
        trimOverflow: true,
        fillIds: new Set(copies.map(c => c.id)),
      });
    });
  }, [selectedDesignId, designGap, saveSnapshot, setDesigns, handleAutoArrangeRef, designsRef, artboardWidthRef, artboardHeightRef]);

  /**
   * `skipSnapshot` is for the expansion path only, where a single Auto-Arrange can grow the
   * sheet more than once and the customer expects one Ctrl+Z to undo the lot. Everything
   * else — the size dropdown above all — must keep recording its own undo point.
   */
  const handleArtboardResize = useCallback((newWidth: number, newHeight: number, opts?: { skipSnapshot?: boolean }) => {
    if (newWidth <= 0 || newHeight <= 0) return;

    if (designs.length === 0) {
      setArtboardWidth(newWidth);
      setArtboardHeight(newHeight);
      return;
    }

    if (!opts?.skipSnapshot) saveSnapshot();
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
  handleArtboardResizeRef.current = handleArtboardResize;

  /**
   * Which purchasable height today's artwork would fit on, for the tick beside that size in
   * the gangsheet size dropdown.
   *
   * Deliberately lags the sheet. Answering it means measuring the *ink* bounds of every
   * design, and each of those is a nest-mask lookup plus corner trigonometry — while
   * `designs` is committed on every pointer move of a multi-select drag. As a plain `useMemo`
   * this recomputed sixty times a second, and it was measurable in a drag profile, all to
   * keep a checkmark current inside a dropdown that is usually closed. Nothing acts on this
   * value automatically (auto-shrink measures the sheet itself), so letting it settle first
   * costs nothing but a beat of staleness in a hint.
   */
  const [recommendedArtboardHeight, setRecommendedArtboardHeight] = useState<number | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      setRecommendedArtboardHeight(
        fitGangsheetHeight(designs, artboardHeight, designGap, GANGSHEET_HEIGHTS)?.height ?? null,
      );
    }, 150);
    return () => clearTimeout(timer);
  }, [designs, artboardHeight, designGap, GANGSHEET_HEIGHTS]);

  /**
   * Resize, then record the pick. Wired to the Gangsheet Size dropdown.
   *
   * The order is the whole point. `handleArtboardResize` pushes an undo snapshot, and that
   * snapshot has to describe the sheet as it was *before* this pick — height and floor
   * together. Setting the floor first put the new value into the old height's snapshot, so
   * undoing the pick returned the sheet to 60" while leaving it pinned at 120".
   *
   * The floor itself lives in `useImageEditorModelStateDesign` alongside the history, which
   * snapshots and restores it; see `manualHeightFloorRef` there for why it is no longer a
   * ref sitting outside undo.
   */
  const handleArtboardHeightPick = useCallback((newHeight: number) => {
    handleArtboardResizeRef.current(artboardWidthRef.current, newHeight);
    manualHeightFloorRef.current = newHeight;
  }, [artboardWidthRef, manualHeightFloorRef]);

  /**
   * Drop the sheet to the smallest purchasable height that still fits the artwork.
   *
   * Deliberately a measure-and-translate, never a re-pack. The current layout already fits
   * inside its own measured band, so sliding that band as a rigid unit onto a shorter sheet is
   * guaranteed to fit — which is what makes this safe to run automatically. Re-packing at the
   * smaller height could overflow instead, and overflow is exactly what triggers expansion, so
   * the two features would sit there growing and shrinking the sheet against each other.
   *
   * For the same reason it cannot go through `handleArtboardResize`: that keeps each design's
   * absolute Y and then clamps designs individually, which on a shrink would pull the artwork
   * apart and pile it against the bottom edge instead of moving the arrangement intact.
   *
   * Being a pure translation also makes it idempotent — the band's height never changes, so a
   * second call finds nothing left to do.
   *
   * It can legitimately land on a height the packer just refused. Expansion fires when the
   * *search* cannot find a layout at a given height, which is not the same as no layout
   * existing; a pack that succeeds at 24" and comes out 11.4" tall genuinely does fit a 12"
   * sheet. Taking that saving is the point of the feature, and it cannot loop, because
   * shrinking moves the artwork without ever asking the packer to run again.
   */
  const shrinkSheetToFit = useCallback((opts?: { snapshot?: boolean }) => {
    // In edit mode the gangsheet size is locked to the variant the customer already bought,
    // so shrinking here would swap that line item for a cheaper one behind their back.
    if (isEditMode) return;
    const currentDesigns = designsRef.current;
    if (currentDesigns.length === 0) return;
    const currentHeight = artboardHeightRef.current;
    const band = getContentInkBandY(currentDesigns, currentHeight);
    if (!band) return;
    // `designGap` is one setting doing duty as two physical quantities: the gap *between*
    // designs, where 0 is a legitimate customer choice, and the margin at the *sheet edge*,
    // where it is not — ink flush to the edge of a DTF sheet is a production risk. Only the
    // sheet-edge reading is floored, and it is named apart from the gap so the distinction
    // survives the next reader. The gap handed to the packer above is left exactly as chosen.
    const sheetEdgeMargin = Math.max(designGap ?? DEFAULT_SHEET_MARGIN, DEFAULT_SHEET_MARGIN);
    const shrink = planSheetShrink({
      band,
      currentHeight,
      margin: sheetEdgeMargin,
      heights: GANGSHEET_HEIGHTS,
      manualFloor: manualHeightFloorRef.current,
    });
    // With no size to be saved the sheet can still be wrong at the top: the packers have no
    // border inset, so an arrange that fits without shrinking leaves its first row flush
    // against the edge. Reseating is the same rigid translation with the height held, so it
    // cannot cost the customer a rung — see `planBandReseat`.
    const plan = shrink ?? (() => {
      const reseat = planBandReseat({ band, currentHeight, margin: sheetEdgeMargin });
      return reseat ? { height: currentHeight, shift: reseat.shift } : null;
    })();
    if (!plan) return;

    if (opts?.snapshot) saveSnapshot();
    // Writes the very array it measured rather than taking `prev`, so the band the new height
    // was derived from and the designs being moved onto it can never be two different things.
    setDesigns(currentDesigns.map(d => ({
      ...d,
      transform: { ...d.transform, ny: (d.transform.ny * currentHeight - plan.shift) / plan.height },
    })));
    if (plan.height !== currentHeight) setArtboardHeight(plan.height);
  }, [isEditMode, designsRef, artboardHeightRef, designGap, GANGSHEET_HEIGHTS, saveSnapshot, setDesigns, setArtboardHeight, manualHeightFloorRef]);
  shrinkSheetToFitRef.current = shrinkSheetToFit;

  /**
   * Slide the artwork clear of the sheet's top edge, holding the height.
   *
   * `shrinkSheetToFit` already does this, but only as the consolation prize when there is
   * no size to be saved, and it only runs from the arrange and delete paths. Import has the
   * same problem and neither of those triggers: placement goes through the packer, the
   * packer seeds its free space at the origin, so the first row of a fresh sheet — or of any
   * sheet with room at the top — lands flush at y=0. That is ink on the edge of a DTF sheet,
   * which is a production risk, and until now it sat there until the customer happened to
   * delete something.
   *
   * Deliberately the re-seat *without* the shrink. An import is not a reason to change the
   * size the customer is buying, and holding the height is also what makes this incapable of
   * costing them a rung: `planBandReseat` is a rigid translation of a band whose height it
   * does not change, and where the sheet is too tight for the full margin at both ends it
   * splits the slack rather than asking for more film. Unlike `shrinkSheetToFit` it is
   * therefore safe in edit mode too, where the height is locked to a purchased variant.
   *
   * Never snapshots. `applyImageDirectly` already recorded one, so the import and the
   * re-seat undo together as the single step the customer thinks they took.
   */
  const reseatSheetBand = useCallback(() => {
    const currentDesigns = designsRef.current;
    if (currentDesigns.length === 0) return;
    const currentHeight = artboardHeightRef.current;
    const band = getContentInkBandY(currentDesigns, currentHeight);
    if (!band) return;
    // Same two-quantities-one-setting distinction `shrinkSheetToFit` makes: the gap handed
    // to the packer is the customer's choice and 0 is legitimate, but the sheet *edge* is
    // floored, and the local is named apart so the difference survives the next reader.
    const sheetEdgeMargin = Math.max(designGap ?? DEFAULT_SHEET_MARGIN, DEFAULT_SHEET_MARGIN);
    const reseat = planBandReseat({ band, currentHeight, margin: sheetEdgeMargin });
    // Null covers the case this must not fight: an import that overflowed leaves the band
    // taller than the sheet, so there is no slack to redistribute and the expansion path is
    // left to grow the sheet on its own.
    if (!reseat) return;
    setDesigns(currentDesigns.map(d => ({
      ...d,
      transform: { ...d.transform, ny: (d.transform.ny * currentHeight - reseat.shift) / currentHeight },
    })));
  }, [designsRef, artboardHeightRef, designGap, setDesigns]);
  const reseatSheetBandRef = useRef(reseatSheetBand);
  reseatSheetBandRef.current = reseatSheetBand;

  const importReseatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Ask for one re-seat once the current import has settled.
   *
   * Called per file, but coalesced to one run per batch: each call cancels the pending
   * timer, and the timer parks itself while `isUploadBatchActive()` is true. Re-seating per
   * file would be both churn and wrong — every re-seat slides the whole sheet down, and the
   * next file then lands flush in the strip that opened up at the top, so twenty files would
   * walk the customer's existing work five inches down the sheet.
   */
  const scheduleImportReseat = useCallback(() => {
    if (importReseatTimerRef.current) clearTimeout(importReseatTimerRef.current);
    const tick = () => {
      if (isUploadBatchActive()) {
        importReseatTimerRef.current = setTimeout(tick, IMPORT_RESEAT_POLL_MS);
        return;
      }
      importReseatTimerRef.current = null;
      if (!mountedRef.current) return;
      reseatSheetBandRef.current();
    };
    importReseatTimerRef.current = setTimeout(tick, 0);
  }, [mountedRef]);

  useEffect(() => () => {
    if (importReseatTimerRef.current) clearTimeout(importReseatTimerRef.current);
  }, []);

  // Stable refs for keyboard handler to avoid frequent re-registration
  const handleUndoRef = useRef(handleUndo);
  handleUndoRef.current = handleUndo;
  const handleRedoRef = useRef(handleRedo);
  handleRedoRef.current = handleRedo;
  handleAutoArrangeRef.current = handleAutoArrange;
  beginArrangeRef.current = beginArrange;
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
  const handleGroupSelectedRef = useRef(handleGroupSelected);
  handleGroupSelectedRef.current = handleGroupSelected;
  const handleUngroupSelectedRef = useRef(handleUngroupSelected);
  handleUngroupSelectedRef.current = handleUngroupSelected;
  const selectedDesignIdRef = useRef(selectedDesignId);
  selectedDesignIdRef.current = selectedDesignId;
  const saveSnapshotRef = useRef(saveSnapshot);
  saveSnapshotRef.current = saveSnapshot;
  artboardWidthRef.current = artboardWidth;
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
      // Group / Ungroup — Ctrl+G groups the current multi-selection,
      // Ctrl+Shift+G ungroups the selection. Order matters: check
      // Shift+G first so Ctrl+G alone doesn't accidentally trigger both
      // paths. `key.toLowerCase()` handles capitals-lock without a
      // separate branch.
      if (ctrl && e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        handleUngroupSelectedRef.current();
        return;
      }
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        handleGroupSelectedRef.current();
        return;
      }
      if (ctrl && e.key === 'd') {
        e.preventDefault();
        if (selectedDesignIdsRef.current.size > 1) {
          beginArrangeRef.current();
          const newIds = handleDuplicateSelectedRef.current();
          if (newIds.length > 0) {
            // Same pack the Auto-Arrange button gives — see COPY_ARRANGE_OPTS.
            setTimeout(() => handleAutoArrangeRef.current({
              skipSnapshot: true,
              preserveSelection: true,
              arrangeAll: true,
              fullRepack: true,
            }), 0);
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
          // Nudge selection units with uniform group clamping. A user group
          // contributes one bounding box, so a member can never be clamped
          // independently and separated from its siblings.
          const abW = artboardWidthRef.current;
          const abH = artboardHeightRef.current;
          const units = getDesignSelectionUnits(designsRef.current, multiIds, abW, abH);
          let allowedDnx = dnx;
          let allowedDny = dny;
          for (const unit of units) {
            if (unit.minX <= unit.maxX) {
              allowedDnx = Math.max(-unit.minX / abW, Math.min((abW - unit.maxX) / abW, allowedDnx));
            }
            if (unit.minY <= unit.maxY) {
              allowedDny = Math.max(-unit.minY / abH, Math.min((abH - unit.maxY) / abH, allowedDny));
            }
          }
          setDesigns(prev => prev.map(d => {
            if (!units.some(unit => unit.members.some(member => member.id === d.id))) return d;
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


  const applyImageDirectly = useCallback((newImageInfo: ImageInfo, rawWidthInches: number, rawHeightInches: number, alphaThresholded?: boolean) => {
    // Every import format funnels through here, so this is the one place that can
    // keep a file's declared size out of a design's geometry. Refusing the import
    // is the only safe answer to an unreadable size: the arithmetic below divides
    // by both values, and a non-finite result would be written into `transform`
    // and then persisted, which no reload can undo.
    const sane = sanitizeDesignInches(rawWidthInches, rawHeightInches);
    if (!sane) {
      console.error("[import] refusing artwork with unusable physical size", rawWidthInches, rawHeightInches);
      toast({ title: t("toast.invalidImage"), description: t("toast.invalidImageDesc"), variant: "destructive" });
      return;
    }
    const { widthInches, heightInches, oversizeFrom } = sane;

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

    if (oversizeFrom || initialS < 1) {
      const origDims = formatDimensions(
        oversizeFrom?.widthInches ?? widthInches,
        oversizeFrom?.heightInches ?? heightInches,
        lang,
      );
      const fitDims = formatDimensions(widthInches * initialS, heightInches * initialS, lang);
      toast({
        title: t("toast.imageResized"),
        description: t("toast.imageResizedDesc", { origDims, fitDims }),
        variant: "destructive",
      });
    }

    const scaledW = widthInches * initialS;
    const scaledH = heightInches * initialS;
    const gap = designGap ?? 0.25;

    let baseNx = 0;
    let baseNy = 0;
    /** True once the packer has returned a slot, which must then be used unmodified. */
    let placed = false;
    const existingDesigns = designsRef.current;
    if (existingDesigns.length === 0) {
      baseNx = (scaledW / 2) / currentAbW;
      baseNy = (scaledH / 2) / effectiveAbH;
    } else {
      // Placement goes through the shared packer rather than a bespoke corner scan, so an
      // incoming design gets the same best-fit treatment as an arrange and cannot land on
      // top of existing work. Existing designs are anchored, so none of them move.
      //
      // Occupancy is measured against `currentAbH`, not `effectiveAbH`: if the sheet grew
      // above, the `setDesigns` rescale that compensates for it has only been queued, so
      // `designsRef` still holds pre-growth `ny` values. That rescale preserves absolute
      // position, so `ny * currentAbH` is the design's real inch offset either way. Using
      // the new height here instead is what let designs overlap after a growth step.
      const INCOMING = '__incoming__';
      // Grouped designs collapse into one rectangle covering the whole group, so an import
      // cannot nest into a gap *inside* a group and split it apart. Ungrouped designs keep
      // their silhouette, so the newcomer can still tuck into their concavities.
      const currentRects = toPackRects(
        existingDesigns, currentAbW, currentAbH, getDesignNestSilhouette,
      );
      const incomingMask = getDesignNestMask({
        image: newImageInfo.image,
        artW: scaledW,
        artH: scaledH,
        sourceKey: newImageInfo.image.src,
      })?.mask;
      // Nesting rather than rectangle-fitting the newcomer, so it can slot into a
      // neighbour's concavity instead of demanding a clear box of its own.
      const packed = keepPositionsNest(
        [
          ...currentRects.map(r => ({ id: r.id, w: r.w, h: r.h, mask: r.mask, noRotate: r.isGroup })),
          { id: INCOMING, w: scaledW, h: scaledH, mask: incomingMask },
        ],
        currentRects,
        currentAbW, effectiveAbH, currentAbW, effectiveAbH,
        gap, undefined,
        false, // never auto-rotate an import
      );
      const spot = packed.result.find(p => p.id === INCOMING);
      if (spot && !spot.overflows) {
        baseNx = spot.nx;
        baseNy = spot.ny;
        placed = true;
      } else {
        const maxBottom = Math.max(...currentRects.map(r => r.y + r.h));
        baseNx = (scaledW / 2) / currentAbW;
        baseNy = (maxBottom + gap + scaledH / 2) / effectiveAbH;
      }
    }

    // A placement from the packer is already legal and must be used verbatim: nesting
    // deliberately lets a design's transparent margin hang over a neighbour or off the
    // sheet edge, so re-clamping it to its bounding box here would drag it out of the very
    // slot that was just found for it. Only the fallback path, which guessed a position,
    // gets clamped.
    const halfNx = (scaledW / 2) / currentAbW;
    const halfNy = (scaledH / 2) / effectiveAbH;
    const newTransform = {
      nx: placed ? baseNx : Math.min(Math.max(baseNx, halfNx), Math.max(halfNx, 1 - halfNx)),
      ny: placed ? baseNy : Math.max(baseNy, halfNy),
      s: initialS,
      rotation: 0,
    };

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
    // Atomic single-select. Using `setSelectedDesignId` alone would set
    // the primary id but leave `selectedDesignIds` untouched — if a
    // group was selected before the upload (which is trivially easy
    // now that group selection auto-expands the ids set), the stale
    // ids set survives and every downstream check that reads
    // `selectedDesignIds.size >= 2` (auto-arrange's "arrange
    // selection" branch, the multi-resize / multi-drag handlers, the
    // context-menu multi-delete path) sees a phantom multi-selection
    // and mis-targets the *old* group instead of the newly uploaded
    // design. `selectOne` writes both fields in a single store
    // transaction so downstream reads always see a consistent pair.
    selectOne(newDesignId);
    // The packer had the whole sheet, so this design may well have landed flush against the
    // top edge. Coalesced, so a twenty-file drop re-seats once at the end rather than
    // twenty times on the way through.
    scheduleImportReseat();
  }, [saveSnapshot, toast, designGap, scheduleImportReseat]);


  return {
    ...bag,
    arrangeStage,
    arrangeEpoch,
    getAlignDelta,
    handleAlignCorner,
    handleAutoArrange,
    canFill,
    handleFillEmptySpace,
    handleArtboardResize,
    handleArtboardHeightPick,
    shrinkSheetToFit,
    reseatSheetBand,
    GANGSHEET_HEIGHTS,
    MAX_ARTBOARD_HEIGHT,
    recommendedArtboardHeight,
    handleUndoRef,
    handleRedoRef,
    handleDuplicateDesignRef,
    handleDeleteDesignRef,
    handleDeleteMultiRef,
    handleDuplicateSelectedRef,
    handleCopySelectedRef,
    handlePasteRef,
    handleRotate90Ref,
    selectedDesignIdRef,
    saveSnapshotRef,
    selectedDesignIdsRef,
    applyImageDirectly,
  };
}

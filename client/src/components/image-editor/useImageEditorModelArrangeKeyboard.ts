import { useRef, useCallback, useEffect, useMemo } from "react";
import { formatDimensions } from "@/lib/format-length";
import {
  clampDesignToArtboard,
  getArrangeWorker,
  getEffectiveHeight,
  getRotatedBounds,
  getStampExtra,
  nextArrangeRequestId,
} from "./utils";
import type { ImageInfo, DesignItem } from "@/lib/types";
import type { ImageEditorBagAfterDesign } from "./image-editor-hook-bag.types";

export function useImageEditorModelArrangeKeyboard(bag: ImageEditorBagAfterDesign) {
  const {
    onDesignUploaded,
    profile,
    initialWidth,
    initialHeight,
    initialGangsheetHeights,
    initialQuantity,
    shopifyVariants,
    initialVariantId,
    shopDomain,
    embedFromShopify,
    initialDesignState,
    initialDesignId,
    isEditMode,
    toast,
    t,
    lang,
    isMobile,
    isLgUp,
    imageInfo,
    setImageInfo,
    resizeSettings,
    setResizeSettings,
    isProcessing,
    setIsProcessing,
    isAddingToCart,
    setIsAddingToCart,
    isUpdateFlow,
    setIsUpdateFlow,
    addToCartProgressLabel,
    setAddToCartProgressLabel,
    addToCartStallTimeoutRef,
    lastAddToCartPngBytesRef,
    shellUploadUrlRef,
    refreshAddToCartStallTimeout,
    isUploading,
    setIsUploading,
    uploadProgress,
    setUploadProgress,
    artboardWidth,
    setArtboardWidth,
    artboardHeight,
    setArtboardHeight,
    artboardWidthRef,
    artboardHeightRef,
    contentFillCacheRef,
    handleAutoArrangeRef,
    quantity,
    setQuantity,
    designGap,
    setDesignGap,
    duplicateCount,
    setDuplicateCount,
    clampDuplicateCount,
    parseDuplicateCount,
    handleDuplicateCountKeyDown,
    designTransform,
    setDesignTransform,
    designs,
    setDesigns,
    selectedDesignId,
    setSelectedDesignId,
    selectedDesignIds,
    setSelectedDesignIds,
    mobilePanel,
    setMobilePanel,
    showDesignInfo,
    setShowDesignInfo,
    selectionZoomActive,
    setSelectionZoomActive,
    editingLayerName,
    setEditingLayerName,
    editingNameValue,
    setEditingNameValue,
    clipboardRef,
    proportionalLock,
    setProportionalLock,
    designInfoRef,
    sidebarFileRef,
    headerUploadInputRef,
    canvasRef,
    downloadContainer,
    setDownloadContainer,
    spotPreviewData,
    setSpotPreviewData,
    fluorPanelContainer,
    setFluorPanelContainer,
    mobileToolbarContainer,
    setMobileToolbarContainer,
    copySpotSelectionsRef,
    contextMenu,
    setContextMenu,
    cropModalDesignId,
    setCropModalDesignId,
    pushSnapshot,
    undo,
    redo,
    clearIsUndoRedo,
    canUndo,
    canRedo,
    mountedRef,
    designsRef,
    nudgeSnapshotSavedRef,
    nudgeTimeoutRef,
    thumbnailCacheRef,
    assetDataUrlCacheRef,
    restoredLayerAssetRef,
    multiDragAccumRef,
    multiResizeStartRef,
    multiRotateStartRef,
    snapshotCacheRef,
    getSnapshot,
    saveSnapshot,
    applySnapshot,
    handleUndo,
    handleRedo,
    handleInteractionEnd,
    selectedDesign,
    activeImageInfo,
    activeDesignTransform,
    activeWidthInches,
    activeHeightInches,
    activeResizeSettings,
    selectedVariantPrice,
    effectiveDPI,
    layerRows,
    handleSelectDesign,
    handleMultiSelect,
    getLayerThumbnail,
    handleDesignTransformChange,
    handleMultiDragDelta,
    handleMultiResizeDelta,
    handleMultiRotateDelta,
    handleEffectiveSizeChange,
    isArtboardFull,
    handleDuplicateDesign,
    handleDuplicateAndArrange,
    handleDuplicateSelected,
    handleDuplicateById,
    handleRemoveOneCopy,
    handleCopySelected,
    handlePaste,
    handleDeleteGroup,
    handleDeleteDesign,
    handleDeleteMulti,
    handleRotate90,
    handleFlipX,
    handleFlipY,
    handleCanvasContextMenu,
  } = bag;

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

  const handleAutoArrange = useCallback((opts?: { skipSnapshot?: boolean; preserveSelection?: boolean }) => {
    const currentDesigns = designsRef.current;
    if (currentDesigns.length === 0) { console.warn('[autoArrange] no designs'); return; }
    if (!opts?.skipSnapshot) saveSnapshot();

    const usableW = artboardWidthRef.current;
    const usableH = artboardHeightRef.current;

    const arrangeSelection = selectedDesignIds.size >= 2;
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
      const requestId = nextArrangeRequestId();
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
  }, [artboardHeight, artboardWidth, handleArtboardResize, GANGSHEET_HEIGHTS, MAX_ARTBOARD_HEIGHT]);

  // Stable refs for keyboard handler to avoid frequent re-registration
  const handleUndoRef = useRef(handleUndo);
  handleUndoRef.current = handleUndo;
  const handleRedoRef = useRef(handleRedo);
  handleRedoRef.current = handleRedo;
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


  return {
    ...bag,
    getAlignNxNy,
    handleAlignCorner,
    handleAutoArrange,
    handleArtboardResize,
    GANGSHEET_HEIGHTS,
    MAX_ARTBOARD_HEIGHT,
    recommendedArtboardHeight,
    handleExpandArtboard,
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
    showDesignInfoRef,
    saveSnapshotRef,
    selectedDesignIdsRef,
    applyImageDirectly,
  };
}

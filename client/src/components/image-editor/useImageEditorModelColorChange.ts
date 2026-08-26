import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageEditorBagAfterHalftone } from "./image-editor-hook-bag.types";
import type { ColorChangeReason, RgbColor } from "@/lib/color-change-core";
import { analyzeColorChangeBlob, isColorChangeAbort, recolorPngBlob } from "@/lib/color-change-client";
import { capRestoredPreview } from "@/lib/draft-preview-cap";
import { stampEditSplit } from "@/lib/edit-split";
import { revokeThumbnailCacheEntry } from "@/lib/thumbnail-cache";

export type ColorChangeStatus = "closed" | "checking" | "ready" | "applying" | "ineligible" | "error";

export interface ColorChangeState {
  status: ColorChangeStatus;
  designId: string | null;
  sourceColor: RgbColor | null;
  targetHex: string;
  reason?: ColorChangeReason | "vector-source" | "halftoned" | "select-one";
  message?: string;
}

const CLOSED_STATE: ColorChangeState = {
  status: "closed",
  designId: null,
  sourceColor: null,
  // Filled in from the analyzed ink once the design has been read. Opening on
  // the artwork's own colour is what makes the swatch a starting point rather
  // than an arbitrary colour one stray click would commit.
  targetHex: "",
};

function imageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode the recolored PNG."));
    };
    image.src = url;
  });
}

function colorToHex(color: RgbColor): string {
  return `#${[color.r, color.g, color.b].map(value => value.toString(16).padStart(2, "0")).join("")}`;
}

function hexToColor(hex: string): RgbColor | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return { r: value >> 16, g: (value >> 8) & 255, b: value & 255 };
}

export function useImageEditorModelColorChange(bag: ImageEditorBagAfterHalftone) {
  const {
    selectedDesignId,
    selectedDesignIds,
    designsRef,
    setDesigns,
    setImageInfo,
    saveSnapshot,
    thumbnailCacheRef,
    contentFillCacheRef,
    assetDataUrlCacheRef,
    toast,
    t,
  } = bag;
  const [colorChangeState, setColorChangeState] = useState<ColorChangeState>(CLOSED_STATE);
  const jobTokenRef = useRef(0);
  const jobAbortRef = useRef<AbortController | null>(null);
  const applyInFlightRef = useRef(false);
  /**
   * The exact print source that eligibility was proven against. Apply is only
   * ever allowed to rewrite this revision: anything else (an upscale, a
   * background removal, a crop landing between Ready and Apply) would be
   * recolored on trust rather than on analysis.
   */
  const analyzedSourceRef = useRef<{ designId: string; imageInfo: object } | null>(null);

  /**
   * Ignoring a stale result is not enough: a print-resolution decode and
   * re-encode is seconds of CPU, so an abandoned job has to actually stop or it
   * competes with the one the customer is waiting on.
   */
  const beginJob = useCallback(() => {
    jobAbortRef.current?.abort();
    // A superseded job must never clear a guard the new job now owns.
    applyInFlightRef.current = false;
    const controller = new AbortController();
    jobAbortRef.current = controller;
    return { token: ++jobTokenRef.current, signal: controller.signal };
  }, []);

  const closeColorChange = useCallback(() => {
    jobTokenRef.current++;
    jobAbortRef.current?.abort();
    jobAbortRef.current = null;
    applyInFlightRef.current = false;
    analyzedSourceRef.current = null;
    setColorChangeState(CLOSED_STATE);
  }, []);

  useEffect(() => () => {
    jobAbortRef.current?.abort();
    jobAbortRef.current = null;
  }, []);

  const setColorChangeTarget = useCallback((targetHex: string) => {
    setColorChangeState(previous => ({ ...previous, targetHex }));
  }, []);

  const openColorChange = useCallback(async () => {
    const targetIds = selectedDesignIds.size > 0
      ? Array.from(selectedDesignIds)
      : (selectedDesignId ? [selectedDesignId] : []);
    if (targetIds.length !== 1) {
      setColorChangeState({ ...CLOSED_STATE, status: "ineligible", reason: "select-one" });
      return;
    }
    const design = designsRef.current.find(item => item.id === targetIds[0]);
    if (!design) return;
    if (design.imageInfo.isPDF || design.imageInfo.originalPdfData || design.imageInfo.svgSource) {
      setColorChangeState({ ...CLOSED_STATE, status: "ineligible", designId: design.id, reason: "vector-source" });
      return;
    }
    if (design.halftoned) {
      setColorChangeState({ ...CLOSED_STATE, status: "ineligible", designId: design.id, reason: "halftoned" });
      return;
    }

    const { token, signal } = beginJob();
    setColorChangeState(previous => ({
      ...previous,
      status: "checking",
      designId: design.id,
      sourceColor: null,
      reason: undefined,
      message: undefined,
    }));
    try {
      const source = design.imageInfo.exportBlob ?? design.imageInfo.file;
      const analysis = await analyzeColorChangeBlob(source, design.imageInfo.exportCrop, signal);
      if (token !== jobTokenRef.current) return;
      analyzedSourceRef.current = analysis.eligible ? { designId: design.id, imageInfo: design.imageInfo } : null;
      if (!analysis.eligible) {
        setColorChangeState(previous => ({
          ...previous,
          status: "ineligible",
          reason: analysis.reason,
        }));
        return;
      }
      setColorChangeState(previous => ({
        ...previous,
        status: "ready",
        sourceColor: analysis.sourceColor,
        targetHex: colorToHex(analysis.sourceColor),
      }));
    } catch (error) {
      if (token !== jobTokenRef.current || isColorChangeAbort(error)) return;
      setColorChangeState(previous => ({
        ...previous,
        status: "error",
        message: error instanceof Error ? error.message : "Color analysis failed.",
      }));
    }
  }, [beginJob, designsRef, selectedDesignId, selectedDesignIds]);

  const applyColorChange = useCallback(async () => {
    const designId = colorChangeState.designId;
    const target = hexToColor(colorChangeState.targetHex);
    if (!designId || !target || colorChangeState.status !== "ready") return;
    const design = designsRef.current.find(item => item.id === designId);
    if (!design || design.halftoned) return;
    // Refuse before spending any CPU if the print source moved on since it was
    // analyzed; the post-work identity check alone would recolor unproven bytes.
    const analyzed = analyzedSourceRef.current;
    if (!analyzed || analyzed.designId !== designId || analyzed.imageInfo !== design.imageInfo) {
      setColorChangeState(previous => ({
        ...previous,
        status: "error",
        message: t("editor.colorChangeSourceChanged"),
      }));
      return;
    }
    // Rewriting the print source to the colour it already has would still cost
    // a full decode/encode, a history entry, and a fresh upload at checkout.
    const sourceColor = colorChangeState.sourceColor;
    if (sourceColor && sourceColor.r === target.r && sourceColor.g === target.g && sourceColor.b === target.b) {
      closeColorChange();
      return;
    }
    // The status check above reads a render-old value, so a double click can
    // otherwise start two print-resolution jobs against the same design.
    if (applyInFlightRef.current) return;

    const { token, signal } = beginJob();
    // Claim the guard *after* beginJob, never before: beginJob releases the
    // previous job's claim, so an earlier claim would be wiped by the very call
    // that starts the job it was meant to protect.
    applyInFlightRef.current = true;
    setColorChangeState(previous => ({ ...previous, status: "applying", message: undefined }));
    try {
      const source = design.imageInfo.exportBlob ?? design.imageInfo.file;
      const result = await recolorPngBlob(source, target, design.imageInfo.exportCrop, signal);
      if (token !== jobTokenRef.current) return;
      if (!result.ok) {
        setColorChangeState(previous => ({ ...previous, status: "ineligible", reason: result.reason }));
        return;
      }
      const blob = new Blob([result.png], { type: "image/png" });
      const decoded = await imageFromBlob(blob);
      const preview = await capRestoredPreview(decoded, blob, { preserveCleanAlpha: !!design.alphaThresholded });
      if (preview.image !== decoded && decoded.src.startsWith("blob:")) URL.revokeObjectURL(decoded.src);
      if (token !== jobTokenRef.current) {
        if (preview.image.src.startsWith("blob:")) URL.revokeObjectURL(preview.image.src);
        return;
      }
      const current = designsRef.current.find(item => item.id === designId);
      if (!current || current.imageInfo !== design.imageInfo) {
        if (preview.image.src.startsWith("blob:")) URL.revokeObjectURL(preview.image.src);
        setColorChangeState(previous => ({
          ...previous,
          status: "error",
          message: t("editor.colorChangeSourceChanged"),
        }));
        return;
      }
      const baseName = design.imageInfo.file.name.replace(/\.[^.]+$/, "") || "design";
      const file = new File([blob], `${baseName}-color.png`, { type: "image/png" });
      const nextInfo = {
        ...design.imageInfo,
        file,
        image: preview.image,
        originalWidth: result.width,
        originalHeight: result.height,
        exportBlob: blob,
        exportCrop: undefined,
        exportPixelWidth: result.width,
        exportPixelHeight: result.height,
        isPDF: false,
        originalPdfData: undefined,
        svgSource: undefined,
        vectorInkBox: undefined,
      };

      saveSnapshot();
      revokeThumbnailCacheEntry(thumbnailCacheRef.current, design.imageInfo.image.src);
      contentFillCacheRef.current.delete(design.imageInfo.image.src);
      assetDataUrlCacheRef.current.delete(design.id);
      setDesigns(previous => stampEditSplit(
        previous.map(item => item.id === designId ? { ...item, imageInfo: nextInfo } : item),
        new Set([designId]),
        "color",
      ));
      if (selectedDesignId === designId) setImageInfo(nextInfo);
      analyzedSourceRef.current = null;
      setColorChangeState(CLOSED_STATE);
      toast({
        title: t("editor.colorChangeDone"),
        description: t("editor.colorChangeDoneDescription", { color: colorChangeState.targetHex.toUpperCase() }),
      });
    } catch (error) {
      if (token !== jobTokenRef.current || isColorChangeAbort(error)) return;
      setColorChangeState(previous => ({
        ...previous,
        status: "error",
        message: error instanceof Error ? error.message : "Color change failed.",
      }));
    } finally {
      // Only the job that still owns the token may release the guard; a job
      // aborted while its preview decode was pending must not unlock the one
      // that replaced it.
      if (token === jobTokenRef.current) applyInFlightRef.current = false;
    }
  }, [
    assetDataUrlCacheRef,
    beginJob,
    closeColorChange,
    colorChangeState,
    contentFillCacheRef,
    designsRef,
    saveSnapshot,
    selectedDesignId,
    setDesigns,
    setImageInfo,
    thumbnailCacheRef,
    toast,
    t,
  ]);

  return {
    colorChangeState,
    openColorChange,
    closeColorChange,
    setColorChangeTarget,
    applyColorChange,
  };
}
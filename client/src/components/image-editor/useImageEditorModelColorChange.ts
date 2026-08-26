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
  /** Rows processed, 0 to 1, while checking or applying. */
  progress?: number;
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

/**
 * Recolours the preview the editor already has, instead of decoding the new
 * print source.
 *
 * The recoloured file can be hundreds of megapixels, and decoding it in the tab
 * just to build a thumbnail throws away everything the streaming recolour
 * saved — it is also the step most likely to fail outright on iOS, which caps
 * how large an image it will rasterise. The preview is already the same artwork
 * at display size, and a single-ink recolour changes nothing but RGB, so
 * painting the target colour through the preview's own alpha (`source-in`
 * keeps destination alpha and replaces the colour) produces exactly the image
 * the full decode would have produced, at a few hundred kilopixels.
 */
async function maskRecolorPreview(source: HTMLImageElement, target: RgbColor): Promise<HTMLImageElement | null> {
  const width = source.naturalWidth || 0;
  const height = source.naturalHeight || 0;
  if (!width || !height) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(source, 0, 0);
  context.globalCompositeOperation = "source-in";
  context.fillStyle = colorToHex(target);
  context.fillRect(0, 0, width, height);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
  if (!blob) return null;
  return imageFromBlob(blob);
}

/** Within this much of the output's aspect ratio, the preview frames the same artwork. */
const PREVIEW_ASPECT_TOLERANCE = 0.01;

async function buildRecoloredPreview(
  currentPreview: HTMLImageElement | undefined,
  recolored: Blob,
  target: RgbColor,
  output: { width: number; height: number },
  preserveCleanAlpha: boolean,
): Promise<HTMLImageElement> {
  const width = currentPreview?.naturalWidth ?? 0;
  const height = currentPreview?.naturalHeight ?? 0;
  const outputAspect = output.width / output.height;
  // A preview framed differently from the output — which a crop applied since
  // it was built would cause — cannot stand in for it, so that case pays for
  // the decode.
  if (currentPreview && width > 0 && height > 0 &&
      Math.abs(width / height - outputAspect) <= PREVIEW_ASPECT_TOLERANCE * outputAspect) {
    const masked = await maskRecolorPreview(currentPreview, target).catch(() => null);
    if (masked) return masked;
  }
  const decoded = await imageFromBlob(recolored);
  const capped = await capRestoredPreview(decoded, recolored, { preserveCleanAlpha });
  if (capped.image !== decoded && decoded.src.startsWith("blob:")) URL.revokeObjectURL(decoded.src);
  return capped.image;
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
   * Turns the worker's row reports into dialog progress.
   *
   * Reported often enough to prove the worker is alive on a slow phone, so it
   * is collapsed to whole percent before it reaches React — a print-resolution
   * source would otherwise re-render the dialog a few hundred times.
   */
  const makeProgressReporter = useCallback((token: number) => {
    let lastPercent = -1;
    return (fraction: number) => {
      const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
      if (percent === lastPercent) return;
      lastPercent = percent;
      if (token !== jobTokenRef.current) return;
      setColorChangeState(previous => (
        previous.status === "checking" || previous.status === "applying"
          ? { ...previous, progress: percent / 100 }
          : previous
      ));
    };
  }, []);

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
      progress: 0,
    }));
    try {
      const source = design.imageInfo.exportBlob ?? design.imageInfo.file;
      const analysis = await analyzeColorChangeBlob(
        source,
        design.imageInfo.exportCrop,
        signal,
        makeProgressReporter(token),
      );
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
  }, [beginJob, designsRef, makeProgressReporter, selectedDesignId, selectedDesignIds]);

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
    setColorChangeState(previous => ({ ...previous, status: "applying", message: undefined, progress: 0 }));
    try {
      const source = design.imageInfo.exportBlob ?? design.imageInfo.file;
      const result = await recolorPngBlob(
        source,
        target,
        design.imageInfo.exportCrop,
        signal,
        makeProgressReporter(token),
      );
      if (token !== jobTokenRef.current) return;
      if (!result.ok) {
        setColorChangeState(previous => ({ ...previous, status: "ineligible", reason: result.reason }));
        return;
      }
      const blob = result.blob;
      const previewImage = await buildRecoloredPreview(
        design.imageInfo.image,
        blob,
        target,
        result,
        !!design.alphaThresholded,
      );
      if (token !== jobTokenRef.current) {
        if (previewImage.src.startsWith("blob:")) URL.revokeObjectURL(previewImage.src);
        return;
      }
      const current = designsRef.current.find(item => item.id === designId);
      if (!current || current.imageInfo !== design.imageInfo) {
        if (previewImage.src.startsWith("blob:")) URL.revokeObjectURL(previewImage.src);
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
        image: previewImage,
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
    makeProgressReporter,
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
import { useCallback, useRef, useState } from "react";
import type { ImageEditorBagAfterHalftone } from "./image-editor-hook-bag.types";
import type { ColorChangeReason, RgbColor } from "@/lib/color-change-core";
import { analyzeColorChangeBlob, recolorPngBlob } from "@/lib/color-change-client";
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
  targetHex: "#ff2d95",
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

  const closeColorChange = useCallback(() => {
    jobTokenRef.current++;
    setColorChangeState(CLOSED_STATE);
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

    const token = ++jobTokenRef.current;
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
      const analysis = await analyzeColorChangeBlob(source, design.imageInfo.exportCrop);
      if (token !== jobTokenRef.current) return;
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
        targetHex: previous.targetHex || colorToHex(analysis.sourceColor),
      }));
    } catch (error) {
      if (token !== jobTokenRef.current) return;
      setColorChangeState(previous => ({
        ...previous,
        status: "error",
        message: error instanceof Error ? error.message : "Color analysis failed.",
      }));
    }
  }, [designsRef, selectedDesignId, selectedDesignIds]);

  const applyColorChange = useCallback(async () => {
    const designId = colorChangeState.designId;
    const target = hexToColor(colorChangeState.targetHex);
    if (!designId || !target || colorChangeState.status !== "ready") return;
    const design = designsRef.current.find(item => item.id === designId);
    if (!design || design.halftoned) return;

    const token = ++jobTokenRef.current;
    setColorChangeState(previous => ({ ...previous, status: "applying", message: undefined }));
    try {
      const source = design.imageInfo.exportBlob ?? design.imageInfo.file;
      const result = await recolorPngBlob(source, target, design.imageInfo.exportCrop);
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
      setColorChangeState(CLOSED_STATE);
      toast({
        title: t("editor.colorChangeDone"),
        description: t("editor.colorChangeDoneDescription", { color: colorChangeState.targetHex.toUpperCase() }),
      });
    } catch (error) {
      if (token !== jobTokenRef.current) return;
      setColorChangeState(previous => ({
        ...previous,
        status: "error",
        message: error instanceof Error ? error.message : "Color change failed.",
      }));
    }
  }, [
    assetDataUrlCacheRef,
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
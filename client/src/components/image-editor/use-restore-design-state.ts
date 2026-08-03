import { useEffect } from "react";
import type { DesignItem, ImageInfo, ImageTransform } from "@/lib/types";
import {
  DEFAULT_LAYER_CENTER_NX,
  DEFAULT_LAYER_CENTER_NY,
  DEFAULT_LAYER_ROTATION,
  DEFAULT_LAYER_SCALE,
  DEFAULT_LAYER_SIZE_INCHES,
  EXPORT_DPI,
} from "./constants";
import type { InitialDesignState } from "./types";

export type RestoredAsset = { url: string; key?: string; mimeType?: string; fileSig: string };

function resolveArtboardSize(state: InitialDesignState): { w: number; h: number } | null {
  const parsedSize = (() => {
    const raw = state.gangsheet?.size || state.gangsheetSize || "";
    const m = String(raw).match(/([\d.]+)\s*["']?\s*x\s*([\d.]+)/i);
    if (!m) return null;
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { w, h };
  })();
  let abW = Number(state.canvas?.artboardWidthInches ?? state.canvas?.width);
  let abH = Number(state.canvas?.artboardHeightInches ?? state.canvas?.height);
  if ((!Number.isFinite(abW) || abW <= 0 || !Number.isFinite(abH) || abH <= 0) && parsedSize) {
    abW = parsedSize.w;
    abH = parsedSize.h;
  }
  if (!Number.isFinite(abW) || abW <= 0 || !Number.isFinite(abH) || abH <= 0) return null;
  return { w: abW, h: abH };
}

async function loadImageFromPublicUrl(
  assetUrl: string,
): Promise<{ image: HTMLImageElement; blob: Blob }> {
  let response = await fetch(assetUrl);
  if (!response.ok) {
    response = await fetch(`/api/fetch-binary?url=${encodeURIComponent(assetUrl)}`);
  }
  if (!response.ok) {
    throw new Error(`Asset load failed (${response.status})`);
  }
  const blob = await response.blob();
  const objUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    // Armed before .src is set, so a decode failure can't fire `error` before we're listening.
    const eventSettled = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Image decode failed"));
    });
    img.src = objUrl;
    // Async decode keeps large restores off the main thread; falls back to the events above.
    try {
      await img.decode();
    } catch {
      await eventSettled;
    }
    return { image: img, blob };
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

export function useRestoreDesignState({
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
}: {
  initialDesignState?: InitialDesignState | null;
  restoredLayerAssetRef: React.MutableRefObject<Map<string, RestoredAsset>>;
  setIsProcessing: (v: boolean) => void;
  setDesigns: React.Dispatch<React.SetStateAction<DesignItem[]>>;
  setSelectedDesignId: (v: string | null) => void;
  setImageInfo: (v: ImageInfo | null) => void;
  setDesignTransform: (v: ImageTransform) => void;
  setArtboardWidth: (v: number) => void;
  setArtboardHeight: (v: number) => void;
  setQuantity: (v: number) => void;
  setDesignGap: (v: number | undefined) => void;
}) {
  useEffect(() => {
    if (!initialDesignState) return;
    const layers = Array.isArray(initialDesignState.layers) ? initialDesignState.layers : [];
    if (!layers.length) return;

    let cancelled = false;
    setIsProcessing(true);

    void (async () => {
      const restoredDesigns = (
        await Promise.all(
          layers.map(async (layer, i): Promise<DesignItem | null> => {
            if (cancelled) return null;
            if (String(layer.asset?.source || "") === "production-reference") return null;

            const assetUrl = String(layer.asset?.url || "").trim();
            if (!assetUrl.startsWith("http://") && !assetUrl.startsWith("https://")) return null;

            try {
              const { image, blob } = await loadImageFromPublicUrl(assetUrl);
              const fileName =
                String(layer.name || "").trim() ||
                String(layer.asset?.key || "").split("/").pop() ||
                `layer-${i + 1}.png`;
              const file = new File([blob], fileName, {
                type: blob.type || "image/png",
                lastModified: Date.now(),
              });
              const layerId = String(layer.layerId || crypto.randomUUID());
              restoredLayerAssetRef.current.set(layerId, {
                url: assetUrl,
                key: layer.asset?.key ? String(layer.asset.key) : undefined,
                mimeType: layer.asset?.mimeType ? String(layer.asset.mimeType) : undefined,
                fileSig: `${fileName}:${file.size}:${file.lastModified}`,
              });
              const originalDpi = Number(layer.settings?.originalDpi) || EXPORT_DPI;
              const sx = Number(layer.scaleX);
              const sy = Number(layer.scaleY);
              const scaleAbs =
                Number.isFinite(sx) && sx !== 0
                  ? Math.abs(sx)
                  : Number.isFinite(sy) && sy !== 0
                    ? Math.abs(sy)
                    : DEFAULT_LAYER_SCALE;
              return {
                id: layerId,
                name: String(layer.name || fileName),
                imageInfo: {
                  file,
                  image,
                  originalWidth: image.naturalWidth || image.width,
                  originalHeight: image.naturalHeight || image.height,
                  dpi: originalDpi,
                },
                originalDPI: originalDpi,
                widthInches: Number(layer.width) > 0 ? Number(layer.width) : DEFAULT_LAYER_SIZE_INCHES,
                heightInches: Number(layer.height) > 0 ? Number(layer.height) : DEFAULT_LAYER_SIZE_INCHES,
                transform: {
                  nx: Number.isFinite(Number(layer.x)) ? Number(layer.x) : DEFAULT_LAYER_CENTER_NX,
                  ny: Number.isFinite(Number(layer.y)) ? Number(layer.y) : DEFAULT_LAYER_CENTER_NY,
                  s: scaleAbs,
                  rotation: Number.isFinite(Number(layer.rotation)) ? Number(layer.rotation) : DEFAULT_LAYER_ROTATION,
                  flipX: Number.isFinite(sx) ? sx < 0 : false,
                  flipY: Number.isFinite(sy) ? sy < 0 : false,
                },
                alphaThresholded: Boolean(layer.settings?.alphaThresholded),
                halftoned: Boolean(layer.settings?.halftoned),
                halftoneSettings:
                  layer.settings?.halftoneSettings &&
                  typeof layer.settings.halftoneSettings === "object"
                    ? layer.settings.halftoneSettings as DesignItem["halftoneSettings"]
                    : undefined,
                printFileName: Boolean(layer.settings?.printFileName),
              };
            } catch (err) {
              console.warn("[builder] skipped layer restore", err);
              return null;
            }
          }),
        )
      ).filter((d): d is DesignItem => Boolean(d));

      if (cancelled) return;
      if (!restoredDesigns.length) {
        console.warn("[builder] design state loaded but no layers could be restored");
        setIsProcessing(false);
        return;
      }

      const artboard = resolveArtboardSize(initialDesignState);
      if (artboard) {
        setArtboardWidth(artboard.w);
        setArtboardHeight(artboard.h);
      }
      const restoredQty = Number(initialDesignState.settings?.quantity);
      if (Number.isFinite(restoredQty) && restoredQty > 0) setQuantity(Math.floor(restoredQty));
      const restoredGap = Number(initialDesignState.settings?.designGap);
      if (Number.isFinite(restoredGap) && restoredGap >= 0) setDesignGap(restoredGap);

      setDesigns(restoredDesigns);
      const selected =
        restoredDesigns.find((d) =>
          layers.some((l) => String(l.layerId || "") === d.id && Boolean(l.selected)),
        ) || restoredDesigns[restoredDesigns.length - 1];
      setSelectedDesignId(selected?.id ?? null);
      if (selected) {
        setDesignTransform(selected.transform);
        setImageInfo(selected.imageInfo);
      }
      setIsProcessing(false);
    })().catch((err) => {
      console.error("[builder] design state restore failed", err);
      if (!cancelled) setIsProcessing(false);
    });

    return () => {
      cancelled = true;
    };
  }, [initialDesignState?.designId, initialDesignState?.version]);
}

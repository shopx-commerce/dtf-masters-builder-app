import fs from "node:fs";
import path from "node:path";

const root = "/Users/brainxshopify/dtf-masters-builder-app";
const srcPath = path.join(root, "client/src/components/image-editor.tsx.bak");
const src = fs.readFileSync(srcPath, "utf8");
const lines = src.split("\n");

function slice(start, end) {
  return lines.slice(start - 1, end).join("\n");
}

function writeRel(rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content.trim() + "\n");
}

writeRel(
  "client/src/components/image-editor/types.ts",
  `export interface InitialDesignStateLayer {
  layerId?: string;
  name?: string;
  selected?: boolean;
  rotation?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  scaleX?: number;
  scaleY?: number;
  settings?: { originalDpi?: number; [k: string]: unknown } | null;
  asset?: { url?: string; key?: string; mimeType?: string } | null;
}

export interface InitialDesignState {
  designId?: string | null;
  version?: number | string | null;
  canvas?: { artboardWidthInches?: number; artboardHeightInches?: number; width?: number; height?: number } | null;
  settings?: { quantity?: number; designGap?: number } | null;
  layers?: InitialDesignStateLayer[] | null;
  gangsheet?: { size?: string } | null;
  gangsheetSize?: string;
}`,
);

writeRel(
  "client/src/components/image-editor/utils.ts",
  `import { hasCleanAlpha } from "@/lib/image-crop";
import type { ImageTransform } from "@/lib/types";
import ExportWorkerModule from "@/lib/export-worker?worker";
import ArrangeWorkerModule from "@/lib/arrange-worker?worker";
import {
  ADD_TO_CART_LABEL_MAX_LEN,
  EXPORT_DPI,
  RASTER_DPI_FALLBACK,
} from "./constants";

${slice(9, 16).replace("const RASTER_DPI_FALLBACK = 144;", "")}

${slice(20, 36)}

export function shortAddToCartLabel(message: string, maxLen = ADD_TO_CART_LABEL_MAX_LEN): string {
  const s = String(message || '').trim();
  if (!s) return s;
  return s.length <= maxLen ? s : \`\${s.slice(0, maxLen - 1)}…\`;
}

let _exportWorker: Worker | null = null;
export function getExportWorker(): Worker | null {
  if (!_exportWorker) {
    try { _exportWorker = new ExportWorkerModule(); }
    catch { return null; }
  }
  return _exportWorker;
}

let _arrangeWorker: Worker | null = null;
export function getArrangeWorker(): Worker | null {
  if (!_arrangeWorker) {
    try { _arrangeWorker = new ArrangeWorkerModule(); }
    catch { return null; }
  }
  return _arrangeWorker;
}

${slice(176, 305)}

export let exportReqCounter = 0;
export let arrangeReqCounter = 0;
export function nextExportRequestId() { return ++exportReqCounter; }
export function nextArrangeRequestId() { return ++arrangeReqCounter; }
`,
);

writeRel(
  "client/src/components/image-editor/size-input.tsx",
  `import { useState } from "react";
import { cmToInches, useMetric } from "@/lib/format-length";

${slice(73, 146)}
`,
);

// Extract hooks and components from backup
writeRel(
  "client/src/components/image-editor/use-add-to-cart-stall.ts",
  `import { useCallback, useEffect, useRef } from "react";
import {
  ADD_TO_CART_STALL_MIN_MS_NEW,
  ADD_TO_CART_STALL_MIN_MS_UPDATE,
  ADD_TO_CART_STALL_MS_PER_MB,
} from "./constants";
import { shortAddToCartLabel } from "./utils";

type ToastFn = (opts: {
  title: string;
  description?: string;
  variant?: "default" | "destructive";
}) => void;

export function useAddToCartStall({
  toast,
  isUpdateFlow,
  setIsAddingToCart,
  setIsProcessing,
  setIsUpdateFlow,
  setAddToCartProgressLabel,
}: {
  toast: ToastFn;
  isUpdateFlow: boolean;
  setIsAddingToCart: (v: boolean) => void;
  setIsProcessing: (v: boolean) => void;
  setIsUpdateFlow: (v: boolean) => void;
  setAddToCartProgressLabel: (v: string | undefined) => void;
}) {
  const addToCartStallTimeoutRef = useRef<number | null>(null);
  const lastAddToCartPngBytesRef = useRef<number>(0);
  const shellUploadUrlRef = useRef<string | null>(null);

  const refreshAddToCartStallTimeout = useCallback((pngBytes?: number) => {
    if (addToCartStallTimeoutRef.current != null) {
      window.clearTimeout(addToCartStallTimeoutRef.current);
    }
    const mb = Math.max(1, (pngBytes || 0) / (1024 * 1024));
    const minMs = isUpdateFlow ? ADD_TO_CART_STALL_MIN_MS_UPDATE : ADD_TO_CART_STALL_MIN_MS_NEW;
    const stallMs = Math.max(minMs, Math.ceil(mb * ADD_TO_CART_STALL_MS_PER_MB));
    addToCartStallTimeoutRef.current = window.setTimeout(() => {
      setIsAddingToCart(false);
      setIsProcessing(false);
      setIsUpdateFlow(false);
      addToCartStallTimeoutRef.current = null;
      toast({
        title: isUpdateFlow ? 'Update stalled' : 'Add to cart stalled',
        description: \`No upload status received for \${Math.round(stallMs / 60_000)} minutes. Please refresh and try again.\`,
        variant: 'destructive',
      });
    }, stallMs);
  }, [toast, isUpdateFlow, setIsAddingToCart, setIsProcessing, setIsUpdateFlow]);

  useEffect(() => {
    const onShellConfig = (e: MessageEvent) => {
      if (e.data?.type !== 'dtf-builder-shell-config') return;
      if (typeof e.data.uploadUrl === 'string' && e.data.uploadUrl.trim()) {
        shellUploadUrlRef.current = String(e.data.uploadUrl).trim();
      }
    };
    window.addEventListener('message', onShellConfig);
    return () => window.removeEventListener('message', onShellConfig);
  }, []);

  useEffect(() => {
    const onCartStatus = (e: MessageEvent) => {
      if (e.data?.type !== 'dtf-builder-cart-status') return;
      if (e.data.status === 'progress' || e.data.status === 'uploaded') {
        refreshAddToCartStallTimeout(lastAddToCartPngBytesRef.current || undefined);
        if (typeof e.data.message === 'string' && e.data.message.trim()) {
          setAddToCartProgressLabel(shortAddToCartLabel(e.data.message));
        }
      }
      if (e.data.status === 'error' || e.data.status === 'done') {
        if (addToCartStallTimeoutRef.current != null) {
          window.clearTimeout(addToCartStallTimeoutRef.current);
          addToCartStallTimeoutRef.current = null;
        }
        setIsAddingToCart(false);
        setIsProcessing(false);
        setIsUpdateFlow(false);
        setAddToCartProgressLabel(undefined);
      }
      if (e.data.status === 'error') {
        const detail = typeof e.data.message === 'string' ? e.data.message : (isUpdateFlow ? 'Could not update design' : 'Could not add to cart');
        toast({ title: isUpdateFlow ? 'Update failed' : 'Add to cart failed', description: detail.slice(0, 180), variant: 'destructive' });
      }
    };
    window.addEventListener('message', onCartStatus);
    return () => window.removeEventListener('message', onCartStatus);
  }, [toast, isUpdateFlow, refreshAddToCartStallTimeout, setIsAddingToCart, setIsProcessing, setIsUpdateFlow, setAddToCartProgressLabel]);

  const clearStallTimeout = useCallback(() => {
    if (addToCartStallTimeoutRef.current != null) {
      window.clearTimeout(addToCartStallTimeoutRef.current);
      addToCartStallTimeoutRef.current = null;
    }
  }, []);

  return {
    addToCartStallTimeoutRef,
    lastAddToCartPngBytesRef,
    shellUploadUrlRef,
    refreshAddToCartStallTimeout,
    clearStallTimeout,
  };
}
`,
);

writeRel(
  "client/src/components/image-editor/use-restore-design-state.ts",
  `import { useEffect } from "react";
import type { DesignItem, ImageTransform } from "@/lib/types";
import {
  DEFAULT_DESIGN_TRANSFORM,
  DEFAULT_LAYER_CENTER_NX,
  DEFAULT_LAYER_CENTER_NY,
  DEFAULT_LAYER_ROTATION,
  DEFAULT_LAYER_SCALE,
  DEFAULT_LAYER_SIZE_INCHES,
} from "./constants";
import type { InitialDesignState } from "./types";

type RestoredAsset = { url: string; key?: string; mimeType?: string; fileSig: string };

export function useRestoreDesignState({
  initialDesignState,
  restoredLayerAssetRef,
  setIsProcessing,
  setDesigns,
  setSelectedDesignId,
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

    const loadImageFromAssetUrl = async (assetUrl: string): Promise<{ image: HTMLImageElement; blob: Blob }> => {
      const response = await fetch(\`/api/fetch-binary?url=\${encodeURIComponent(assetUrl)}\`);
      if (!response.ok) throw new Error(\`Asset load failed (\${response.status})\`);
      const blob = await response.blob();
      const objUrl = URL.createObjectURL(blob);
      try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("Image decode failed"));
          img.src = objUrl;
        });
        return { image, blob };
      } finally {
        URL.revokeObjectURL(objUrl);
      }
    };

    void (async () => {
      const restoredDesigns: DesignItem[] = [];
      for (let i = 0; i < layers.length; i++) {
        if (cancelled) return;
        const layer = layers[i];
        const assetUrl = String(layer.asset?.url || "").trim();
        if (!assetUrl) continue;
        try {
          const { image, blob } = await loadImageFromAssetUrl(assetUrl);
          const fileName =
            String(layer.name || "").trim() ||
            String(layer.asset?.key || "").split("/").pop() ||
            \`layer-\${i + 1}.png\`;
          const file = new File([blob], fileName, {
            type: blob.type || "image/png",
            lastModified: Date.now(),
          });
          const layerId = String(layer.layerId || crypto.randomUUID());
          restoredLayerAssetRef.current.set(layerId, {
            url: assetUrl,
            key: layer.asset?.key ? String(layer.asset.key) : undefined,
            mimeType: layer.asset?.mimeType ? String(layer.asset.mimeType) : undefined,
            fileSig: \`\${fileName}:\${file.size}:\${file.lastModified}\`,
          });
          const originalDpi = Number(layer.settings?.originalDpi) || 300;
          const sx = Number(layer.scaleX);
          const sy = Number(layer.scaleY);
          const scaleAbs =
            Number.isFinite(sx) && sx !== 0
              ? Math.abs(sx)
              : Number.isFinite(sy) && sy !== 0
                ? Math.abs(sy)
                : DEFAULT_LAYER_SCALE;
          restoredDesigns.push({
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
            printFileName: Boolean(layer.settings?.printFileName),
          });
        } catch (err) {
          console.warn("[builder] skipped layer restore", err);
        }
      }

      if (cancelled || !restoredDesigns.length) return;

      const parsedSize = (() => {
        const raw =
          initialDesignState.gangsheet?.size ||
          initialDesignState.gangsheetSize ||
          "";
        const m = String(raw).match(/([\\d.]+)\\s*["']?\\s*x\\s*([\\d.]+)/i);
        if (!m) return null;
        const w = Number(m[1]);
        const h = Number(m[2]);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
        return { w, h };
      })();
      let abW = Number(
        initialDesignState.canvas?.artboardWidthInches ?? initialDesignState.canvas?.width,
      );
      let abH = Number(
        initialDesignState.canvas?.artboardHeightInches ?? initialDesignState.canvas?.height,
      );
      if ((!Number.isFinite(abW) || abW <= 0 || !Number.isFinite(abH) || abH <= 0) && parsedSize) {
        abW = parsedSize.w;
        abH = parsedSize.h;
      }
      if (Number.isFinite(abW) && abW > 0) setArtboardWidth(abW);
      if (Number.isFinite(abH) && abH > 0) setArtboardHeight(abH);
      const restoredQty = Number(initialDesignState.settings?.quantity);
      if (Number.isFinite(restoredQty) && restoredQty > 0) setQuantity(Math.floor(restoredQty));
      const restoredGap = Number(initialDesignState.settings?.designGap);
      if (Number.isFinite(restoredGap)) setDesignGap(restoredGap);

      setDesigns(restoredDesigns);
      setSelectedDesignId(restoredDesigns[0]?.id ?? null);
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
`,
);

console.log("Extracted image-editor modules");

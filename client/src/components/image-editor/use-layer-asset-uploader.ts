import { useCallback, useEffect, useRef } from "react";
import { canUseShellRelay, deleteR2Asset, uploadProductionToR2 } from "@/lib/r2-direct-upload";
import {
  LAYER_ASSET_MIME,
  layerAssetStem,
  layerBitmapToPngBlob,
  layerContentToken,
} from "@/lib/layer-bitmap";
import { LAYER_ASSET_GC_DELAY_MS, LAYER_ASSET_UPLOAD_CONCURRENCY } from "./constants";
import type { RestoredAsset } from "./use-restore-design-state";
import type { DesignItem } from "@/lib/types";

type LayerAssetStatus = "pending" | "uploading" | "uploaded" | "error";

export type LayerAssetRef = {
  key: string;
  url: string;
  mimeType: string;
  filename: string;
};

type LayerAssetRecord = {
  status: LayerAssetStatus;
  key: string;
  url: string | null;
  mimeType: string;
  filename: string;
  /** Uploaded by this session, so this session may still delete it. */
  owned: boolean;
  cancelled: boolean;
};

type Transport = { uploadUrl: string; useShellRelay: boolean; shopKey: string };

function r2KeyFromPublicUrl(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\/+/, "");
  } catch {
    return "";
  }
}

/** The proxy files a design under its sanitised id, so only ids it leaves untouched can be addressed. */
function isAddressableDesignId(designId: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,79}$/.test(designId);
}

/** Uploads each layer's bitmap to R2 by reconciling against the design list on every change. */
export function useLayerAssetUploader({
  designs,
  designIdRef,
  restoredLayerAssetRef,
  shellUploadUrlRef,
  shellShopKeyRef,
  shellConfigReady,
}: {
  designs: DesignItem[];
  designIdRef: React.MutableRefObject<string>;
  restoredLayerAssetRef: React.MutableRefObject<Map<string, RestoredAsset>>;
  shellUploadUrlRef: React.MutableRefObject<string | null>;
  shellShopKeyRef: React.MutableRefObject<string | null>;
  shellConfigReady: boolean;
}) {
  const recordsRef = useRef<Map<string, LayerAssetRecord>>(new Map());
  const sourcesRef = useRef<Map<string, DesignItem>>(new Map());
  const queueRef = useRef<string[]>([]);
  const gcTimersRef = useRef<Map<string, number>>(new Map());
  const seededLayerIdsRef = useRef<Set<string>>(new Set());
  const activeCountRef = useRef(0);
  const pumpRef = useRef<() => void>(() => {});
  const aliveRef = useRef(true);
  useEffect(() => {
    const gcTimers = gcTimersRef.current;
    return () => {
      aliveRef.current = false;
      for (const timer of gcTimers.values()) window.clearTimeout(timer);
      gcTimers.clear();
    };
  }, []);

  const resolveTransport = useCallback((): Transport | null => {
    const uploadUrl = shellUploadUrlRef.current?.trim() || "";
    // Inside the shell the relay is the only reliable transport; uploadUrl is the shell's own.
    const useShellRelay = canUseShellRelay();
    const shopKey = shellShopKeyRef.current?.trim() || "";
    if (!shopKey || (!uploadUrl && !useShellRelay)) return null;
    if (!isAddressableDesignId(designIdRef.current)) return null;
    return { uploadUrl, useShellRelay, shopKey };
  }, [shellUploadUrlRef, shellShopKeyRef, designIdRef]);

  const deleteAsset = useCallback((key: string, transport: Transport) => {
    void deleteR2Asset(key, designIdRef.current, transport.uploadUrl, {
      useShellRelay: transport.useShellRelay,
    }).catch((err) => console.warn("[layer-asset] delete failed:", err));
  }, [designIdRef]);

  const runUpload = useCallback(async (token: string) => {
    const record = recordsRef.current.get(token);
    const source = sourcesRef.current.get(token);
    const transport = resolveTransport();
    if (!record || !source || !transport) return;
    record.status = "uploading";
    const objectKey = `designs/${transport.shopKey}/${designIdRef.current}/layers/${token}-${layerAssetStem(source, token)}.png`;
    try {
      const blob = await layerBitmapToPngBlob(source);
      const uploaded = await uploadProductionToR2(blob, record.filename, transport.uploadUrl, undefined, {
        objectKey,
        useShellRelay: transport.useShellRelay,
        productionFormat: "png",
      });
      const key = uploaded.key || objectKey;
      if (record.cancelled || !aliveRef.current) {
        deleteAsset(key, transport);
        recordsRef.current.delete(token);
        return;
      }
      record.status = "uploaded";
      record.key = key;
      record.url = uploaded.productionUrl;
      record.owned = true;
    } catch (err) {
      console.warn("[layer-asset] upload failed:", err);
      if (record.cancelled) recordsRef.current.delete(token);
      else record.status = "error";
    } finally {
      sourcesRef.current.delete(token);
    }
  }, [resolveTransport, designIdRef, deleteAsset]);

  const pump = useCallback(() => {
    while (activeCountRef.current < LAYER_ASSET_UPLOAD_CONCURRENCY && queueRef.current.length > 0) {
      const token = queueRef.current.shift()!;
      if (recordsRef.current.get(token)?.status !== "pending") continue;
      activeCountRef.current += 1;
      void runUpload(token).finally(() => {
        activeCountRef.current -= 1;
        pumpRef.current();
      });
    }
  }, [runUpload]);
  pumpRef.current = pump;

  const releaseToken = useCallback((token: string) => {
    const record = recordsRef.current.get(token);
    if (!record) return;
    if (record.status === "uploading") {
      record.cancelled = true;
      return;
    }
    recordsRef.current.delete(token);
    sourcesRef.current.delete(token);
    const transport = resolveTransport();
    if (record.status !== "uploaded" || !record.owned || !record.key || !transport) return;
    deleteAsset(record.key, transport);
  }, [resolveTransport, deleteAsset]);

  useEffect(() => {
    const transport = resolveTransport();
    const records = recordsRef.current;
    const gcTimers = gcTimersRef.current;
    const liveTokens = new Set<string>();

    for (const design of designs) {
      const token = layerContentToken(design);
      liveTokens.add(token);
      const pendingGc = gcTimers.get(token);
      if (pendingGc != null) {
        window.clearTimeout(pendingGc);
        gcTimers.delete(token);
      }
      const existing = records.get(token);
      if (existing) {
        existing.cancelled = false;
        continue;
      }

      const restored = restoredLayerAssetRef.current.get(design.id);
      if (restored && !seededLayerIdsRef.current.has(design.id)) {
        seededLayerIdsRef.current.add(design.id);
        const key = restored.key || r2KeyFromPublicUrl(restored.url);
        if (key) {
          records.set(token, {
            status: "uploaded",
            key,
            url: restored.url,
            mimeType: restored.mimeType || LAYER_ASSET_MIME,
            filename: `${layerAssetStem(design, design.id)}.png`,
            owned: false,
            cancelled: false,
          });
          continue;
        }
      }

      if (!transport) continue;
      records.set(token, {
        status: "pending",
        key: "",
        url: null,
        mimeType: LAYER_ASSET_MIME,
        filename: `${layerAssetStem(design, design.id)}.png`,
        owned: false,
        cancelled: false,
      });
      sourcesRef.current.set(token, design);
      queueRef.current.push(token);
    }

    for (const token of records.keys()) {
      if (liveTokens.has(token) || gcTimers.has(token)) continue;
      gcTimers.set(token, window.setTimeout(() => {
        gcTimers.delete(token);
        releaseToken(token);
      }, LAYER_ASSET_GC_DELAY_MS));
    }

    pump();
  }, [designs, shellConfigReady, resolveTransport, restoredLayerAssetRef, releaseToken, pump]);

  /** Uploaded asset for a layer, or null when its bytes still have to be embedded inline. */
  const getLayerAssetRef = useCallback((design: DesignItem): LayerAssetRef | null => {
    const record = recordsRef.current.get(layerContentToken(design));
    if (!record || record.status !== "uploaded" || !record.url || !record.key) return null;
    return { key: record.key, url: record.url, mimeType: record.mimeType, filename: record.filename };
  }, []);

  /** Called once a design state referencing these assets is saved: flush pending removals, then drop ownership. */
  const releaseLayerAssetOwnership = useCallback(() => {
    const gcTimers = gcTimersRef.current;
    for (const [token, timer] of gcTimers) {
      window.clearTimeout(timer);
      gcTimers.delete(token);
      releaseToken(token);
    }
    for (const record of recordsRef.current.values()) record.owned = false;
  }, [releaseToken]);

  return { getLayerAssetRef, releaseLayerAssetOwnership };
}

import { useCallback, useEffect, useRef } from "react";
import { canUseShellRelay, deleteR2Asset, uploadProductionToR2 } from "@/lib/r2-direct-upload";
import {
  LAYER_ASSET_MIME,
  layerAssetStem,
  layerBitmapToPngBlob,
  layerContentToken,
  layerScreenedContentToken,
  layerScreenedToPngBlob,
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

/**
 * "source" is the editable pre-screen asset every layer gets. "screened" is the extra, already-
 * rendered halftone raster that only halftoned layers get — the server cannot reproduce a dot
 * screen from the source, so the print file would come back smooth without it.
 */
type LayerAssetKind = "source" | "screened";

type LayerAssetRecord = {
  status: LayerAssetStatus;
  kind: LayerAssetKind;
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
    // Still a single flat segment under .../layers/, so the screened key needs no proxy allowlist
    // change — it already clears the existing layer-asset gate.
    const suffix = record.kind === "screened" ? "-screened" : "";
    const objectKey = `designs/${transport.shopKey}/${designIdRef.current}/layers/${token}-${layerAssetStem(source, token)}${suffix}.png`;
    try {
      const blob = record.kind === "screened"
        ? await layerScreenedToPngBlob(source)
        : await layerBitmapToPngBlob(source);
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
            kind: "source",
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
        kind: "source",
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

    // Second pass: the screened render, halftoned layers only. Its own token, its own record, and
    // therefore its own independent upload and GC lifecycle — including being swept when a
    // re-screen swaps imageInfo.image and the old token stops being live.
    for (const design of designs) {
      if (!design.halftoned) continue;
      const screenedToken = layerScreenedContentToken(design);
      liveTokens.add(screenedToken);
      const pendingGc = gcTimers.get(screenedToken);
      if (pendingGc != null) {
        window.clearTimeout(pendingGc);
        gcTimers.delete(screenedToken);
      }
      const existing = records.get(screenedToken);
      if (existing) {
        existing.cancelled = false;
        continue;
      }
      // No restore seeding here on purpose: restore only ever needs the pre-screen source, since it
      // re-derives the screen client-side. A restored design re-uploads its screened render once.
      if (!transport) continue;
      records.set(screenedToken, {
        status: "pending",
        kind: "screened",
        key: "",
        url: null,
        mimeType: LAYER_ASSET_MIME,
        filename: `${layerAssetStem(design, design.id)}-screened.png`,
        owned: false,
        cancelled: false,
      });
      sourcesRef.current.set(screenedToken, design);
      queueRef.current.push(screenedToken);
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

  /**
   * Uploaded SCREENED render for a halftoned layer, or null (not halftoned, or not up yet). The
   * server compositor must use this instead of the editable asset when settings.halftoned is set.
   */
  const getLayerScreenedAssetRef = useCallback((design: DesignItem): LayerAssetRef | null => {
    if (!design.halftoned) return null;
    const token = layerScreenedContentToken(design);
    const record = recordsRef.current.get(token);
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

  return { getLayerAssetRef, getLayerScreenedAssetRef, releaseLayerAssetOwnership };
}

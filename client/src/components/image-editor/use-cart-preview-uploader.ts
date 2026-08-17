import { useCallback, useEffect, useRef } from "react";
import { canUseShellRelay, uploadProductionToR2 } from "@/lib/r2-direct-upload";
import { designPreviewObjectKey } from "@/lib/design-object-keys";
import { designContentSignature } from "@/lib/design-content-signature";
import {
  computeDesignDrawSize,
  computeOutputPixelSize,
  computePreviewDpi,
} from "@/lib/gangsheet-geometry";
import { drawPrintLabel, labelReadsUpsideDown } from "@/lib/print-label";
import {
  CART_PREVIEW_DEBOUNCE_MS,
  CART_PREVIEW_MAX_DIMENSION,
  CART_PREVIEW_WAIT_MS,
} from "./constants";
import { getDesignLabel } from "./utils";
import type { DesignItem } from "@/lib/types";

/**
 * Renders and uploads the small cart thumbnail in the background, so Add-to-Cart never waits on a
 * full-resolution render just to show the customer a picture.
 *
 * Why getCartPreviewUrl is async rather than a plain getter: layer assets are cached by content, so
 * they survive moves — but a whole-sheet preview is invalidated by every drag, resize, rotate and
 * z-order change. At Add-to-Cart time the upload for the current arrangement is therefore normally
 * still in flight. A synchronous getter would far more often return null, or a URL whose bytes are
 * a previous arrangement, than the right answer.
 *
 * The preview object key is deterministic and fixed per design, so every upload overwrites the same
 * object and the URL string never changes. That means the URL alone proves nothing — we track WHICH
 * content signature's bytes are currently live at that key, and only hand out the URL once the live
 * bytes match the current arrangement.
 *
 * Deliberately renders on the main thread rather than through the export worker: this app's
 * export-worker.ts speaks a dedup'd sourceIndex/imageBuffer protocol built for the full-resolution
 * render pipeline, not a plain per-design bitmap. Reverse-engineering that wire format for a ~1500px
 * preview isn't worth it — a canvas this small, on a 700ms debounce, is cheap enough on the main
 * thread that offloading it buys nothing.
 */

type PreviewState = {
  /** Signature whose bytes are currently live at the preview key. */
  uploadedSig: string | null;
  url: string | null;
  inFlightSig: string | null;
  inFlight: Promise<string | null> | null;
};

type Transport = { uploadUrl: string; useShellRelay: boolean; shopKey: string };

/** Matches use-layer-asset-uploader: the proxy files designs under a sanitised id. */
function isAddressableDesignId(designId: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,79}$/.test(designId);
}

export function useCartPreviewUploader({
  designs,
  artboardWidth,
  artboardHeight,
  designIdRef,
  shellUploadUrlRef,
  shellShopKeyRef,
  shellConfigReady,
}: {
  designs: DesignItem[];
  artboardWidth: number;
  artboardHeight: number;
  designIdRef: React.MutableRefObject<string>;
  shellUploadUrlRef: React.MutableRefObject<string | null>;
  shellShopKeyRef: React.MutableRefObject<string | null>;
  shellConfigReady: boolean;
}) {
  const stateRef = useRef<PreviewState>({
    uploadedSig: null,
    url: null,
    inFlightSig: null,
    inFlight: null,
  });
  const designsRef = useRef<DesignItem[]>(designs);
  const artboardRef = useRef({ width: artboardWidth, height: artboardHeight });
  const debounceRef = useRef<number | null>(null);
  const aliveRef = useRef(true);

  designsRef.current = designs;
  artboardRef.current = { width: artboardWidth, height: artboardHeight };

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    };
  }, []);

  const resolveTransport = useCallback((): Transport | null => {
    const uploadUrl = shellUploadUrlRef.current?.trim() || "";
    const useShellRelay = canUseShellRelay();
    const shopKey = shellShopKeyRef.current?.trim() || "";
    if (!shopKey || (!uploadUrl && !useShellRelay)) return null;
    if (!isAddressableDesignId(designIdRef.current)) return null;
    return { uploadUrl, useShellRelay, shopKey };
  }, [shellUploadUrlRef, shellShopKeyRef, designIdRef]);

  /** Renders the sheet at preview scale, on the main thread — see file header. */
  const renderPreviewBlob = useCallback(async (items: DesignItem[], abW: number, abH: number) => {
    const dpi = computePreviewDpi(abW, abH, CART_PREVIEW_MAX_DIMENSION);
    const { outW, outH } = computeOutputPixelSize(abW, abH, dpi);

    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not supported");
    ctx.clearRect(0, 0, outW, outH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    for (const design of items) {
      const { drawW, drawH } = computeDesignDrawSize(
        design.widthInches,
        design.heightInches,
        design.transform.s,
        dpi,
      );
      ctx.save();
      ctx.translate(design.transform.nx * outW, design.transform.ny * outH);
      ctx.rotate((design.transform.rotation * Math.PI) / 180);
      ctx.scale(design.transform.flipX ? -1 : 1, design.transform.flipY ? -1 : 1);
      ctx.imageSmoothingEnabled = !design.alphaThresholded;
      ctx.drawImage(design.imageInfo.image, -drawW / 2, -drawH / 2, drawW, drawH);
      const label = getDesignLabel(design);
      const artH = design.heightInches * design.transform.s;
      if (label && artH > 0) {
        // Flip undone first: the layout's coordinates are in unflipped design space, and a
        // mirrored name would be worse than no name at all.
        ctx.scale(design.transform.flipX ? -1 : 1, design.transform.flipY ? -1 : 1);
        drawPrintLabel(ctx, label, drawH / artH, labelReadsUpsideDown(design.transform.rotation));
      }
      ctx.restore();
    }
    const blob: Blob = await new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"),
    );
    canvas.width = 0;
    canvas.height = 0;
    return blob;
  }, []);

  /** Renders + uploads for one signature. Resolves the URL, or null if it could not be produced. */
  const runUpload = useCallback(async (sig: string): Promise<string | null> => {
    const transport = resolveTransport();
    const items = designsRef.current;
    const { width: abW, height: abH } = artboardRef.current;
    if (!transport || !items.length || !(abW > 0) || !(abH > 0)) return null;
    const objectKey = designPreviewObjectKey(transport.shopKey, designIdRef.current);
    if (!objectKey) return null;
    try {
      const blob = await renderPreviewBlob(items, abW, abH);
      const uploaded = await uploadProductionToR2(blob, "cart-preview.png", transport.uploadUrl, undefined, {
        objectKey,
        useShellRelay: transport.useShellRelay,
        productionFormat: "png",
      });
      const url = uploaded.cartPreviewUrl || uploaded.productionUrl || null;
      if (!aliveRef.current || !url) return null;
      const state = stateRef.current;
      state.uploadedSig = sig;
      state.url = url;
      return url;
    } catch (err) {
      console.warn("[cart-preview] render/upload failed:", err);
      return null;
    }
  }, [resolveTransport, designIdRef, renderPreviewBlob]);

  /** Starts an upload for `sig` unless one is already running for it. */
  const ensureUpload = useCallback((sig: string): Promise<string | null> => {
    const state = stateRef.current;
    if (state.uploadedSig === sig && state.url) return Promise.resolve(state.url);
    if (state.inFlightSig === sig && state.inFlight) return state.inFlight;
    const promise = runUpload(sig).finally(() => {
      const s = stateRef.current;
      if (s.inFlightSig === sig) {
        s.inFlightSig = null;
        s.inFlight = null;
      }
    });
    state.inFlightSig = sig;
    state.inFlight = promise;
    return promise;
  }, [runUpload]);

  // Re-render the preview in the background whenever the arrangement settles.
  useEffect(() => {
    if (!shellConfigReady) return;
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      if (!aliveRef.current) return;
      if (!designs.length) return;
      const sig = designContentSignature(designs, artboardWidth, artboardHeight);
      if (stateRef.current.uploadedSig === sig) return;
      void ensureUpload(sig);
    }, CART_PREVIEW_DEBOUNCE_MS);
  }, [designs, artboardWidth, artboardHeight, shellConfigReady, ensureUpload]);

  /**
   * URL of a preview whose bytes match the CURRENT arrangement, or null.
   *
   * Null on timeout is a deliberate, graceful outcome: addLine simply omits _preview_url, which the
   * cart already tolerates (no thumbnail, not a broken image). Returning a stale URL instead would
   * put a picture of the wrong layout on the customer's cart line.
   */
  const getCartPreviewUrl = useCallback(async (): Promise<string | null> => {
    const items = designsRef.current;
    if (!items.length) return null;
    const { width: abW, height: abH } = artboardRef.current;
    const sig = designContentSignature(items, abW, abH);
    const state = stateRef.current;
    if (state.uploadedSig === sig && state.url) return state.url;

    // The debounce may not have fired yet (customer hit Add to Cart immediately) — start it now.
    if (debounceRef.current != null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const pending = ensureUpload(sig);
    let timer: number | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = window.setTimeout(() => resolve(null), CART_PREVIEW_WAIT_MS);
    });
    try {
      const url = await Promise.race([pending, timeout]);
      // Only trust the result if it is genuinely for the arrangement we were asked about.
      if (url && stateRef.current.uploadedSig === sig) return url;
      return null;
    } finally {
      if (timer != null) window.clearTimeout(timer);
    }
  }, [ensureUpload]);

  return { getCartPreviewUrl };
}

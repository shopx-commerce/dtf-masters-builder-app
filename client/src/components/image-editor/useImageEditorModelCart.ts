import { useCallback } from "react";
import { uploadProductionToR2, canUseShellRelay } from "@/lib/r2-direct-upload";
import { designProductionObjectKey } from "@/lib/design-object-keys";
import { designContentSignature } from "@/lib/design-content-signature";
import { EXPORT_DPI, EXPORT_TIMEOUT_MS } from "./constants";
import {
  getExportWorker,
  injectPngDpi,
  nextExportRequestId,
} from "./utils";
import type { ImageEditorBagAfterExport } from "./image-editor-hook-bag.types";
import type { InitialDesignState } from "./types";
import type { SpotPreviewData } from "../controls-section";
import { thresholdImageInfo } from "./useImageEditorModelHalftone";

/**
 * The extra dependency is declared narrowly rather than folded into the accumulated bag, so it is
 * obvious at the call site that this hook needs the cart-preview uploader.
 */
export function useImageEditorModelCart(
  bag: ImageEditorBagAfterExport & { getCartPreviewUrl: () => Promise<string | null> },
) {
  // Only the bag fields these two handlers actually use are destructured here;
  // the full bag is still re-spread into the return so downstream consumers are unaffected.
  const {
    initialDesignState,
    isEditMode,
    shopifyVariants,
    initialVariantId,
    shopDomain,
    toast,
    setIsProcessing,
    setIsAddingToCart,
    setIsUpdateFlow,
    setAddToCartProgressLabel,
    addToCartStallTimeoutRef,
    lastAddToCartPngBytesRef,
    shellUploadUrlRef,
    shellShopKeyRef,
    refreshAddToCartStallTimeout,
    artboardWidth,
    artboardHeight,
    quantity,
    designGap,
    designsRef,
    selectedDesignIdRef,
    selectedDesignIdsRef,
    assetDataUrlCacheRef,
    restoredLayerAssetRef,
    designIdRef,
    getLayerAssetRef,
    getLayerScreenedAssetRef,
    releaseLayerAssetOwnership,
    fileToDataUrl,
    addToCartInFlightRef,
    profile,
    spotPreviewData,
    getCartPreviewUrl,
  } = bag;

  const buildDesignStatePayload = useCallback(async () => {
    const currentDesigns = designsRef.current;
    const currentSelectedDesignId = selectedDesignIdRef.current;
    const currentSelectedDesignIds = selectedDesignIdsRef.current;
    const layers = currentDesigns.map((d, index) => ({
      layerId: d.id,
      name: d.name,
      type: "image",
      selected: d.id === currentSelectedDesignId || currentSelectedDesignIds.has(d.id),
      visible: true,
      locked: false,
      opacity: 1,
      zIndex: index,
      rotation: d.transform.rotation,
      x: d.transform.nx,
      y: d.transform.ny,
      width: d.widthInches,
      height: d.heightInches,
      scaleX: d.transform.s * (d.transform.flipX ? -1 : 1),
      scaleY: d.transform.s * (d.transform.flipY ? -1 : 1),
      settings: {
        alphaThresholded: Boolean(d.alphaThresholded),
        halftoned: Boolean(d.halftoned),
        halftoneSettings: d.halftoneSettings,
        printFileName: Boolean(d.printFileName),
        originalDpi: d.originalDPI,
      },
    }));

    const savedLayersById = new Map(
      (Array.isArray((initialDesignState as { layers?: unknown[] } | null)?.layers)
        ? (initialDesignState as { layers: Array<{ layerId?: string; name?: string; asset?: { url?: string; key?: string; mimeType?: string } }> }).layers
        : []
      ).map((l) => [String(l.layerId || ""), l]),
    );

    const layerAssetsBase = await Promise.all(
      currentDesigns.map(async (d) => {
        // Eagerly uploaded while designing — send the R2 reference instead of the bytes.
        const uploaded = getLayerAssetRef(d);
        if (uploaded) {
          return {
            layerId: d.id,
            filename: uploaded.filename,
            mimeType: uploaded.mimeType,
            url: uploaded.url,
            key: uploaded.key,
          };
        }

        const f = d.imageInfo?.file;
        const fileSig = f ? `${f.name}:${f.size}:${f.lastModified}` : "";
        const restored = restoredLayerAssetRef.current.get(d.id);
        const savedLayer = savedLayersById.get(d.id);
        const savedUrl = String(savedLayer?.asset?.url || restored?.url || "").trim();
        const savedKey = savedLayer?.asset?.key || restored?.key;

        // Edit: layer already in saved JSON — reuse R2 asset unless pixels changed (new upload).
        if (isEditMode && savedUrl && restored && fileSig && fileSig === restored.fileSig) {
          return {
            layerId: d.id,
            filename: f?.name || savedLayer?.name || null,
            mimeType: savedLayer?.asset?.mimeType || restored?.mimeType || f?.type || "image/png",
            url: savedUrl,
            key: savedKey ? String(savedKey) : undefined,
          };
        }

        if (!f) {
          return {
            layerId: d.id,
            filename: null,
            mimeType: null,
            dataUrl: null,
          };
        }
        const sig = fileSig;
        const cached = assetDataUrlCacheRef.current.get(d.id);
        if (cached?.sig === sig) {
          return {
            layerId: d.id,
            filename: f.name,
            mimeType: f.type || null,
            dataUrl: cached.dataUrl,
          };
        }
        const dataUrl = await fileToDataUrl(f);
        assetDataUrlCacheRef.current.set(d.id, { sig, dataUrl, filename: f.name, mimeType: f.type || undefined });
        return {
          layerId: d.id,
          filename: f.name,
          mimeType: f.type || null,
          dataUrl,
        };
      }),
    );
    // Halftoned layers carry a second asset: the already-screened render. The uploaded `asset`
    // above is deliberately the PRE-screen source (so restore can re-screen once), which the server
    // cannot turn back into a dot screen — it depends on OKLab tolerance/feather, a strength preset
    // and the design's printed size. Additive and absent for every non-halftoned layer.
    const layerAssets = layerAssetsBase.map((entry, index) => {
      const screened = getLayerScreenedAssetRef(currentDesigns[index]);
      if (!screened) return entry;
      return {
        ...entry,
        renderedAsset: {
          filename: screened.filename,
          mimeType: screened.mimeType,
          url: screened.url,
          key: screened.key,
        },
      };
    });
    releaseLayerAssetOwnership();

    return {
      designId: designIdRef.current,
      builderPath: typeof window !== "undefined" ? window.location.pathname : null,
      canvas: {
        artboardWidthInches: artboardWidth,
        artboardHeightInches: artboardHeight,
        outputDpi: EXPORT_DPI,
      },
      settings: {
        quantity,
        designGap,
      },
      gangsheetSize: `${artboardWidth}" x ${artboardHeight}"`,
      layers,
      layerAssets,
    };
  }, [
    fileToDataUrl,
    artboardWidth,
    artboardHeight,
    quantity,
    designGap,
    initialDesignState,
    isEditMode,
    designsRef,
    selectedDesignIdRef,
    selectedDesignIdsRef,
    restoredLayerAssetRef,
    assetDataUrlCacheRef,
    designIdRef,
    getLayerAssetRef,
    getLayerScreenedAssetRef,
    releaseLayerAssetOwnership,
  ]);

  const handleAddToCart = useCallback(async () => {
    if (addToCartInFlightRef.current) return;
    if (designsRef.current.length === 0) {
      toast({ title: "No designs", description: "Add at least one design before adding to cart.", variant: "destructive" });
      return;
    }
    addToCartInFlightRef.current = true;
    setIsAddingToCart(true);
    setIsUpdateFlow(isEditMode);
    setIsProcessing(true);
    if (addToCartStallTimeoutRef.current != null) {
      window.clearTimeout(addToCartStallTimeoutRef.current);
      addToCartStallTimeoutRef.current = null;
    }
    try {
      const exportProductionPng = async (): Promise<{ pngBlob: Blob; exportWorkerBuffer: ArrayBuffer | null }> => {
        const currentDesigns = designsRef.current;
        const cleaned = new Map<string, import("@/lib/types").ImageInfo>();
        await Promise.all(
          currentDesigns
            .filter(d => d.halftoned)
            .map(async d => {
              const info = await thresholdImageInfo(d.imageInfo);
              if (info) cleaned.set(d.id, info);
            }),
        );
        const exportDesignsSource = currentDesigns.map(d =>
          cleaned.has(d.id) ? { ...d, imageInfo: cleaned.get(d.id)! } : d,
        );
        const exportDpi = EXPORT_DPI;
        const outW = Math.max(1, Math.round(artboardWidth * exportDpi));
        const outH = Math.max(1, Math.round(artboardHeight * exportDpi));
        const worker = getExportWorker();
        const useWorker = worker && typeof OffscreenCanvas !== 'undefined';
        let pngBlob: Blob;
        let exportWorkerBuffer: ArrayBuffer | null = null;

        if (useWorker) {
          const bitmaps = await Promise.all(exportDesignsSource.map((d) => createImageBitmap(d.imageInfo.image)));
          const exportDesigns = exportDesignsSource.map((d, i) => ({
            widthInches: d.widthInches,
            heightInches: d.heightInches,
            nx: d.transform.nx,
            ny: d.transform.ny,
            s: d.transform.s,
            rotation: d.transform.rotation,
            flipX: d.transform.flipX,
            flipY: d.transform.flipY,
            bitmap: bitmaps[i],
            alphaThresholded: d.alphaThresholded,
            printFileName: d.printFileName,
            name: d.name,
          }));
          const requestId = nextExportRequestId();
          const exportResult = await new Promise<{ buffer: ArrayBuffer; byteLength: number }>((resolve, reject) => {
            const timer = window.setTimeout(() => reject(new Error('Export timed out — sheet may be too large.')), EXPORT_TIMEOUT_MS);
            const onMessage = (e: MessageEvent) => {
              if (e.data.requestId !== requestId) return;
              worker.removeEventListener('message', onMessage);
              window.clearTimeout(timer);
              if (e.data.type === 'error') reject(new Error(e.data.error));
              else if (e.data.buffer) {
                const buf = e.data.buffer as ArrayBuffer;
                const byteLength = Number(e.data.byteLength) > 0 ? Number(e.data.byteLength) : buf.byteLength;
                resolve({ buffer: buf, byteLength });
              }
              else reject(new Error('Export returned no image data'));
            };
            worker.addEventListener('message', onMessage);
            worker.postMessage({ type: 'export', requestId, designs: exportDesigns, outW, outH, exportDpi }, bitmaps);
          });
          exportWorkerBuffer = exportResult.buffer;
          pngBlob = new Blob([exportWorkerBuffer], { type: 'image/png' });
        } else {
          const exportCanvas = document.createElement('canvas');
          exportCanvas.width = outW;
          exportCanvas.height = outH;
          const ctx = exportCanvas.getContext('2d');
          if (!ctx) throw new Error('Canvas not supported');
          ctx.clearRect(0, 0, outW, outH);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          for (const design of exportDesignsSource) {
            const img = design.imageInfo.image;
            const drawW = Math.max(1, Math.round(design.widthInches * design.transform.s * exportDpi));
            const drawH = Math.max(1, Math.round(design.heightInches * design.transform.s * exportDpi));
            const centerX = design.transform.nx * outW;
            const centerY = design.transform.ny * outH;
            ctx.save();
            ctx.translate(centerX, centerY);
            ctx.rotate((design.transform.rotation * Math.PI) / 180);
            ctx.scale(design.transform.flipX ? -1 : 1, design.transform.flipY ? -1 : 1);
            ctx.imageSmoothingEnabled = !design.alphaThresholded;
            ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
            ctx.imageSmoothingEnabled = true;
            ctx.restore();
          }
          const rawBlob: Blob = await new Promise((res, rej) =>
            exportCanvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'),
          );
          exportCanvas.width = 0;
          exportCanvas.height = 0;
          pngBlob = await injectPngDpi(rawBlob, exportDpi);
        }
        return { pngBlob, exportWorkerBuffer };
      };

      const exportProductionPdf = async (): Promise<Blob> => {
        const { PDFDocument, degrees, StandardFonts } = await import("pdf-lib");
        const { addSpotColorVectorsToPDF } = await import("@/lib/spot-color-vectors");
        const pdfDoc = await PDFDocument.create();
        const pageWidthPt = artboardWidth * 72;
        const pageHeightPt = artboardHeight * 72;
        const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);
        const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const exportDpi = EXPORT_DPI;

        const currentDesigns = designsRef.current;
        const cleaned = new Map<string, import("@/lib/types").ImageInfo>();
        await Promise.all(
          currentDesigns
            .filter(d => d.halftoned)
            .map(async d => {
              const info = await thresholdImageInfo(d.imageInfo);
              if (info) cleaned.set(d.id, info);
            }),
        );
        const exportDesignsSource = currentDesigns.map(d =>
          cleaned.has(d.id) ? { ...d, imageInfo: cleaned.get(d.id)! } : d,
        );
        for (const design of exportDesignsSource) {
          const drawW = Math.max(1, Math.round(design.widthInches * design.transform.s * exportDpi));
          const drawH = Math.max(1, Math.round(design.heightInches * design.transform.s * exportDpi));
          const canvas = document.createElement("canvas");
          canvas.width = drawW;
          canvas.height = drawH;
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          ctx.imageSmoothingEnabled = !design.alphaThresholded;
          ctx.imageSmoothingQuality = "high";
          ctx.save();
          ctx.translate(design.transform.flipX ? drawW : 0, design.transform.flipY ? drawH : 0);
          ctx.scale(design.transform.flipX ? -1 : 1, design.transform.flipY ? -1 : 1);
          ctx.drawImage(design.imageInfo.image, 0, 0, drawW, drawH);
          ctx.restore();

          const dataUrl = canvas.toDataURL("image/png");
          const base64 = dataUrl.split(",")[1];
          if (!base64) continue;
          const pngBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          const image = await pdfDoc.embedPng(pngBytes);
          const widthPt = design.widthInches * design.transform.s * 72;
          const heightPt = design.heightInches * design.transform.s * 72;
          const centerX = design.transform.nx * pageWidthPt;
          const centerY = pageHeightPt - design.transform.ny * pageHeightPt;
          const rotation = design.transform.rotation ?? 0;
          const radians = (-rotation * Math.PI) / 180;
          const cos = Math.cos(radians);
          const sin = Math.sin(radians);

          page.drawImage(image, {
            x: centerX - (widthPt / 2) * cos + (heightPt / 2) * sin,
            y: centerY - (widthPt / 2) * sin - (heightPt / 2) * cos,
            width: widthPt,
            height: heightPt,
            rotate: degrees(-rotation),
          });

          if (design.printFileName) {
            const label = design.name.replace(/\.[^/.]+$/, "");
            const size = Math.max(4, Math.round(0.08 * 72));
            const margin = 0.02 * 72;
            const textWidth = font.widthOfTextAtSize(label, size);
            page.drawText(label, {
              x: centerX + (widthPt / 2) * cos - (heightPt / 2) * sin - textWidth - margin,
              y: centerY - (widthPt / 2) * sin - (heightPt / 2) * cos + margin,
              size,
              font,
              rotate: degrees(-rotation),
            });
          }

          const colors = (spotPreviewData as SpotPreviewData | undefined)?.colors;
          if (colors?.some((color) => color.spotFluorY || color.spotFluorM || color.spotFluorG || color.spotFluorOrange)) {
            const offsetX = design.transform.nx * artboardWidth - (design.widthInches * design.transform.s) / 2;
            const offsetY = design.transform.ny * artboardHeight - (design.heightInches * design.transform.s) / 2;
            await addSpotColorVectorsToPDF(
              pdfDoc,
              page,
              design.imageInfo.image,
              colors,
              design.widthInches * design.transform.s,
              design.heightInches * design.transform.s,
              artboardHeight,
              offsetX,
              offsetY,
              rotation,
            );
          }
          canvas.width = 0;
          canvas.height = 0;
        }

        return new Blob([await pdfDoc.save()], { type: "application/pdf" });
      };

      // Skip re-export/re-upload on update when nothing rendered has actually changed.
      const existingProduction = (initialDesignState as { production?: { url?: string | null; key?: string | null; previewUrl?: string | null; status?: string | null } } | null)?.production;

      const roundSig = (v: unknown) => {
        const n = Number(v);
        return Number.isFinite(n) ? n.toFixed(6) : "x";
      };
      // Shared with the cart-preview upload cache — see lib/design-content-signature.ts.
      const currentContentSig = (): string =>
        designContentSignature(designsRef.current, artboardWidth, artboardHeight);
      const savedContentSig = (): string | null => {
        const st = initialDesignState as InitialDesignState | null;
        if (!st) return null;
        const abW = Number(st.canvas?.artboardWidthInches ?? st.canvas?.width);
        const abH = Number(st.canvas?.artboardHeightInches ?? st.canvas?.height);
        if (!Number.isFinite(abW) || !Number.isFinite(abH) || abW <= 0 || abH <= 0) return null;
        const savedLayers = Array.isArray(st.layers) ? st.layers : [];
        const parts = [`ab:${roundSig(abW)}x${roundSig(abH)}`];
        for (const l of savedLayers) {
          // Mirror the restore filter (use-restore-design-state): production-reference and
          // non-http layers are not restored, so they must not appear in the comparison.
          if (String(l.asset?.source || "") === "production-reference") continue;
          const url = String(l.asset?.url || "").trim();
          if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
          const layerId = String(l.layerId || "");
          const restored = restoredLayerAssetRef.current.get(layerId);
          if (!restored?.fileSig) return null; // can't confirm pixels unchanged → don't skip
          const sx = Number(l.scaleX);
          const sy = Number(l.scaleY);
          const s =
            Number.isFinite(sx) && sx !== 0 ? Math.abs(sx)
            : Number.isFinite(sy) && sy !== 0 ? Math.abs(sy)
            : NaN;
          const settings = l.settings as { alphaThresholded?: unknown; printFileName?: unknown } | null | undefined;
          const alphaThresholded = Boolean(settings?.alphaThresholded);
          const printFileName = Boolean(settings?.printFileName);
          parts.push(
            `${layerId}|${roundSig(l.width)}|${roundSig(l.height)}|${roundSig(l.x)}|${roundSig(l.y)}|${roundSig(s)}|${roundSig(l.rotation)}|${sx < 0 ? 1 : 0}|${sy < 0 ? 1 : 0}|${alphaThresholded ? 1 : 0}|${printFileName ? 1 : 0}|${String(l.name || "")}|${restored.fileSig}`,
          );
        }
        return parts.join("~");
      };

      // Reusable only if a print file genuinely exists. With production now generated
      // asynchronously, an edit-load can find production.url already set — it is derived from the
      // deterministic key upfront — while the file itself is still pending or has failed. Checking
      // the URL alone would treat those as reusable and ship a cart line pointing at nothing.
      const existingProductionReady =
        Boolean(existingProduction?.url) &&
        (existingProduction?.status == null || existingProduction.status === "ready");

      let canReuseProduction = false;
      if (isEditMode && existingProductionReady && profile?.id !== "fluorescent") {
        const savedSig = savedContentSig();
        const curSig = currentContentSig();
        canReuseProduction = Boolean(savedSig && curSig && savedSig === curSig);
      }

      const productionIsPdf = profile?.id === "fluorescent";

      const selectedVariant = shopifyVariants?.find((v) => v.height != null && Math.abs(v.height - artboardHeight) < 0.01);
      const vid = selectedVariant?.id || initialVariantId || '';
      const vidDigits = vid.replace(/\D/g, '');

      if (!vidDigits) throw new Error('No variant ID available');
      if (!shopDomain) throw new Error('Shop domain missing — open the builder from the storefront product page.');

      const filename = `gangsheet-${Date.now()}.${productionIsPdf ? "pdf" : "png"}`;
      const existingProductionKey =
        isEditMode && existingProduction?.key ? String(existingProduction.key) : undefined;
      const reusableProductionKey =
        existingProductionKey &&
        existingProductionKey.toLowerCase().endsWith(productionIsPdf ? ".pdf" : ".png")
          ? existingProductionKey
          : undefined;
      // A new design gets the deterministic key so the print file URL is knowable before the file
      // exists. Reuse always wins, so an existing design (legacy key shape included) keeps the
      // exact key its state JSON and any placed order already point at.
      // PDF (fluorescent) is deliberately excluded: the deterministic key is .png, and the proxy
      // has no server-side PDF production path at all.
      const productionKey =
        reusableProductionKey ||
        (productionIsPdf
          ? undefined
          : designProductionObjectKey(shellShopKeyRef.current, designIdRef.current) || undefined);
      const uploadUrl = shellUploadUrlRef.current?.trim() || '';
      const uploadInBuilder = canUseShellRelay() || Boolean(uploadUrl);
      const onUploadProgress = (msg: string) => setAddToCartProgressLabel(msg);

      /**
       * Per-design eligibility to skip the client 300-DPI render and let the server produce the
       * print file. Deliberately per-design rather than a global switch, so a design the server
       * cannot yet reproduce simply keeps today's behaviour instead of shipping a wrong file.
       *
       *  (a) every layer is already uploaded to R2 as a real asset the server can fetch;
       *  (b) every halftoned layer also has its screened render uploaded — the server cannot
       *      re-derive a dot screen, so without this the print file would come back smooth;
       *  (c) not the fluorescent/PDF profile, whose spot-colour data is never persisted and which
       *      the server provably cannot reproduce;
       *  (d) a deterministic production key exists, so the server knows where to write.
       */
      const serverRenderEligible = (() => {
        if (productionIsPdf || !productionKey) return false;
        const items = designsRef.current;
        if (!items.length) return false;
        return items.every((d) => {
          if (!getLayerAssetRef(d)) return false;
          if (d.halftoned && !getLayerScreenedAssetRef(d)) return false;
          return true;
        });
      })();

      let productionBlob: Blob | null = null;
      let exportWorkerBuffer: ArrayBuffer | null = null;
      let designState: Awaited<ReturnType<typeof buildDesignStatePayload>>;
      if (canReuseProduction || serverRenderEligible) {
        // No pixel work at all: either nothing rendered changed, or the server is producing the
        // print file. This is the actual speedup — a 816 MP sheet no longer renders in the browser.
        designState = await buildDesignStatePayload();
      } else if (productionIsPdf) {
        const [pdf, fluorescentDesignState] = await Promise.all([exportProductionPdf(), buildDesignStatePayload()]);
        productionBlob = pdf;
        designState = fluorescentDesignState;
      } else {
        const [exp, pngDesignState] = await Promise.all([exportProductionPng(), buildDesignStatePayload()]);
        productionBlob = exp.pngBlob;
        exportWorkerBuffer = exp.exportWorkerBuffer;
        designState = pngDesignState;
      }
      // Reset to 0 when nothing was rendered, so the stall-timeout watchdog is not fed a stale (or
      // production-sized) byte count and the loader clears in seconds instead of minutes.
      lastAddToCartPngBytesRef.current = productionBlob ? productionBlob.size : 0;

      let productionUrl: string | null = null;
      let cartPreviewUrl: string | null = null;
      let uploadedProductionKey: string | null = productionKey || null;
      let exportBufferForUpload = exportWorkerBuffer;

      if (canReuseProduction && existingProduction?.url) {
        // Nothing affecting the sheet changed — point at the already-uploaded production PNG.
        productionUrl = String(existingProduction.url);
        cartPreviewUrl = existingProduction.previewUrl ? String(existingProduction.previewUrl) : productionUrl;
        uploadedProductionKey = existingProduction.key ? String(existingProduction.key) : uploadedProductionKey;
        setAddToCartProgressLabel(undefined);
      } else if (serverRenderEligible) {
        // Nothing to upload: there is no client-rendered production file. The cart line carries the
        // deterministic key, and the shell derives the final print-file URL from it — the link is
        // knowable before the bytes exist. Only the small preview is fetched here.
        cartPreviewUrl = await getCartPreviewUrl();
        setAddToCartProgressLabel(undefined);
      } else if (uploadInBuilder) {
        const uploadOpts = {
          // Never fall back to `filename` here. A bare filename is not a valid object key, and
          // since Phase 2 the proxy rejects an unrecognized key outright instead of quietly
          // swapping in a random one — which surfaced as "The store upload relay did not accept
          // the PNG production file" on every new design. Omitting objectKey is the correct way
          // to say "server, you pick".
          objectKey: productionKey,
          // Inside the shell the relay is the only reliable transport; uploadUrl is the shell's own.
          useShellRelay: canUseShellRelay(),
          productionFormat: productionIsPdf ? "pdf" as const : "png" as const,
        };
        const uploadBody =
          exportBufferForUpload && exportBufferForUpload.byteLength > 0
            ? new Blob([exportBufferForUpload], { type: "image/png" })
            : productionBlob;
        try {
          const uploaded = await uploadProductionToR2(
            uploadBody as Blob,
            filename,
            uploadUrl,
            onUploadProgress,
            uploadOpts,
          );
          productionUrl = uploaded.productionUrl;
          uploadedProductionKey = uploaded.key || uploadedProductionKey;
          exportBufferForUpload = null;
          // Prefer the small client-rendered preview over the server's shrink-the-production-PNG
          // derivative, which no longer exists. Falls back to the full-res URL, which is what the
          // derivative itself fell back to, so the cart still gets a thumbnail either way.
          cartPreviewUrl = (await getCartPreviewUrl()) || uploaded.cartPreviewUrl || uploaded.productionUrl;
        } catch (uploadErr) {
          const detail = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
          console.warn("[handleAddToCart] Builder R2 upload failed, falling back to parent shell:", detail);
          setAddToCartProgressLabel(undefined);
          // Parent shell can upload via signed proxy URL when builder→R2 or shell relay fails.
        }
      }

      const message = {
        type: isEditMode ? 'dtf-builder-save-design' : 'dtf-builder-add-to-cart',
        variantId: vidDigits,
        quantity: quantity,
        gangsheetSize: artboardWidth + '" x ' + artboardHeight + '"',
        shop: shopDomain || '',
        filename,
        productionExport: true,
        dedupId: `${isEditMode ? "upd" : "atc"}-${vidDigits}-${Date.now()}`,
        designState,
        builderUploaded: Boolean(productionUrl),
        productionFormat: productionIsPdf ? "pdf" : "png",
        // Sent independently of productionUrl on purpose: when the render is skipped there is no
        // uploaded URL yet, but the deterministic key must still reach the state JSON and the cart
        // line — the shell derives the print-file URL from it.
        ...(uploadedProductionKey ? { productionKey: uploadedProductionKey } : {}),
        ...(productionUrl ? { productionUrl } : {}),
        ...(cartPreviewUrl || productionUrl
          ? { cartPreviewUrl: cartPreviewUrl || productionUrl }
          : {}),
        ...(isEditMode && existingProduction?.url && !productionUrl
          ? { productionUrl: String(existingProduction.url), cartPreviewUrl: existingProduction.previewUrl ? String(existingProduction.previewUrl) : String(existingProduction.url) }
          : {}),
        builderVersion: (import.meta as unknown as { env?: { VITE_APP_VERSION?: string } })?.env?.VITE_APP_VERSION || "builder-unversioned",
      };

      const pngByteLength = lastAddToCartPngBytesRef.current;

      // `serverRenderEligible` must short-circuit this guard: there is intentionally no production
      // file to hand over, so treating that as an upload failure would turn every eligible
      // Add-to-Cart into a hard error.
      if (!productionUrl && !serverRenderEligible) {
        if (!productionBlob || !productionBlob.size) throw new Error("Empty design file");
        if (canUseShellRelay()) {
          throw new Error(
            `The store upload relay did not accept the ${productionIsPdf ? "PDF" : "PNG"} production file. Please refresh the storefront and try again.`,
          );
        }
        const productionBuffer = await productionBlob.arrayBuffer();
        const messageWithFile = message as { pngBuffer?: ArrayBuffer; pdfBuffer?: ArrayBuffer; productionMimeType?: string };
        if (productionIsPdf) {
          messageWithFile.pdfBuffer = productionBuffer;
          messageWithFile.productionMimeType = "application/pdf";
        } else {
          messageWithFile.pngBuffer = productionBuffer;
          messageWithFile.productionMimeType = "image/png";
        }
        window.parent.postMessage(message, '*', [productionBuffer]);
        refreshAddToCartStallTimeout(pngByteLength || productionBuffer.byteLength);
      } else {
        window.parent.postMessage(message, '*');
        refreshAddToCartStallTimeout(canReuseProduction ? 0 : pngByteLength);
      }
      // Keep loading state until parent redirects (upload runs in parent). Do not clear in finally.
    } catch (error) {
      console.error('Add to cart failed:', error);
      toast({
        title: isEditMode ? "Update failed" : "Failed",
        description: error instanceof Error ? error.message : (isEditMode ? "Could not update design" : "Could not add to cart"),
        variant: "destructive"
      });
      addToCartInFlightRef.current = false;
      setIsAddingToCart(false);
      setIsUpdateFlow(false);
      setIsProcessing(false);
      if (addToCartStallTimeoutRef.current != null) {
        window.clearTimeout(addToCartStallTimeoutRef.current);
        addToCartStallTimeoutRef.current = null;
      }
    }
  }, [artboardWidth, artboardHeight, quantity, shopifyVariants, initialVariantId, shopDomain, toast, refreshAddToCartStallTimeout, buildDesignStatePayload, isEditMode, initialDesignState, setIsAddingToCart, setIsUpdateFlow, setIsProcessing, setAddToCartProgressLabel, addToCartStallTimeoutRef, lastAddToCartPngBytesRef, shellUploadUrlRef, shellShopKeyRef, designIdRef, designsRef, getLayerAssetRef, getLayerScreenedAssetRef, getCartPreviewUrl, profile, spotPreviewData]);

  return {
    ...bag,
    buildDesignStatePayload,
    handleAddToCart,
  };
}

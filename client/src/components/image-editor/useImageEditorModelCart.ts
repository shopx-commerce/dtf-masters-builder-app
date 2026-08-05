import { useCallback } from "react";
import { uploadProductionToR2, canUseShellRelay } from "@/lib/r2-direct-upload";
import { EXPORT_DPI, EXPORT_TIMEOUT_MS } from "./constants";
import {
  canUseMemoryEfficientPngExport,
  exportPngWithWorker,
  getExportMemoryWarning,
  injectPngDpi,
} from "./utils";
import type { ImageEditorBagAfterExport } from "./image-editor-hook-bag.types";
import type { InitialDesignState } from "./types";
import type { SpotPreviewData } from "../controls-section";
import { thresholdImageInfo } from "./useImageEditorModelHalftone";
import { isRecoverableImageInfo } from "@/lib/editor-draft-storage";

function postMessageToParent(message: unknown, transfer?: Transferable[]): void {
  try {
    if (transfer?.length) {
      window.parent.postMessage(message, "*", transfer);
    } else {
      window.parent.postMessage(message, "*");
    }
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error);
    if (/postmessage|clone|memory|out of memory|data cannot be cloned/i.test(detail)) {
      throw new Error(
        "This sheet is too large to transfer to the storefront. Your work is still saved; please refresh and try again.",
      );
    }
    throw error;
  }
}

export function useImageEditorModelCart(bag: ImageEditorBagAfterExport) {
  // Only the bag fields these two handlers actually use are destructured here;
  // the full bag is still re-spread into the return so downstream consumers are unaffected.
  const {
    initialDesignState,
    initialDesignId,
    isEditMode,
    shopifyVariants,
    initialVariantId,
    shopDomain,
    toast,
    setIsProcessing,
    setExportProgressLabel,
    setIsAddingToCart,
    setIsUpdateFlow,
    setAddToCartProgressLabel,
    addToCartStallTimeoutRef,
    lastAddToCartPngBytesRef,
    shellUploadUrlRef,
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
    fileToDataUrl,
    addToCartInFlightRef,
    profile,
    spotPreviewData,
    t,
    ensureDesignImagesAvailable,
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

    const layerAssets = await Promise.all(
      currentDesigns.map(async (d) => {
        const f = d.imageInfo?.file;
        const fileSig = f ? `${f.name}:${f.size}:${f.lastModified}` : "";
        const restored = restoredLayerAssetRef.current.get(d.id);
        const savedLayer = savedLayersById.get(d.id);
        const savedUrl = String(savedLayer?.asset?.url || restored?.url || "").trim();
        const savedKey = savedLayer?.asset?.key || restored?.key;

        // Edit: layer already in saved JSON — reuse R2 asset unless pixels changed (new upload).
        if (isEditMode && savedUrl && restored && !restored.needsUpload && fileSig && fileSig === restored.fileSig) {
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
        let dataUrl: string;
        try {
          dataUrl = await fileToDataUrl(f);
        } catch (readError) {
          console.warn("[buildDesignStatePayload] file read failed; attempting draft rehydration", {
            designId: d.id,
            error: readError,
          });
          const repaired = await ensureDesignImagesAvailable([d], new Set([d.id]));
          const repairedDesign = repaired.find(candidate => candidate.id === d.id);
          if (!repairedDesign?.imageInfo?.file) {
            throw readError;
          }
          dataUrl = await fileToDataUrl(repairedDesign.imageInfo.file);
          return {
            layerId: d.id,
            filename: repairedDesign.imageInfo.file.name,
            mimeType: repairedDesign.imageInfo.file.type || null,
            dataUrl,
          };
        }
        assetDataUrlCacheRef.current.set(d.id, { sig, dataUrl, filename: f.name, mimeType: f.type || undefined });
        return {
          layerId: d.id,
          filename: f.name,
          mimeType: f.type || null,
          dataUrl,
        };
      }),
    );

    return {
      designId:
        (initialDesignState as { designId?: string | null } | null)?.designId ||
        initialDesignId ||
        null,
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
    initialDesignId,
    isEditMode,
    designsRef,
    selectedDesignIdRef,
    selectedDesignIdsRef,
    restoredLayerAssetRef,
    assetDataUrlCacheRef,
    ensureDesignImagesAvailable,
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
      const repairedDesigns = await ensureDesignImagesAvailable(designsRef.current);
      if (repairedDesigns.some(design => !isRecoverableImageInfo(design.imageInfo))) {
        throw new Error("A design image could not be reloaded. Your progress is saved; recover the draft and try again.");
      }
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
        const useWorker = canUseMemoryEfficientPngExport();
        const memoryWarning = getExportMemoryWarning();
        if (memoryWarning) {
          toast({
            title: t("toast.exportMemoryWarning"),
            description: memoryWarning,
          });
        }
        let pngBlob: Blob;
        let exportWorkerBuffer: ArrayBuffer | null = null;

        if (useWorker) {
          const result = await exportPngWithWorker({
            designs: exportDesignsSource.map(d => ({
              widthInches: d.widthInches,
              heightInches: d.heightInches,
              nx: d.transform.nx,
              ny: d.transform.ny,
              s: d.transform.s,
              rotation: d.transform.rotation,
              flipX: d.transform.flipX,
              flipY: d.transform.flipY,
              image: d.imageInfo.image,
              alphaThresholded: d.alphaThresholded,
              printFileName: d.printFileName,
              name: d.name,
            })),
            outW,
            outH,
            exportDpi,
            onProgress: ({ phase, completed, total }) => {
              if (phase === "preparing") setExportProgressLabel("Preparing export...");
              else if (phase === "rendering") setExportProgressLabel(`Rendering strip ${completed} of ${total}...`);
              else setExportProgressLabel("Finalizing PNG...");
            },
          });
          exportWorkerBuffer = result.buffer;
          pngBlob = new Blob([exportWorkerBuffer], { type: 'image/png' });
        } else {
          toast({
            title: t("toast.exportCompatibilityWarning"),
            description: t("toast.exportCompatibilityWarningDesc"),
          });
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
              colors.map((color) => ({
                hex: color.hex,
                rgb: color.rgb,
                spotWhite: Boolean(color.spotWhite),
                spotGloss: Boolean(color.spotGloss),
                spotFluorY: Boolean(color.spotFluorY),
                spotFluorM: Boolean(color.spotFluorM),
                spotFluorG: Boolean(color.spotFluorG),
                spotFluorOrange: Boolean(color.spotFluorOrange),
              })),
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
      const existingProduction = (initialDesignState as { production?: { url?: string | null; key?: string | null; previewUrl?: string | null } } | null)?.production;

      const roundSig = (v: unknown) => {
        const n = Number(v);
        return Number.isFinite(n) ? n.toFixed(6) : "x";
      };
      // Must cover every field the renderer reads, or a real visual change could go undetected.
      const currentContentSig = (): string => {
        const parts = [`ab:${roundSig(artboardWidth)}x${roundSig(artboardHeight)}`];
        for (const d of designsRef.current) {
          const f = d.imageInfo?.file;
          const fileSig = f ? `${f.name}:${f.size}:${f.lastModified}` : "";
          const t = d.transform;
          parts.push(
            `${d.id}|${roundSig(d.widthInches)}|${roundSig(d.heightInches)}|${roundSig(t.nx)}|${roundSig(t.ny)}|${roundSig(t.s)}|${roundSig(t.rotation)}|${t.flipX ? 1 : 0}|${t.flipY ? 1 : 0}|${d.alphaThresholded ? 1 : 0}|${d.printFileName ? 1 : 0}|${String(d.name || "")}|${fileSig}`,
          );
        }
        return parts.join("~");
      };
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

      let canReuseProduction = false;
      if (isEditMode && existingProduction?.url && profile?.id !== "fluorescent") {
        const savedSig = savedContentSig();
        const curSig = currentContentSig();
        canReuseProduction = Boolean(savedSig && curSig && savedSig === curSig);
      }

      let productionBlob: Blob | null = null;
      let exportWorkerBuffer: ArrayBuffer | null = null;
      const productionIsPdf = profile?.id === "fluorescent";
      let designState: Awaited<ReturnType<typeof buildDesignStatePayload>>;
      if (canReuseProduction) {
        // Only the (small) design-state JSON needs rebuilding — no pixel work at all.
        designState = await buildDesignStatePayload();
      } else {
        if (productionIsPdf) {
          const [pdf, fluorescentDesignState] = await Promise.all([exportProductionPdf(), buildDesignStatePayload()]);
          productionBlob = pdf;
          designState = fluorescentDesignState;
        } else {
          const [exp, pngDesignState] = await Promise.all([exportProductionPng(), buildDesignStatePayload()]);
          productionBlob = exp.pngBlob;
          exportWorkerBuffer = exp.exportWorkerBuffer;
          designState = pngDesignState;
        }
      }
      // Reset to 0 on reuse so the stall-timeout watchdog isn't fed a stale byte count.
      lastAddToCartPngBytesRef.current = productionBlob ? productionBlob.size : 0;

      const selectedVariant = shopifyVariants?.find((v) => v.height != null && Math.abs(v.height - artboardHeight) < 0.01);
      const vid = selectedVariant?.id || initialVariantId || '';
      const vidDigits = vid.replace(/\D/g, '');

      if (!vidDigits) throw new Error('No variant ID available');
      if (!shopDomain) throw new Error('Shop domain missing — open the builder from the storefront product page.');

      const filename = `gangsheet-${Date.now()}.${productionIsPdf ? "pdf" : "png"}`;
      const existingProductionKey =
        isEditMode && existingProduction?.key ? String(existingProduction.key) : undefined;
      const productionKey =
        existingProductionKey &&
        existingProductionKey.toLowerCase().endsWith(productionIsPdf ? ".pdf" : ".png")
          ? existingProductionKey
          : undefined;
      const uploadUrl = shellUploadUrlRef.current?.trim() || '';
      const uploadInBuilder = canUseShellRelay() || Boolean(uploadUrl);
      const onUploadProgress = (msg: string) => setAddToCartProgressLabel(msg);

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
      } else if (uploadInBuilder) {
        const uploadOpts = {
          objectKey: productionKey || filename,
          // Prefer the signed upload endpoint when the parent provides one.
          // The legacy shell relay may still return a PNG URL for PDF uploads.
          useShellRelay: !uploadUrl && canUseShellRelay(),
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
          cartPreviewUrl = uploaded.cartPreviewUrl || uploaded.productionUrl;
          uploadedProductionKey = uploaded.key || uploadedProductionKey;
          exportBufferForUpload = null;
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
        ...(productionUrl
          ? {
              productionUrl,
              productionKey: uploadedProductionKey || undefined,
              cartPreviewUrl: cartPreviewUrl || productionUrl,
            }
          : {}),
        ...(isEditMode && existingProduction?.url && !productionUrl
          ? { productionUrl: String(existingProduction.url), cartPreviewUrl: existingProduction.previewUrl ? String(existingProduction.previewUrl) : String(existingProduction.url) }
          : {}),
        builderVersion: (import.meta as unknown as { env?: { VITE_APP_VERSION?: string } })?.env?.VITE_APP_VERSION || "builder-unversioned",
      };

      const pngByteLength = lastAddToCartPngBytesRef.current;

      if (!productionUrl) {
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
        postMessageToParent(messageWithFile, [productionBuffer]);
        refreshAddToCartStallTimeout(pngByteLength || productionBuffer.byteLength);
      } else {
        postMessageToParent(message);
        refreshAddToCartStallTimeout(canReuseProduction ? 0 : pngByteLength);
      }
      // Drop large local references after the parent has received the message.
      productionBlob = null;
      exportWorkerBuffer = null;
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
      setExportProgressLabel(undefined);
      if (addToCartStallTimeoutRef.current != null) {
        window.clearTimeout(addToCartStallTimeoutRef.current);
        addToCartStallTimeoutRef.current = null;
      }
    }
  }, [artboardWidth, artboardHeight, quantity, shopifyVariants, initialVariantId, shopDomain, toast, t, refreshAddToCartStallTimeout, buildDesignStatePayload, isEditMode, initialDesignState, setIsAddingToCart, setIsUpdateFlow, setIsProcessing, setExportProgressLabel, setAddToCartProgressLabel, addToCartStallTimeoutRef, lastAddToCartPngBytesRef, shellUploadUrlRef, profile, spotPreviewData, ensureDesignImagesAvailable]);

  return {
    ...bag,
    buildDesignStatePayload,
    handleAddToCart,
  };
}

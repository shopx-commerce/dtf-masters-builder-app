import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { hasVectorPrintSource } from "@/lib/vector-print-source";
import type { ImageInfo } from "@/lib/types";

interface CropModalProps {
  open: boolean;
  onClose: () => void;
  imageInfo: ImageInfo;
  onCrop: (croppedImageInfo: ImageInfo) => void;
  t: (key: string) => string;
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to load image")); };
    img.src = url;
  });
}

/** The crop box as a fraction of the preview it was drawn on, so it can be
 *  reapplied to a print source of any resolution. */
interface FractionalBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Pixel dimensions of an encoded image without decoding it when we can avoid
 * it. A PNG carries them in the IHDR at a fixed offset, and every print source
 * this app produces itself is a PNG; anything else falls back to a decode.
 */
async function readEncodedSize(blob: Blob): Promise<{ w: number; h: number } | null> {
  try {
    const head = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
    if (head.length === 24 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
      const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
      const w = view.getUint32(16);
      const h = view.getUint32(20);
      if (w > 0 && h > 0) return { w, h };
    }
  } catch {
    /* fall through to a decode */
  }
  if (typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { w: bitmap.width, h: bitmap.height };
    bitmap.close();
    return size.w > 0 && size.h > 0 ? size : null;
  } catch {
    return null;
  }
}

/**
 * Moves the crop onto the design's existing `exportBlob` by narrowing
 * `exportCrop`, in whole source pixels. Nothing is re-encoded, so the print
 * source keeps every pixel it had inside the box the customer kept.
 */
async function composeExportCrop(
  info: ImageInfo,
  box: FractionalBox,
): Promise<{ rect: NonNullable<ImageInfo["exportCrop"]>; baseWidth: number } | null> {
  if (!info.exportBlob) return null;
  let base = info.exportCrop;
  if (!base) {
    const size = await readEncodedSize(info.exportBlob);
    if (!size) return null;
    base = { x: 0, y: 0, width: size.w, height: size.h };
  }
  const x = Math.max(base.x, Math.min(base.x + base.width - 1, Math.round(base.x + box.x * base.width)));
  const y = Math.max(base.y, Math.min(base.y + base.height - 1, Math.round(base.y + box.y * base.height)));
  const width = Math.max(1, Math.min(base.x + base.width - x, Math.round(box.w * base.width)));
  const height = Math.max(1, Math.min(base.y + base.height - y, Math.round(box.h * base.height)));
  return { rect: { x, y, width, height }, baseWidth: base.width };
}

/**
 * Carries the design's print source through the crop.
 *
 * Crop was the one editing tool that built a fresh `ImageInfo` and so dropped
 * `exportBlob` / `exportCrop` / `svgSource` / `originalPdfData` /
 * `vectorInkBox` on the floor. The customer's 300 DPI source was replaced by
 * the 4096-capped preview the crop was taken from, and a PDF or SVG lost its
 * geometry entirely — while `dpi` was carried over unchanged, so the badge kept
 * quoting the resolution the design used to have.
 *
 * Both sources are cropped geometrically rather than re-rendered: a raster by
 * narrowing `exportCrop`, a vector by composing the box into `vectorInkBox`,
 * which is already a page fraction for exactly this reason. Neither costs a
 * pixel of resolution, and neither needs the design's physical size.
 */
async function cropPrintSourceFields(
  info: ImageInfo,
  box: FractionalBox,
  croppedPreviewBlob: Blob,
): Promise<Partial<ImageInfo>> {
  const isVector = hasVectorPrintSource(info);
  // The preview already *is* the print source, so there is nothing to carry.
  if (!isVector && !info.exportBlob) {
    return { dpi: scaleDpi(info.dpi, box.w) };
  }

  const composed = await composeExportCrop(info, box);

  if (isVector) {
    const base = info.vectorInkBox ?? { x: 0, y: 0, w: 1, h: 1 };
    return {
      vectorInkBox: {
        x: base.x + box.x * base.w,
        y: base.y + box.y * base.h,
        w: box.w * base.w,
        h: box.h * base.h,
      },
      // `exportBlob` is only the fallback for a failed re-rasterise, but it has
      // to frame the same artwork or that fallback prints the uncropped design.
      ...(composed
        ? { exportCrop: composed.rect }
        : { exportBlob: croppedPreviewBlob, exportCrop: undefined }),
    };
  }

  if (composed) {
    return {
      exportCrop: composed.rect,
      dpi: scaleDpi(info.dpi, composed.rect.width / composed.baseWidth),
    };
  }

  // The print source could not be measured, so it can no longer be trusted to
  // frame the same artwork as the preview. Leaving it in place would print the
  // uncropped design; the cropped preview becomes the print source instead.
  console.warn("[crop-modal] could not measure the print source; using the cropped preview");
  return {
    exportBlob: croppedPreviewBlob,
    exportCrop: undefined,
    svgSource: undefined,
    originalPdfData: undefined,
    vectorInkBox: undefined,
    isPDF: false,
    dpi: scaleDpi(info.dpi, box.w),
  };
}

/** DPI after the print source lost the same fraction of its pixels. */
function scaleDpi(dpi: number, scale: number): number {
  if (!(dpi > 0) || !(scale > 0)) return dpi;
  return Math.max(1, Math.round(dpi * scale));
}

export default function CropModal({
  open,
  onClose,
  imageInfo,
  onCrop,
  t,
}: CropModalProps) {
  const img = imageInfo.image;
  const imgW = img.naturalWidth || img.width;
  const imgH = img.naturalHeight || img.height;

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [crop, setCrop] = useState({ x: 0, y: 0, w: imgW, h: imgH });
  const [dragging, setDragging] = useState<string | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; crop: typeof crop } | null>(null);
  const cropRafRef = useRef<number | null>(null);
  const pendingCropMoveRef = useRef<{ x: number; y: number } | null>(null);
  const containerRectCacheRef = useRef<DOMRect | null>(null);

  useEffect(() => {
    if (open) {
      setCrop({ x: 0, y: 0, w: imgW, h: imgH });
    }
  }, [open, imgW, imgH]);

  useEffect(() => {
    if (!open || !containerRef.current) return;
    let rafId: number | null = null;
    const ro = new ResizeObserver((entries) => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const el = entries[0]?.target as HTMLDivElement;
        if (el) setContainerSize({ w: el.clientWidth, h: el.clientHeight });
      });
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); if (rafId != null) cancelAnimationFrame(rafId); };
  }, [open]);

  const scale = Math.min(
    containerSize.w / imgW,
    containerSize.h / imgH,
    1
  );
  const dispW = imgW * scale;
  const dispH = imgH * scale;
  const offsetX = (containerSize.w - dispW) / 2;
  const offsetY = (containerSize.h - dispH) / 2;

  const toImgCoords = useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRectCacheRef.current || containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      const x = ((clientX - rect.left - offsetX) / dispW) * imgW;
      const y = ((clientY - rect.top - offsetY) / dispH) * imgH;
      return { x: Math.max(0, Math.min(imgW, x)), y: Math.max(0, Math.min(imgH, y)) };
    },
    [offsetX, offsetY, dispW, dispH, imgW, imgH]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, handle: string) => {
      e.preventDefault();
      setDragging(handle);
      dragStartRef.current = { x: e.clientX, y: e.clientY, crop: { ...crop } };
    },
    [crop]
  );

  useEffect(() => {
    if (!dragging) return;
    containerRectCacheRef.current = containerRef.current?.getBoundingClientRect() ?? null;
    const processCropMove = (clientX: number, clientY: number) => {
      if (!dragStartRef.current) return;
      const start = dragStartRef.current;
      const curr = toImgCoords(clientX, clientY);
      const startImg = toImgCoords(start.x, start.y);
      const dx = curr.x - startImg.x;
      const dy = curr.y - startImg.y;
      const { crop: c } = start;

      const MIN = 20;
      if (dragging === "move") {
        setCrop({
          x: Math.max(0, Math.min(imgW - c.w, c.x + dx)),
          y: Math.max(0, Math.min(imgH - c.h, c.y + dy)),
          w: c.w,
          h: c.h,
        });
      } else if (dragging === "tl") {
        setCrop({
          x: Math.max(0, Math.min(c.x + c.w - MIN, c.x + dx)),
          y: Math.max(0, Math.min(c.y + c.h - MIN, c.y + dy)),
          w: Math.max(MIN, c.w - dx),
          h: Math.max(MIN, c.h - dy),
        });
      } else if (dragging === "tr") {
        setCrop({
          x: c.x,
          y: Math.max(0, Math.min(c.y + c.h - MIN, c.y + dy)),
          w: Math.max(MIN, c.w + dx),
          h: Math.max(MIN, c.h - dy),
        });
      } else if (dragging === "bl") {
        setCrop({
          x: Math.max(0, Math.min(c.x + c.w - MIN, c.x + dx)),
          y: c.y,
          w: Math.max(MIN, c.w - dx),
          h: Math.max(MIN, c.h + dy),
        });
      } else if (dragging === "br") {
        setCrop({
          x: c.x,
          y: c.y,
          w: Math.max(MIN, c.w + dx),
          h: Math.max(MIN, c.h + dy),
        });
      } else if (dragging === "t") {
        setCrop({
          x: c.x,
          y: Math.max(0, Math.min(c.y + c.h - MIN, c.y + dy)),
          w: c.w,
          h: Math.max(MIN, c.h - dy),
        });
      } else if (dragging === "b") {
        setCrop({ x: c.x, y: c.y, w: c.w, h: Math.max(MIN, c.h + dy) });
      } else if (dragging === "l") {
        setCrop({
          x: Math.max(0, Math.min(c.x + c.w - MIN, c.x + dx)),
          y: c.y,
          w: Math.max(MIN, c.w - dx),
          h: c.h,
        });
      } else if (dragging === "r") {
        setCrop({ x: c.x, y: c.y, w: Math.max(MIN, c.w + dx), h: c.h });
      }
    };
    const onMove = (e: PointerEvent) => {
      pendingCropMoveRef.current = { x: e.clientX, y: e.clientY };
      if (cropRafRef.current == null) {
        cropRafRef.current = requestAnimationFrame(() => {
          cropRafRef.current = null;
          const pm = pendingCropMoveRef.current;
          if (!pm) return;
          pendingCropMoveRef.current = null;
          processCropMove(pm.x, pm.y);
        });
      }
    };
    const onUp = () => {
      if (cropRafRef.current != null) { cancelAnimationFrame(cropRafRef.current); cropRafRef.current = null; }
      const pm = pendingCropMoveRef.current;
      pendingCropMoveRef.current = null;
      if (pm) processCropMove(pm.x, pm.y);
      containerRectCacheRef.current = null;
      setDragging(null);
      dragStartRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (cropRafRef.current != null) cancelAnimationFrame(cropRafRef.current);
    };
  }, [dragging, imgW, imgH, toImgCoords]);

  const handleApply = useCallback(async () => {
    // Whole pixels, so the crop is a straight blit. Drawing a fractional source
    // rect resamples every pixel through a bilinear filter, which softens the
    // artwork and reintroduces the semi-transparent edges the alpha-threshold
    // and halftone tools exist to remove.
    const rx = Math.max(0, Math.min(imgW - 1, Math.round(crop.x)));
    const ry = Math.max(0, Math.min(imgH - 1, Math.round(crop.y)));
    const rw = Math.max(1, Math.min(imgW - rx, Math.round(crop.w)));
    const rh = Math.max(1, Math.min(imgH - ry, Math.round(crop.h)));

    const canvas = document.createElement("canvas");
    canvas.width = rw;
    canvas.height = rh;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(img, rx, ry, rw, rh, 0, 0, rw, rh);
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob((b) => res(b), "image/png")
    );
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) return;
    const croppedImg = await loadImageFromBlob(blob);
    const file = new File([blob], imageInfo.file.name.replace(/\.[^/.]+$/, "") + "-cropped.png", { type: "image/png" });

    const box: FractionalBox = { x: rx / imgW, y: ry / imgH, w: rw / imgW, h: rh / imgH };
    const printSource = await cropPrintSourceFields(imageInfo, box, blob);

    const newInfo: ImageInfo = {
      ...imageInfo,
      file,
      image: croppedImg,
      originalWidth: croppedImg.naturalWidth,
      originalHeight: croppedImg.naturalHeight,
      ...printSource,
    };
    onCrop(newInfo);
    onClose();
  }, [crop, img, imgW, imgH, imageInfo, onCrop, onClose]);

  if (!open) return null;

  const cx = (crop.x / imgW) * dispW + offsetX;
  const cy = (crop.y / imgH) * dispH + offsetY;
  const cw = (crop.w / imgW) * dispW;
  const ch = (crop.h / imgH) * dispH;

  const handleSize = 10;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl max-w-[90vw] max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-gray-800 px-6 py-3 border-b border-gray-200">
          {t("editor.cropTitle")}
        </h2>
        <p className="text-sm text-gray-500 px-6 pb-2">
          {t("editor.cropDesc")}
        </p>
        <div
          ref={containerRef}
          className="relative flex-1 min-h-[300px] max-h-[60vh] bg-gray-900 flex items-center justify-center overflow-hidden"
          style={{ minWidth: 400 }}
        >
          <img
            src={img.src}
            alt=""
            className="max-w-full max-h-full object-contain select-none pointer-events-none"
            style={{ width: dispW, height: dispH }}
            draggable={false}
          />
          <div
            className="absolute border-2 border-cyan-500 bg-cyan-500/10 pointer-events-none"
            style={{ left: cx, top: cy, width: cw, height: ch }}
          />
          {/* Dark overlay: 4 rectangles around the crop area */}
          <div className="absolute inset-0 pointer-events-none" style={{ left: offsetX, top: offsetY, width: dispW, height: dispH }}>
            <div className="absolute bg-black/50" style={{ left: 0, top: 0, width: dispW, height: cy - offsetY }} />
            <div className="absolute bg-black/50" style={{ left: 0, top: cy + ch - offsetY, width: dispW, height: dispH - (cy + ch - offsetY) }} />
            <div className="absolute bg-black/50" style={{ left: 0, top: cy - offsetY, width: cx - offsetX, height: ch }} />
            <div className="absolute bg-black/50" style={{ left: cx + cw - offsetX, top: cy - offsetY, width: dispW - (cx + cw - offsetX), height: ch }} />
          </div>
          {(["tl", "t", "tr", "l", "r", "bl", "b", "br"] as const).map((h) => (
            <div
              key={h}
              className="absolute w-4 h-4 border-2 border-white bg-cyan-500 rounded-sm cursor-move shadow-md"
              style={{
                left: h.includes("l") ? cx - 8 : h.includes("r") ? cx + cw - 8 : cx + cw / 2 - 8,
                top: h.includes("t") ? cy - 8 : h.includes("b") ? cy + ch - 8 : cy + ch / 2 - 8,
              }}
              onPointerDown={(e) => handlePointerDown(e, h)}
            />
          ))}
          <div
            className="absolute border-2 border-dashed border-cyan-400 cursor-move"
            style={{ left: cx + handleSize, top: cy + handleSize, width: cw - handleSize * 2, height: ch - handleSize * 2 }}
            onPointerDown={(e) => handlePointerDown(e, "move")}
          />
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
          <Button variant="outline" onClick={onClose}>
            {t("editor.cropCancel")}
          </Button>
          <Button onClick={handleApply} className="bg-cyan-600 hover:bg-cyan-700">
            {t("editor.cropApply")}
          </Button>
        </div>
      </div>
    </div>
  );
}

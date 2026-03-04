import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
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

  useEffect(() => {
    if (open) {
      setCrop({ x: 0, y: 0, w: imgW, h: imgH });
    }
  }, [open, imgW, imgH]);

  useEffect(() => {
    if (!open || !containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const el = entries[0]?.target as HTMLDivElement;
      if (el) setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
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
      const rect = containerRef.current?.getBoundingClientRect();
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
    const onMove = (e: PointerEvent) => {
      if (!dragStartRef.current) return;
      const start = dragStartRef.current;
      const curr = toImgCoords(e.clientX, e.clientY);
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
    const onUp = () => {
      setDragging(null);
      dragStartRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, imgW, imgH, toImgCoords]);

  const handleApply = useCallback(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(crop.w);
    canvas.height = Math.round(crop.h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(
      img,
      crop.x, crop.y, crop.w, crop.h,
      0, 0, crop.w, crop.h
    );
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob((b) => res(b), "image/png")
    );
    if (!blob) return;
    const croppedImg = await loadImageFromBlob(blob);
    const file = new File([blob], imageInfo.file.name.replace(/\.[^/.]+$/, "") + "-cropped.png", { type: "image/png" });
    const newInfo: ImageInfo = {
      file,
      image: croppedImg,
      originalWidth: croppedImg.naturalWidth,
      originalHeight: croppedImg.naturalHeight,
      dpi: imageInfo.dpi,
    };
    onCrop(newInfo);
    onClose();
  }, [crop, img, imageInfo, onCrop, onClose]);

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

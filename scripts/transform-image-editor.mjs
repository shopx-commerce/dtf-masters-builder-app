import fs from "node:fs";
import path from "node:path";

const root = "/Users/brainxshopify/dtf-masters-builder-app";
const srcPath = path.join(root, "client/src/components/image-editor.tsx.bak");
const outPath = path.join(root, "client/src/components/image-editor.tsx");
const lines = fs.readFileSync(srcPath, "utf8").split("\n");

function slice(start, end) {
  return lines.slice(start - 1, end);
}

const header = `import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { flushSync } from "react-dom";
import UploadSection from "./upload-section";
import PreviewSection from "./preview-section";
import ControlsSection, { type SpotPreviewData } from "./controls-section";
import CropModal from "./crop-modal";
import { cropImageToContent, cropImageToContentAsync, hasCleanAlpha, isOpaqueRasterUpload } from "@/lib/image-crop";
import { parsePDF, type ParsedPDFData } from "@/lib/pdf-parser";
import { useToast } from "@/hooks/use-toast";
import { useHistory, type HistorySnapshot } from "@/hooks/use-history";
import { useIsMobile } from "@/hooks/use-mobile";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useLanguage } from "@/lib/i18n";
import { formatDimensions, formatLength, useMetric, cmToInches, getUnitSuffix } from "@/lib/format-length";
import { formatVariantPriceForDisplay, getSelectedVariantPrice } from "@/lib/variant-price";
import { Trash2, Copy, ChevronDown, ChevronUp, Undo2, Redo2, RotateCw, ArrowUpLeft, ArrowUpRight, ArrowDownLeft, ArrowDownRight, LayoutGrid, Layers, Loader2, Plus, Minus, Droplets, Link, Unlink, FlipHorizontal2, FlipVertical2, MousePointerClick, XCircle, Stamp, Check, X, ScanSearch } from "lucide-react";
import { uploadProductionToR2 } from "@/lib/r2-direct-upload";
import {
  ADD_TO_CART_STALL_MIN_MS_NEW,
  ADD_TO_CART_STALL_MIN_MS_UPDATE,
  ADD_TO_CART_STALL_MS_PER_MB,
  DEFAULT_DESIGN_TRANSFORM,
  DEFAULT_LAYER_CENTER_NX,
  DEFAULT_LAYER_CENTER_NY,
  DEFAULT_LAYER_ROTATION,
  DEFAULT_LAYER_SCALE,
  DEFAULT_LAYER_SIZE_INCHES,
  EXPORT_DPI,
  EXPORT_TIMEOUT_MS,
} from "./image-editor/constants";
import SizeInput from "./image-editor/size-input";
import type { InitialDesignState } from "./image-editor/types";
import {
  clampDesignToArtboard,
  fetchImageDpi,
  getArrangeWorker,
  getEffectiveHeight,
  getExportWorker,
  getRotatedBounds,
  getStampExtra,
  injectPngDpi,
  inchesFromPixelsPair,
  imageHasCleanAlpha,
  nextExportRequestId,
  normalizeRasterDpiForInches,
  shortAddToCartLabel,
} from "./image-editor/utils";
import { useAddToCartStall } from "./image-editor/use-add-to-cart-stall";
import { useRestoreDesignState } from "./image-editor/use-restore-design-state";

export type { ImageInfo, ResizeSettings, ImageTransform, DesignItem } from "@/lib/types";
import type { ImageInfo, ResizeSettings, ImageTransform, DesignItem } from "@/lib/types";
import { type ProfileConfig, HOT_PEEL_PROFILE } from "@/lib/profiles";
`;

// Main component body: original lines 307-2345, 2411-2992, 3135-end
// Skip: 1-306 (helpers), 2346-2410 (stall hooks), 2993-3133 (restore effect)

const part1 = slice(307, 2345);
const part2 = slice(2411, 2992);
const part3 = slice(3135, lines.length);

let body = [...part1, ...part2, ...part3];

const bodyText = body.join("\n");

// Replace magic numbers with constants
const patched = bodyText
  .replace(
    /useState<ImageTransform>\(\{ nx: 0\.5, ny: 0\.5, s: 1, rotation: 0 \}\)/g,
    "useState<ImageTransform>(DEFAULT_DESIGN_TRANSFORM)",
  )
  .replace(
    /setDesignTransform\(\{ nx: 0\.5, ny: 0\.5, s: 1, rotation: 0 \}\)/g,
    "setDesignTransform(DEFAULT_DESIGN_TRANSFORM)",
  )
  .replace(
    /transform: \{ \.\.\.d\.transform, nx: 0\.5, ny: 0\.5 \}/g,
    "transform: { ...d.transform, nx: DEFAULT_LAYER_CENTER_NX, ny: DEFAULT_LAYER_CENTER_NY }",
  )
  .replace(
    /const minMs = isUpdateFlow \? 4 \* 60 \* 1000 : 10 \* 60 \* 1000;\s*\n\s*const stallMs = Math\.max\(minMs, Math\.ceil\(mb \* 90_000\)\);[\s\S]*?\}, \[toast, isUpdateFlow\]\);/,
    "",
  )
  .replace(
    /useEffect\(\(\) => \{\s*const onShellConfig[\s\S]*?\}, \[\]\);\s*\n\s*useEffect\(\(\) => \{\s*const onCartStatus[\s\S]*?\}, \[toast, isUpdateFlow, refreshAddToCartStallTimeout\]\);/,
    "",
  )
  .replace(
    /const addToCartStallTimeoutRef = useRef<number \| null>\(null\);\s*\n\s*const lastAddToCartPngBytesRef = useRef<number>\(0\);\s*\n\s*const shellUploadUrlRef = useRef<string \| null>\(null\);/,
    "",
  )
  .replace(
    /useEffect\(\(\) => \{\s*if \(!initialDesignState\) return;[\s\S]*?\}, \[initialDesignState\?\.designId, initialDesignState\?\.version\]\);/,
    "",
  )
  .replace(/const exportDpi = 300;/g, "const exportDpi = EXPORT_DPI;")
  .replace(/300_000/g, "EXPORT_TIMEOUT_MS")
  .replace(/\+\+_exportReqCounter/g, "nextExportRequestId()")
  .replace(/\+\+_arrangeReqCounter/g, "nextArrangeRequestId()")
  .replace(/const requestId = nextExportRequestId\(\)\(\);/g, "const requestId = nextExportRequestId();")
  .replace(/const requestId = nextArrangeRequestId\(\)\(\);/g, "const requestId = nextArrangeRequestId();");

// Insert hooks after isUpdateFlow state - find anchor
const hookInsert = `
  const {
    addToCartStallTimeoutRef,
    lastAddToCartPngBytesRef,
    shellUploadUrlRef,
    refreshAddToCartStallTimeout,
    clearStallTimeout,
  } = useAddToCartStall({
    toast,
    isUpdateFlow,
    setIsAddingToCart,
    setIsProcessing,
    setIsUpdateFlow,
    setAddToCartProgressLabel,
  });
`;

const restoreHookInsert = `
  useRestoreDesignState({
    initialDesignState,
    restoredLayerAssetRef,
    setIsProcessing,
    setDesigns,
    setSelectedDesignId,
    setArtboardWidth,
    setArtboardHeight,
    setQuantity,
    setDesignGap,
  });
`;

let finalBody = patched.replace(
  /const \[isUpdateFlow, setIsUpdateFlow\] = useState\(false\);/,
  `const [isUpdateFlow, setIsUpdateFlow] = useState(false);${hookInsert}`,
);

finalBody = finalBody.replace(
  /const buildDesignStatePayload = useCallback/,
  `${restoreHookInsert}\n\n  const buildDesignStatePayload = useCallback`,
);

// Fix handleAddToCart clear timeout to use clearStallTimeout where appropriate - optional

fs.writeFileSync(outPath, `${header}\n${finalBody}`.trim() + "\n");
console.log("Wrote", outPath, "lines:", header.split("\n").length + finalBody.split("\n").length);

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = "/Users/brainxshopify/dtf-masters-builder-app";
const monolithPath = "/tmp/image-editor-monolith.tsx";
const outDir = path.join(root, "client/src/components/image-editor");
const providerPath = path.join(outDir, "image-editor-provider.tsx");

if (!fs.existsSync(monolithPath)) {
  execSync(
    `git show HEAD:client/src/components/image-editor.tsx > ${monolithPath}`,
    { cwd: root },
  );
}

const monolith = fs.readFileSync(monolithPath, "utf8").split("\n");
let body = monolith.slice(300, 3222).join("\n");

body = body
  .replace(
    /const \[artboardWidth, setArtboardWidth\] = useState\(initialWidth \?\? profile\.artboardWidth\);\n  const \[artboardHeight, setArtboardHeight\] = useState\(initialHeight \?\? profile\.gangsheetHeights\[0\] \?\? 12\);/,
    `const [artboardWidth, setArtboardWidth] = useState(initialWidth ?? profile.artboardWidth);
  const [artboardHeight, setArtboardHeight] = useState(initialHeight ?? profile.gangsheetHeights[0] ?? 12);
  const artboardWidthRef = useRef(artboardWidth);
  artboardWidthRef.current = artboardWidth;
  const artboardHeightRef = useRef(artboardHeight);
  artboardHeightRef.current = artboardHeight;
  const contentFillCacheRef = useRef<Map<string, number>>(new Map());
  const handleAutoArrangeRef = useRef<(opts?: { skipSnapshot?: boolean; preserveSelection?: boolean }) => void>(() => {});`,
  )
  .replace(
    /const \[designTransform, setDesignTransform\] = useState<ImageTransform>\(\{ nx: 0\.5, ny: 0\.5, s: 1, rotation: 0 \}\);/,
    "const [designTransform, setDesignTransform] = useState<ImageTransform>(DEFAULT_DESIGN_TRANSFORM);",
  )
  .replace(
    /setDesignTransform\(\{ nx: 0\.5, ny: 0\.5, s: 1, rotation: 0 \}\);/g,
    "setDesignTransform(DEFAULT_DESIGN_TRANSFORM);",
  )
  .replace(
    /transform: \{ \.\.\.d\.transform, nx: 0\.5, ny: 0\.5 \}/g,
    "transform: { ...d.transform, nx: DEFAULT_LAYER_CENTER_NX, ny: DEFAULT_LAYER_CENTER_NY }",
  )
  .replace(
    /const addToCartStallTimeoutRef = useRef<number \| null>\(null\);\n  const lastAddToCartPngBytesRef = useRef<number>\(0\);/,
    `const [addToCartProgressLabel, setAddToCartProgressLabel] = useState<string | undefined>();
  const {
    addToCartStallTimeoutRef,
    lastAddToCartPngBytesRef,
    shellUploadUrlRef,
    refreshAddToCartStallTimeout,
  } = useAddToCartStall({
    toast,
    isUpdateFlow,
    setIsAddingToCart,
    setIsProcessing,
    setIsUpdateFlow,
    setAddToCartProgressLabel,
  });`,
  )
  .replace(
    /  const refreshAddToCartStallTimeout = useCallback\([\s\S]*?\}, \[toast, refreshAddToCartStallTimeout, isUpdateFlow\]\);\n\n/,
    "",
  )
  .replace(
    /  useEffect\(\(\) => \{\n    if \(!initialDesignState\) return;[\s\S]*?\}, \[initialDesignState\?\.designId, initialDesignState\?\.version\]\);\n\n/,
    `  useRestoreDesignState({
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

`,
  )
  .replace(/\+\+_exportReqCounter/g, "nextExportRequestId()")
  .replace(/\+\+_arrangeReqCounter/g, "nextArrangeRequestId()")
  .replace(/const requestId = nextExportRequestId\(\)\(\);/g, "const requestId = nextExportRequestId();")
  .replace(/const requestId = nextArrangeRequestId\(\)\(\);/g, "const requestId = nextArrangeRequestId();");

const bodyLines = body.split("\n");
const markers = [
  "const getAlignNxNy = useCallback",
  "const handleFallbackImage",
  "const handleDownload",
  "const buildDesignStatePayload",
];
const splitIdx = markers.map((m) => {
  const i = bodyLines.findIndex((l) => l.trim().startsWith(m));
  if (i < 0) throw new Error(`Marker not found: ${m}`);
  return i;
});

const chunks = [
  bodyLines.slice(0, splitIdx[0]),
  bodyLines.slice(splitIdx[0], splitIdx[1]),
  bodyLines.slice(splitIdx[1], splitIdx[2]),
  bodyLines.slice(splitIdx[2], splitIdx[3]),
  bodyLines.slice(splitIdx[3]),
];

function collectDestructureNames(destructureBody) {
  const names = [];
  for (const part of destructureBody.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const name = trimmed.split(":")[0].trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.push(name);
  }
  return names;
}

function collectBindings(chunkLines) {
  const names = new Set();
  for (let i = 0; i < chunkLines.length; i++) {
    const line = chunkLines[i];

    let m = line.match(/^  const \[([A-Za-z_][A-Za-z0-9_]*),\s*([A-Za-z_][A-Za-z0-9_]*)\]/);
    if (m) {
      names.add(m[1]);
      names.add(m[2]);
      continue;
    }

    m = line.match(/^  const ([A-Za-z_][A-Za-z0-9_]*) =/);
    if (m) {
      names.add(m[1]);
      continue;
    }

    m = line.match(/^  const \{([^}]+)\} =/);
    if (m) {
      for (const n of collectDestructureNames(m[1])) names.add(n);
      continue;
    }

    if (line.match(/^  const \{$/)) {
      const parts = [];
      i++;
      while (i < chunkLines.length && !chunkLines[i].includes("} =")) {
        parts.push(chunkLines[i].trim().replace(/,$/, ""));
        i++;
      }
      if (i < chunkLines.length) {
        const tail = chunkLines[i].split("} =")[0].trim().replace(/,$/, "");
        if (tail) parts.push(tail);
        for (const n of collectDestructureNames(parts.join(", "))) names.add(n);
      }
    }
  }
  return [...names];
}

const propsBindings = [
  "onDesignUploaded", "profile", "initialWidth", "initialHeight", "initialGangsheetHeights",
  "initialQuantity", "shopifyVariants", "initialVariantId", "shopDomain", "embedFromShopify",
  "initialDesignState", "initialDesignId", "isEditMode",
];

const partNames = [
  "useImageEditorModelStateDesign",
  "useImageEditorModelArrangeKeyboard",
  "useImageEditorModelUploadCrop",
  "useImageEditorModelExport",
  "useImageEditorModelCart",
];

const sharedImports = `import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { flushSync } from "react-dom";
import { cropImageToContent, cropImageToContentAsync, hasCleanAlpha, isOpaqueRasterUpload } from "@/lib/image-crop";
import { parsePDF, type ParsedPDFData } from "@/lib/pdf-parser";
import { useToast } from "@/hooks/use-toast";
import { useHistory, type HistorySnapshot } from "@/hooks/use-history";
import { useIsMobile } from "@/hooks/use-mobile";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useLanguage } from "@/lib/i18n";
import { formatDimensions, formatLength, useMetric, cmToInches, getUnitSuffix } from "@/lib/format-length";
import { formatVariantPriceForDisplay, getSelectedVariantPrice } from "@/lib/variant-price";
import { uploadProductionToR2 } from "@/lib/r2-direct-upload";
import {
  DEFAULT_DESIGN_TRANSFORM,
  DEFAULT_LAYER_CENTER_NX,
  DEFAULT_LAYER_CENTER_NY,
  EXPORT_DPI,
  EXPORT_TIMEOUT_MS,
  RASTER_DPI_FALLBACK,
} from "./constants";
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
  nextArrangeRequestId,
  normalizeRasterDpiForInches,
  shortAddToCartLabel,
} from "./utils";
import { useAddToCartStall } from "./use-add-to-cart-stall";
import { useRestoreDesignState } from "./use-restore-design-state";
import type { ImageInfo, ResizeSettings, ImageTransform, DesignItem } from "@/lib/types";
import { HOT_PEEL_PROFILE } from "@/lib/profiles";
import type { ImageEditorProps } from "./types";
import type { SpotPreviewData } from "../controls-section";
`;

const cumulative = [];
for (let i = 0; i < partNames.length; i++) {
  const bindings = collectBindings(chunks[i]);
  const priorKeys = [...propsBindings, ...cumulative.flat()];
  const destructure = priorKeys.length
    ? `  const {\n    ${priorKeys.join(",\n    ")},\n  } = bag;\n\n`
    : "";

  const hookHead = i === 0
    ? `export function ${partNames[i]}(props: ImageEditorProps) {
  const {
    onDesignUploaded,
    profile = HOT_PEEL_PROFILE,
    initialWidth,
    initialHeight,
    initialGangsheetHeights,
    initialQuantity,
    shopifyVariants,
    variantId: initialVariantId,
    shopDomain,
    embedFromShopify,
    initialDesignState,
    initialDesignId,
    isEditMode = false,
  } = props;

`
    : `export function ${partNames[i]}(bag: Record<string, unknown>) {
${destructure}`;

  const returnNames = [...priorKeys, ...bindings];
  const fileContent = `${sharedImports}
${hookHead}${chunks[i].join("\n")}

  return { ${returnNames.join(", ")} };
}
`;

  fs.writeFileSync(path.join(outDir, `${partNames[i]}.ts`), fileContent);
  cumulative.push(bindings);

  if (i > 0) {
    const destructureSet = new Set(priorKeys);
    const chunkText = chunks[i].join("\n");
    const suspectIds = [...chunkText.matchAll(/\b([a-z][a-zA-Z0-9_]*)\b/g)]
      .map((m) => m[1])
      .filter((id) => !destructureSet.has(id));
    const jsKeywords = new Set([
      "if", "else", "return", "const", "let", "var", "function", "async", "await", "new", "typeof",
      "case", "break", "switch", "default", "for", "while", "try", "catch", "finally", "throw",
      "true", "false", "null", "undefined", "import", "from", "export", "Math", "window", "document",
      "console", "Promise", "Set", "Map", "Array", "Object", "String", "Number", "Boolean", "Date",
      "JSON", "Error", "Blob", "File", "FileReader", "HTMLImageElement", "HTMLCanvasElement",
      "Image", "URL", "OffscreenCanvas", "createImageBitmap", "fetch", "encodeURIComponent",
      "parseInt", "parseFloat", "isFinite", "isNaN", "setTimeout", "clearTimeout", "requestAnimationFrame",
      "prev", "next", "acc", "idx", "i", "j", "k", "e", "ev", "err", "msg", "raw", "val", "key", "id",
      "ctx", "c", "d", "f", "w", "h", "x", "y", "t", "s", "n", "m", "a", "b", "r", "p", "l", "g", "o",
    ]);
    const missing = [...new Set(suspectIds.filter((id) => {
      if (jsKeywords.has(id)) return false;
      if (/^[A-Z]/.test(id)) return false; // types / components
      return !destructureSet.has(id);
    }))].slice(0, 15);
    if (missing.length) {
      console.warn(`${partNames[i]}: identifiers used but not in bag destructure (sample):`, missing.join(", "));
    }
  }

  console.log(partNames[i], fileContent.split("\n").length);
}

const provider = `import type { ImageEditorProps } from "./types";
import { ImageEditorContext } from "./image-editor-context";
import { useImageEditorModelStateDesign } from "./useImageEditorModelStateDesign";
import { useImageEditorModelArrangeKeyboard } from "./useImageEditorModelArrangeKeyboard";
import { useImageEditorModelUploadCrop } from "./useImageEditorModelUploadCrop";
import { useImageEditorModelExport } from "./useImageEditorModelExport";
import { useImageEditorModelCart } from "./useImageEditorModelCart";

export type { ImageInfo, ResizeSettings, ImageTransform, DesignItem } from "@/lib/types";

export function ImageEditorProvider({ children, ...props }: ImageEditorProps & { children: React.ReactNode }) {
  const value = useImageEditorModel(props);
  return <ImageEditorContext.Provider value={value}>{children}</ImageEditorContext.Provider>;
}

function useImageEditorModel(props: ImageEditorProps) {
  const p0 = useImageEditorModelStateDesign(props);
  const p1 = useImageEditorModelArrangeKeyboard(p0);
  const p2 = useImageEditorModelUploadCrop({ ...p0, ...p1 });
  const p3 = useImageEditorModelExport({ ...p0, ...p1, ...p2 });
  const p4 = useImageEditorModelCart({ ...p0, ...p1, ...p2, ...p3 });
  const bag = { ...p0, ...p1, ...p2, ...p3, ...p4 };

  const actionToolbarProps = {
    t: bag.t,
    lang: bag.lang,
    embedFromShopify: bag.embedFromShopify,
    isUploading: bag.isUploading,
    activeImageInfo: bag.activeImageInfo,
    handleFileUploadUnified: bag.handleFileUploadUnified,
    handleBatchStart: bag.handleBatchStart,
    selectedDesignId: bag.selectedDesignId,
    selectedDesignIds: bag.selectedDesignIds,
    designs: bag.designs,
    handleThresholdAlpha: bag.handleThresholdAlpha,
    handleThresholdAlphaAll: bag.handleThresholdAlphaAll,
    handleAutoArrange: bag.handleAutoArrange,
    canUndo: bag.canUndo,
    canRedo: bag.canRedo,
    undo: bag.undo,
    redo: bag.redo,
    duplicateCount: bag.duplicateCount,
    setDuplicateCount: bag.setDuplicateCount,
    parseDuplicateCount: bag.parseDuplicateCount,
    handleDuplicateCountKeyDown: bag.handleDuplicateCountKeyDown,
    clampDuplicateCount: bag.clampDuplicateCount,
    handleDuplicateDesign: bag.handleDuplicateDesign,
    handleDeleteDesign: bag.handleDeleteDesign,
    handleDuplicateAndArrange: bag.handleDuplicateAndArrange,
    designGap: bag.designGap,
    setDesignGap: bag.setDesignGap,
    handleAutoArrangeRef: bag.handleAutoArrangeRef,
    artboardWidth: bag.artboardWidth,
    artboardHeight: bag.artboardHeight,
    setArtboardWidth: bag.setArtboardWidth,
    setArtboardHeight: bag.setArtboardHeight,
    proportionalLock: bag.proportionalLock,
    setProportionalLock: bag.setProportionalLock,
    activeResizeSettings: bag.activeResizeSettings,
    handleResizeSettingsChange: bag.handleResizeSettingsChange,
    handleRotate90: bag.handleRotate90,
    handleAlignCorner: bag.handleAlignCorner,
    isMobile: bag.isMobile,
    GANGSHEET_HEIGHTS: bag.GANGSHEET_HEIGHTS,
    recommendedArtboardHeight: bag.recommendedArtboardHeight,
    profile: bag.profile,
  };

  return { ...bag, actionToolbarProps };
}

export type ImageEditorModel = ReturnType<typeof useImageEditorModel>;
`;

fs.writeFileSync(providerPath, provider);
console.log("provider", provider.split("\n").length);
console.log("total body lines", bodyLines.length);

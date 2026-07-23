import fs from "node:fs";
import path from "node:path";

const root = "/Users/brainxshopify/dtf-masters-builder-app";
const providerPath = path.join(root, "client/src/components/image-editor/image-editor-provider.tsx");
const lines = fs.readFileSync(providerPath, "utf8").split("\n");

const hookStart = lines.findIndex((l) => l.startsWith("function useImageEditorModel"));
const hookBodyStart = hookStart + 15;
const hookEnd = lines.findIndex((l, i) => i > hookStart && l.trim().startsWith("const actionToolbarProps = {"));

const bodyLines = lines.slice(hookBodyStart, hookEnd);
const returnBlock = lines.slice(hookEnd, hookEnd + 27).join("\n");

const markers = [
  "const contentFillCacheRef",
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

function collectBindings(chunkLines) {
  const names = new Set();
  for (const line of chunkLines) {
    // Only top-level hook bindings (2-space indent), not locals inside callbacks.
    const m = line.match(/^  const ([A-Za-z_][A-Za-z0-9_]*) =/);
    if (m) names.add(m[1]);
  }
  return [...names];
}

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
import { getSelectedVariantPrice } from "@/lib/variant-price";
import { uploadProductionToR2 } from "@/lib/r2-direct-upload";
import {
  DEFAULT_DESIGN_TRANSFORM,
  DEFAULT_LAYER_CENTER_NX,
  DEFAULT_LAYER_CENTER_NY,
  EXPORT_DPI,
  EXPORT_TIMEOUT_MS,
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
  normalizeRasterDpiForInches,
  shortAddToCartLabel,
} from "./utils";
import { useAddToCartStall } from "./use-add-to-cart-stall";
import { useRestoreDesignState } from "./use-restore-design-state";
import type { ImageInfo, ResizeSettings, ImageTransform, DesignItem } from "@/lib/types";
import { HOT_PEEL_PROFILE } from "@/lib/profiles";
import type { ImageEditorProps } from "./types";
`;

const outDir = path.join(root, "client/src/components/image-editor");
const allBindings = [];

for (let i = 0; i < chunks.length; i++) {
  const chunk = chunks[i];
  const bindings = collectBindings(chunk);
  allBindings.push(bindings);

  const prevBindings = allBindings.slice(0, i).flat();
  const destructure = prevBindings.length
    ? `  const {\n    ${prevBindings.join(",\n    ")},\n  } = bag;\n\n`
    : "";

  let hookHead;
  if (i === 0) {
    hookHead = `export function ${partNames[i]}(props: ImageEditorProps) {
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

`;
  } else {
    hookHead = `export function ${partNames[i]}(bag: Record<string, unknown>) {
${destructure}`;
  }

  const hookTail = `  return { ${[
    ...(i === 0
      ? [
          "onDesignUploaded",
          "profile",
          "initialWidth",
          "initialHeight",
          "initialGangsheetHeights",
          "initialQuantity",
          "shopifyVariants",
          "initialVariantId",
          "shopDomain",
          "embedFromShopify",
          "initialDesignState",
          "initialDesignId",
          "isEditMode",
        ]
      : []),
    ...prevBindings,
    ...bindings,
  ].join(", ")} };
}
`;

  const fileContent = `${sharedImports}
${hookHead}${chunk.join("\n")}

${hookTail}`;

  fs.writeFileSync(path.join(outDir, `${partNames[i]}.ts`), fileContent);
  console.log(partNames[i], fileContent.split("\n").length, "bindings:", bindings.length);
}

const provider = `${sharedImports}
import { ImageEditorContext } from "./image-editor-context";
import { ${partNames.join(", ")} } from "./${partNames[0]}";
import { ${partNames.slice(1).map((n) => `${n}`).join(", ")} } from "./${partNames[1]}";
import { ${partNames[2]} } from "./${partNames[2]}";
import { ${partNames[3]} } from "./${partNames[3]}";
import { ${partNames[4]} } from "./${partNames[4]}";

export type { ImageInfo, ResizeSettings, ImageTransform, DesignItem } from "@/lib/types";

export function ImageEditorProvider({ children, ...props }: ImageEditorProps & { children: React.ReactNode }) {
  const value = useImageEditorModel(props);
  return <ImageEditorContext.Provider value={value}>{children}</ImageEditorContext.Provider>;
}

function useImageEditorModel(props: ImageEditorProps) {
  const p0 = ${partNames[0]}(props);
  const p1 = ${partNames[1]}(p0);
  const p2 = ${partNames[2]}({ ...p0, ...p1 });
  const p3 = ${partNames[3]}({ ...p0, ...p1, ...p2 });
  const p4 = ${partNames[4]}({ ...p0, ...p1, ...p2, ...p3 });
  const bag = { ...p0, ...p1, ...p2, ...p3, ...p4 } as Record<string, unknown>;

${returnBlock.replace(/^  /gm, "  ")}
}

export type ImageEditorModel = ReturnType<typeof useImageEditorModel>;
`;

// Fix imports in provider - import each from its own file
const providerFixed = `${sharedImports}
import { ImageEditorContext } from "./image-editor-context";
import { useImageEditorModelStateDesign } from "./use-image-editor-model-state-design";
import { useImageEditorModelArrangeKeyboard } from "./use-image-editor-model-arrange-keyboard";
import { useImageEditorModelUploadCrop } from "./use-image-editor-model-upload-crop";
import { useImageEditorModelExport } from "./use-image-editor-model-export";
import { useImageEditorModelCart } from "./use-image-editor-model-cart";

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
  const bag = { ...p0, ...p1, ...p2, ...p3, ...p4 } as Record<string, unknown>;

  const {
    t, lang, profile, embedFromShopify, isUploading, activeImageInfo, handleFileUploadUnified, handleBatchStart,
    selectedDesignId, selectedDesignIds, designs, handleThresholdAlpha, handleThresholdAlphaAll, handleAutoArrange,
    canUndo, canRedo, undo, redo, duplicateCount, setDuplicateCount, parseDuplicateCount, handleDuplicateCountKeyDown,
    clampDuplicateCount, handleDuplicateDesign, handleDeleteDesign, handleDuplicateAndArrange, designGap, setDesignGap,
    handleAutoArrangeRef, artboardWidth, artboardHeight, setArtboardWidth, setArtboardHeight, proportionalLock,
    setProportionalLock, activeResizeSettings, handleResizeSettingsChange, handleRotate90, handleAlignCorner, isMobile,
    GANGSHEET_HEIGHTS, recommendedArtboardHeight,
  } = bag;

${returnBlock.split("\n").slice(1).join("\n")}
}

export type ImageEditorModel = ReturnType<typeof useImageEditorModel>;
`;

fs.writeFileSync(providerPath, providerFixed);
console.log("Done. Provider lines:", providerFixed.split("\n").length);

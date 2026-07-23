import fs from "node:fs";
import path from "node:path";

const root = "/Users/brainxshopify/dtf-masters-builder-app";
const outDir = path.join(root, "client/src/components/image-editor");

const partNames = [
  "useImageEditorModelStateDesign",
  "useImageEditorModelArrangeKeyboard",
  "useImageEditorModelUploadCrop",
  "useImageEditorModelExport",
  "useImageEditorModelCart",
];

const propsBindings = [
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
];

function collectBindings(chunkLines) {
  const names = new Set();
  for (const line of chunkLines) {
    const m = line.match(/^  const ([A-Za-z_][A-Za-z0-9_]*) =/);
    if (m) names.add(m[1]);
  }
  return [...names];
}

function extractBody(fileContent, partIndex) {
  const lines = fileContent.split("\n");
  const start = partIndex === 0
    ? lines.findIndex((l) => l.trim() === "} = props;") + 1
    : lines.findIndex((l) => l.trim() === "} = bag;") + 1;
  const end = lines.findIndex((l, i) => i > start && l.trim().startsWith("return {"));
  return lines.slice(start, end);
}

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

const bodies = partNames.map((name, i) => {
  const content = fs.readFileSync(path.join(outDir, `${name}.ts`), "utf8");
  return extractBody(content, i);
});

const allBindings = bodies.map(collectBindings);
const cumulative = [];
for (let i = 0; i < partNames.length; i++) {
  const prev = cumulative.flat();
  const chunk = bodies[i];
  const bindings = allBindings[i];
  const destructure = prev.length
    ? `  const {\n    ${prev.join(",\n    ")},\n  } = bag;\n\n`
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

  const returnNames = [...(i === 0 ? propsBindings : []), ...prev, ...bindings];
  const hookTail = `  return { ${returnNames.join(", ")} };
}
`;

  const fileContent = `${sharedImports}
${hookHead}${chunk.join("\n")}

${hookTail}`;

  fs.writeFileSync(path.join(outDir, `${partNames[i]}.ts`), fileContent);
  cumulative.push(bindings);
  console.log(partNames[i], fileContent.split("\n").length, "return keys:", returnNames.length);
}

console.log("Fixed part files.");

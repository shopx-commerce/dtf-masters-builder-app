import fs from "node:fs";
import path from "node:path";

const root = "/Users/brainxshopify/dtf-masters-builder-app";
const mainPath = path.join(root, "client/src/components/image-editor.tsx");
const lines = fs.readFileSync(mainPath, "utf8").split("\n");

const sharedImports = lines.slice(0, 48).join("\n");

const modelBody = lines.slice(50, 2876).join("\n"); // line 51-2876

const modelImports = `${sharedImports}
import type { ImageEditorProps } from "./types";
`;

const modelHook = `${modelImports}
export function useImageEditorModel({
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
}: ImageEditorProps = {}) {
${modelBody}
}

export type ImageEditorModel = ReturnType<typeof useImageEditorModel>;
`;

fs.writeFileSync(path.join(root, "client/src/components/image-editor/use-image-editor-model.ts"), modelHook);

const viewBody = lines.slice(2876).join("\n"); // from actionToolbarProps / empty check

const viewFile = `import UploadSection from "../upload-section";
import PreviewSection from "../preview-section";
import ControlsSection from "../controls-section";
import CropModal from "../crop-modal";
import SizeInput from "./size-input";
import EditorActionToolbar from "./editor-action-toolbar";
import { formatLength, useMetric } from "@/lib/format-length";
import {
  ArrowDownLeft, ArrowDownRight, ArrowUpLeft, ArrowUpRight, Copy, ChevronDown, ChevronUp,
  Droplets, Focus, Layers, Loader2, Plus, RotateCw, ScanSearch, Trash2, Undo2, Redo2, XCircle,
} from "lucide-react";
import type { ImageEditorModel } from "./use-image-editor-model";

export default function ImageEditorView({ model }: { model: ImageEditorModel }) {
  const m = model;
  const {
    t, lang, profile, embedFromShopify, isMobile, isLgUp, isUploading, uploadProgress, isProcessing,
    isAddingToCart, addToCartProgressLabel, isEditMode, isDragOver, artboardWidth, artboardHeight,
    quantity, designGap, duplicateCount, designs, selectedDesignId, selectedDesignIds, mobilePanel,
    setMobilePanel, showDesignInfo, setShowDesignInfo, selectionZoomActive, setSelectionZoomActive,
    editingLayerName, setEditingLayerName, editingNameValue, setEditingNameValue, proportionalLock,
    setProportionalLock, spotPreviewData, contextMenu, setContextMenu, cropModalDesignId,
    setCropModalDesignId, activeImageInfo, activeDesignTransform, activeResizeSettings,
    selectedVariantPrice, effectiveDPI, layerRows, canvasRef, designInfoRef, sidebarFileRef,
    headerUploadInputRef, downloadContainer, setDownloadContainer, fluorPanelContainer,
    setFluorPanelContainer, mobileToolbarContainer, setMobileToolbarContainer, GANGSHEET_HEIGHTS,
    MAX_ARTBOARD_HEIGHT, recommendedArtboardHeight, initialVariantId, shopifyVariants,
    handleFileUploadUnified, handleBatchStart, handleSidebarFileChange, handleDragEnter,
    handleDragLeave, handleDragOver, handleDrop, handleSelectDesign, handleMultiSelect,
    handleDesignTransformChange, handleMultiDragDelta, handleMultiResizeDelta, handleMultiRotateDelta,
    handleEffectiveSizeChange, handleResizeSettingsChange, handleDuplicateDesign,
    handleDuplicateAndArrange, handleDuplicateSelected, handleDuplicateById, handleRemoveOneCopy,
    handleDeleteDesign, handleDeleteMulti, handleRotate90, handleFlipX, handleFlipY, handleAlignCorner,
    handleAutoArrange, handleArtboardResize, handleExpandArtboard, handleThresholdAlpha,
    handleThresholdAlphaAll, handleCropDesign, handleCropApply, handleDownload, handleAddToCart,
    handleCanvasContextMenu, handleInteractionEnd, handleUndo, handleRedo, canUndo, canRedo,
    handleAutoArrangeRef, actionToolbarProps, getLayerThumbnail, onDesignUploaded,
    setDesignGap, setDuplicateCount, parseDuplicateCount, handleDuplicateCountKeyDown, clampDuplicateCount,
    setArtboardWidth, setArtboardHeight, setQuantity, copySpotSelectionsRef,
  } = m;

${viewBody.replace(/^  const actionToolbarProps = \{[\s\S]*?\};\n/, "")}
}
`;

fs.writeFileSync(path.join(root, "client/src/components/image-editor/image-editor-view.tsx"), viewFile);

const typesPath = path.join(root, "client/src/components/image-editor/types.ts");
if (!fs.readFileSync(typesPath, "utf8").includes("ImageEditorProps")) {
  fs.appendFileSync(typesPath, `
import type { ProfileConfig } from "@/lib/profiles";

export interface ImageEditorProps {
  onDesignUploaded?: () => void;
  profile?: ProfileConfig;
  initialWidth?: number;
  initialHeight?: number;
  initialGangsheetHeights?: number[];
  initialQuantity?: number;
  shopifyVariants?: Array<{ id: string; title: string; price: string | null; height: number | null }>;
  variantId?: string | null;
  shopDomain?: string | null;
  embedFromShopify?: boolean;
  initialDesignState?: InitialDesignState | null;
  initialDesignId?: string | null;
  isEditMode?: boolean;
}
`);
}

const thinMain = `import { HOT_PEEL_PROFILE } from "@/lib/profiles";
import type { ImageEditorProps } from "./image-editor/types";
import { useImageEditorModel } from "./image-editor/use-image-editor-model";
import ImageEditorView from "./image-editor/image-editor-view";

export type { ImageInfo, ResizeSettings, ImageTransform, DesignItem } from "@/lib/types";
export { HOT_PEEL_PROFILE };

export default function ImageEditor(props: ImageEditorProps = {}) {
  const model = useImageEditorModel(props);
  return <ImageEditorView model={model} />;
}
`;

fs.writeFileSync(mainPath, thinMain);

// Split model into 3 parts under 1K each
const modelLines = modelHook.split("\n");
const hookStart = modelLines.findIndex((l) => l.includes("}: ImageEditorProps"));
const bodyLines = modelLines.slice(hookStart + 2, -3); // exclude closing brace and export type

const chunk1 = bodyLines.slice(0, 980);
const chunk2 = bodyLines.slice(980, 1960);
const chunk3 = bodyLines.slice(1960);

function wrapChunk(name, chunkBody, partIndex) {
  if (partIndex === 1) {
    return `${modelImports}
import type { ImageEditorModelContext } from "./model-context";

export function useImageEditorModelPart1(props: ImageEditorProps): ImageEditorModelContext {
${chunkBody}
  return ctx;
}
`;
  }
  return `import type { ImageEditorModelContext } from "./model-context";
import type { ImageEditorProps } from "./types";

export function useImageEditorModelPart${partIndex}(props: ImageEditorProps, ctx: ImageEditorModelContext): ImageEditorModelContext {
${chunkBody}
  return ctx;
}
`;
}

// Actually splitting model into parts with shared ctx is complex - skip auto-chunk for now if model hook works as single file
// Instead split model manually into thematic files after verifying build

console.log("main lines:", thinMain.split("\n").length);
console.log("model lines:", modelHook.split("\n").length);
console.log("view lines:", viewFile.split("\n").length);

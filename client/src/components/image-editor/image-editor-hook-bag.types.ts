import type { useImageEditorModelStateDesign } from "./useImageEditorModelStateDesign";
import type { useImageEditorModelArrangeKeyboard } from "./useImageEditorModelArrangeKeyboard";
import type { useImageEditorModelUploadCrop } from "./useImageEditorModelUploadCrop";
import type { useImageEditorModelHalftone } from "./useImageEditorModelHalftone";
import type { useImageEditorModelColorChange } from "./useImageEditorModelColorChange";
import type { useImageEditorModelExport } from "./useImageEditorModelExport";

export type ImageEditorBagAfterDesign = ReturnType<typeof useImageEditorModelStateDesign>;
export type ImageEditorBagAfterArrange = ReturnType<typeof useImageEditorModelArrangeKeyboard>;
export type ImageEditorBagAfterUploadCrop = ReturnType<typeof useImageEditorModelUploadCrop>;
export type ImageEditorBagAfterHalftone = ReturnType<typeof useImageEditorModelHalftone>;
export type ImageEditorBagAfterColorChange = ReturnType<typeof useImageEditorModelColorChange>;
export type ImageEditorBagAfterExport = ReturnType<typeof useImageEditorModelExport>;

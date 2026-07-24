import { createContext, useContext } from "react";
import type { ImageEditorModel } from "./image-editor-provider";

export const ImageEditorContext = createContext<ImageEditorModel | null>(null);

export function useImageEditorContext() {
  const ctx = useContext(ImageEditorContext);
  if (!ctx) throw new Error("useImageEditorContext must be used within ImageEditorProvider");
  return ctx;
}

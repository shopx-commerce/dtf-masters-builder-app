import type { ImageEditorProps } from "./image-editor/types";
import { ImageEditorProvider } from "./image-editor/image-editor-provider";
import ImageEditorView from "./image-editor/image-editor-view";

export type {
  ImageInfo,
  ResizeSettings,
  ImageTransform,
  DesignItem,
  StrokeSettings,
  ShapeSettings,
  StrokeMode,
  CutlineVisibility,
  StickerSize,
} from "@/lib/types";

export default function ImageEditor(props: ImageEditorProps = {}) {
  return (
    <ImageEditorProvider {...props}>
      <ImageEditorView />
    </ImageEditorProvider>
  );
}

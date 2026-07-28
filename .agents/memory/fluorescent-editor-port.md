---
name: Fluorescent editor port
description: Durable constraints for maintaining the Fluorescent color-selection improvements.
---

The Fluorescent editor should remain a selective enhancement of the existing editor architecture: keep Shopify upload/cart/update, variant, R2 media, export, and embed flows unchanged, and route interactive wand state through the existing ControlsSection and PreviewSection boundary.

**Why:** Replacing the editor wholesale would risk regressions in the established Shopify-sensitive flows; the source repository is useful as a behavior reference, not as a drop-in architecture.

**How to apply:** When porting future source changes, preserve the current provider/context and export pipeline, gate Fluorescent-only UI by product profile, and keep Magic Wand erase, Selection Zoom, pinch zoom, and pan mutually exclusive with Color Select Wand assignment.
---
name: Fluorescent editor port
description: Durable constraints for maintaining the Fluorescent color-selection improvements.
---

The Fluorescent editor should remain a selective enhancement of the existing editor architecture: keep Shopify upload/cart/update, variant, R2 media, export, and embed flows unchanged, and route interactive wand state through the existing ControlsSection and PreviewSection boundary.

**Why:** Replacing the editor wholesale would risk regressions in the established Shopify-sensitive flows; the source repository is useful as a behavior reference, not as a drop-in architecture.

**How to apply:** When porting future source changes, preserve the current provider/context and export pipeline, gate Fluorescent-only UI by product profile, and keep Magic Wand erase, Selection Zoom, pinch zoom, and pan mutually exclusive with Color Select Wand assignment.

Auto Color undo state must be stored per design, not as one panel-wide boolean, because color assignments are restored per selected design.

**Why:** Switching between designs otherwise resets the undo label even though the first design still has its auto-assigned fluorescent colors.

**How to apply:** Keep each design's pre-auto-assignment snapshot keyed by design ID and restore the corresponding snapshot when selection changes.

Embedded production uploads must not fall back to posting the full exported file through the parent add-to-cart message.

**Why:** The storefront proxy's upload endpoint can reject large PDF message bodies with HTTP 413; the signed upload URL or shell R2 relay must carry the file instead.

**How to apply:** Prefer a configured signed upload URL over the legacy shell relay, pass the production format and MIME type, and fail clearly rather than sending an oversized PDF fallback.
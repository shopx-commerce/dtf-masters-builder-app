---
name: Restored layer asset normalization
description: Saved transparent uploads may contain padding while state dimensions describe cropped artwork.
---

When restoring a saved transparent layer, compare the saved physical aspect ratio with the source image and its alpha-content bounds. Crop only when the alpha bounds match the saved dimensions; preserve the original image for intentional non-proportional resizing.

**Why:** The editor can save cropped physical dimensions while an older or external asset reference still points to the original padded upload, which stretches artwork in Admin Edit.

**How to apply:** Keep the normalization bounded and cache repeated assets during a restore. If normalization changes pixels, do not reuse the old remote asset on the next save.
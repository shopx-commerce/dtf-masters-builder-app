---
name: Editor file rehydration
description: Invalid editor image references can be repaired once from the IndexedDB draft before an operation fails.
---

When an editor image or file reference becomes unusable, rehydrate that design from its IndexedDB blob, replace the live ImageInfo, invalidate image-derived caches, and retry the current operation once. If the backup is missing, preserve the draft and stop with a recovery message.

**Why:** Browser and Windows temporary file references can disappear during large-sheet sessions even while React still holds a File object.

**How to apply:** Use the shared preflight before arrange/export/cart work and keep the retry bounded per invalid file state so a missing backup cannot create an infinite loop.
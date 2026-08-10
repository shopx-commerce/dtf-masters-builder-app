---
name: Editor draft recovery
description: Browser crash recovery uses IndexedDB for editor state and uploaded file blobs.
---

Keep crash recovery in IndexedDB, storing the current design snapshot separately from immutable uploaded file blobs keyed by file signature. Autosave should be debounced and remote saved-design state must take precedence over local recovery.

**Why:** Large PNGs exceed practical localStorage limits, and browser resets can otherwise destroy hours of gangsheet work.

**How to apply:** Preserve the original file blobs for export, save meaningful editor state after changes, offer recovery only for unsent local work, and discard an old draft when the user starts a fresh upload.
---
name: Parent postMessage memory guard
description: Large editor payloads can fail during structured cloning even after export succeeds.
---

Keep the existing parent message contract and wrap large parent `postMessage` calls so structured-clone or out-of-memory failures become a clear recoverable editor error. Release temporary production buffers after a successful handoff and close transferred export bitmaps if worker submission fails.

**Why:** Large sheets can exhaust browser memory while cloning a cross-window payload, leaving the editor with an opaque red failure even though the design itself is still recoverable.

**How to apply:** Treat this as a safety net, not a replacement for eventually moving image payloads to storage URLs. Do not alter normal successful uploads or production rendering when applying the guard.
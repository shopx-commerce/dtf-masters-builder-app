---
name: Spot color input boundary
description: Normalize optional UI color flags before passing extracted colors into PDF spot-color tracing.
---

The editor’s extracted-color model allows spot flags to be omitted, while PDF spot-color tracing requires explicit booleans. Normalize the flags at that boundary and do not assume optional display-only name fields exist on extracted colors.

**Why:** Fluorescent cart/PDF generation can fail at compile time or runtime when UI-shaped color objects are passed directly into the stricter tracing helper.

**How to apply:** Map extracted colors to the `SpotColorInput` shape immediately before calling spot-color PDF/vector code.
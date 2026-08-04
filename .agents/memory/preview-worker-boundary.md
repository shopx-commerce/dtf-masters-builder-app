---
name: Preview worker boundary
description: Preview-only thumbnail and color work may run in workers without changing export or cart rendering.
---

Keep worker offloading limited to preview-only work unless the output contract is explicitly revalidated. Thumbnail jobs should use request IDs, ignore stale results, revoke generated blob URLs, and fall back to the existing main-thread path.

**Why:** Large sheets need responsive interaction, but export and cart output must remain pixel- and coordinate-compatible.

**How to apply:** Add worker-backed preview preparation behind capability checks, keep exports on their current path, and treat worker failure as a recoverable compatibility case.
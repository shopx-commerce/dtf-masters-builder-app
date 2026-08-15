---
name: Production file recovery
description: How to rebuild a missing production gangsheet.png from saved design state when the storage URL 404s.
---

# Recovering a missing production gangsheet

**Rule:** A 404 production URL with a working cart preview usually means the file was never generated — not deleted. The design is recoverable: the state JSON and every layer asset live in public storage.

**Why:** Since the phase-2 speed-up, "server-render eligible" designs skip the client render entirely; the deterministic production URL is minted before any bytes exist and a storefront-proxy-side renderer is supposed to produce the file later. This Replit app has neither a renderer nor R2 write credentials (no R2_ACCOUNT_ID/R2_API_TOKEN in any env), so if the proxy side doesn't generate it, nothing does — the order link points at nothing. (Pre-phase-2 misses came from the parent-shell upload being killed by the redirect-to-cart navigation.)

**How to apply:**
1. State JSON is publicly fetchable at `<R2 public base>/designs/<shopKey>/<designId>/state/design-state.json` (allowlist regex in `server/lib/safe-external-url.ts`). Layer assets under `.../layers/` are public too.
2. Rebuild by mirroring `client/src/lib/export-worker.ts` math exactly: sheet = artboard inches × outputDpi; per layer center = (x·outW, y·outH) (x/y are normalized nx/ny); draw box = widthInches·|s|·dpi (saved scaleX = s·flipSign); rotate clockwise about center; composite in zIndex order on transparent canvas; write PNG with density set.
3. Halftoned layers must composite their already-screened render 1:1, never resampled (none hit so far).
4. Verify before delivering: alpha stats non-blank at native res, and visually diff a flattened thumbnail against the design's `preview/cart-preview.png` — it was rendered by the same math and is ground truth.
5. Rebuilt files can only be handed to the user as downloads; restoring the original media URL requires the dev's proxy-side R2 credentials.

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

## Very tall sheets (learned on 180"/250" recoveries)

- Sheets past ~100" at 300dpi exceed sharp-composite memory. Working approach: blend layers into fresh zeroed bands (~512 rows) in zIndex order with straight-alpha source-over, stream each band through one zlib deflate into multiple IDAT chunks (custom PNG writer with pHYs for density). ~25s for 91 layers on a 54000-row sheet; peak RSS stays under ~500MB. A band-scoped refcount evicts rotated renders once their last band is done.
- sharp traps hit: only ONE `.resize()` per pipeline (a second call silently replaces the first), and `.rotate()` runs BEFORE `.resize()` in a single chain — resize and rotate must be separate pipelines on raw buffers.
- Rotation semantics confirmed end-to-end: state JSON degrees = canvas 2D clockwise = sharp `.rotate()` positive. Verified by native-res crop of an asymmetric 90°-rotated layer vs the preview (pole side / text order).
- Verification calibration: the cart preview composites over a checkerboard transparency pattern, so semi-transparent distress art produces a ~10% binarized-alpha mismatch floor that is NOT a defect. Prove correctness with (a) best-shift correlation per sheet third (expect ≤1px offset), and (b) an asymmetric rotated-layer crop for direction. A same-layout no-rotation design gives the speckle baseline.
- Preview `last-modified` predates the state JSON save by the layer-upload duration (preview uploads first, then layers, then state) — a sub-minute gap does not mean divergent versions.
- Layer assets in R2 are the editor's already-processed bytes (alpha threshold etc. baked in); `settings.alphaThresholded` is informational, do not re-apply.
- `tmp-rebuild-gangsheet.mjs` in the workspace root (gitignored) implements all of this; rewrite from this recipe if it is gone. Usage: `node tmp-rebuild-gangsheet.mjs <state.json> <out.png> 300 [thumb.png] [thumbDpi]`.

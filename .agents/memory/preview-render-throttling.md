---
name: Preview render throttling
description: Rules for rAF-throttled zoom/pan state commits and static-composite signature caching in the editor preview.
---

Rule: wheel/pinch zoom and pan state commits are rAF-throttled (one React re-render per frame); one-shot zoom actions (fit, reset, focus, toolbar +/-) must go through an immediate commit helper that cancels the pending rAF and syncs the ref, or a stale queued value overwrites the requested zoom. The per-render `zoomRef.current = zoom` sync must be skipped while a queued commit is pending.

The static-composite cache signature over all non-selected designs is precomputed once per render-effect run (its inputs are all effect deps), not rebuilt per drag frame — rebuilding the string per frame was itself a hot-path cost with many designs.

**Why:** with many designs, per-event setZoom re-rendered the ~4k-line preview component faster than refresh rate, and per-frame signature hashing scaled with design count.

Multi-drag commits `designs` per pointer move, so any moving design's transform must stay out of the composite signature: while dragging, multi-selected companions are excluded from the composite and drawn per-frame on top (ghost alpha). Baking them in forces a full composite rebuild every frame.

The static composite must actually draw every non-excluded design inside its scene-draw helper. A refactor that moves ghost drawing out of the composite can silently drop the base image draw — the symptom is "non-selected designs vanish" (e.g. added layer copies invisible) whenever the composite rebuilds, and it can look like a stale-closure race because whichever render pass last rebuilt the empty composite wins.

**How to apply:** any new zoom/pan mutation site must pick queued (continuous gestures) vs immediate (one-shot) commit; any new input to the static scene draw must be added both to the signature body and the render-effect deps. Preview-only — never touch export/cart rendering.

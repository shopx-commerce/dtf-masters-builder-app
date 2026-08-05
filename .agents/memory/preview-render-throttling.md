---
name: Preview render throttling
description: Rules for rAF-throttled zoom/pan state commits and static-composite signature caching in the editor preview.
---

Rule: wheel/pinch zoom and pan state commits are rAF-throttled (one React re-render per frame); one-shot zoom actions (fit, reset, focus, toolbar +/-) must go through an immediate commit helper that cancels the pending rAF and syncs the ref, or a stale queued value overwrites the requested zoom. The per-render `zoomRef.current = zoom` sync must be skipped while a queued commit is pending.

The static-composite cache signature over all non-selected designs is precomputed once per render-effect run (its inputs are all effect deps), not rebuilt per drag frame — rebuilding the string per frame was itself a hot-path cost with many designs.

**Why:** with many designs, per-event setZoom re-rendered the ~4k-line preview component faster than refresh rate, and per-frame signature hashing scaled with design count.

**How to apply:** any new zoom/pan mutation site must pick queued (continuous gestures) vs immediate (one-shot) commit; any new input to the static scene draw must be added both to the signature body and the render-effect deps. Preview-only — never touch export/cart rendering.

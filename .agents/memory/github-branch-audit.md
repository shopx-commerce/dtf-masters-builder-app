---
name: GitHub branch audit
description: How to evaluate the historical gangsheet-editor-updates branch against the current editor.
---

The historical `feature/gangsheet-editor-updates` branch is not a safe upgrade base for the current app. It replaces the modular editor with a monolithic component and removes or regresses current draft recovery, restored-image handling, bounded export workers, halftone source preservation, arrange/preview improvements, local upscaling, and Shopify/embed/cart bridges.

**Why:** The branch was created before the current pipeline work and its apparent additions are mixed with broad deletions/replacements. A direct merge can compile only after substantial repair while silently dropping newer behavior.

**How to apply:** During future GitHub syncs, compare branch ancestry and changed/deleted paths first. Keep current `main` for editor architecture, export, restore, workers, and Shopify boundaries; port only an isolated feature after checking it against current types and call sites.
---
name: Gangsheet height list normalization
description: Height option lists from Shopify variants must be deduped and numerically sorted before any "next size up" logic.
---

Height lists supplied by Shopify variants (`initialGangsheetHeights`) can arrive in arbitrary order (variant position / alphabetical string order like 12, 120, 160, 24, 340).

**Rule:** any list of gangsheet height options must be deduped and sorted ascending numerically at the point it is memoized, before `find(h => h > current)` / `find(h => h >= required)` / `list[list.length - 1]` (MAX) lookups.

**Why:** an unsorted list made "add one copy" auto-expansion jump 12" straight to 340" (the first larger entry in list order), and could also make MAX wrong, disabling expansion entirely.

**How to apply:** the two memos that build the list (arrange/keyboard hook and state/design hook) normalize it; if a new consumer receives raw variant heights, normalize there too. Dev repro on the test page: `?heights=340,12,24,...&copytest=1&copyclicks=N` (DEV + test mode only) plus sheet-dims console logging.

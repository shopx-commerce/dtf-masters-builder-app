---
name: Copy-count arrangement
description: Packing behavior when changing a layer's copy count.
---

Changing a layer's copy count must use full-sheet Auto-Arrange even when the new copies are selected in Layers. Preserve the selection for user feedback, but do not let it switch the arranger into selected-only mode.

**Why:** Selected-only arrangement treats every other design as a fixed obstacle, so newly added copies can stack in a vertical column below their source. The user expects the same space-filling result as clicking Auto-Arrange.

**How to apply:** Keep packing scope as an explicit arrangement option. Use full-sheet scope for copy-count add/remove operations and selected-only scope only for intentional multi-selection arrangement.
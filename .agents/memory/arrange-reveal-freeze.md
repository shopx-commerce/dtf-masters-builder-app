---
name: Hiding a multi-commit operation
description: Why covering the canvas never hid auto-nesting, and the rule that replaced it — withhold the commits from the view instead of veiling them.
---

Hiding an operation that commits state many times means **withholding the commits from the
view**, not painting something over the canvas.

**Why:** Auto-Arrange, the height ladder and Fill Sheet each commit React state several times
per logical operation — a rung scales every design and raises the sheet, the next pack commits
its own layout, Fill Sheet deliberately appends copies stacked at sheet centre before a pass
spreads them, and every height commit re-fits the view. A translucent cover was already in
place and the customer still watched the sheet thrash underneath it, because the canvas
repaints on each of those commits regardless of what is drawn on top. Making the cover more
opaque only trades a visible struggle for a longer blank wait; the repaint cost, the mid-flight
overlap marks and the re-zoom are all still happening. Freezing the props the preview reads
removes the frames themselves — the preview sees no change, so it has nothing to repaint, and
the finished layout arrives in one commit.

**How to apply:** When a preview must hide a multi-step operation:

- Hold **the whole picture together** — designs, sheet size, selection, transform, the epoch.
  Holding the designs but not the sheet height shows a frame that never existed.
- Capture the pre-operation frame from a ref written by a dependency-less effect, and detect
  the busy transition **during render**. The flag and the first mutation usually arrive in the
  same batch, so capturing in an effect grabs the already-mutated frame — for Fill Sheet that
  is precisely the copies piled in the centre, held for the whole operation.
- Always give the hold a failsafe timeout. A stale picture that stopped being true is worse
  than untidy nesting.
- **Go inert while held.** A frozen sheet is a picture of somewhere the designs no longer are,
  so pointer input on it acts on positions the customer cannot see. Disable pointer events on
  the canvas area only — the zoom, reset and history controls sit outside it and must stay
  live, as must anything the preview portals out (mobile toolbar, backdrop picker).
- Keep the cover mounted a beat past settle (~160ms). The final repaint and the re-fit both
  happen after the busy flag drops, and they are the last thing that should be visible.

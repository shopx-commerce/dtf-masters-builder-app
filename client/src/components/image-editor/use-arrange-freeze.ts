import { useEffect, useRef, useState } from "react";

/**
 * How long the preview can be held before it is let go regardless of what the editor says.
 *
 * Purely a failsafe. A held preview showing a picture that stopped being true minutes ago is
 * far worse than a moment of untidy nesting, so if the busy flag ever sticks — a worker that
 * never reports, an exception on a path that skips the usual cleanup — the sheet comes back
 * on its own rather than stranding the customer in front of a frozen editor.
 */
const MAX_HOLD_MS = 20000;

/**
 * Holds the preview on the frame it had before an arrange started.
 *
 * Packing a sheet is not one visual change but several. Copies are added at a provisional
 * position, the packer moves them, an overflow throws the layout away and packs it again,
 * and if the artwork still does not fit, the sheet grows to the next purchasable height and
 * the whole thing is repacked at the new size — each rung committing its own layout. Fill
 * Sheet goes further and stacks its new copies in the middle of the sheet on purpose before
 * each pass spreads them out. React paints every one of those commits, so the customer
 * watches designs land in the wrong place, jump, pile up and re-zoom before settling. The
 * result was right the whole time; the process just looks broken.
 *
 * Rather than trying to cover all that up, this stops it being drawn at all. While the sheet
 * is busy the preview keeps being handed the values it already had, so from its point of
 * view nothing has changed and it has nothing to repaint. When the sheet settles, the real
 * values arrive in a single commit and it paints the finished layout once.
 *
 * That also takes care of the red overlap marks for free. They are recomputed from whatever
 * is committed, so an intermediate layout used to be able to flash them up mid-arrange; an
 * intermediate layout that is never handed over cannot.
 *
 * Pass one object holding everything that describes the picture. Anything left out stays
 * live and will disagree with the held frame, so it is better to hold too much than too
 * little — the whole bundle is swapped back together the moment the sheet settles.
 */
export function useArrangeFreeze<T extends object>(live: T, busy: boolean, maxHoldMs = MAX_HOLD_MS): T {
  /**
   * The bundle as of the last settled commit.
   *
   * Recorded in an effect, which is what makes the hold land on the right frame. Adding
   * copies raises the busy flag and puts the new copies into state in the same commit, so by
   * the time this hook runs `live` already has them. Effects have not run for that commit
   * yet, so this still holds the sheet as it was a moment before — which is the frame worth
   * keeping on screen.
   */
  const settledRef = useRef(live);
  const heldRef = useRef<T | null>(null);
  const busyRef = useRef(false);
  const [expired, setExpired] = useState(false);

  // In render rather than an effect: an effect would let one intermediate frame through
  // before the hold began, and that frame is the ugliest one of the operation.
  if (busy !== busyRef.current) {
    busyRef.current = busy;
    heldRef.current = busy ? settledRef.current : null;
  }

  useEffect(() => {
    if (!busy) {
      setExpired(false);
      return;
    }
    const timer = window.setTimeout(() => setExpired(true), maxHoldMs);
    return () => window.clearTimeout(timer);
  }, [busy, maxHoldMs]);

  const view = !expired && heldRef.current ? heldRef.current : live;

  useEffect(() => {
    if (!busy) settledRef.current = live;
  });

  return view;
}

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n";

/**
 * How long the sheet has to be busy before the veil appears.
 *
 * Short, because the veil's job is to hide the intermediate layouts, and they are painted within
 * a frame or two of the click. Not zero, because an arrange that finishes in 80ms would otherwise
 * flash a grey sheet at the customer, and a flash reads as a glitch where nothing was wrong.
 */
const SHOW_AFTER_MS = 140;

/** Fade at each end. Long enough to read as a transition, short enough not to feel like a wait. */
const FADE_MS = 180;

/**
 * Covers the preview while the sheet is being packed.
 *
 * Adding a copy is not one visual change but three: the copy appears on a provisional grid, the
 * packer moves it, and if the artwork no longer fits the sheet grows and everything is packed
 * again. Each one gets painted, so the customer watching sees designs land in the wrong place and
 * jump — which is what "weird looking nesting" and "it feels buggy" describe, even though the
 * final layout was correct all along. Hiding the middle of the operation and showing the settled
 * result is both more honest about what is happening and much less alarming to watch.
 *
 * Deliberately does not take pointer events, and sits at `z-20` — under the phone's tool and
 * layers sheets at `z-40`. Clicking "+" several times in a row is a normal way to build a sheet,
 * so the controls that do it must stay both crisp and clickable while the sheet behind them is
 * covered; a veil that dimmed or swallowed those clicks would make the editor feel locked.
 */
export function ArrangeOverlay({ stage }: { stage: 'nesting' | 'expanding' | null }) {
  const { t } = useLanguage();
  // `mounted` outlives `stage` by one fade so the veil can be seen leaving; without it the
  // overlay would be unmounted on the same frame the layout settles and simply blink out.
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  // Held so the caption does not change while the veil is fading out, which would read as the
  // editor starting a second operation on its way to finishing the first.
  const [lastStage, setLastStage] = useState<'nesting' | 'expanding'>('nesting');
  useEffect(() => {
    if (stage) setLastStage(stage);
  }, [stage]);

  // Keyed on being busy at all rather than on the stage, so a run that goes from nesting to
  // growing the sheet neither restarts the delay nor flickers between the two.
  const busy = stage !== null;
  useEffect(() => {
    if (busy) {
      const timer = window.setTimeout(() => {
        setMounted(true);
        // Painted transparent first, so the browser has a previous value to animate from.
        requestAnimationFrame(() => setShown(true));
      }, SHOW_AFTER_MS);
      return () => window.clearTimeout(timer);
    }
    setShown(false);
    const timer = window.setTimeout(() => setMounted(false), FADE_MS);
    return () => window.clearTimeout(timer);
  }, [busy]);

  if (!mounted) return null;

  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-white/70 backdrop-blur-[2px] transition-opacity ${
        shown ? "opacity-100" : "opacity-0"
      }`}
      style={{ transitionDuration: `${FADE_MS}ms` }}
    >
      <div className="flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-[12px] font-semibold text-white shadow-lg">
        <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
        {lastStage === 'expanding' ? t("editor.expandingSheet") : t("editor.nesting")}
      </div>
    </div>
  );
}

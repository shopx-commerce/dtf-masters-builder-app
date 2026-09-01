import { useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n";

/**
 * How long the sheet has to be busy before the cover appears.
 *
 * Not zero, because an arrange that finishes in 80ms would otherwise flash a panel at the
 * customer, and a flash reads as a glitch where nothing was wrong. Nothing is at risk during
 * this window: the preview is already held on its last settled frame by then, so what is on
 * screen for those first few frames is a calm sheet rather than a half-packed one.
 */
const SHOW_AFTER_MS = 140;

/**
 * How long the cover stays up after the sheet reports itself finished.
 *
 * The settled layout is handed to the preview the instant the sheet is no longer busy, and
 * painting it takes a frame — plus another for the view to re-fit if the sheet grew a size.
 * Lifting the cover on that same tick would put the one thing it exists to hide, the jump to
 * the new size, right at the end of the reveal. Waiting lets all of it happen underneath.
 */
const HOLD_AFTER_MS = 160;

/** Fade at each end. Long enough to read as a reveal, short enough not to feel like a wait. */
const FADE_MS = 220;

/** Six pieces finding their places, staggered so they read as being set down one by one. */
const TILES = [0, 1, 2, 3, 4, 5];

/**
 * Covers the preview while the sheet is being packed.
 *
 * Works together with `useArrangeFreeze`, and the division between them matters. The freeze
 * is what actually keeps the intermediate layouts — the provisional placements, the discarded
 * packs, the sheet growing a rung at a time, Fill Sheet's copies stacked in the middle —
 * from ever being drawn. This is only the curtain in front of it: it says the editor is
 * working, and it hides the moment the finished layout drops into place. Without the freeze
 * a translucent cover just makes the same jumping harder to see; with it, there is nothing
 * moving back there to hide.
 *
 * Everything here animates transform and opacity only, so the whole cover is compositor work
 * and costs the packer nothing at the moment the machine is busiest. Deliberately NOT a
 * backdrop-filter: blurring the covered canvas would re-filter it every frame for no gain,
 * since the frame behind is a still one.
 *
 * Deliberately does not take pointer events, and sits at `z-20` — under the phone's tool and
 * layers sheets at `z-40`. Clicking "+" several times in a row is a normal way to build a
 * sheet, so the controls that do it must stay both crisp and clickable while the sheet behind
 * them is covered; a cover that swallowed those clicks would make the editor feel locked.
 */
export function ArrangeOverlay({ stage }: { stage: 'nesting' | 'expanding' | 'filling' | null }) {
  const { t } = useLanguage();
  // `mounted` outlives `stage` by the hold plus one fade so the cover can be seen leaving;
  // without it the overlay would unmount on the same frame the layout settles and blink out.
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  // Held so the caption does not change while the cover is fading out, which would read as
  // the editor starting a second operation on its way to finishing the first.
  const [lastStage, setLastStage] = useState<'nesting' | 'expanding' | 'filling'>('nesting');
  useEffect(() => {
    if (stage) setLastStage(stage);
  }, [stage]);

  // Keyed on being busy at all rather than on the stage, so a run that goes from nesting to
  // growing the sheet neither restarts the delay nor flickers between the two.
  const busy = stage !== null;
  useEffect(() => {
    if (busy) {
      let frame = 0;
      const timer = window.setTimeout(() => {
        setMounted(true);
        // Painted transparent first, so the browser has a previous value to animate from.
        frame = requestAnimationFrame(() => setShown(true));
      }, SHOW_AFTER_MS);
      return () => {
        window.clearTimeout(timer);
        if (frame) cancelAnimationFrame(frame);
      };
    }
    const fade = window.setTimeout(() => setShown(false), HOLD_AFTER_MS);
    const unmount = window.setTimeout(() => setMounted(false), HOLD_AFTER_MS + FADE_MS);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(unmount);
    };
  }, [busy]);

  if (!mounted) return null;

  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 z-20 flex items-center justify-center overflow-hidden transition-opacity ${
        shown ? "opacity-100" : "opacity-0"
      }`}
      style={{
        transitionDuration: `${FADE_MS}ms`,
        // Near enough to solid that nothing behind it is legible, but not a dead slab: the
        // sheet stays faintly visible so the customer can still see they are looking at
        // their own work rather than at the editor having navigated somewhere.
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(248,250,252,0.96) 55%, rgba(255,255,255,0.95) 100%)",
      }}
    >
      {/* A slow band of light travelling down the sheet. The only suggestion that anything is
          being worked over, and the only thing on this layer that moves. */}
      <div
        className="veil-sweep absolute inset-x-0 h-1/3"
        style={{
          background:
            "linear-gradient(180deg, rgba(16,185,129,0) 0%, rgba(16,185,129,0.08) 50%, rgba(16,185,129,0) 100%)",
        }}
      />
      <div
        className={`relative flex flex-col items-center gap-3 rounded-2xl border border-slate-200/80 bg-white/95 px-6 py-5 transition-all ${
          shown ? "scale-100 opacity-100" : "scale-95 opacity-0"
        }`}
        style={{
          transitionDuration: `${FADE_MS}ms`,
          boxShadow: "0 12px 32px -14px rgba(15,23,42,0.38)",
        }}
      >
        <span className="grid grid-cols-3 gap-1.5">
          {TILES.map((i) => (
            <i
              key={i}
              className="veil-tile block h-2.5 w-2.5 rounded-[3px] bg-emerald-500"
              style={{ animationDelay: `${i * 0.12}s` }}
            />
          ))}
        </span>
        <span className="text-[12px] font-semibold tracking-wide text-slate-700">
          {lastStage === 'expanding'
            ? t("editor.expandingSheet")
            : lastStage === 'filling'
              ? t("editor.fillingSheet")
              : t("editor.nesting")}
        </span>
        {/* Indeterminate on purpose. The packer cannot say how far through it is — it may
            still throw the layout away and start again on a bigger sheet — and a bar that
            claimed a percentage would be inventing one. */}
        <span className="relative block h-[3px] w-28 overflow-hidden rounded-full bg-slate-200">
          <span
            className="veil-bar absolute inset-y-0 left-0 w-1/3 rounded-full"
            style={{ background: "linear-gradient(90deg, rgba(16,185,129,0.25), rgb(16,185,129), rgba(16,185,129,0.25))" }}
          />
        </span>
      </div>
    </div>
  );
}

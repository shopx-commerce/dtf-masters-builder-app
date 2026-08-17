import { useEffect, useState } from "react";
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
 * One tileable wave. The path starts and ends at the same height with the same slope, so two of
 * them side by side join seamlessly and the track can loop by sliding exactly one tile.
 */
function WaveShape({ fill }: { fill: string }) {
  return (
    <svg
      className="h-full w-1/2 flex-none"
      viewBox="0 0 1440 180"
      preserveAspectRatio="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M0,96 C240,150 480,42 720,96 C960,150 1200,42 1440,96 L1440,180 L0,180 Z" fill={fill} />
    </svg>
  );
}

/**
 * A drifting band of water. The only thing that ever changes per frame is the track's transform,
 * which keeps the whole animation on the compositor thread: it costs no layout, no paint, and no
 * main-thread time while the packer is working. Layers drift at different speeds and in opposite
 * directions so the water reads as depth rather than as a repeating texture.
 */
function WaveLayer({
  duration,
  delay,
  reverse,
  height,
  fill,
}: {
  duration: number;
  delay: number;
  reverse?: boolean;
  height: string;
  fill: string;
}) {
  return (
    <div className="absolute inset-x-0 bottom-0 overflow-hidden" style={{ height }}>
      <div
        className="veil-wave-track"
        style={{
          animationDuration: `${duration}s`,
          animationDelay: `${delay}s`,
          animationDirection: reverse ? "reverse" : "normal",
        }}
      >
        <WaveShape fill={fill} />
        <WaveShape fill={fill} />
      </div>
    </div>
  );
}

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
 * The veil itself is a plain translucent gradient with slow water waves drifting along the bottom.
 * Deliberately NOT a backdrop-filter: blurring the covered canvas would re-filter it every frame
 * at the exact moment the machine is busiest. Every moving part here animates transform/opacity
 * only, so the veil is compositor-work and nothing else.
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
      className={`pointer-events-none absolute inset-0 z-20 flex items-center justify-center overflow-hidden transition-opacity ${
        shown ? "opacity-100" : "opacity-0"
      }`}
      style={{
        transitionDuration: `${FADE_MS}ms`,
        background:
          "linear-gradient(to bottom, rgba(255,255,255,0.80) 0%, rgba(255,255,255,0.74) 55%, rgba(250,254,252,0.87) 100%)",
      }}
    >
      <div className="absolute inset-x-0 bottom-0 h-[38%] min-h-[120px]">
        <WaveLayer duration={32} delay={-6} height="100%" fill="rgba(16,185,129,0.10)" />
        <WaveLayer duration={21} delay={-11} reverse height="76%" fill="rgba(20,184,166,0.14)" />
        <WaveLayer duration={13} delay={-3} height="56%" fill="rgba(34,197,94,0.18)" />
      </div>
      <div
        className={`relative flex items-center gap-2.5 rounded-full bg-slate-900/80 px-4 py-2 text-[12px] font-semibold text-white shadow-lg ring-1 ring-white/15 transition-all ${
          shown ? "scale-100 opacity-100" : "scale-95 opacity-0"
        }`}
        style={{ transitionDuration: `${FADE_MS}ms` }}
      >
        <span className="flex items-end gap-[3px]">
          <i className="veil-droplet" />
          <i className="veil-droplet" style={{ animationDelay: "0.16s" }} />
          <i className="veil-droplet" style={{ animationDelay: "0.32s" }} />
        </span>
        {lastStage === 'expanding' ? t("editor.expandingSheet") : t("editor.nesting")}
      </div>
    </div>
  );
}

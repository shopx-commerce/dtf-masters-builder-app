import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n";

/**
 * How long the sheet has to be busy before the customer is told about it.
 *
 * Most arranges finish well inside this, and an indicator that appears and vanishes inside a
 * few frames is worse than none at all: it reads as a flicker, and the flicker is what makes a
 * fast operation look broken. Anything long enough to notice gets past this and is explained.
 */
const SHOW_AFTER_MS = 400;

/**
 * Says what the sheet is doing while it packs, scoped to the preview.
 *
 * The stage matters because growing the sheet is several packs with a paint between each, which
 * without an explanation looks like the editor stuttering repeatedly rather than like one
 * operation taking its time.
 */
export function ArrangeBusyPill({ stage }: { stage: 'nesting' | 'expanding' | null }) {
  const { t } = useLanguage();
  const [visible, setVisible] = useState(false);

  // Keyed on being busy at all rather than on the stage, so a run that goes from nesting to
  // growing the sheet does not restart the timer. Restarting it would hide the indicator at
  // precisely the moment the wait became long enough to need one.
  const busy = stage !== null;
  useEffect(() => {
    if (!busy) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [busy]);

  if (!stage || !visible) return null;

  return (
    <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2">
      <div className="flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-[12px] font-semibold text-white shadow-lg backdrop-blur-sm">
        <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
        {stage === 'expanding' ? t("editor.expandingSheet") : t("editor.nesting")}
      </div>
    </div>
  );
}

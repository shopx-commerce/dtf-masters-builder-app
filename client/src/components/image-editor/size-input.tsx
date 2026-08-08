import { useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cmToInches, useMetric } from "@/lib/format-length";

export default function SizeInput({
  value,
  onCommit,
  title,
  min = 0.1,
  max = 999,
  lang,
}: {
  value: number;
  onCommit: (v: number) => void;
  title: string;
  min?: number;
  max?: number;
  lang: "en" | "es" | "fr";
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const onCommitAtFocusRef = useRef<typeof onCommit>(onCommit);
  const metric = useMetric(lang);
  const cm = value * 2.54;
  const useM = metric && cm >= 100;
  const stepInches = metric ? cmToInches(0.25) : 0.1;
  const display = metric
    ? useM
      ? (cm / 100).toFixed(2)
      : cm.toFixed(2)
    : value.toFixed(2);

  const commit = (raw: string) => {
    const v = parseFloat(raw);
    if (isNaN(v)) return;
    const inches = metric
      ? useM
        ? cmToInches(v * 100)
        : cmToInches(v)
      : v;
    onCommitAtFocusRef.current(Math.max(min, Math.min(inches, max)));
  };

  const step = (delta: number) => {
    onCommit(Math.max(min, Math.min(max, value + delta)));
  };

  // Hit area and glyph are separate boxes.
  //
  // These two arrows set a physical print dimension and sat 16×14 CSS px, 3px
  // apart: missing Increase by 8px hits Decrease, and the customer is left with
  // a plausible-looking wrong number in the field they are about to trust. On a
  // coarse pointer each `button` becomes a bare 44×44 hit box and the bezel
  // moves to an inner `span` that keeps its original 16×14, so the arrows are
  // no bigger to look at.
  //
  // Non-overlap is structural rather than arithmetic: the two buttons are
  // siblings in a flex column, so their border boxes cannot intersect whatever
  // the sizes are. The `coarse:gap-2` on top of that leaves 8px of dead space —
  // Material's recommended separation — between two 44px targets, so an
  // increment has to miss by more than 30px before it becomes a decrement.
  //
  // The cost is honest and unavoidable: two non-overlapping 44px targets need
  // 88px of column, so the pair occupies 96px of layout height on touch devices
  // against 31px on a mouse. Desktop is untouched — on a fine pointer the button
  // is exactly the size of the bezel it contains, as before.
  const arrows = (
    <div className="flex flex-col gap-[3px] coarse:gap-2">
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => step(stepInches)}
        aria-label="Increase size"
        className="group flex h-3.5 w-4 items-center justify-center coarse:h-11 coarse:w-11"
        title="Increase size"
      >
        <span className="flex h-3.5 w-4 min-w-4 items-center justify-center rounded border border-gray-300 bg-gray-100 text-gray-500 transition-colors group-hover:bg-cyan-100 group-hover:text-cyan-600 group-active:bg-cyan-200">
          <ChevronUp className="h-3 w-3" strokeWidth={3} />
        </span>
      </button>
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => step(-stepInches)}
        aria-label="Decrease size"
        className="group flex h-3.5 w-4 items-center justify-center coarse:h-11 coarse:w-11"
        title="Decrease size"
      >
        <span className="flex h-3.5 w-4 min-w-4 items-center justify-center rounded border border-gray-300 bg-gray-100 text-gray-500 transition-colors group-hover:bg-cyan-100 group-hover:text-cyan-600 group-active:bg-cyan-200">
          <ChevronDown className="h-3 w-3" strokeWidth={3} />
        </span>
      </button>
    </div>
  );

  // One input for both the idle and the editing state, never `readOnly`.
  //
  // This was two branches: an idle `readOnly` input whose `onFocus` swapped in
  // an editable one. iOS decides whether to raise the software keyboard at the
  // moment focus is granted, and at that moment the field was still read-only,
  // so an iPhone got no keyboard and the size could never be typed. Clearing
  // `readOnly` in the next render is too late — iOS does not re-evaluate an
  // element that is already focused. `inputMode` has to be there before the tap
  // for the same reason.
  //
  // Density is gated on the pointer, not on the layout width.
  //
  // This was `h-11 md:h-7` / `text-[16px] md:text-[12px]`, which reads the width
  // breakpoint as a proxy for "is there a mouse". An iPad is 820–834px wide, so
  // it took the `md:` arm and got a 28px field at 12px type — on a device with a
  // software keyboard and no mouse. `coarse:` asks the question directly, so the
  // 44px field and 16px type now follow the touch screen rather than the width.
  //
  // 44px is the smallest comfortable thumb target. 16px is the threshold below
  // which iOS Safari zooms the whole page on focus; `index.html`'s
  // `maximum-scale=1` cannot prevent that here, because a viewport meta only
  // governs the top-level document and this builder is embedded in an iframe on
  // the storefront (`lib/shell-message.ts`). Suppressing the zoom in the meta tag
  // instead would defeat WCAG 1.4.4, and newer iOS ignores it anyway.
  //
  // The field widens to `w-16` on touch because five characters (`12.00` /
  // `30.48`) clip at 56px once the type is 16px. A mouse keeps 12px / `w-14` /
  // 28px exactly as before.
  return (
    <div className="flex items-center gap-px">
      <input
        type="text"
        inputMode="decimal"
        className={`h-7 coarse:h-11 bg-white border-2 rounded font-bold text-gray-900 text-center outline-none shadow-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none text-[12px] coarse:text-[16px] ${metric ? 'w-16' : 'w-14 coarse:w-16'} ${
          editing
            ? 'border-cyan-500'
            : 'border-gray-300 cursor-pointer hover:border-cyan-400 hover:bg-cyan-50 active:bg-cyan-100 transition-colors'
        }`}
        value={editing ? draft : display}
        onChange={(e) => {
          setDraft(e.target.value);
          setEditing(true);
        }}
        onFocus={() => {
          onCommitAtFocusRef.current = onCommit;
          setDraft(display);
          setEditing(true);
        }}
        onBlur={() => {
          if (editing) commit(draft);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit(draft);
            setEditing(false);
          } else if (e.key === "Escape") setEditing(false);
        }}
        title={editing ? title : title + " — click to edit"}
      />
      {arrows}
    </div>
  );
}

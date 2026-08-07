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

  const arrows = (
    <div className="flex flex-col" style={{ gap: 3 }}>
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => step(stepInches)}
        aria-label="Increase size"
        className="flex h-3.5 w-4 min-w-4 items-center justify-center rounded border border-gray-300 bg-gray-100 text-gray-500 transition-colors hover:bg-cyan-100 hover:text-cyan-600 active:bg-cyan-200"
        title="Increase size"
      >
        <ChevronUp className="h-3 w-3" strokeWidth={3} />
      </button>
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => step(-stepInches)}
        aria-label="Decrease size"
        className="flex h-3.5 w-4 min-w-4 items-center justify-center rounded border border-gray-300 bg-gray-100 text-gray-500 transition-colors hover:bg-cyan-100 hover:text-cyan-600 active:bg-cyan-200"
        title="Decrease size"
      >
        <ChevronDown className="h-3 w-3" strokeWidth={3} />
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
  // Height: 44px on phones (`h-11`), the smallest comfortable thumb target, back to
  // 28px (`h-7`) from `md` up. `md` and not `lg` because that is where the layout
  // actually swaps — `image-editor-view` renders its size column only while
  // `useIsMobile()` (max-width 767px) holds, and above that the same component is used
  // by the desktop toolbar, so `lg:` would have left that toolbar 44px tall between
  // 768px and 1023px. The arrows stay 14px by choice: they are keyboard/mouse
  // affordances, and the field itself is what a thumb aims for.
  return (
    <div className="flex items-center gap-px">
      <input
        type="text"
        inputMode="decimal"
        className={`h-11 md:h-7 bg-white border-2 rounded font-bold text-gray-900 text-center outline-none shadow-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${metric ? 'w-16 text-[12px]' : 'w-14 text-[12px]'} ${
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

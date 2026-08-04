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

  if (editing) {
    return (
      <div className="flex items-center gap-px">
        <input
          type="text"
          inputMode="decimal"
           className={`h-7 bg-white border-2 border-cyan-500 rounded font-bold text-gray-900 text-center outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none shadow-sm ${metric ? 'w-16 text-[12px]' : 'w-14 text-[12px]'}`}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => {
            onCommitAtFocusRef.current = onCommit;
          }}
          onBlur={() => {
            commit(draft);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit(draft);
              setEditing(false);
            } else if (e.key === "Escape") setEditing(false);
          }}
          title={title}
        />
        {arrows}
      </div>
    );
  }
  return (
      <div className="flex items-center gap-px">
      <input
        type="text"
        readOnly
         className={`h-7 bg-white border-2 border-gray-300 rounded font-bold text-gray-900 text-center outline-none cursor-pointer hover:border-cyan-400 hover:bg-cyan-50 active:bg-cyan-100 transition-colors shadow-sm ${metric ? 'w-16 text-[12px]' : 'w-14 text-[12px]'}`}
        value={display}
        onFocus={() => {
          onCommitAtFocusRef.current = onCommit;
          setDraft(display);
          setEditing(true);
        }}
        title={title + " — click to edit"}
      />
      {arrows}
    </div>
  );
}

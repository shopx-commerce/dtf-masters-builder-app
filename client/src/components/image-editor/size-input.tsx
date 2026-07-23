import { useState } from "react";
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
  const metric = useMetric(lang);
  const cm = value * 2.54;
  const useM = metric && cm >= 100;
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
    onCommit(Math.max(min, Math.min(inches, max)));
  };

  if (editing) {
    return (
      <input
        type="text"
        inputMode="decimal"
        className={`h-5 bg-gray-100 border border-cyan-500 rounded font-semibold text-gray-900 text-center outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${metric ? 'w-16 text-[10px]' : 'w-14 text-[11px]'}`}
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
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
    );
  }
  return (
    <input
      type="text"
      readOnly
      className={`h-5 bg-gray-100 border border-gray-300 rounded font-semibold text-gray-900 text-center outline-none cursor-pointer hover:border-gray-400 transition-colors ${metric ? 'w-16 text-[10px]' : 'w-14 text-[11px]'}`}
      value={display}
      onFocus={() => {
        setDraft(display);
        setEditing(true);
      }}
      title={title}
    />
  );
}

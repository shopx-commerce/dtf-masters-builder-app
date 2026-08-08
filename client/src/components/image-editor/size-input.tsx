import { useRef, useState } from "react";
import { ChevronDown, ChevronUp, Minus, Plus } from "lucide-react";
import { cmToInches, useMetric } from "@/lib/format-length";

export default function SizeInput({
  value,
  onCommit,
  title,
  min = 0.1,
  max = 999,
  lang,
  fluid = false,
}: {
  value: number;
  onCommit: (v: number) => void;
  title: string;
  min?: number;
  max?: number;
  lang: "en" | "es" | "fr";
  /**
   * Let the field take whatever width is left rather than claiming a fixed one.
   *
   * Opt-in because it only makes sense inside a row that is itself distributing space, and
   * a `w-full` field in the desktop toolbar — where the parent is sized by its contents —
   * would collapse to nothing.
   */
  fluid?: boolean;
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

  // A stacked pair of arrows on a mouse; a −/+ stepper flanking the field on touch.
  //
  // These two controls set a physical print dimension, so a mis-tap leaves the customer with
  // a plausible-looking wrong number in the field they are about to trust. The stacked
  // version guards against that with distance: 44×44 hit boxes and 8px between them. But it
  // pays 96px of column height to show two 16×14 bezels, which next to a 44px field is
  // two-thirds empty space and arrows so small they read as decoration rather than buttons.
  //
  // Laying them out horizontally with the input between them removes the hazard structurally
  // instead of arithmetically — you cannot overshoot `+` into `−` when 64px of text field
  // separates them — which then buys back the room to make the glyphs legible. The row
  // collapses from 96px to 44px, and the arrows get a 40×44 target with a 20px glyph.
  //
  // `coarse:contents` is what re-parents them: it drops this wrapper on a touch screen so
  // both buttons become direct children of the outer flex row, where `order-first` puts the
  // decrement to the left of the field. On a fine pointer the wrapper stays a flex column
  // after the input and desktop is untouched.
  const bezel =
    "flex h-3.5 w-4 min-w-4 items-center justify-center rounded border border-gray-300 bg-gray-100 text-gray-500 transition-colors group-hover:bg-cyan-100 group-hover:text-cyan-600 group-active:bg-cyan-200 coarse:h-10 coarse:w-9 coarse:rounded-md";
  const hit = "group flex h-3.5 w-4 items-center justify-center coarse:h-11 coarse:w-9";

  const arrows = (
    <div className="flex flex-col gap-[3px] coarse:contents">
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => step(stepInches)}
        aria-label="Increase size"
        className={hit}
        title="Increase size"
      >
        <span className={bezel}>
          {/* Up/down reads as a stack; plus/minus reads as a stepper. The pair
              swaps with the orientation so the glyph always matches the layout. */}
          <ChevronUp className="h-3 w-3 coarse:hidden" strokeWidth={3} />
          <Plus className="hidden h-5 w-5 coarse:block" strokeWidth={3} />
        </span>
      </button>
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => step(-stepInches)}
        aria-label="Decrease size"
        className={`${hit} coarse:order-first`}
        title="Decrease size"
      >
        <span className={bezel}>
          <ChevronDown className="h-3 w-3 coarse:hidden" strokeWidth={3} />
          <Minus className="hidden h-5 w-5 coarse:block" strokeWidth={3} />
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
  // Fixed widths — `w-14` imperial for `2.97`/`12.00`, `w-16` metric for `30.48` — are right
  // wherever the row is sized by its contents. They are wrong on the phone's sizing sheet,
  // which has to fit two of these plus four steppers and a lock across the device: at fixed
  // widths that row totals 353px, so it cleared a 390px iPhone by two pixels and scrolled on
  // every phone narrower than that, and in metric it scrolled on all of them. `fluid` hands
  // the leftover space to the fields instead, which is the one part of the row that can give.
  return (
    <div className={`flex items-center gap-px coarse:gap-0.5 ${fluid ? "min-w-0 flex-1" : ""}`}>
      <input
        type="text"
        inputMode="decimal"
        className={`h-7 coarse:h-11 bg-white border-2 rounded font-bold text-gray-900 text-center outline-none shadow-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none text-[12px] coarse:text-[16px] ${fluid ? 'w-full min-w-[42px]' : metric ? 'w-16' : 'w-14'} ${
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

import { memo, useCallback, type Dispatch, type SetStateAction } from "react";
import { Check, ChevronDown, ChevronUp, Copy, Trash2 } from "lucide-react";
import { formatDimensions } from "@/lib/format-length";
import { useLanguage } from "@/lib/i18n";
import type { DesignItem } from "@/lib/types";
import {
  getSelectionSnapshot,
  useIsRowSelected,
  useSelectionActions,
} from "@/state/selection-store";
import {
  useEditingActions,
  useIsEditingCount,
  useIsEditingName,
  useMyEditingCountValue,
  useMyEditingNameValue,
  getEditingSnapshot,
} from "@/state/editing-store";

export interface LayerRowGroup {
  baseName: string;
  sizeKey: string;
  designs: DesignItem[];
  isResized: boolean;
}

/**
 * Handler surface that a layer row needs to reach the model. Every prop
 * here should be a stable reference — either `useCallback`-wrapped in the
 * provider or a Zustand action returned from `useSelectionActions`. Stable
 * identity is what lets `memo(LayerRowComponent)` short-circuit re-renders
 * when unrelated model state changes.
 */
export interface LayerRowHandlers {
  handleSelectDesign: (id: string | null) => void;
  handleSetGroupCount: (row: { designs: DesignItem[] }, targetCount: number) => void;
  handleDeleteGroup: (ids: string[]) => void;
  handleAutoArrangeRef: React.MutableRefObject<
    (opts?: { skipSnapshot?: boolean; preserveSelection?: boolean; arrangeAll?: boolean; fullRepack?: boolean }) => void
  >;
  setDesigns: Dispatch<SetStateAction<DesignItem[]>>;
  getLayerThumbnail: (design: DesignItem) => string;
}

export interface LayerRowProps {
  /** Stable key of the form `${baseName}::${sizeKey}` — used to look up
   *  per-row slices out of the editing store. */
  rowKey: string;
  row: LayerRowGroup;
  handlers: LayerRowHandlers;
}

/**
 * Layers-panel row for a group of same-named / same-size designs.
 *
 * Selection state is read via the Zustand `useIsRowSelected` selector, so
 * this row skips re-rendering when unrelated model state (typing in a
 * numeric input elsewhere, dragging in the preview, etc.) changes. Only
 * the two rows whose `isSelected` boolean flips actually re-render when
 * the user clicks another design.
 *
 * Editing state (name / count drafts, which row is being edited) is
 * likewise read via the Zustand `editing-store` — with **per-row**
 * selectors that return `""` / `false` for rows that aren't the current
 * target. That means typing in one row's name field doesn't trigger a
 * re-render in every other row, only the row being edited.
 *
 * Wrapping in `React.memo` is the last part of the pattern: with only
 * `rowKey`, `row`, and `handlers` as props — all stable across parent
 * re-renders — unaffected rows are cheap no-ops on every parent render.
 */
function LayerRowComponent({ rowKey, row, handlers }: LayerRowProps) {
  const { t, lang } = useLanguage();
  const first = row.designs[0];
  const count = row.designs.length;

  // Selector-based subscription: fires only when *this row's* `isSelected`
  // boolean flips (a click on any design in the row moves it in or out of
  // the selection). Other rows' selection changes do not trigger a
  // re-render here.
  const rowIds = row.designs.map((d) => d.id);
  const isSelected = useIsRowSelected(rowIds);

  const { setSelectedDesignId, setSelectedDesignIds } = useSelectionActions();

  // Editing subscriptions — each hook returns a primitive scoped to this
  // row so unrelated edits never re-render this component.
  const isEditingName = useIsEditingName(rowKey);
  const isEditingCount = useIsEditingCount(rowKey);
  const editingNameValue = useMyEditingNameValue(rowKey);
  const editingCountValue = useMyEditingCountValue(rowKey);
  const {
    beginNameEdit,
    setNameValue,
    endNameEdit,
    beginCountEdit,
    setCountValue,
    endCountEdit,
  } = useEditingActions();

  // The one place membership of `selectedDesignIds` is toggled from this
  // panel, shared by ctrl+click and by the touch checkbox so the two routes
  // cannot drift into producing different states.
  //
  // Folding `selectedDesignId` into the set first mirrors the ctrl+click
  // branch of `preview-section.tsx`'s `handleInteractionStart`. Anything that
  // writes `selectedDesignId` without also writing the set — the keyboard
  // nudge path, `handleRemoveOneCopy` — leaves a design that every bulk
  // action still treats as selected but that the set does not contain; the
  // first toggle would then silently drop it from the selection.
  //
  // Reading the store imperatively rather than subscribing keeps this row out
  // of the re-render set for selection changes it does not participate in,
  // which is the whole point of the Zustand split described above.
  const toggleRowInSelection = useCallback(() => {
    const { selectedDesignId: activeId, selectedDesignIds: current } = getSelectionSnapshot();
    const next = new Set(current);
    if (activeId && !next.has(activeId)) next.add(activeId);
    const allSelected = row.designs.every((d) => next.has(d.id));
    for (const d of row.designs) {
      if (allSelected) next.delete(d.id);
      else next.add(d.id);
    }
    setSelectedDesignIds(next);
    setSelectedDesignId(
      allSelected
        ? (next.size > 0 ? Array.from(next)[next.size - 1] : null)
        : first.id,
    );
  }, [row.designs, first.id, setSelectedDesignId, setSelectedDesignIds]);

  const handleRowClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.ctrlKey || e.metaKey) {
        toggleRowInSelection();
      } else {
        handlers.handleSelectDesign(first.id);
      }
    },
    [first.id, handlers, toggleRowInSelection],
  );

  const handleSelectionToggle = useCallback(
    (e: React.MouseEvent) => {
      // Without this the row's own handler also fires and collapses the
      // multi-selection back down to this one row.
      e.stopPropagation();
      toggleRowInSelection();
    },
    [toggleRowInSelection],
  );

  const commitNameChange = useCallback(() => {
    // Read the *current* draft imperatively — using the reactive value
    // here would put us at the mercy of the store's async flush ordering
    // when Enter fires between keystrokes. The snapshot is always
    // freshest.
    const { editingNameValue: draft } = getEditingSnapshot();
    const trimmed = draft.trim();
    if (trimmed) {
      handlers.setDesigns((prev) =>
        prev.map((d) =>
          row.designs.some((rd) => rd.id === d.id) ? { ...d, name: trimmed } : d,
        ),
      );
    }
    endNameEdit();
  }, [handlers, row.designs, endNameEdit]);

  const commitCountChange = useCallback(() => {
    const { editingCountValue: draft } = getEditingSnapshot();
    handlers.handleSetGroupCount(
      row,
      parseInt(draft || String(count), 10),
    );
    endCountEdit();
  }, [count, handlers, row, endCountEdit]);

  const handleDuplicateAndArrange = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const { editingCountValue: draft } = getEditingSnapshot();
      const targetCount = isEditingCount ? parseInt(draft, 10) : count;
      const groupIds = new Set(row.designs.map((d) => d.id));
      setSelectedDesignIds(groupIds);
      setSelectedDesignId(first.id);
      if (targetCount !== count) {
        handlers.handleSetGroupCount(row, targetCount);
      } else if (Number.isInteger(targetCount)) {
        setTimeout(
          () => handlers.handleAutoArrangeRef.current({ preserveSelection: true }),
          0,
        );
      }
      endCountEdit();
    },
    [
      isEditingCount,
      count,
      row,
      first.id,
      handlers,
      setSelectedDesignIds,
      setSelectedDesignId,
      endCountEdit,
    ],
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      handlers.handleDeleteGroup(row.designs.map((d) => d.id));
    },
    [handlers, row.designs],
  );

  return (
    <div
      className={`relative grid grid-cols-[auto_minmax(0,1fr)] coarse:grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 px-2.5 py-2.5 layersheet:gap-x-1.5 layersheet:gap-y-0.5 layersheet:px-1.5 layersheet:py-1 cursor-pointer transition-colors ${
        isSelected
          ? "bg-cyan-50 border-l-2 border-cyan-400"
          : "hover:bg-gray-100/70 border-l-2 border-transparent"
      }`}
      onClick={handleRowClick}
    >
      {/*
        Multi-select is otherwise unreachable without a keyboard: the canvas'
        ctrl+click has no touch equivalent, and an empty-canvas drag is taken
        by the pan branch whenever the sheet overflows horizontally, which on
        a phone it always does. Tapping the row still selects this design
        alone — that behaviour is load-bearing and unchanged — so the toggle
        is a separate target rather than a mode.

        `coarse:`, not a width breakpoint: a tablet renders the desktop layout
        on a touch screen and needs this; a mouse never does. On a fine
        pointer the button is `display: none`, so it is not a grid item at all
        and the row keeps its original two columns.

        Hit area and glyph are separate boxes, as in `size-input.tsx` — a bare
        44×44 button with the 20px bezel centred inside it. Non-overlap is
        structural: the button owns grid column 1 for both rows, so it cannot
        intersect the copies stepper or the delete button whatever their size.
      */}
      <button
        type="button"
        role="checkbox"
        aria-checked={isSelected}
        onClick={handleSelectionToggle}
        className="hidden row-span-2 h-11 w-11 shrink-0 items-center justify-center coarse:flex"
        aria-label={t(
          isSelected ? "editor.removeFromSelection" : "editor.addToSelection",
          { name: row.baseName },
        )}
        title={t(
          isSelected ? "editor.removeFromSelection" : "editor.addToSelection",
          { name: row.baseName },
        )}
      >
        <span
          className={`flex h-5 w-5 items-center justify-center rounded border-2 transition-colors ${
            isSelected
              ? "border-cyan-500 bg-cyan-500 text-white"
              : "border-gray-400 bg-white text-transparent"
          }`}
        >
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        </span>
      </button>
      <div className="row-span-2 h-9 w-9 rounded bg-gray-100 border border-gray-300 flex-shrink-0 overflow-hidden flex items-center justify-center">
        <img
          src={handlers.getLayerThumbnail(first)}
          alt=""
          className="max-w-full max-h-full object-contain"
          loading="lazy"
          style={{
            transform: `${first.transform.flipX ? "scaleX(-1)" : ""} ${
              first.transform.flipY ? "scaleY(-1)" : ""
            }`,
          }}
        />
      </div>
      {/* `layersheet:pr-12` clears the delete button's enlarged hit box on the
          phone, so a tap meant for the name is not swallowed by it. */}
      {/* One line on the phone rather than two. The name truncates and the
          measurement holds its width, so the pair costs 17px instead of 32 —
          per row, in the list you scroll. */}
      <div className="min-w-0 overflow-hidden pr-7 layersheet:flex layersheet:items-baseline layersheet:gap-1.5 layersheet:pr-12">
        {isEditingName ? (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              /* 16px on any touch screen so iOS does not auto-zoom the page on
                 focus — see the note on the copies field below. `leading-none`
                 keeps the taller glyphs from growing the row while the name is
                 being edited. */
              className="text-[11px] leading-normal coarse:text-[16px] coarse:leading-none text-gray-900 bg-white border border-cyan-400 rounded px-1 py-0 w-full outline-none"
              value={editingNameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commitNameChange();
                } else if (e.key === "Escape") {
                  endNameEdit();
                }
              }}
              onBlur={commitNameChange}
            />
          </div>
        ) : (
          <p
            className="text-[11px] text-gray-900 truncate cursor-text hover:text-cyan-600 transition-colors layersheet:min-w-0"
            title={t("editor.renameDesign")}
            onClick={(e) => {
              e.stopPropagation();
              beginNameEdit(rowKey, first.name);
            }}
          >
            {row.baseName}
            {row.isResized && (
              <span className="ml-1 text-[9px] text-amber-400/80 font-medium">
                {t("editor.resized")}
              </span>
            )}
          </p>
        )}
        <p
          className={`text-gray-600 truncate tabular-nums layersheet:shrink-0 ${
            lang !== "en" ? "text-[9px]" : "text-[10px]"
          }`}
          title={formatDimensions(
            first.widthInches * first.transform.s,
            first.heightInches * first.transform.s,
            lang,
          )}
        >
          {formatDimensions(
            first.widthInches * first.transform.s,
            first.heightInches * first.transform.s,
            lang,
          )}
        </p>
      </div>
      <div className="col-start-2 coarse:col-start-3 flex min-w-0 items-center gap-1.5">
        <div
          className="flex items-center gap-px shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="text"
            inputMode="numeric"
            min={1}
            max={200}
            /*
              Never `readOnly`, not even before the edit begins: iOS decides
              whether to raise the keyboard at the instant focus is granted, so
              a field that is read-only at that instant can never be typed into
              on an iPhone — clearing the flag in the next React render is too
              late. Same reasoning as `size-input.tsx`.

              16px on any touch screen, for the same reason `size-input.tsx` uses
              it: iOS zooms the page when focus lands on a control under 16px, and
              the viewport meta that would suppress that does not reach us inside
              the storefront iframe. Gated on `coarse:` rather than on the width
              breakpoint so an iPad — wide enough for `md:`, but with a software
              keyboard and no mouse — is covered too. A mouse keeps 11px / 24px.
              44px tall on touch so the field matches the stepper beside it.
            */
            className={`h-6 w-14 rounded border-2 bg-white text-center text-[11px] font-semibold tabular-nums text-gray-800 outline-none shadow-sm transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none coarse:h-11 coarse:text-[16px] layersheet:w-11 ${
              isEditingCount
                ? "border-cyan-500"
                : "cursor-pointer border-gray-300 hover:border-cyan-400 hover:bg-cyan-50"
            }`}
            value={isEditingCount ? editingCountValue : String(count)}
            onChange={(e) => {
              const next = e.target.value.replace(/\D/g, "").slice(0, 3);
              if (isEditingCount) setCountValue(next);
              else beginCountEdit(rowKey, next);
            }}
            onFocus={() => {
              if (!isEditingCount) {
                beginCountEdit(rowKey, String(count));
              }
            }}
            onBlur={commitCountChange}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitCountChange();
              } else if (e.key === "Escape") {
                endCountEdit();
              }
              e.stopPropagation();
            }}
            title="Click to set exact copy count"
          />
          {/*
            Hit area and glyph are separate boxes, exactly as in
            `size-input.tsx` — see the long note there. Copy count multiplies
            material consumption, so a mis-tap here costs film by the sheet.
            On a coarse pointer each `button` is a bare 44×44 hit box with the
            original 16×14 bezel centred inside it; the two cannot overlap
            because they are siblings in a flex column, and `coarse:gap-2` puts
            8px of dead space between them.

            Stacked, those two targets plus their gap are 96px — 63% of a 152px
            row, and the single largest reason the phone's layers list read as
            enormous. In the layers sheet they flank the number instead, so the
            targets keep every one of their 44px while costing one row of height
            rather than two. `contents` drops this wrapper out of the box tree so
            all three become flex items of the stepper itself, and `order` seats
            the number between them without reordering the DOM — the tab order
            stays field-then-controls. Nothing separates the two buttons there
            because the field already does.
          */}
          <div className="flex flex-col gap-[3px] coarse:gap-2 layersheet:contents">
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handlers.handleSetGroupCount(row, count + 1)}
              disabled={count >= 200}
              aria-label="Increase copies"
              className="group flex h-3.5 w-4 items-center justify-center disabled:opacity-30 coarse:h-11 coarse:w-11 layersheet:order-last"
              title="Increase copies"
            >
              {/* The bezel grows on the phone while the 44px box around it does
                  not. Laid out flat, a 16x14 mark adrift in a 44px target reads
                  as decoration and gets tapped tentatively; copy count is the
                  control most worth aiming at confidently here. */}
              <span className="flex h-3.5 w-4 min-w-4 items-center justify-center rounded border border-gray-300 bg-gray-100 text-gray-500 transition-colors group-hover:bg-cyan-100 group-hover:text-cyan-600 group-active:bg-cyan-200 layersheet:h-8 layersheet:w-8 layersheet:border-gray-400 layersheet:text-gray-700">
                <ChevronUp className="h-3 w-3 layersheet:h-5 layersheet:w-5" strokeWidth={3} />
              </span>
            </button>
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handlers.handleSetGroupCount(row, count - 1)}
              disabled={count <= 1}
              aria-label="Decrease copies"
              className="group flex h-3.5 w-4 items-center justify-center disabled:opacity-30 coarse:h-11 coarse:w-11 layersheet:order-first"
              title="Decrease copies"
            >
              <span className="flex h-3.5 w-4 min-w-4 items-center justify-center rounded border border-gray-300 bg-gray-100 text-gray-500 transition-colors group-hover:bg-cyan-100 group-hover:text-cyan-600 group-active:bg-cyan-200 layersheet:h-8 layersheet:w-8 layersheet:border-gray-400 layersheet:text-gray-700">
                <ChevronDown className="h-3 w-3 layersheet:h-5 layersheet:w-5" strokeWidth={3} />
              </span>
            </button>
          </div>
        </div>
        <button
          onClick={handleDuplicateAndArrange}
          className="inline-flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-md border border-fuchsia-400 bg-fuchsia-100 px-1.5 text-[9px] font-bold text-fuchsia-800 shadow-sm shadow-fuchsia-500/20 transition-colors hover:bg-fuchsia-200 layersheet:h-11"
          title="Duplicate & Arrange"
        >
          <Copy className="h-3 w-3" />
          <span className="whitespace-nowrap">Duplicate &amp; Arrange</span>
        </button>
      </div>
      {/* Hit area and glyph are separate boxes on the phone, as everywhere else
          in this row: the 12px bezel keeps its size and the box around it grows
          to 44. */}
      <button
        onClick={handleDelete}
        aria-label={t("editor.deleteLayer", { name: row.baseName })}
        title={t("editor.deleteLayer", { name: row.baseName })}
        className="absolute right-2.5 top-2.5 p-0.5 rounded hover:bg-gray-200 text-red-500 hover:text-red-600 transition-colors flex-shrink-0 layersheet:right-0 layersheet:top-0 layersheet:flex layersheet:h-11 layersheet:w-11 layersheet:items-center layersheet:justify-center layersheet:rounded-none layersheet:hover:bg-transparent"
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  );
}

export const LayerRow = memo(LayerRowComponent);

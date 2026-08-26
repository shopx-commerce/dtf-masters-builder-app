import { useEffect, useRef } from "react";
import { Loader2, Palette, X } from "lucide-react";
import type { ColorChangeState } from "./useImageEditorModelColorChange";

const REASON_KEYS: Record<string, string> = {
  "select-one": "editor.colorChangeSelectOne",
  "vector-source": "editor.colorChangeRasterOnly",
  halftoned: "editor.colorChangeHalftone",
  "not-png": "editor.colorChangePngOnly",
  "no-alpha-channel": "editor.colorChangeNeedsTransparency",
  "multiple-visible-colors": "editor.colorChangeMultipleColors",
  "grayscale-ambiguity": "editor.colorChangeMultipleColors",
  "no-visible-pixels": "editor.colorChangeNoPixels",
  "unsupported-bit-depth": "editor.colorChangeUnsupported",
  "unsupported-format": "editor.colorChangeUnsupported",
  "image-too-large": "editor.colorChangeTooLarge",
  "animated-png": "editor.colorChangeUnsupported",
  "invalid-png": "editor.colorChangeUnsupported",
  "invalid-crop": "editor.colorChangeUnsupported",
  "empty-input": "editor.colorChangeUnsupported",
};

export default function ColorChangeDialog({
  state,
  imageSrc,
  t,
  onTargetChange,
  onApply,
  onClose,
}: {
  state: ColorChangeState;
  imageSrc?: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onTargetChange: (hex: string) => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const hexInputRef = useRef<HTMLInputElement>(null);
  const open = state.status !== "closed";
  const ready = state.status === "ready";

  // Escape is how every other overlay in the editor closes, and here it also
  // aborts the running PNG job rather than leaving it to burn CPU.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  useEffect(() => {
    if (ready) hexInputRef.current?.focus();
  }, [ready]);

  if (!open) return null;
  const validHex = /^#[0-9a-f]{6}$/i.test(state.targetHex);
  const sourceHex = state.sourceColor
    ? `#${[state.sourceColor.r, state.sourceColor.g, state.sourceColor.b].map(value => value.toString(16).padStart(2, "0")).join("")}`
    : null;
  const unchanged = !!sourceHex && validHex && state.targetHex.toLowerCase() === sourceHex.toLowerCase();
  // Artwork with soft edges is previewed through a mask whose alpha is coverage,
  // so what the customer sees here is what the print will be. Flat artwork has
  // no such mask and keeps using the editor's own preview.
  const maskSrc = state.coverageMaskSrc || imageSrc;
  const softEdges = state.model?.kind === "blend";
  // Rounded down, so a design reported as 97% is at least 97%.
  const dominancePercent = typeof state.dominance === "number"
    ? Math.floor(state.dominance * 100)
    : null;
  const refusedShare = state.reason === "multiple-visible-colors" && dominancePercent !== null;
  const refusalMessage = refusedShare
    ? t("editor.colorChangeMultipleColorsShare", { percent: dominancePercent })
    : t(REASON_KEYS[state.reason || ""] || "editor.colorChangeUnsupported");

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-3"
      role="dialog"
      aria-modal="true"
      aria-labelledby="color-change-title"
      onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-2">
            <Palette className="h-5 w-5 text-violet-600" />
            <h2 id="color-change-title" className="font-bold text-slate-900">{t("editor.colorChange")}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-2 text-slate-500 hover:bg-slate-100" aria-label={t("editor.colorChangeClose")}><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-4 p-4">
          {(state.status === "checking" || state.status === "applying") && (
            <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-sm font-medium text-slate-600">
              <div className="flex items-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin text-violet-600" />
                {state.status === "checking" ? t("editor.colorChangeChecking") : t("editor.colorChangeApplying")}
              </div>
              {/* Large artwork takes seconds, and a bare spinner on a phone is
                  indistinguishable from a hung tab — the bar is the worker
                  reporting the rows it has actually rewritten. */}
              {typeof state.progress === "number" && (
                <div className="w-48">
                  <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full rounded-full bg-violet-600 transition-[width] duration-150"
                      style={{ width: `${Math.round(state.progress * 100)}%` }}
                    />
                  </div>
                  <p className="mt-1 text-center text-xs font-mono text-slate-500">
                    {Math.round(state.progress * 100)}%
                  </p>
                </div>
              )}
            </div>
          )}

          {(state.status === "ineligible" || state.status === "error") && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {state.message || refusalMessage}
            </div>
          )}

          {state.status === "ready" && (
            <>
              <div
                className="relative h-44 overflow-hidden rounded-lg border border-slate-200"
                style={{
                  backgroundColor: "#fff",
                  backgroundImage: "linear-gradient(45deg,#e2e8f0 25%,transparent 25%),linear-gradient(-45deg,#e2e8f0 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e2e8f0 75%),linear-gradient(-45deg,transparent 75%,#e2e8f0 75%)",
                  backgroundSize: "20px 20px",
                  backgroundPosition: "0 0,0 10px,10px -10px,-10px 0",
                }}
              >
                {maskSrc && validHex && (
                  <div
                    className="absolute inset-3"
                    style={{
                      backgroundColor: state.targetHex,
                      WebkitMaskImage: `url("${maskSrc}")`,
                      maskImage: `url("${maskSrc}")`,
                      WebkitMaskRepeat: "no-repeat",
                      maskRepeat: "no-repeat",
                      WebkitMaskPosition: "center",
                      maskPosition: "center",
                      WebkitMaskSize: "contain",
                      maskSize: "contain",
                    }}
                  />
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="mb-1 text-xs font-semibold text-slate-600">{t("editor.colorChangeSource")}</p>
                  <div className="flex h-10 items-center gap-2 rounded-md border border-slate-200 px-2">
                    <span className="h-6 w-6 rounded border border-black/20" style={{ backgroundColor: sourceHex || "#000" }} />
                    <span className="text-xs font-mono uppercase">{sourceHex}</span>
                  </div>
                </div>
                <div>
                  <p className="mb-1 text-xs font-semibold text-slate-600">{t("editor.colorChangeNew")}</p>
                  <div className="flex h-10 items-center gap-2 rounded-md border border-slate-200 px-2">
                    <input type="color" value={validHex ? state.targetHex : "#000000"} onChange={event => onTargetChange(event.target.value)} className="h-7 w-8 cursor-pointer border-0 bg-transparent p-0" />
                    <input ref={hexInputRef} value={state.targetHex} onChange={event => onTargetChange(event.target.value)} className="min-w-0 flex-1 bg-transparent text-xs font-mono uppercase outline-none" aria-label={t("editor.colorChangeHex")} />
                  </div>
                </div>
              </div>
              {!validHex && <p className="text-xs font-medium text-red-600">{t("editor.colorChangeInvalidHex")}</p>}
              {unchanged && <p className="text-xs font-medium text-slate-500">{t("editor.colorChangeSameColor")}</p>}
              {/* Say what was actually found rather than promising something
                  the artwork cannot deliver: flat artwork is untouched apart
                  from its colour, soft artwork keeps its softness, and artwork
                  carrying a few stray pixels says so before it is committed. */}
              <p className="text-xs leading-5 text-slate-500">
                {softEdges ? t("editor.colorChangeSoftEdgeNote") : t("editor.colorChangeExactNote")}
              </p>
              {dominancePercent !== null && dominancePercent < 100 && (
                <p className="text-xs leading-5 text-slate-500">
                  {t("editor.colorChangeMostlyOneColor", { percent: dominancePercent })}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3">
          <button type="button" onClick={onClose} className="min-h-10 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700">{t("editor.colorChangeCancel")}</button>
          {state.status === "ready" && (
            <button type="button" onClick={onApply} disabled={!validHex || unchanged} className="min-h-10 rounded-md bg-violet-600 px-4 text-sm font-bold text-white hover:bg-violet-700 disabled:opacity-40">{t("editor.colorChangeApply")}</button>
          )}
        </div>
      </div>
    </div>
  );
}
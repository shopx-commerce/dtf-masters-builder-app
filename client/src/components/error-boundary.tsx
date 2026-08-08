import { Component, type ReactNode } from "react";
import {
  disableDraftSaves,
  enableDraftSaves,
  purgeEditorDraftStorage,
} from "@/lib/editor-draft-storage";
import { en } from "@/lib/translations/en";
import { es } from "@/lib/translations/es";
import { fr } from "@/lib/translations/fr";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  /** True once the customer has asked to delete, before they have confirmed. */
  isConfirmingStartFresh: boolean;
  isStartingFresh: boolean;
}

/**
 * This boundary wraps `LanguageProvider` — it has to, or a crash inside the
 * provider would have nothing to catch it — so `useLanguage` is out of reach and
 * the dictionary is read directly. Same storage key the provider persists to, so
 * the two agree on the customer's choice; falling back to English on anything
 * unreadable matches `useLanguage`'s own lookup order.
 */
const LANGUAGE_STORAGE_KEY = "app-language";
const dictionaries: Record<string, Record<string, string>> = { en, es, fr };

function translate(key: string): string {
  let lang = "en";
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored === "es" || stored === "fr") lang = stored;
  } catch {
    // Storage can be blocked outright (third-party context, hardened settings).
  }
  return dictionaries[lang]?.[key] ?? en[key] ?? key;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    error: null,
    isConfirmingStartFresh: false,
    isStartingFresh: false,
  };

  static getDerivedStateFromError(error: Error): State {
    // Deliberately side-effecting in the render phase. React tears the tree
    // down on its way to the fallback, which runs the editor's unmount flush
    // and would persist the very state that just crashed — turning a one-off
    // crash into one the customer meets again on every reload. `componentDidCatch`
    // is too late to prevent that (it runs during commit, interleaved with the
    // deletion), whereas this runs before commit begins. Setting a module flag
    // is idempotent, so a double invocation in StrictMode is harmless.
    disableDraftSaves("the app crashed");
    return { hasError: true, error, isConfirmingStartFresh: false, isStartingFresh: false };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("App crash caught by ErrorBoundary:", error, info.componentStack);
  }

  handleRecover = () => {
    enableDraftSaves();
    this.setState({ hasError: false, error: null, isConfirmingStartFresh: false });
  };

  handleReload = () => {
    window.location.reload();
  };

  /**
   * The only route back for a customer whose *saved* work is what breaks the
   * app. Every other discard control lives inside the editor, so if the editor
   * cannot mount they would otherwise have to clear site data by hand — which
   * ordinary customers do not know how to do.
   *
   * It is unrecoverable and it sat one click below two harmless buttons, so it
   * asks first. The delete itself is not blocked when another tab owns draft
   * saving: this is the escape hatch from a crash loop and the crashed tab is
   * often the non-owner, so refusing here would trap that customer. The other
   * tab is told instead — see `purgeEditorDraftStorage`.
   */
  handleAskStartFresh = () => {
    this.setState({ isConfirmingStartFresh: true });
  };

  handleCancelStartFresh = () => {
    this.setState({ isConfirmingStartFresh: false });
  };

  handleStartFresh = () => {
    this.setState({ isStartingFresh: true });
    void purgeEditorDraftStorage()
      // A breath before the reload. The purge announcement is already queued
      // against the other tabs by the time this resolves and does not depend on
      // this page surviving, but the whole point of the announcement is that a
      // healthy tab does not lose work, so it is not worth being clever about.
      .finally(() => new Promise(resolve => setTimeout(resolve, 150)))
      .finally(() => window.location.reload());
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white border border-red-500/30 rounded-xl p-8 text-center space-y-5">
            <div className="text-red-400 text-5xl">!</div>
            <h2 className="text-xl font-bold text-gray-900">{translate("error.title")}</h2>
            <p className="text-gray-600 text-sm">{translate("error.desc")}</p>
            {this.state.error && (
              <details className="text-left">
                <summary className="text-gray-500 text-xs cursor-pointer hover:text-gray-600">
                  {translate("error.details")}
                </summary>
                <pre className="mt-2 text-[10px] text-red-300/70 bg-gray-50 rounded p-3 overflow-auto max-h-32 whitespace-pre-wrap">
                  {this.state.error.message}
                </pre>
              </details>
            )}
            <div className="flex gap-3 justify-center pt-2">
              <button
                onClick={this.handleRecover}
                disabled={this.state.isStartingFresh}
                className="px-5 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-gray-900 text-sm font-medium transition-colors disabled:opacity-60"
              >
                {translate("error.recover")}
              </button>
              <button
                onClick={this.handleReload}
                disabled={this.state.isStartingFresh}
                className="px-5 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 border border-gray-200 text-gray-700 text-sm font-medium transition-colors disabled:opacity-60"
              >
                {translate("error.reload")}
              </button>
            </div>
            {this.state.isConfirmingStartFresh ? (
              <div
                className="pt-1 text-left border-t border-gray-200 mt-1"
                data-testid="start-fresh-confirm"
              >
                <p className="mt-4 text-sm font-medium text-gray-900">
                  {translate("error.startFreshConfirmTitle")}
                </p>
                <p className="mt-1 text-[11px] text-gray-500">
                  {translate("error.startFreshConfirmBody")}
                </p>
                <div className="flex gap-3 justify-center pt-3">
                  <button
                    onClick={this.handleStartFresh}
                    disabled={this.state.isStartingFresh}
                    className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-medium transition-colors disabled:opacity-60"
                  >
                    {this.state.isStartingFresh
                      ? translate("error.startFreshBusy")
                      : translate("error.startFreshConfirm")}
                  </button>
                  <button
                    onClick={this.handleCancelStartFresh}
                    disabled={this.state.isStartingFresh}
                    className="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 border border-gray-200 text-gray-700 text-xs font-medium transition-colors disabled:opacity-60"
                  >
                    {translate("error.startFreshCancel")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="pt-1">
                <button
                  onClick={this.handleAskStartFresh}
                  className="text-xs text-gray-500 underline underline-offset-2 hover:text-gray-700 disabled:opacity-60"
                >
                  {translate("error.startFresh")}
                </button>
                <p className="mt-1 text-[11px] text-gray-400">
                  {translate("error.startFreshHint")}
                </p>
              </div>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

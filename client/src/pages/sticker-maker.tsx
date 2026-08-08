import { useState, useEffect } from "react";
import ImageEditor from "@/components/image-editor";
import { type ProfileConfig, HOT_PEEL_PROFILE } from "@/lib/profiles";
import type { InitialDesignState } from "@/components/image-editor/types";
import { Link } from "wouter";
import { ArrowLeft, Upload, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import LanguageToggle from "@/components/language-toggle";
import { resolveShellTargetOrigin, resolveShellTopTargetOrigin } from "@/lib/shell-message";

interface StickerMakerProps {
  profile?: ProfileConfig;
}

interface ShopifyVariant {
  id: string;
  title: string;
  price: string | null;
  sku: string | null;
  width: number | null;
  height: number | null;
}

interface VariantConfig {
  configured: boolean;
  source?: "proxy" | "storefront" | "storefront-ajax";
  artboardWidth?: number;
  gangsheetHeights?: number[];
  selectedHeight?: number;
  variantTitle?: string;
  selectedVariantPrice?: string | null;
  variants?: ShopifyVariant[];
  error?: string;
}

function getRawParams() {
  return Object.fromEntries(new URLSearchParams(window.location.search).entries());
}

function normalizeDesignStatePayload(json: unknown): InitialDesignState | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  if (typeof root.error === "string" && root.error.trim()) return null;
  const nested =
    root.state && typeof root.state === "object"
      ? (root.state as Record<string, unknown>)
      : null;
  const state = (nested || root) as InitialDesignState;
  if (!Array.isArray(state.layers)) return null;
  const rawVersion = state.version ?? root.version ?? 1;
  const version = Number.isFinite(Number(rawVersion)) ? Number(rawVersion) : 1;
  return {
    ...state,
    designId:
      state.designId ??
      (typeof root.designId === "string" ? root.designId : null),
    version,
  };
}

function resolveStateUrl(stateUrl: string | null, stateKey: string | null): string | null {
  if (stateUrl && String(stateUrl).trim()) return String(stateUrl).trim();
  if (!stateKey || !String(stateKey).trim()) return null;
  const fromEnv = (import.meta as unknown as { env?: { VITE_R2_PUBLIC_BASE_URL?: string } })?.env
    ?.VITE_R2_PUBLIC_BASE_URL;
  const base = String(fromEnv || "").trim().replace(/\/$/, "");
  if (!base) return null;
  const key = String(stateKey).trim().replace(/^\/+/, "");
  return `${base}/${key}`;
}

export default function StickerMaker({ profile = HOT_PEEL_PROFILE }: StickerMakerProps) {
  const { t } = useLanguage();

  const rawParams = getRawParams();
  const ctxToken = rawParams["ctx"] ?? null;
  const variantId = rawParams["variant"] ?? rawParams["variant_id"] ?? null;
  const productId = rawParams["product_id"] ?? rawParams["productId"] ?? null;
  const productHandle = rawParams["product_handle"] ?? rawParams["productHandle"] ?? null;
  const quantity = rawParams["quantity"] ?? null;
  const shopDomain = rawParams["shop"] ?? null;
  const designId = rawParams["designId"] ?? null;
  const stateKey = rawParams["stateKey"] ?? null;
  const stateUrl = resolveStateUrl(rawParams["stateUrl"] ?? null, stateKey);
  const isAdminEditMode = Boolean(stateUrl || designId || stateKey);
  /** Local-only builder preview: skips Shopify product/variant context and uses editor defaults. */
  const testMode =
    rawParams["test"] === "1" ||
    rawParams["test"] === "true" ||
    window.location.pathname === "/test-builder";
  const directEmbedMode = window.location.pathname === "/embed";
  /** Opened from Shopify (proxy / product) — skip landing-style chrome and upload gate */
  const embedFromShopify = !!(ctxToken || shopDomain || isAdminEditMode);
  /** Explicit storefront loading remains supported; direct embeds with a variant
   * also need the variant config so they expose every configured gangsheet size. */
  const useStorefront =
    rawParams["storefront"] === "1" ||
    rawParams["storefront"] === "true" ||
    (directEmbedMode && Boolean(variantId));
  /** Editor only when coming from Shopify (ctx / shop) or optional dev: ?storefront=1&variant= */
  const allowEditor =
    testMode ||
    directEmbedMode ||
    Boolean(ctxToken) ||
    Boolean(shopDomain) ||
    isAdminEditMode ||
    (Boolean(variantId) && useStorefront);
  const [variantConfig, setVariantConfig] = useState<VariantConfig | null>(null);
  const [initialDesignState, setInitialDesignState] = useState<InitialDesignState | null>(null);
  const [designStateLoadError, setDesignStateLoadError] = useState<string | null>(null);
  const [loadingDesignState, setLoadingDesignState] = useState(Boolean(stateUrl || stateKey));
  const [effectiveVariantId, setEffectiveVariantId] = useState<string | null>(variantId);
  const [effectiveShopDomain, setEffectiveShopDomain] = useState<string | null>(shopDomain);
  const [effectiveQuantity, setEffectiveQuantity] = useState<number | null>(
    quantity ? parseInt(quantity, 10) || 1 : null,
  );
  /** Full-screen loader only for optional Storefront fetch — never block UI for ?ctx= (proxy already minted ctx; we hydrate variants in background). */
  const [loading, setLoading] = useState(!!variantId && useStorefront);

  const storefrontVariantQuery = (vid: string) => {
    const q = new URLSearchParams({ variant: vid });
    if (productId) q.set("product_id", productId);
    if (productHandle) q.set("product_handle", productHandle);
    return `/api/storefront-variant-config?${q.toString()}`;
  };

  useEffect(() => {
    // Primary flow: proxy → redirect with ?ctx=… — hydrate sizes/prices without blocking the editor shell
    if (ctxToken) {
      const hydrateFromCtx = (data: VariantConfig) => {
        const hasHeights = Array.isArray(data.gangsheetHeights) && data.gangsheetHeights.length > 0;
        if (hasHeights) {
          setVariantConfig({ ...data, configured: true, source: data.source ?? "proxy" });
          return;
        }
        const vid = variantId || effectiveVariantId;
        if (!vid) {
          setVariantConfig({ ...data, configured: true, source: data.source ?? "proxy" });
          return;
        }
        fetch(storefrontVariantQuery(vid))
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
          .then((extra: VariantConfig) => {
            if (Array.isArray(extra.gangsheetHeights) && extra.gangsheetHeights.length > 0) {
              setVariantConfig({ ...extra, configured: true, source: "storefront-ajax" });
            } else {
              console.warn("[builder] ctx missing gangsheetHeights; storefront ajax also empty", { data, extra });
              setVariantConfig({ ...data, configured: true, source: data.source ?? "proxy" });
            }
          })
          .catch((err) => {
            console.error("[builder] storefront variant-config fallback failed:", err);
            setVariantConfig({ ...data, configured: true, source: data.source ?? "proxy" });
          });
      };

      fetch(`/api/builder-context/${encodeURIComponent(ctxToken)}`)
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then((data: VariantConfig) => hydrateFromCtx(data))
        .catch((err) => {
          console.error("[builder] ctx fetch error:", err);
          const vid = variantId || effectiveVariantId;
          if (vid) {
            fetch(storefrontVariantQuery(vid))
              .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
              .then((extra: VariantConfig) => {
                if (Array.isArray(extra.gangsheetHeights) && extra.gangsheetHeights.length > 0) {
                  setVariantConfig({ ...extra, configured: true, source: "storefront-ajax" });
                } else {
                  setVariantConfig({ configured: false, error: "Invalid or expired ctx" });
                }
              })
              .catch(() => setVariantConfig({ configured: false, error: "Invalid or expired ctx" }));
            return;
          }
          setVariantConfig({ configured: false, error: "Invalid or expired ctx" });
        });
      return;
    }

    // Optional dev fallback: ?storefront=1 — only then call Storefront (env vars on server)
    if (variantId && useStorefront) {
      fetch(`/api/shopify/variant-config?variant=${encodeURIComponent(variantId)}`)
        .then((r) => r.json())
        .then((data: VariantConfig) => {
          setVariantConfig({ ...data, source: data.configured ? "storefront" : undefined });
          setLoading(false);
        })
        .catch((err) => {
          console.error("[Shopify] fetch error:", err);
          setVariantConfig({ configured: false });
          setLoading(false);
        });
      return;
    }

    setLoading(false);
  }, [ctxToken, variantId, useStorefront, productId, productHandle]);

  useEffect(() => {
    if (!stateUrl && !stateKey) return;
    let cancelled = false;
    setLoadingDesignState(true);
    setDesignStateLoadError(null);
    const loaderUrl = stateUrl
      ? `/api/fetch-json?url=${encodeURIComponent(stateUrl)}`
      : stateKey
        ? `/api/design-state?stateKey=${encodeURIComponent(String(stateKey))}`
        : null;
    if (!loaderUrl) {
      setLoadingDesignState(false);
      return;
    }
    fetch(loaderUrl)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((json) => {
        if (cancelled) return;
        const normalized = normalizeDesignStatePayload(json);
        if (!normalized) {
          throw new Error(
            typeof (json as { error?: string })?.error === "string"
              ? (json as { error: string }).error
              : "Design state JSON is missing layers",
          );
        }
        setInitialDesignState(normalized);
        const fromStateVariant = normalized.references?.productVariantId;
        const fromStateShop = (normalized as { shop?: string }).shop;
        const fromStateQty = Number(normalized.settings?.quantity);
        if (!effectiveVariantId && fromStateVariant) {
          setEffectiveVariantId(String(fromStateVariant));
        }
        if (!effectiveShopDomain && fromStateShop) {
          setEffectiveShopDomain(String(fromStateShop));
        }
        if (!effectiveQuantity && Number.isFinite(fromStateQty) && fromStateQty > 0) {
          setEffectiveQuantity(Math.floor(fromStateQty));
        }
      })
      .catch((err) => {
        console.error("[builder] design state fetch error:", err);
        if (!cancelled) {
          setDesignStateLoadError(
            err instanceof Error ? err.message : "Failed to load saved design",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDesignState(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stateUrl, stateKey]);

  // Preview surfaces simulate storefront height options so expansion and the
  // size picker work without Shopify. Override with `?heights=12,24,36`.
  //
  // Without this a preview falls back to the profile's list, which is empty, so
  // the only size on offer is the sheet's current height — the gangsheet can
  // never grow and "add copies" reports no space to arrange instead of
  // expanding.
  const PREVIEW_DEFAULT_HEIGHTS = [12, 18, 24, 36, 48, 60, 72, 84, 96, 120, 160, 240, 340];
  const devHeights = (import.meta.env.DEV && testMode)
    ? (rawParams["heights"] ?? "")
        .split(",")
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const resolvedWidth = variantConfig?.configured ? variantConfig.artboardWidth : undefined;
  const resolvedHeight = variantConfig?.configured ? variantConfig.selectedHeight : undefined;
  // A configured variant always wins: those heights are the ones with real
  // Shopify variants behind them, and offering a size that cannot be bought
  // would break add-to-cart. `/embed` without a variant has nothing to buy
  // either way, so it gets the preview list rather than a single stuck size.
  //
  // The variant check is what keeps that safe, and it has to be the variant
  // rather than the route. `/embed?variant=` whose config fetch fails lands here
  // too, with `configured: false` and no `variants` — and add-to-cart, finding
  // no height match in an empty list, falls back to the variant the customer
  // arrived on. Offering thirteen heights there would let them pick 96" and be
  // charged for 12". Being stuck on one size is the better failure.
  const nothingToBuy = !effectiveVariantId;
  const resolvedHeights = variantConfig?.configured
    ? variantConfig.gangsheetHeights
    : (devHeights.length > 0
        ? devHeights
        : (testMode || (directEmbedMode && nothingToBuy) ? PREVIEW_DEFAULT_HEIGHTS : undefined));
  const resolvedVariants = variantConfig?.configured ? variantConfig.variants : undefined;
  /** Wait for `/api/builder-context` before mounting the editor so artboard size isn’t briefly wrong (first variant / default). */
  const waitingForCtx = Boolean(ctxToken) && variantConfig === null;
  const waitingForEditState = Boolean(stateUrl || stateKey) && loadingDesignState;

  if (loading) {
    return (
      <div className="h-screen [height:100dvh] flex flex-col bg-gray-50 overflow-hidden">
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-gray-400">
            <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm">Fetching from Storefront…</span>
          </div>
        </div>
      </div>
    );
  }

  if (!allowEditor) {
    return (
      <div className="h-screen [height:100dvh] flex flex-col bg-gray-50 items-center justify-center gap-6 p-6">
        <p className="text-lg font-semibold text-gray-900">{t("editor.noProductSelected")}</p>
        <Link href="/">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm text-gray-800 hover:bg-gray-50"
          >
            <ArrowLeft className="w-4 h-4" />
            {t("editor.back")}
          </button>
        </Link>
      </div>
    );
  }

  const requestCloseShopifyOverlay = () => {
    const payload = { type: "dtf-builder-close-overlay" as const };
    /* Nested iframes: parent = app-proxy shell; theme script runs on the storefront (top). */
    try {
      if (window.top && window.top !== window) {
        window.top.postMessage(payload, resolveShellTopTargetOrigin());
      }
    } catch {
      /* ignore */
    }
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, resolveShellTargetOrigin());
      }
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="h-screen [height:100dvh] flex flex-col bg-gray-50 overflow-hidden">
      {embedFromShopify ? (
        <header className="flex-shrink-0 bg-gray-50 border-b border-gray-200 px-3 sm:px-4 py-2">
          <div className="flex flex-row flex-nowrap items-center justify-between gap-2 sm:gap-3 w-full min-w-0">
            <div className="min-w-0 flex flex-col gap-0.5 flex-1">
              <button
                type="button"
                className="sm:hidden inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-500 px-4 py-2 text-base font-medium text-white shadow-lg shadow-cyan-500/25 hover:from-cyan-600 hover:to-blue-600 transition-colors w-fit max-w-full"
                onClick={() => window.dispatchEvent(new CustomEvent("dtf:open-upload"))}
              >
                <Upload className="w-5 h-5 flex-shrink-0" />
                <span className="truncate">{t("editor.addDesigns")}</span>
              </button>
              <h1
                className="hidden sm:block text-lg font-black tracking-widest truncate max-w-[min(100vw-8rem,28rem)] sm:max-w-xl"
                style={{
                  fontFamily: "'Orbitron', sans-serif",
                  background: "linear-gradient(90deg, #06b6d4, #3b82f6, #8b5cf6, #06b6d4)",
                  backgroundSize: "200% auto",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                  animation: "gradientShift 4s linear infinite",
                  filter: "drop-shadow(0 0 8px rgba(6,182,212,0.5))",
                }}
                title={profile.title}
              >
                {profile.title}
              </h1>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
              <LanguageToggle />
              <button
                type="button"
                onClick={requestCloseShopifyOverlay}
                className="inline-flex h-9 w-9 sm:h-10 sm:w-10 coarse:!h-11 coarse:!w-11 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-800 shadow-sm hover:bg-gray-50"
                aria-label={t("editor.closeBuilder")}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
        </header>
      ) : (
        <header className="flex-shrink-0 bg-gray-50 border-b border-gray-200 px-4 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 flex-shrink-0">
              <Link href="/">
                <button type="button" className="flex items-center gap-1 text-gray-600 hover:text-gray-900 transition-colors text-xs">
                  <ArrowLeft className="w-3.5 h-3.5" />
                  {t("editor.back")}
                </button>
              </Link>
              <div className="min-w-0 flex flex-col gap-0.5">
                <button
                  type="button"
                  className="sm:hidden inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-500 px-4 py-2 text-base font-medium text-white shadow-lg shadow-cyan-500/25 hover:from-cyan-600 hover:to-blue-600 transition-colors"
                  onClick={() => window.dispatchEvent(new CustomEvent("dtf:open-upload"))}
                >
                  <Upload className="w-5 h-5" />
                  {t("editor.addDesigns")}
                </button>
                <h1
                  className="hidden sm:block text-lg font-black tracking-widest truncate max-w-[min(100vw-8rem,28rem)] sm:max-w-xl"
                  style={{
                    fontFamily: "'Orbitron', sans-serif",
                    background: "linear-gradient(90deg, #06b6d4, #3b82f6, #8b5cf6, #06b6d4)",
                    backgroundSize: "200% auto",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                    backgroundClip: "text",
                    animation: "gradientShift 4s linear infinite",
                    filter: "drop-shadow(0 0 8px rgba(6,182,212,0.5))",
                  }}
                  title={profile.title}
                >
                  {profile.title}
                </h1>
              </div>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <span className="text-[11px] text-gray-600 hidden sm:inline">
                {t("editor.tips")}{" "}
                <a href="mailto:Support@anynestapp.com" className="text-cyan-600 hover:text-cyan-700 font-semibold">
                  Support@anynestapp.com
                </a>
              </span>
              <LanguageToggle />
            </div>
          </div>
        </header>
      )}

      <main className="flex-1 min-h-0">
        {designStateLoadError ? (
          <div className="h-full flex items-center justify-center p-6">
            <div className="max-w-md rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <p className="font-semibold">Could not load saved design</p>
              <p className="mt-1">{designStateLoadError}</p>
            </div>
          </div>
        ) : waitingForCtx || waitingForEditState ? (
          <div className="h-full flex items-center justify-center">
            <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" aria-hidden />
          </div>
        ) : (
          <ImageEditor
            key={`${designId || "new"}-${initialDesignState?.version ?? 0}-${resolvedHeights?.join("x") ?? "sizes"}`}
            profile={profile}
            initialWidth={resolvedWidth}
            initialHeight={resolvedHeight}
            initialGangsheetHeights={resolvedHeights}
            initialQuantity={effectiveQuantity || 1}
            shopifyVariants={resolvedVariants}
            variantId={effectiveVariantId}
            shopDomain={effectiveShopDomain}
            embedFromShopify={embedFromShopify}
            initialDesignState={initialDesignState}
            initialDesignId={designId}
            isEditMode={isAdminEditMode}
          />
        )}
      </main>
    </div>
  );
}

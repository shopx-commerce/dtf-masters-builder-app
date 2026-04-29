import { useState, useEffect } from "react";
import ImageEditor from "@/components/image-editor";
import { type ProfileConfig, HOT_PEEL_PROFILE } from "@/lib/profiles";
import { Link } from "wouter";
import { ArrowLeft, Upload, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import LanguageToggle from "@/components/language-toggle";

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
  source?: "proxy" | "storefront";
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

export default function StickerMaker({ profile = HOT_PEEL_PROFILE }: StickerMakerProps) {
  const { t } = useLanguage();

  const rawParams = getRawParams();
  const ctxToken = rawParams["ctx"] ?? null;
  const variantId = rawParams["variant"] ?? rawParams["variant_id"] ?? null;
  const quantity = rawParams["quantity"] ?? null;
  const shopDomain = rawParams["shop"] ?? null;
  /** Opened from Shopify (proxy / product) — skip landing-style chrome and upload gate */
  const embedFromShopify = !!(ctxToken || shopDomain);
  /** Opt-in only: ?storefront=1 fetches sizes from Storefront API (needs env vars). Default is builder_context only. */
  const useStorefront =
    rawParams["storefront"] === "1" || rawParams["storefront"] === "true";
  /** Editor only when coming from Shopify (ctx / shop) or optional dev: ?storefront=1&variant= */
  const allowEditor =
    Boolean(ctxToken) ||
    Boolean(shopDomain) ||
    (Boolean(variantId) && useStorefront);
  const [variantConfig, setVariantConfig] = useState<VariantConfig | null>(null);
  /** Full-screen loader only for optional Storefront fetch — never block UI for ?ctx= (proxy already minted ctx; we hydrate variants in background). */
  const [loading, setLoading] = useState(!!variantId && useStorefront);

  useEffect(() => {
    // Primary flow: proxy → redirect with ?ctx=… — hydrate sizes/prices without blocking the editor shell
    if (ctxToken) {
      fetch(`/api/builder-context/${encodeURIComponent(ctxToken)}`)
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then((data: VariantConfig) => {
          setVariantConfig({ ...data, configured: true, source: "proxy" });
        })
        .catch((err) => {
          console.error("[builder] ctx fetch error:", err);
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
  }, [ctxToken, variantId, useStorefront]);

  const resolvedWidth = variantConfig?.configured ? variantConfig.artboardWidth : undefined;
  const resolvedHeight = variantConfig?.configured ? variantConfig.selectedHeight : undefined;
  const resolvedHeights = variantConfig?.configured ? variantConfig.gangsheetHeights : undefined;
  const resolvedVariants = variantConfig?.configured ? variantConfig.variants : undefined;
  /** Wait for `/api/builder-context` before mounting the editor so artboard size isn’t briefly wrong (first variant / default). */
  const waitingForCtx = Boolean(ctxToken) && variantConfig === null;

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
        window.top.postMessage(payload, "*");
      }
    } catch {
      /* ignore */
    }
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, "*");
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
                className="inline-flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-800 shadow-sm hover:bg-gray-50"
                aria-label={t("editor.closeBuilder")}
              >
                <X className="w-4 h-4" />
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
        {waitingForCtx ? (
          <div className="h-full flex items-center justify-center">
            <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" aria-hidden />
          </div>
        ) : (
          <ImageEditor
            profile={profile}
            initialWidth={resolvedWidth}
            initialHeight={resolvedHeight}
            initialGangsheetHeights={resolvedHeights}
            initialQuantity={quantity ? parseInt(quantity, 10) || 1 : 1}
            shopifyVariants={resolvedVariants}
            variantId={variantId}
            shopDomain={shopDomain}
            embedFromShopify={embedFromShopify}
          />
        )}
      </main>
    </div>
  );
}

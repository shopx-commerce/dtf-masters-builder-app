import { useEffect, useState } from "react";
import { Link } from "wouter";
import ImageEditor from "@/builders/die-cut-sticker/image-editor";
import {
  parseShopStickerSettingsFromSearch,
  type ShopStickerSettings,
} from "@/lib/shop-sticker-settings";
import LanguageToggle from "@/components/language-toggle";
import type { DieCutShopifyVariant } from "@/builders/die-cut-sticker/die-cut-checkout";

function getUrlParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const embedParam = urlParams.get("embed");
  return {
    isEmbed: embedParam === "true" || embedParam === "1",
    ctx: urlParams.get("ctx") || undefined,
    parentOrigin:
      urlParams.get("parentOrigin") ||
      urlParams.get("parent_origin") ||
      urlParams.get("origin") ||
      undefined,
    settingsUrl:
      urlParams.get("settingsUrl") || urlParams.get("settings_url") || undefined,
    returnUrl:
      urlParams.get("returnUrl") ||
      urlParams.get("return_url") ||
      urlParams.get("productUrl") ||
      urlParams.get("product_url") ||
      undefined,
    customerId:
      urlParams.get("customerId") || urlParams.get("customer_id") || undefined,
    customerEmail:
      urlParams.get("customerEmail") ||
      urlParams.get("customer_email") ||
      undefined,
    productHandle:
      urlParams.get("productHandle") ||
      urlParams.get("product_handle") ||
      undefined,
    variantId:
      urlParams.get("variantId") ||
      urlParams.get("variant_id") ||
      urlParams.get("variant") ||
      undefined,
    shopDomain: urlParams.get("shop") || undefined,
    designImageUrl:
      urlParams.get("designImageUrl") ||
      urlParams.get("design_image_url") ||
      undefined,
    imageName:
      urlParams.get("imageName") || urlParams.get("image_name") || undefined,
    stickerSize:
      urlParams.get("stickerSize") || urlParams.get("sticker_size") || undefined,
    quantity: urlParams.get("quantity") || urlParams.get("qty") || undefined,
    outlineType:
      urlParams.get("outlineType") || urlParams.get("outline_type") || undefined,
  };
}

const initialParams = getUrlParams();

/**
 * Auto-fetching shop settings replaces the built-in size/quantity presets and
 * reveals the finish/lamination pickers. Set VITE_DIE_CUT_FETCH_SHOP_SETTINGS
 * to "false" (or pass ?shopSettings=off) to keep the standalone defaults.
 */
const AUTO_FETCH_SHOP_SETTINGS = (() => {
  const off = /^(0|false|no|off)$/i;
  if (typeof window !== "undefined") {
    const override = new URLSearchParams(window.location.search).get("shopSettings");
    if (override) return !off.test(override.trim());
  }
  const env = import.meta.env.VITE_DIE_CUT_FETCH_SHOP_SETTINGS;
  return env == null || env === "" ? true : !off.test(String(env).trim());
})();

export default function DieCutStickerMaker() {
  const [shopStickerSettings, setShopStickerSettings] =
    useState<ShopStickerSettings | null>(() =>
      typeof window !== "undefined"
        ? parseShopStickerSettingsFromSearch(window.location.search)
        : null,
    );
  const [shopDomain, setShopDomain] = useState<string | undefined>(
    initialParams.shopDomain,
  );
  const [variantId, setVariantId] = useState<string | undefined>(
    initialParams.variantId,
  );
  const [productHandle, setProductHandle] = useState<string | undefined>(
    initialParams.productHandle,
  );
  const [variants, setVariants] = useState<DieCutShopifyVariant[]>([]);

  // Hydrate Shopify proxy builder context (same ctx flow as gangsheet builders)
  useEffect(() => {
    const ctx = initialParams.ctx;
    if (!ctx) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/builder-context/${encodeURIComponent(ctx)}`);
        if (!r.ok || cancelled) return;
        const data = (await r.json()) as {
          shop?: string;
          variant?: string;
          variant_id?: string;
          product_handle?: string;
          productHandle?: string;
          variants?: DieCutShopifyVariant[];
        };
        if (cancelled) return;
        if (data.shop) setShopDomain(String(data.shop));
        const v = data.variant || data.variant_id;
        if (v) setVariantId(String(v));
        const ph = data.product_handle || data.productHandle;
        if (ph) setProductHandle(String(ph));
        if (Array.isArray(data.variants)) setVariants(data.variants);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const fromUrl = parseShopStickerSettingsFromSearch(window.location.search);
    if (fromUrl) setShopStickerSettings(fromUrl);
  }, []);

  // Load shop sticker settings once we know shop/variant (pricing + size presets)
  useEffect(() => {
    if (!AUTO_FETCH_SHOP_SETTINGS) return;
    if (shopStickerSettings) return;
    const shop = shopDomain;
    if (!shop && !initialParams.settingsUrl) return;
    let cancelled = false;
    const url =
      initialParams.settingsUrl ||
      (() => {
        const q = new URLSearchParams();
        if (shop) q.set("shop", shop);
        if (variantId) q.set("variantId", String(variantId).replace(/\D/g, ""));
        return `/api/sticker-settings?${q.toString()}`;
      })();
    void (async () => {
      try {
        const r = await fetch(url, { credentials: "omit" });
        if (!r.ok || cancelled) return;
        const data = (await r.json()) as ShopStickerSettings;
        if (cancelled || !data || typeof data.version !== "number") return;
        setShopStickerSettings(data);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shopDomain, variantId, shopStickerSettings]);

  useEffect(() => {
    let expectedOrigin: string | null = null;
    try {
      const po = initialParams.parentOrigin;
      if (po) expectedOrigin = new URL(po).origin;
    } catch {
      expectedOrigin = null;
    }
    const onMessage = (ev: MessageEvent) => {
      if (expectedOrigin && ev.origin !== expectedOrigin) {
        // Also accept shell config from proxy origin
      }
      const d = ev.data;
      if (!d || typeof d !== "object") return;
      const t = (d as { type?: string }).type;
      if (t === "stickerShopSettings" || t === "SHOP_STICKER_SETTINGS") {
        const settings = (d as { settings?: unknown }).settings;
        if (!settings || typeof settings !== "object") return;
        const s = settings as ShopStickerSettings;
        if (typeof s.version !== "number") return;
        setShopStickerSettings(s);
        return;
      }
      if (t === "dtf-builder-shell-config") {
        // Shell is ready — announce die-cut builder readiness for R2 relay
        try {
          window.parent.postMessage({ type: "dtf-builder-ready" }, "*");
        } catch {
          /* ignore */
        }
      }
    };
    window.addEventListener("message", onMessage);
    try {
      if (window.parent !== window) {
        window.parent.postMessage({ type: "dtf-builder-ready" }, "*");
        window.parent.postMessage({ type: "stickerEmbedReady" }, "*");
      }
    } catch {
      /* ignore */
    }
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!initialParams.isEmbed || !initialParams.parentOrigin) return;
    const target = (() => {
      try {
        return new URL(initialParams.parentOrigin).origin;
      } catch {
        return initialParams.parentOrigin;
      }
    })();
    const askParent = () => {
      try {
        if (window.parent !== window) {
          window.parent.postMessage({ type: "stickerEmbedReady" }, target);
          window.parent.postMessage(
            { type: "STICKER_EMBED_REQUEST_SETTINGS" },
            target,
          );
        }
      } catch {
        /* ignore */
      }
    };
    askParent();
    const t = window.setTimeout(askParent, 500);
    return () => clearTimeout(t);
  }, []);

  const openedFromShopify = !!(
    initialParams.ctx ||
    shopDomain ||
    initialParams.isEmbed
  );

  return (
    <div
      className={`min-h-screen ${initialParams.isEmbed || openedFromShopify ? "embed-mode" : ""}`}
      style={{ backgroundColor: "#FFFFFF" }}
    >
      {!initialParams.isEmbed && !initialParams.ctx && (
        <header className="border-b border-gray-200 px-6 py-4 bg-white">
          <div className="max-w-7xl mx-auto flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-4">
              <Link
                href="/"
                className="text-sm font-medium text-cyan-600 hover:text-cyan-700"
              >
                ← Back
              </Link>
              <h1
                className="text-2xl font-black tracking-widest"
                style={{
                  fontFamily: "'Orbitron', sans-serif",
                  background:
                    "linear-gradient(90deg, #06b6d4, #3b82f6, #8b5cf6, #06b6d4)",
                  backgroundSize: "200% auto",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                }}
              >
                DIE-CUT STICKERS
              </h1>
            </div>
            <div className="flex items-center gap-3 text-sm text-gray-500">
              <span>AnyNest Die-Cut Sticker Builder</span>
              <LanguageToggle />
            </div>
          </div>
        </header>
      )}

      <main
        className={`max-w-7xl mx-auto px-4 md:px-6 ${
          initialParams.isEmbed || initialParams.ctx ? "py-2" : "py-6 md:py-8"
        }`}
      >
        <ImageEditor
          shopStickerSettings={shopStickerSettings}
          isEmbedMode={initialParams.isEmbed || !!initialParams.ctx}
          embedParentOrigin={initialParams.parentOrigin}
          embedReturnUrl={initialParams.returnUrl}
          customerId={initialParams.customerId}
          customerEmail={initialParams.customerEmail}
          productHandle={productHandle}
          variantId={variantId}
          variants={variants}
          shopDomain={shopDomain}
          initialImageUrl={initialParams.designImageUrl}
          initialImageName={initialParams.imageName}
          initialStickerSize={initialParams.stickerSize}
          initialQuantity={initialParams.quantity}
          initialOutlineType={initialParams.outlineType}
        />
      </main>

      {!initialParams.isEmbed && !initialParams.ctx && (
        <footer className="text-center py-6 text-sm text-gray-500">
          <p className="font-heading tracking-wide">
            Production-Grade Die Cut Stickers. Fast Turnaround.
          </p>
        </footer>
      )}
    </div>
  );
}

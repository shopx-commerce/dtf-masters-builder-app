import type { Express, NextFunction, Request, Response as ExpressResponse } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import sharp from "sharp";
import express from "express";
import { nanoid } from "nanoid";
import crypto from "crypto";
import Replicate from "replicate";

import { fetchStorefrontVariantList } from "./lib/storefront-variant-config";
import {
  createUpscaleCacheKey,
  getCachedUpscaleResult,
  getUpscaleProvider,
  isLocalUpscaleConfigured,
  runLocalUpscaleQueued,
  setCachedUpscaleResult,
} from "./lib/local-upscale";
import { normalizeShopifyPrice } from "./lib/shopify-price";
import {
  assertSafeExternalUrl,
  fetchSafeExternalUrl,
  isAllowedDesignObjectKey,
  isAllowedDieCutObjectKey,
  isAllowedDesignStateKey,
  parseExternalUrl,
} from "./lib/safe-external-url";
import {
  deleteR2Object,
  publicUrlForKey,
  uploadR2Object,
  isR2Configured,
} from "./lib/r2-storage";
import { storage } from "./storage";

import sgMail from "@sendgrid/mail";


// ─── Shopify helpers ────────────────────────────────────────────────────────

function toVariantGid(id: string): string {
  return id.startsWith('gid://') ? id : `gid://shopify/ProductVariant/${id}`;
}

/** Try to extract a W×H pair from a string like "22.5 in X 12 in", "22x24", "22.5×12" */
function parseSizePair(str: string): { width: number; height: number } | null {
  const m = str.match(/(\d+(?:\.\d+)?)\s*(?:in|inch(?:es)?|")?\s*[xX×]\s*(\d+(?:\.\d+)?)/);
  if (m) return { width: parseFloat(m[1]), height: parseFloat(m[2]) };
  return null;
}

/** Parse width/height from Shopify variant selectedOptions + title.
 *  Supports: combined "22.5 in X 12 in" in any option value or variant title,
 *  OR separate "Width"/"Height" named options. */
function parseDimensions(
  options: Array<{ name: string; value: string }>,
  title = ''
): { width: number | null; height: number | null } {
  // 1. Check each option value for a combined W×H string
  for (const opt of options) {
    const pair = parseSizePair(opt.value);
    if (pair) return pair;
  }
  // 2. Separate named options: Width / Height / Length
  let width: number | null = null;
  let height: number | null = null;
  for (const opt of options) {
    const n = opt.name.toLowerCase().trim();
    const v = parseFloat(opt.value);
    if (isNaN(v)) continue;
    if (n === 'width' || n === 'w') width = v;
    else if (n === 'height' || n === 'h' || n === 'length') height = v;
  }
  if (width !== null || height !== null) return { width, height };
  // 3. Try the variant title itself
  const pair = parseSizePair(title);
  if (pair) return pair;
  return { width: null, height: null };
}

const SHOPIFY_VARIANT_QUERY = `
  query GetVariantWithSiblings($id: ID!) {
    node(id: $id) {
      ... on ProductVariant {
        id
        title
        selectedOptions { name value }
        product {
          title
          variants(first: 100) {
            nodes {
              id
              title
              selectedOptions { name value }
            }
          }
        }
      }
    }
  }
`;

// ─── end Shopify helpers ─────────────────────────────────────────────────────

// ─── Builder context from Shopify proxy POST (Admin API data — no Storefront token) ─

const BUILDER_CONTEXT_TTL_MS = 15 * 60 * 1000;
type BuilderContextPayload = {
  configured: boolean;
  source: 'proxy';
  shop?: string;
  artboardWidth?: number;
  gangsheetHeights?: number[] | null;
  selectedHeight?: number | null;
  variantTitle?: string;
  variants?: Array<{ id: string; title: string; price: string | null; sku: string | null; width: number | null; height: number | null }>;
  selectedVariantPrice?: string | null;
  error?: string;
};

const builderContextStore = new Map<string, { at: number; payload: BuilderContextPayload }>();

function pruneBuilderContextStore() {
  const now = Date.now();
  for (const [k, v] of builderContextStore.entries()) {
    if (now - v.at > BUILDER_CONTEXT_TTL_MS) builderContextStore.delete(k);
  }
}

function parseBuilderContextJson(raw: unknown): Record<string, unknown> {
  if (raw == null) throw new Error('builder_context is missing');
  if (typeof raw === 'string') {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) throw new Error('builder_context must parse to an object');
    return parsed as Record<string, unknown>;
  }
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  throw new Error('builder_context must be a JSON string or object');
}

function normalizeVariantId(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  if (s.startsWith('gid://')) return s;
  const digits = s.replace(/\D/g, '');
  return digits ? `gid://shopify/ProductVariant/${digits}` : s;
}

function normalizeBuilderContextPayload(
  obj: Record<string, unknown>,
  selectedVariantIdFromRequest: string | null,
): BuilderContextPayload {
  let rawVariants = obj.variants as unknown;
  if (!Array.isArray(rawVariants) || rawVariants.length === 0) {
    const nested = obj.product as Record<string, unknown> | undefined;
    if (nested && Array.isArray(nested.variants)) rawVariants = nested.variants;
  }
  const list = Array.isArray(rawVariants) ? rawVariants : [];

  const variants = list.map((item: unknown) => {
    const row = item as Record<string, unknown>;
    const id = normalizeVariantId(String(row.id ?? row.variant_id ?? '').trim());
    const title = String(row.title ?? row.name ?? '');
    let width = row.width != null ? Number(row.width) : NaN;
    let height = row.height != null ? Number(row.height) : NaN;
    if (isNaN(width) || isNaN(height)) {
      const opts = Array.isArray(row.selectedOptions) ? row.selectedOptions as Array<{ name: string; value: string }> : [];
      if (opts.length) {
        const dim = parseDimensions(opts, title);
        if (dim.width != null && isNaN(width)) width = dim.width;
        if (dim.height != null && isNaN(height)) height = dim.height;
      }
    }
    if ((isNaN(width) || isNaN(height)) && title) {
      const pair = parseSizePair(title);
      if (pair) {
        if (isNaN(width)) width = pair.width;
        if (isNaN(height)) height = pair.height;
      }
    }
    const price = row.price != null ? normalizeShopifyPrice(row.price) : null;
    const sku = row.sku != null ? String(row.sku) : null;
    return {
      id,
      title,
      price,
      sku,
      width: !isNaN(width) ? width : null,
      height: !isNaN(height) ? height : null,
    };
  });

  let artboardWidth: number | undefined =
    typeof obj.artboardWidth === 'number' ? obj.artboardWidth
      : typeof obj.artboard_width === 'number' ? obj.artboard_width
        : undefined;

  const explicitHeights = (obj.gangsheetHeights ?? obj.gangsheet_heights) as unknown;
  let gangsheetHeights: number[] | null = null;
  if (Array.isArray(explicitHeights)) {
    gangsheetHeights = explicitHeights.map((h) => Number(h)).filter((n) => !isNaN(n)).sort((a, b) => a - b);
  } else {
    const hs = new Set<number>();
    for (const v of variants) {
      if (v.height != null) hs.add(v.height);
    }
    gangsheetHeights = hs.size > 0 ? [...hs].sort((a, b) => a - b) : null;
  }

  if (artboardWidth == null) {
    const w = variants.find((x) => x.width != null)?.width;
    if (w != null) artboardWidth = w;
  }
  if (artboardWidth == null) artboardWidth = 22;

  const selRaw = obj.selectedVariant ?? obj.selected_variant;
  let selectedFromPayload = '';
  if (selRaw && typeof selRaw === 'object' && selRaw !== null) {
    selectedFromPayload = String((selRaw as Record<string, unknown>).id ?? '');
  } else if (selRaw != null && selRaw !== '') {
    selectedFromPayload = String(selRaw);
  }

  const selectedIdRaw = String(
    obj.selectedVariantId ?? obj.selected_variant_id ?? selectedFromPayload ?? selectedVariantIdFromRequest ?? '',
  ).trim();
  const selectedId = normalizeVariantId(selectedIdRaw);
  const variantDigits = selectedIdRaw.replace(/\D/g, '');
  const selected =
    variants.find((v) => v.id && v.id === selectedId)
    ?? (variantDigits
      ? variants.find((v) => v.id && v.id.endsWith(variantDigits))
      : undefined);

  const variantTitle = selected?.title ?? variants[0]?.title;
  const selectedHeight = selected?.height ?? (gangsheetHeights && gangsheetHeights[0]) ?? null;
  const selectedVariantPrice = selected?.price ?? variants[0]?.price ?? null;

  return {
    configured: true,
    source: 'proxy',
    artboardWidth,
    gangsheetHeights,
    selectedHeight,
    variantTitle,
    selectedVariantPrice,
    variants,
  };
}

/** Parse proxy body (JSON or form) and store normalized context; returns ctx token for redirect / GET. */
function storeBuilderContextFromBody(body: Record<string, unknown>): string {
  pruneBuilderContextStore();
  let data: Record<string, unknown>;
  const bc = body.builder_context ?? body.builderContext ?? body.context;
  if (bc != null) {
    data = parseBuilderContextJson(bc);
  } else if (body.variants != null || body.product != null) {
    data = body;
  } else {
    throw new Error('Missing builder_context or body with variants');
  }
  const variantFromBody = (body.variant ?? body.variant_id) as string | undefined;
  const normalized = normalizeBuilderContextPayload(
    data,
    variantFromBody ? String(variantFromBody) : null,
  );
  const token = nanoid(32);
  const shopTop = body.shop != null ? String(body.shop) : undefined;
  const shopFromContext = data.shop != null ? String(data.shop) : undefined;
  const payload: BuilderContextPayload = {
    ...normalized,
    ...(shopTop || shopFromContext ? { shop: shopTop ?? shopFromContext } : {}),
  };
  builderContextStore.set(token, { at: Date.now(), payload });
  return token;
}

// ─── end builder context ─────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
    fieldSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/png') {
      cb(null, true);
    } else {
      cb(new Error('Only PNG files are allowed'));
    }
  },
});

const REAL_ESRGAN_VERSION =
  "nightmareai/real-esrgan:f121d640bd286e1fdc67f9799164c1d5be36ff74576ee11c803ae5b665dd46aa";
const UPSCALE_REQUEST_TIMEOUT_MS = 120_000;

function createTimedFetch(timeoutMs: number) {
  return async (
    input: globalThis.Request | string,
    init: globalThis.RequestInit = {},
  ): Promise<globalThis.Response> => {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutController.signal])
      : timeoutController.signal;
    try {
      return await fetch(input, { ...init, signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

function extractUpscaleOutputUrl(output: unknown): string | null {
  const candidate = Array.isArray(output) ? output[0] : output;
  if (typeof candidate === "string") return candidate;
  if (candidate instanceof URL) return candidate.toString();
  if (candidate && typeof candidate === "object") {
    const value = candidate as { url?: unknown; toString?: () => string };
    if (typeof value.url === "function") {
      const url = value.url();
      return url instanceof URL ? url.toString() : typeof url === "string" ? url : null;
    }
    if (typeof value.url === "string") return value.url;
    if (typeof value.toString === "function") {
      const text = value.toString();
      return text !== "[object Object]" ? text : null;
    }
  }
  return null;
}

export async function registerRoutes(app: Express): Promise<Server> {
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // ─── Die-cut sticker shop settings ─────────────────────────────────────────
  function buildStickerSettings(query: Record<string, string | string[] | undefined>) {
    const defaultSettings = {
      version: 1,
      sizes: {
        minWidth: 0.5,
        minHeight: 0.5,
        maxWidth: 12,
        maxHeight: 12,
        enableCustomSize: true,
        presets: [
          { label: '2×2"', width: 2, height: 2 },
          { label: '3×3"', width: 3, height: 3 },
          { label: '4×4"', width: 4, height: 4 },
          { label: '2×3"', width: 2, height: 3 },
          { label: '3×4"', width: 3, height: 4 },
        ],
      },
      pricing: {
        tiers: [
          { qtyMin: 1000, base: 0.06, rate: 0.0092, minPer: 0.1 },
          { qtyMin: 500, base: 0.09, rate: 0.0086, minPer: 0.12 },
          { qtyMin: 300, base: 0.11, rate: 0.0074, minPer: 0.15 },
          { qtyMin: 200, base: 0.12, rate: 0.01, minPer: 0.175 },
          { qtyMin: 100, base: 0.15, rate: 0.018, minPer: 0.26 },
          { qtyMin: 50, base: 0.23, rate: 0.028, minPer: 0.38 },
          { qtyMin: 25, base: 0.52, rate: 0.027, minPer: 0.6 },
        ],
        quantityOptions: [25, 50, 100, 150, 200, 250, 300, 350, 500, 750, 1000],
        minOrderPrice: 0,
        extraFeeFlat: 0,
      },
      finish: {
        glossy: { enabled: true, adjustment: 0 },
        matte: { enabled: true, adjustment: 0 },
      },
      lamination: {
        none: { enabled: true, adjustment: 0 },
        gloss: { enabled: true, adjustment: 2 },
        matte: { enabled: true, adjustment: 2 },
      },
      defaults: {
        finish: "glossy",
        lamination: "none",
        quantity: 25,
        widthIn: 3,
        heightIn: 3,
      },
      currencyCode: "USD",
    };

    const shopParam = String(query.shop || "").toLowerCase().trim();
    const shopSlug = shopParam.replace(/[\.\-]/g, "_").toUpperCase();
    type Settings = typeof defaultSettings;
    let settings: Settings = defaultSettings;

    const tryParseEnv = (key: string): Settings | null => {
      const raw = process.env[key];
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && typeof parsed.version === "number") {
          return parsed as Settings;
        }
      } catch {
        console.warn(`${key} is not valid JSON — skipping`);
      }
      return null;
    };

    if (shopSlug) {
      const perShop = tryParseEnv(`SHOP_STICKER_SETTINGS_JSON_${shopSlug}`);
      if (perShop) settings = perShop;
    }
    if (settings === defaultSettings) {
      const global_ = tryParseEnv("SHOP_STICKER_SETTINGS_JSON");
      if (global_) settings = global_;
    }

    const isOff = (value: string | undefined) =>
      value != null && value !== "" && /^(0|false|no|off)$/i.test(value.trim());

    // Omitting these keys hides the finish/lamination pickers client-side while
    // leaving size presets and pricing tiers intact.
    if (isOff(process.env.DIE_CUT_ENABLE_FINISH_LAMINATION)) {
      const { finish: _finish, lamination: _lamination, ...rest } = settings;
      settings = rest as Settings;
    }

    const variantPriceCentsRaw = String(query.variantPrice || "").trim();
    if (variantPriceCentsRaw) {
      const variantPriceCents = parseInt(variantPriceCentsRaw, 10);
      if (Number.isFinite(variantPriceCents) && variantPriceCents > 0) {
        const variantPriceDollars = variantPriceCents / 100;
        const { widthIn, heightIn, quantity } = settings.defaults;
        const tiers = [...settings.pricing.tiers].sort((a, b) => b.qtyMin - a.qtyMin);
        const tier = tiers.find((t) => quantity >= t.qtyMin) || tiers[tiers.length - 1];
        const area = widthIn * heightIn;
        const perSticker = Math.max(tier.minPer, tier.base + tier.rate * area);
        const baseTotal = Math.round(perSticker * quantity * 100) / 100;
        const extraFeeFlat = Math.round((variantPriceDollars - baseTotal) * 100) / 100;
        settings = {
          ...settings,
          pricing: { ...settings.pricing, extraFeeFlat, minOrderPrice: 0 },
        };
      }
    }
    return settings;
  }

  function stickerSettingsCorsHeaders(req: Request, res: ExpressResponse) {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Accept, Content-Type");
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
  }

  app.get("/api/sticker-settings", (req, res) => {
    stickerSettingsCorsHeaders(req, res);
    res.json(buildStickerSettings(req.query as Record<string, string | undefined>));
  });
  app.options("/api/sticker-settings", (req, res) => {
    stickerSettingsCorsHeaders(req, res);
    res.sendStatus(204);
  });

  app.get("/apps/sticker-settings", (req, res) => {
    const apiSecret = process.env.SHOPIFY_API_SECRET;
    const signature = (req.query.signature as string | undefined) || "";
    if (apiSecret && signature) {
      const params = req.query as Record<string, string>;
      const message = Object.keys(params)
        .filter((k) => k !== "signature")
        .sort()
        .map((k) => `${k}=${params[k]}`)
        .join("");
      const expected = crypto
        .createHmac("sha256", apiSecret)
        .update(message, "utf8")
        .digest("hex");
      try {
        if (
          signature.length !== expected.length ||
          !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
        ) {
          return res.status(401).json({ error: "Invalid app proxy signature" });
        }
      } catch {
        return res.status(401).json({ error: "Invalid app proxy signature" });
      }
    } else if (apiSecret && !signature) {
      return res.status(401).json({ error: "Missing app proxy signature" });
    }
    stickerSettingsCorsHeaders(req, res);
    res.json(buildStickerSettings(req.query as Record<string, string | undefined>));
  });
  app.options("/apps/sticker-settings", (req, res) => {
    stickerSettingsCorsHeaders(req, res);
    res.sendStatus(204);
  });

  async function fetchViaR2ApiIfPossible(target: URL): Promise<Response | null> {
    assertSafeExternalUrl(target.toString());
    const accountId = String(process.env.R2_ACCOUNT_ID || "").trim();
    const apiToken = String(process.env.R2_API_TOKEN || "").trim();
    const bucketName = String(process.env.R2_BUCKET_NAME || "stickers").trim();
    if (!accountId || !apiToken || !bucketName) return null;
    const host = target.host.toLowerCase();
    const looksLikeR2Public = host.endsWith(".r2.dev") || host.includes(".r2.cloudflarestorage.com");
    if (!looksLikeR2Public) return null;
    const key = target.pathname.replace(/^\/+/, "");
    if (!key) return null;
    const encodedKey = key.split("/").map((seg) => encodeURIComponent(seg)).join("/");
    const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodedKey}`;
    return fetch(apiUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
    });
  }

  async function fetchR2ObjectByKey(key: string): Promise<Response | null> {
    const accountId = String(process.env.R2_ACCOUNT_ID || "").trim();
    const apiToken = String(process.env.R2_API_TOKEN || "").trim();
    const bucketName = String(process.env.R2_BUCKET_NAME || "stickers").trim();
    const cleanKey = String(key || "").trim().replace(/^\/+/, "");
    if (!accountId || !apiToken || !bucketName || !cleanKey) return null;
    const encodedKey = cleanKey.split("/").map((seg) => encodeURIComponent(seg)).join("/");
    const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodedKey}`;
    return fetch(apiUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
    });
  }

  app.get("/api/fetch-json", async (req, res) => {
    const target = parseExternalUrl(req.query.url);
    if (!target) {
      return res.status(400).json({ error: "Valid http/https url is required" });
    }
    try {
      assertSafeExternalUrl(target.toString());
      const upstream = (await fetchViaR2ApiIfPossible(target)) || (await fetchSafeExternalUrl(target.toString()));
      if (!upstream.ok) {
        return res.status(502).json({ error: `Upstream returned ${upstream.status}` });
      }
      const json = await upstream.json();
      return res.json(json);
    } catch (err) {
      console.error("[fetch-json] error:", err);
      const message = err instanceof Error ? err.message : "Failed to fetch JSON";
      const status = message.includes("not allowed") ? 403 : 500;
      return res.status(status).json({ error: message });
    }
  });

  app.get("/api/fetch-binary", async (req, res) => {
    const target = parseExternalUrl(req.query.url);
    if (!target) {
      return res.status(400).json({ error: "Valid http/https url is required" });
    }
    try {
      assertSafeExternalUrl(target.toString());
      const upstream = (await fetchViaR2ApiIfPossible(target)) || (await fetchSafeExternalUrl(target.toString()));
      if (!upstream.ok) {
        return res.status(502).json({ error: `Upstream returned ${upstream.status}` });
      }
      const contentType = upstream.headers.get("content-type") || "application/octet-stream";
      const cacheControl = upstream.headers.get("cache-control") || "public, max-age=300";
      const body = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("content-type", contentType);
      res.setHeader("cache-control", cacheControl);
      return res.status(200).send(body);
    } catch (err) {
      console.error("[fetch-binary] error:", err);
      const message = err instanceof Error ? err.message : "Failed to fetch binary";
      const status = message.includes("not allowed") ? 403 : 500;
      return res.status(status).json({ error: message });
    }
  });

  app.get("/api/design-state", async (req, res) => {
    const stateKey = String(req.query.stateKey || "").trim();
    if (!stateKey) {
      return res.status(400).json({ error: "stateKey is required" });
    }
    if (!isAllowedDesignStateKey(stateKey)) {
      return res.status(403).json({ error: "stateKey not allowed" });
    }
    try {
      const upstream = await fetchR2ObjectByKey(stateKey);
      if (!upstream) {
        return res.status(500).json({ error: "R2 credentials are not configured on builder app" });
      }
      if (!upstream.ok) {
        return res.status(502).json({ error: `R2 object read failed (${upstream.status})` });
      }
      const json = await upstream.json();
      return res.json(json);
    } catch (err) {
      console.error("[design-state] error:", err);
      return res.status(500).json({ error: "Failed to load design state" });
    }
  });

  app.get("/api/r2-object", async (req, res) => {
    const key = String(req.query.key || "").trim();
    if (!key) {
      return res.status(400).json({ error: "key is required" });
    }
    if (!isAllowedDesignObjectKey(key)) {
      return res.status(403).json({ error: "key not allowed" });
    }
    try {
      const upstream = await fetchR2ObjectByKey(key);
      if (!upstream) {
        return res.status(500).json({ error: "R2 credentials are not configured on builder app" });
      }
      if (!upstream.ok) {
        return res.status(502).json({ error: `R2 object read failed (${upstream.status})` });
      }
      const contentType = upstream.headers.get("content-type") || "application/octet-stream";
      const body = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("content-type", contentType);
      res.setHeader("cache-control", "public, max-age=300");
      return res.status(200).send(body);
    } catch (err) {
      console.error("[r2-object] error:", err);
      return res.status(500).json({ error: "Failed to load object" });
    }
  });

  /**
   * Standalone die-cut upload: writes the production PDF / preview PNG to the
   * same R2 keys the Shopify shell uses, so the orders/paid email can find them.
   * Used only when the builder runs outside the Shopify app-proxy shell (the
   * shell path uploads through the Shopify app instead). Same-origin POST.
   */
  const dieCutUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
  }).single("file");

  app.post("/api/die-cut/upload", dieCutUpload, async (req, res) => {
    try {
      if (!isR2Configured()) {
        return res
          .status(500)
          .json({ error: "R2 credentials are not configured on builder app" });
      }
      const file = (req as Request & { file?: Express.Multer.File }).file;
      const objectKey = String((req.body?.objectKey as string) || "").trim();
      if (!file || !file.buffer?.length) {
        return res.status(400).json({ error: "file is required" });
      }
      if (!isAllowedDieCutObjectKey(objectKey)) {
        return res.status(403).json({ error: "objectKey not allowed" });
      }
      const isPdf = /\.pdf$/i.test(objectKey);
      const contentType =
        String((req.body?.contentType as string) || "").trim() ||
        (isPdf ? "application/pdf" : "image/png");
      await uploadR2Object(objectKey, file.buffer, contentType);
      const productionUrl = publicUrlForKey(objectKey);
      return res.status(200).json({
        ok: true,
        key: objectKey,
        productionUrl,
        cartPreviewUrl: productionUrl,
      });
    } catch (err) {
      console.error("[die-cut upload] error:", err);
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Upload failed" });
    }
  });

  /**
   * Shopify proxy JSON entrypoint.
   * Body: variant, quantity, shop (optional), builder_path, builder_context (object | JSON string).
   * Success: always includes redirectPath (required for proxy — open this URL in the browser).
   */
  app.post("/api/builder-context", (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const token = storeBuilderContextFromBody(body);
      const q = new URLSearchParams();
      q.set('ctx', token);
      const v = body.variant ?? body.variant_id;
      const qn = body.quantity;
      const shop = body.shop;
      const productId = body.product_id ?? body.productId;
      const productHandle = body.product_handle ?? body.productHandle;
      if (v != null) q.set('variant', String(v));
      if (qn != null) q.set('quantity', String(qn));
      if (shop != null) q.set('shop', String(shop));
      if (productId != null) q.set('product_id', String(productId));
      if (productHandle != null) q.set('product_handle', String(productHandle));
      const rawPath = body.builder_path ?? body.builderPath ?? '/uv-dtf';
      const normalizedPath =
        typeof rawPath === 'string' && rawPath.trim() !== ''
          ? rawPath.trim()
          : '/uv-dtf';
      const builderPath = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
      const builderSlug = builderPath.replace(/^\//, '').split('/')[0];
      if (builderSlug) q.set('builder', builderSlug);
      const redirectPath = `${builderPath}?${q.toString()}`;
      return res.status(200).json({
        ok: true,
        ctx: token,
        redirectQuery: q.toString(),
        redirectPath,
      });
    } catch (e) {
      console.error('[builder-context] POST error:', e instanceof Error ? e.message : e);
      return res.status(400).json({ error: e instanceof Error ? e.message : 'Invalid body' });
    }
  });

  /** Multipart form fields (Shopify proxy form POST) — JSON is already parsed by express.json */
  const formMultipart = multer({
    storage: multer.memoryStorage(),
    limits: { fieldSize: 15 * 1024 * 1024 },
  }).none();

  function multipartFormIfNeeded(req: Request, res: ExpressResponse, next: NextFunction) {
    const ct = req.headers['content-type'] ?? '';
    if (ct.includes('multipart/form-data')) {
      return formMultipart(req, res, next);
    }
    next();
  }

  /** Shopify proxy: POST builder_context to /uv-dtf (etc.) — 302 to GET ?ctx=… (SPA reads context) */
  const BUILDER_POST_PATHS = ['/uv-dtf', '/hot-peel', '/fluorescent', '/specialty-dtf', '/die-cut-stickers', '/embed'] as const;
  for (const path of BUILDER_POST_PATHS) {
    app.post(path, multipartFormIfNeeded, (req, res) => {
      try {
        const body = req.body as Record<string, unknown>;
        const token = storeBuilderContextFromBody(body);
        const q = new URLSearchParams();
        q.set('ctx', token);
        const v = body.variant ?? body.variant_id;
        const qn = body.quantity;
        const shop = body.shop;
        if (v != null) q.set('variant', String(v));
        if (qn != null) q.set('quantity', String(qn));
        if (shop != null) q.set('shop', String(shop));
        const slug = path.replace(/^\//, '');
        if (slug) q.set('builder', slug);
        res.redirect(302, `${path}?${q.toString()}`);
      } catch (e) {
        console.error(`POST ${path} builder_context:`, e);
        res.status(400).send(e instanceof Error ? e.message : 'Invalid builder_context');
      }
    });
  }

  app.get("/api/builder-context/:ctx", (req, res) => {
    pruneBuilderContextStore();
    const token = req.params.ctx;
    const entry = builderContextStore.get(token);
    if (!entry || Date.now() - entry.at > BUILDER_CONTEXT_TTL_MS) {
      return res.status(404).json({ error: 'Context expired or not found', configured: false });
    }
    return res.json(entry.payload);
  });

  app.get("/api/storefront-variant-config", async (req, res) => {
    const variantId = String(req.query.variant ?? req.query.variant_id ?? "").trim();
    const productId = String(req.query.product_id ?? req.query.productId ?? "").trim();
    const productHandle = String(req.query.product_handle ?? req.query.productHandle ?? "").trim();
    if (!variantId) {
      return res.status(400).json({ configured: false, error: "variant or variant_id param required" });
    }
    try {
      const raw = await fetchStorefrontVariantList(variantId, { productId, productHandle });
      if (!raw) {
        return res.status(502).json({
          configured: false,
          error: "Could not load variants (pass product_id/product_handle; set SHOP_CUSTOM_DOMAIN on builder)",
        });
      }
      const normalized = normalizeBuilderContextPayload(
        raw as unknown as Record<string, unknown>,
        variantId,
      );
      return res.json({ ...normalized, source: "storefront-ajax" });
    } catch (err) {
      console.error("[storefront-variant-config] error:", err);
      return res.status(500).json({ configured: false, error: "Failed to load variant config" });
    }
  });

  // ── Optional: Storefront API (only used when client passes ?storefront=1 — not needed for builder_context flow)
  // Requires env: SHOPIFY_STORE_DOMAIN, SHOPIFY_STOREFRONT_TOKEN
  app.get("/api/shopify/variant-config", async (req, res) => {
    try {
      const variantId = (req.query.variant ?? req.query.variant_id) as string | undefined;
      if (!variantId) {
        return res.status(400).json({ error: "variant or variant_id param required" });
      }

      const domain = process.env.SHOPIFY_STORE_DOMAIN;
      const token  = process.env.SHOPIFY_STOREFRONT_TOKEN;

      if (!domain || !token) {
        return res.status(200).json({
          configured: false,
          error: "Set SHOPIFY_STORE_DOMAIN and SHOPIFY_STOREFRONT_TOKEN env vars.",
        });
      }

      const gid = toVariantGid(variantId);
      const apiRes = await fetch(`https://${domain}/api/2024-01/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": token,
        },
        body: JSON.stringify({ query: SHOPIFY_VARIANT_QUERY, variables: { id: gid } }),
      });

      if (!apiRes.ok) {
        return res.status(502).json({ error: `Shopify API ${apiRes.status}` });
      }

      const json = await apiRes.json() as any;
      const variant = json?.data?.node;
      if (!variant) {
        return res.status(404).json({ error: "Variant not found" });
      }

      const { width: selectedWidth, height: selectedHeight } = parseDimensions(variant.selectedOptions, variant.title);

      const allVariants: Array<{ id: string; title: string; selectedOptions: Array<{ name: string; value: string }> }> =
        variant.product?.variants?.nodes ?? [variant];

      const allHeights: number[] = [];
      let artboardWidth = selectedWidth ?? 22;

      const variantList = allVariants.map((v) => {
        const { width: vw, height: vh } = parseDimensions(v.selectedOptions, v.title);
        if (vw != null) artboardWidth = vw;
        if (vh != null && !allHeights.includes(vh)) allHeights.push(vh);
        return { id: v.id.replace('gid://shopify/ProductVariant/', ''), title: v.title, width: vw, height: vh };
      });

      allHeights.sort((a, b) => a - b);

      return res.json({
        configured: true,
        artboardWidth,
        gangsheetHeights: allHeights.length > 0 ? allHeights : null,
        selectedHeight: selectedHeight ?? allHeights[0] ?? null,
        variantTitle: variant.title,
        productTitle: variant.product?.title,
        variants: variantList,
      });
    } catch (err) {
      console.error("[Shopify] variant-config error:", err);
      return res.status(500).json({ error: "Failed to fetch variant config" });
    }
  });

  app.post("/api/process-image", upload.single('image'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
      }

      const {
        strokeWidth = 5,
        strokeColor = "#ffffff",
        enableStroke = true,
        widthInches = 5,
        heightInches = 4,
        outputDPI = 300,
      } = req.body;

      const parsedWidth = Math.max(0.1, Math.min(100, parseFloat(widthInches) || 5));
      const parsedHeight = Math.max(0.1, Math.min(100, parseFloat(heightInches) || 4));
      const parsedDPI = Math.max(72, Math.min(1200, parseInt(outputDPI) || 300));
      const parsedStrokeWidth = Math.max(0, Math.min(50, parseInt(strokeWidth) || 5));
      const enableStrokeBool = enableStroke === true || enableStroke === 'true';

      const outputWidth = Math.round(parsedWidth * parsedDPI);
      const outputHeight = Math.round(parsedHeight * parsedDPI);

      if (outputWidth * outputHeight > 100_000_000) {
        return res.status(400).json({ error: "Requested output dimensions are too large" });
      }

      let imageBuffer = req.file.buffer;

      const resizedImage = await sharp(imageBuffer)
        .resize(outputWidth, outputHeight, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();

      if (enableStrokeBool && parsedStrokeWidth > 0) {
        const strokeWidthPx = Math.round(parsedStrokeWidth * (parsedDPI / 72));
        
        const strokeBuffer = await sharp(resizedImage)
          .extend({
            top: strokeWidthPx,
            bottom: strokeWidthPx,
            left: strokeWidthPx,
            right: strokeWidthPx,
            background: strokeColor
          })
          .composite([
            {
              input: resizedImage,
              top: strokeWidthPx,
              left: strokeWidthPx,
            }
          ])
          .png()
          .toBuffer();

        imageBuffer = strokeBuffer;
      } else {
        imageBuffer = resizedImage;
      }

      res.set({
        'Content-Type': 'image/png',
        'Content-Disposition': 'attachment; filename="processed-sticker.png"',
        'Content-Length': imageBuffer.length.toString(),
      });

      res.send(imageBuffer);
    } catch (error) {
      console.error("Image processing error:", error);
      res.status(500).json({ 
        error: "Failed to process image", 
        details: error instanceof Error ? error.message : "Unknown error" 
      });
    }
  });

  app.post("/api/upscale-image", upload.single("image"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No PNG image provided" });
      }
      if (req.file.mimetype !== "image/png") {
        return res.status(400).json({ error: "Only PNG images are supported" });
      }

      const parsedScale = Number.parseInt(String(req.body.scaleFactor ?? "2"), 10);
      const scaleFactor = Number.isFinite(parsedScale)
        ? Math.max(2, Math.min(4, parsedScale))
        : 2;
      const provider = getUpscaleProvider();
      if (provider === "local" && !isLocalUpscaleConfigured()) {
        return res.status(503).json({
          error: "Local Real-ESRGAN is not configured. Set REAL_ESRGAN_BIN or use UPSCALE_PROVIDER=auto.",
        });
      }
      const token = process.env.REPLICATE_API_TOKEN;
      if (provider === "replicate" && !token) {
        return res.status(503).json({ error: "AI upscale is not configured on this server" });
      }
      const sourceMetadata = await sharp(req.file.buffer).metadata();
      const sourceWidth = sourceMetadata.width ?? 0;
      const sourceHeight = sourceMetadata.height ?? 0;
      if (!sourceWidth || !sourceHeight) {
        return res.status(400).json({ error: "Could not read PNG dimensions" });
      }
      const cacheKey = createUpscaleCacheKey(req.file.buffer, scaleFactor, provider);
      const cachedResult = getCachedUpscaleResult(cacheKey);
      if (cachedResult) {
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Upscale-Provider", provider);
        res.setHeader("X-Upscale-Cache", "hit");
        return res.status(200).send(cachedResult);
      }

      const sourceStats = await sharp(req.file.buffer).stats();
      const sourceAlpha = sourceStats.channels[3];
      const sourceHasTransparency = Boolean(sourceAlpha && sourceAlpha.min < 255);
      let outputBuffer: Buffer;
      if (provider === "local") {
        outputBuffer = await runLocalUpscaleQueued(req.file.buffer, scaleFactor);
      } else {
        const imageDataUri = `data:image/png;base64,${req.file.buffer.toString("base64")}`;
        const replicate = new Replicate({
          auth: token!,
          fetch: createTimedFetch(UPSCALE_REQUEST_TIMEOUT_MS),
        });

        const predictionController = new AbortController();
        const predictionTimer = setTimeout(
          () => predictionController.abort(),
          UPSCALE_REQUEST_TIMEOUT_MS,
        );
        let output: object;
        try {
          output = await replicate.run(REAL_ESRGAN_VERSION, {
            input: {
              image: imageDataUri,
              scale: scaleFactor,
              face_enhance: false,
            },
            // Replicate's synchronous wait header accepts 1–60 seconds.
            // Keep a little headroom below that limit; the outer abort still
            // protects the full request, including result download.
            wait: { mode: "block", timeout: 55 },
            signal: predictionController.signal,
          });
        } finally {
          clearTimeout(predictionTimer);
        }
        const outputUrl = extractUpscaleOutputUrl(output);
        if (!outputUrl) {
          return res.status(502).json({ error: "Upscale service returned no image" });
        }

        let parsedOutputUrl: URL;
        try {
          parsedOutputUrl = new URL(outputUrl);
        } catch {
          return res.status(502).json({ error: "Upscale service returned an invalid image URL" });
        }
        if (parsedOutputUrl.protocol !== "https:") {
          return res.status(502).json({ error: "Upscale service returned an unsafe image URL" });
        }

        const outputResponse = await createTimedFetch(UPSCALE_REQUEST_TIMEOUT_MS)(parsedOutputUrl.toString());
        if (!outputResponse.ok) {
          return res.status(502).json({ error: `Could not download upscaled image (${outputResponse.status})` });
        }
        outputBuffer = Buffer.from(await outputResponse.arrayBuffer());
      }
      const outputMetadata = await sharp(outputBuffer).metadata();
      const outputWidth = outputMetadata.width ?? 0;
      const outputHeight = outputMetadata.height ?? 0;
      if (!outputWidth || !outputHeight) {
        return res.status(502).json({ error: "Upscale service returned invalid image data" });
      }

      let pngBuffer: Buffer;
      if (sourceHasTransparency) {
        // Real-ESRGAN can flatten transparent PNGs. Rebuild the alpha mask
        // separately and use dest-in; joinChannel can silently lose alpha on
        // PNG output with this sharp version.
        const alphaMask = await sharp(req.file.buffer)
          .ensureAlpha()
          .extractChannel(3)
          .resize(outputWidth, outputHeight, { fit: "fill" })
          .png()
          .toBuffer();
        pngBuffer = await sharp(outputBuffer)
          .ensureAlpha()
          .composite([{ input: alphaMask, blend: "dest-in" }])
          .png()
          .toBuffer();
      } else {
        pngBuffer = await sharp(outputBuffer).png().toBuffer();
      }

      const finalStats = await sharp(pngBuffer).stats();
      const finalAlpha = finalStats.channels[3];
      if (sourceHasTransparency && (!finalAlpha || finalAlpha.min >= 255)) {
        return res.status(502).json({ error: "Upscale output lost PNG transparency" });
      }

      setCachedUpscaleResult(cacheKey, pngBuffer);
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Upscale-Provider", provider);
      res.setHeader("X-Upscale-Cache", "miss");
      return res.status(200).send(pngBuffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown upscale error";
      console.error("[upscale-image] failed:", message);
      if (message.toLowerCase().includes("abort") || message.toLowerCase().includes("timeout")) {
        return res.status(504).json({ error: "Upscale service timed out. Please try again." });
      }
      return res.status(502).json({ error: "AI upscale failed. Please try again." });
    }
  });

  app.post("/api/image-info", upload.single('image'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
      }

      const metadata = await sharp(req.file.buffer).metadata();

      res.json({
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
        channels: metadata.channels,
        // Image placement clamps oversized uploads to the artboard in the
        // client. Keep Sharp's density fallback so existing uploads retain
        // their current physical-size behavior.
        density: metadata.density || 72,
        size: req.file.size,
      });
    } catch (error) {
      console.error("Metadata extraction error:", error);
      res.status(500).json({ 
        error: "Failed to extract image metadata", 
        details: error instanceof Error ? error.message : "Unknown error" 
      });
    }
  });

  /**
   * Legacy immediate-email path (name + email).
   * Die-cut ATC + paid-order email now lives on the Shopify app
   * (shell R2 upload → cart → orders/paid webhook → SendGrid).
   */
  app.post("/api/send-design", upload.none(), async (req, res) => {
    try {
      const body = req.body || {};
      const {
        customerName,
        customerEmail,
        customerNotes,
        pdfData,
        fileName,
        stickerSize,
      } = body;

      const isDieCutPendingFlow =
        !!pdfData && (!customerName || !!stickerSize || body.builder === "die-cut-stickers");

      if (isDieCutPendingFlow) {
        return res.status(410).json({
          error:
            "Die-cut designs are saved via the Shopify app R2 pipeline. Open the builder from the store product page and use Add to Cart.",
          code: "DIE_CUT_USE_SHELL_CHECKOUT",
        });
      }

      if (!customerName || !customerEmail) {
        return res.status(400).json({ error: "Name and email are required" });
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(customerEmail)) {
        return res.status(400).json({ error: "Invalid email format" });
      }
      const sendGridApiKey = process.env.SENDGRID_API_KEY;
      if (!sendGridApiKey) {
        return res.status(500).json({ error: "Email service not configured" });
      }
      sgMail.setApiKey(sendGridApiKey);

      const safeName = escapeHtml(customerName);
      const safeEmail = escapeHtml(customerEmail);
      const safeFileName = escapeHtml(fileName || "Not provided");
      const safeNotes = customerNotes ? escapeHtml(customerNotes) : "";
      const notesSection = customerNotes ? `\nCustomer Notes:\n${customerNotes}\n` : "";
      const emailContent = `
New Design Submission

Customer Details:
- Full Name: ${customerName}
- Email: ${customerEmail}
- File Name: ${fileName || "Not provided"}
- Submission Time: ${new Date().toLocaleString()}
${notesSection}
The customer has confirmed that the cutline looks good and is ready to proceed with this design.
`;
      const htmlNotesSection = safeNotes
        ? `<h3>Customer Notes:</h3><p style="background-color: #f3f4f6; padding: 12px; border-radius: 6px; white-space: pre-wrap;">${safeNotes}</p>`
        : "";
      const htmlContent = `
<h2>New Design Submission</h2>
<ul>
  <li><strong>Full Name:</strong> ${safeName}</li>
  <li><strong>Email:</strong> <a href="mailto:${safeEmail}">${safeEmail}</a></li>
  <li><strong>File Name:</strong> ${safeFileName}</li>
  <li><strong>Submission Time:</strong> ${new Date().toLocaleString()}</li>
</ul>
${htmlNotesSection}
<p>The customer has confirmed that the cutline looks good and is ready to proceed with this design.</p>
${pdfData ? "<p><strong>PDF design with CutContour is attached.</strong></p>" : "<p><em>No design file was attached.</em></p>"}
`;
      const msg: sgMail.MailDataRequired = {
        to: "support@anynestapp.com",
        from: "support@anynestapp.com",
        subject: `New Sticker Design Submission from ${safeName}`,
        text: emailContent,
        html: htmlContent,
      };
      if (pdfData) {
        msg.attachments = [
          {
            content: pdfData,
            filename: fileName || "design.pdf",
            type: "application/pdf",
            disposition: "attachment",
          },
        ];
      }
      await sgMail.send(msg);
      res.json({ success: true, message: "Design sent successfully" });
    } catch (error) {
      console.error("Design save / email error:", error);
      res.status(500).json({
        error: "Failed to send design",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /** Public URL helper for die-cut REF (no DB). Email delivery is handled by the Shopify app. */
  app.get("/api/design/:referenceCode/url", async (req, res) => {
    try {
      const referenceCode = String(req.params.referenceCode || "").toUpperCase();
      if (!referenceCode) {
        return res.status(400).json({ error: "Reference code is required" });
      }
      const objectKey = `designs/die-cut/${referenceCode}/production.pdf`;
      const publicUrl = publicUrlForKey(objectKey);
      if (!publicUrl) {
        return res.status(404).json({
          error: "R2 public base URL is not configured",
          referenceCode,
          key: objectKey,
        });
      }
      res.json({
        success: true,
        designUrl: publicUrl,
        referenceCode,
      });
    } catch (error) {
      console.error("Error getting design URL:", error);
      res.status(500).json({
        error: "Failed to get design URL",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.post("/api/cleanup-designs", async (_req, res) => {
    try {
      const { deletedCount } = await runCleanup();
      res.json({ success: true, deletedCount });
    } catch (error) {
      console.error("Cleanup error:", error);
      res.status(500).json({
        error: "Cleanup failed",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}

/** Deletes designs older than 2 months from DB and Cloudflare R2 */
export async function runCleanup(): Promise<{ deletedCount: number }> {
  const twoMonthsAgo = new Date();
  twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
  const { count, filePaths } = await storage.deleteExpiredDesigns(twoMonthsAgo);
  for (const filePath of filePaths) {
    try {
      await deleteR2Object(filePath);
    } catch (err) {
      console.warn("Failed to delete R2 object during cleanup:", filePath, err);
    }
  }
  return { deletedCount: count };
}

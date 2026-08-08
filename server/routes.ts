import type { Express, NextFunction, Request, Response as ExpressResponse } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import sharp from "sharp";
import express from "express";
import rateLimit from "express-rate-limit";
import { nanoid } from "nanoid";
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
  isAllowedDesignStateKey,
  parseExternalUrl,
} from "./lib/safe-external-url";

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

/**
 * Ceiling on live builder contexts. The store is written by an
 * unauthenticated POST, so TTL pruning alone lets a burst grow it without
 * bound between prunes; a hard entry cap is what actually bounds the memory.
 * 2000 concurrent 15-minute sessions is far more than the storefront
 * generates, and eviction is oldest-first.
 */
const MAX_BUILDER_CONTEXT_ENTRIES = 2000;

const builderContextStore = new Map<string, { at: number; payload: BuilderContextPayload }>();

function pruneBuilderContextStore() {
  const now = Date.now();
  for (const [k, v] of builderContextStore.entries()) {
    if (now - v.at > BUILDER_CONTEXT_TTL_MS) builderContextStore.delete(k);
  }
}

/** Insert with oldest-first eviction once the entry cap is reached. */
function setBuilderContext(token: string, entry: { at: number; payload: BuilderContextPayload }) {
  builderContextStore.delete(token);
  builderContextStore.set(token, entry);
  while (builderContextStore.size > MAX_BUILDER_CONTEXT_ENTRIES) {
    const oldest = builderContextStore.keys().next();
    if (oldest.done) break;
    builderContextStore.delete(oldest.value);
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
  setBuilderContext(token, { at: Date.now(), payload });
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

/** Raster import prepare / metadata — PNG, JPEG, WebP up to 100 MB. */
const MAX_PREPARE_FILE_BYTES = 100 * 1024 * 1024;
const MAX_SOURCE_MEGAPIXELS = 150;
const PREPARE_PREVIEW_MAX_EDGE = 4096;
const MAX_INLINE_DECODE_MEGAPIXELS = 40;
/** How many source pixels collapse into one sample of the reduced alpha probe. */
const MAX_SOURCE_PIXELS_PER_ALPHA_SAMPLE = 64;

/**
 * Pixel ceiling handed to every `sharp()` construction.
 *
 * libvips defaults to roughly 268 MP when `limitInputPixels` is omitted, which
 * is well above the 150 MP this app actually intends to accept. Passing it
 * everywhere — not just on the two routes that already did — keeps a crafted
 * header from committing libvips to a decode nobody asked for.
 */
const SHARP_PIXEL_LIMIT = Math.ceil(MAX_SOURCE_MEGAPIXELS * 1_000_000);

type RasterFormat = "png" | "jpeg" | "webp";

/**
 * Identify a raster container from its leading bytes.
 *
 * The multer filters below screen on a client-supplied MIME type or, worse, on
 * the file *name* — neither says anything about the content, so `evil.png`
 * holding SVG markup used to reach `sharp()` and get dispatched to librsvg.
 * Sniffing here means an unsupported container is refused before libvips is
 * handed the buffer at all.
 */
function sniffRasterFormat(buffer: Buffer): RasterFormat | null {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) {
    return "png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("latin1", 0, 4) === "RIFF" &&
    buffer.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

class UnsupportedRasterError extends Error {}

/**
 * Confirm a buffer really is one of the accepted raster formats, first from
 * its magic bytes and then from libvips' own verdict, before any pipeline work
 * runs against it.
 */
async function assertAllowedRasterFormat(
  buffer: Buffer,
  allowed: readonly RasterFormat[],
): Promise<sharp.Metadata> {
  const sniffed = sniffRasterFormat(buffer);
  if (!sniffed || !allowed.includes(sniffed)) {
    throw new UnsupportedRasterError(
      `Unsupported image format. Only ${allowed.join(", ").toUpperCase()} files are accepted.`,
    );
  }
  const metadata = await sharp(buffer, {
    failOn: "none",
    limitInputPixels: SHARP_PIXEL_LIMIT,
  }).metadata();
  const decoded = metadata.format as RasterFormat | undefined;
  if (!decoded || !allowed.includes(decoded)) {
    throw new UnsupportedRasterError(
      `Unsupported image format. Only ${allowed.join(", ").toUpperCase()} files are accepted.`,
    );
  }
  return metadata;
}

const rasterUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_PREPARE_FILE_BYTES,
    fieldSize: 10 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    // Some browsers hand over `application/octet-stream` for a perfectly good
    // PNG, so the extension still has to be tolerated here. It is only a cheap
    // pre-filter: `assertAllowedRasterFormat` is the real gate.
    const declared = String(file.mimetype || "").toLowerCase();
    const ok =
      declared === "image/png" ||
      declared === "image/jpeg" ||
      declared === "image/jpg" ||
      declared === "image/webp" ||
      ((declared === "application/octet-stream" || declared === "") &&
        /\.(png|jpe?g|webp)$/i.test(file.originalname || ""));
    if (ok) cb(null, true);
    else cb(new Error("Only PNG, JPEG, and WebP files are allowed"));
  },
});

// ─── Proxy response hardening ────────────────────────────────────────────────

/**
 * Byte ceilings for the object-proxy routes.
 *
 * These match the budget the rest of the app already agrees on: a customer
 * asset is capped at 100 MB on upload (`MAX_PREPARE_FILE_BYTES`, mirrored by
 * the client's `MAX_SOURCE_FILE_BYTES`), so that is the real ceiling for
 * reading one back. Design state is metadata only and never approaches a
 * megabyte, so it gets a much tighter cap.
 */
const MAX_PROXY_BINARY_BYTES = MAX_PREPARE_FILE_BYTES;
const MAX_PROXY_JSON_BYTES = 8 * 1024 * 1024;
/** Upstream reads are bounded so a slow object cannot pin a worker forever. */
const PROXY_FETCH_TIMEOUT_MS = 30_000;

class UpstreamTooLargeError extends Error {}

/**
 * Buffer an upstream body while enforcing a hard byte ceiling.
 *
 * `Content-Length` is only a hint — an attacker-controlled origin can omit it
 * or lie — so the declared length is used as an early exit and the stream is
 * then counted as it arrives and aborted the moment it exceeds the cap.
 */
async function readUpstreamBodyWithLimit(upstream: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await upstream.body?.cancel().catch(() => {});
    throw new UpstreamTooLargeError(`Upstream object exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`);
  }
  if (!upstream.body) {
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new UpstreamTooLargeError(`Upstream object exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`);
    }
    return buffer;
  }

  const reader = upstream.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new UpstreamTooLargeError(`Upstream object exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Types the proxy routes are willing to label a response with. Everything the
 * builder legitimately stores in R2 is one of these (uploads are `image/png`,
 * production files are PNG or PDF).
 */
const PROXY_ALLOWED_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
]);

/**
 * Collapse an upstream `Content-Type` onto the allowlist.
 *
 * These responses are same-origin, so echoing the upstream type verbatim let
 * an attacker-hosted bucket serve `text/html` or `image/svg+xml` and get
 * script execution on the builder's own origin. Anything unrecognised becomes
 * an opaque download instead.
 */
export function sanitizeProxyContentType(raw: string | null): string {
  const base = String(raw || "").split(";")[0].trim().toLowerCase();
  const normalized = base === "image/jpg" ? "image/jpeg" : base;
  return PROXY_ALLOWED_CONTENT_TYPES.has(normalized) ? normalized : "application/octet-stream";
}

/**
 * Headers that keep a proxied object inert on this origin: no sniffing past
 * the declared type, never rendered as a document, and no script, style or
 * subresource privileges if it is opened anyway.
 */
export function applyProxyDownloadHeaders(
  res: ExpressResponse,
  contentType: string,
  cacheControl: string,
): void {
  res.setHeader("content-type", contentType);
  res.setHeader("cache-control", cacheControl);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("content-disposition", "attachment");
  res.setHeader("content-security-policy", "default-src 'none'; sandbox");
}

/**
 * Recover the R2 object key a public URL refers to.
 *
 * Only ever used to build a key that is then run through the same allowlist
 * `/api/r2-object` enforces — the account's R2 token must never be pointed at
 * a path the caller chose freely.
 */
function candidateR2KeysFromUrl(target: URL): string[] {
  const decodeSegments = (pathname: string) =>
    pathname
      .replace(/^\/+/, "")
      .split("/")
      .map((seg) => {
        try {
          return decodeURIComponent(seg);
        } catch {
          return seg;
        }
      });

  const segments = decodeSegments(target.pathname);
  if (!segments.length || !segments[0]) return [];

  const candidates = new Set<string>();
  candidates.add(segments.join("/"));

  // The S3-compatible endpoint puts the bucket in the path; a configured
  // public base URL may add a prefix of its own. Offer both readings and let
  // the key allowlist decide which one is real.
  const bucketName = String(process.env.R2_BUCKET_NAME || "stickers").trim();
  if (bucketName && segments[0] === bucketName && segments.length > 1) {
    candidates.add(segments.slice(1).join("/"));
  }
  const publicBase = String(process.env.R2_PUBLIC_BASE_URL || "").trim();
  if (publicBase) {
    try {
      const basePath = decodeSegments(new URL(publicBase).pathname).filter(Boolean);
      if (
        basePath.length &&
        basePath.every((seg, i) => segments[i] === seg) &&
        segments.length > basePath.length
      ) {
        candidates.add(segments.slice(basePath.length).join("/"));
      }
    } catch {}
  }
  return [...candidates].filter(Boolean);
}

/** First reading of the URL path that satisfies the caller's key allowlist. */
function validatedR2KeyFromUrl(target: URL, isAllowedKey: (key: string) => boolean): string | null {
  for (const key of candidateR2KeysFromUrl(target)) {
    if (isAllowedKey(key)) return key;
  }
  return null;
}

function fitWithinMegapixels(
  w: number,
  h: number,
  maxMP: number,
  maxEdge: number,
): number {
  const pixels = Math.max(1, w * h);
  const mpScale = Math.sqrt((maxMP * 1_000_000) / pixels);
  const edgeScale = Math.min(maxEdge / Math.max(w, 1), maxEdge / Math.max(h, 1));
  return Math.min(1, mpScale, edgeScale);
}

type SharpReadOpts = {
  failOn: "none";
  sequentialRead: boolean;
  limitInputPixels: number;
};

/**
 * Sample the alpha channel to learn whether the artwork is actually cut out
 * and whether its alpha is binary.
 *
 * Reduced nearest-neighbour, so every byte read is an exact source value
 * rather than a blend of its neighbours — that is what makes the binary-alpha
 * answer trustworthy. Roughly a megabyte even for a 150 MP source.
 */
async function probeAlpha(
  buffer: Buffer,
  sharpOpts: SharpReadOpts,
  srcW: number,
  srcH: number,
): Promise<{ hasTransparentPixels: boolean; binaryAlpha: boolean }> {
  const cells = Math.ceil((srcW * srcH) / MAX_SOURCE_PIXELS_PER_ALPHA_SAMPLE);
  const scale = Math.min(1, Math.sqrt(cells / Math.max(1, srcW * srcH)));
  const samples = await sharp(buffer, sharpOpts)
    .rotate()
    .toColourspace("srgb")
    .ensureAlpha()
    .extractChannel(3)
    .resize(Math.max(1, Math.round(srcW * scale)), Math.max(1, Math.round(srcH * scale)), {
      fit: "fill",
      kernel: "nearest",
    })
    .raw()
    .toBuffer();

  let hasTransparentPixels = false;
  let hasPartialAlpha = false;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    if (a === 0) hasTransparentPixels = true;
    else if (a !== 255) hasPartialAlpha = true;
  }

  // "Binary alpha" is a claim about hard-edged cut-out artwork, and it is only
  // meaningful when transparency exists at all. A fully opaque image trivially
  // satisfies "every alpha is 0 or 255", and calling that binary sent ordinary
  // opaque PNGs down the hard-edge path: nearest-neighbour for the preview and
  // pixelated resampling at print size, both visibly aliased. Require real
  // transparency before making the claim.
  return {
    hasTransparentPixels,
    binaryAlpha: hasTransparentPixels && !hasPartialAlpha,
  };
}

/**
 * Measure the exact content box of a large raster without materializing it.
 *
 * libvips' find_trim runs at full resolution and before any resize, and it
 * reports how far it moved the top-left corner. Running it a second time on
 * the mirrored image turns those same two numbers into the right and bottom
 * insets, so two passes give all four edges exactly — no cell quantisation,
 * no padding fudge, and soft shadow ramps survive down to alpha 1. Both
 * pipelines resize their output to 1×1, so nothing full-size is ever encoded
 * or held in memory.
 */
async function measureContentBounds(
  buffer: Buffer,
  sharpOpts: SharpReadOpts,
  srcW: number,
  srcH: number,
): Promise<{ left: number; top: number; width: number; height: number }> {
  const probe = (mirror: boolean) => {
    let p = sharp(buffer, sharpOpts).rotate();
    if (mirror) p = p.flop().flip();
    return p
      // `lineArt` is essential, not a tweak: without it libvips compares an
      // averaged row/column profile, so a 1-2 px stroke on a wide canvas falls
      // below the threshold and gets cropped off the artwork.
      .trim({ threshold: 0, lineArt: true })
      .resize(1, 1, { fit: "fill" })
      .toBuffer({ resolveWithObject: true });
  };

  const full = { left: 0, top: 0, width: srcW, height: srcH };
  let normal: Awaited<ReturnType<typeof probe>>;
  let mirrored: Awaited<ReturnType<typeof probe>>;
  try {
    [normal, mirrored] = await Promise.all([probe(false), probe(true)]);
  } catch {
    // A uniform image gives libvips nothing to trim against.
    return full;
  }

  const left = Math.max(0, -(normal.info.trimOffsetLeft ?? 0));
  const top = Math.max(0, -(normal.info.trimOffsetTop ?? 0));
  const right = Math.min(srcW, srcW + (mirrored.info.trimOffsetLeft ?? 0));
  const bottom = Math.min(srcH, srcH + (mirrored.info.trimOffsetTop ?? 0));
  const width = right - left;
  const height = bottom - top;

  if (!(width > 0) || !(height > 0)) return full;
  if (width >= srcW && height >= srcH) return full;
  return { left, top, width, height };
}

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

// Replicate throws an ApiError carrying the upstream Response. A 4xx there is
// permanent (bad credential, no credit, retired model), so it must not be
// reported as the transient failure the client retries.
function extractProviderErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const response = (error as { response?: { status?: unknown } }).response;
  const status = response?.status;
  return typeof status === "number" ? status : null;
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

/**
 * Per-IP rate limiting.
 *
 * Nothing here is authenticated, so an IP bucket is the only handle available.
 * The numbers are deliberately loose: a single customer laying out a gangsheet
 * legitimately makes a lot of calls (one `/api/image-info` plus one
 * `/api/prepare-raster-upload` per uploaded file, one `/api/fetch-binary` per
 * distinct restored asset), and throttling a real customer is a worse outcome
 * than an attacker getting a few hundred requests through. The tight bucket is
 * reserved for the mail relay, where there is no legitimate high-volume use.
 *
 * NOTE on proxies: `req.ip` is the immediate peer unless Express is told to
 * trust `X-Forwarded-For`. Set `TRUST_PROXY` (see server/index.ts) when this
 * app runs behind a load balancer or CDN, otherwise every customer shares one
 * bucket.
 */
function buildLimiter(windowMs: number, limit: number, message: string) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: message });
    },
  });
}

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

/** Broad backstop for the whole `/api` surface. */
const apiLimiter = buildLimiter(
  RATE_LIMIT_WINDOW_MS,
  Number(process.env.RATE_LIMIT_API ?? 1200),
  "Too many requests. Please slow down and try again shortly.",
);

/** Object proxying — cheap per call, but each one is an outbound fetch. */
const proxyLimiter = buildLimiter(
  RATE_LIMIT_WINDOW_MS,
  Number(process.env.RATE_LIMIT_PROXY ?? 300),
  "Too many asset requests. Please wait a moment and try again.",
);

/** sharp/libvips routes: each call can cost real CPU and memory. */
const imageLimiter = buildLimiter(
  RATE_LIMIT_WINDOW_MS,
  Number(process.env.RATE_LIMIT_IMAGE ?? 240),
  "Too many image requests. Please wait a moment and try again.",
);

/** Mail relay: an operator inbox, so a handful an hour is plenty. */
const mailLimiter = buildLimiter(
  60 * 60 * 1000,
  Number(process.env.RATE_LIMIT_MAIL ?? 20),
  "Too many design submissions from this address. Please try again later.",
);

const PROXY_RATE_LIMITED_PATHS = [
  "/api/fetch-binary",
  "/api/fetch-json",
  "/api/r2-object",
  "/api/design-state",
];

const IMAGE_RATE_LIMITED_PATHS = [
  "/api/process-image",
  "/api/upscale-image",
  "/api/image-info",
  "/api/prepare-raster-upload",
];

export async function registerRoutes(app: Express): Promise<Server> {
  // Health is the deploy platform's liveness probe; never throttle it.
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  if (process.env.RATE_LIMIT_DISABLED !== "1") {
    app.use("/api", apiLimiter);
    app.use(PROXY_RATE_LIMITED_PATHS, proxyLimiter);
    app.use(IMAGE_RATE_LIMITED_PATHS, imageLimiter);
    app.use("/api/send-design", mailLimiter);
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
      signal: AbortSignal.timeout(PROXY_FETCH_TIMEOUT_MS),
    });
  }

  /**
   * Read an allowlisted external URL, using the account's R2 credentials only
   * when the URL path resolves to a key the object allowlist accepts.
   *
   * The previous version decided from the *host* alone that a URL "looked like
   * R2" and then used the account token with the caller's path as the object
   * key, so any `*.r2.dev` URL turned into an authenticated read of an
   * arbitrary key in the production bucket. Credentials are now reserved for
   * validated keys; anything else falls through to an ordinary anonymous fetch
   * that carries no privilege at all.
   */
  async function fetchAllowlistedUrl(
    target: URL,
    isAllowedKey: (key: string) => boolean,
  ): Promise<Response> {
    assertSafeExternalUrl(target.toString());
    const key = validatedR2KeyFromUrl(target, isAllowedKey);
    if (key) {
      const viaR2Api = await fetchR2ObjectByKey(key);
      if (viaR2Api) return viaR2Api;
    }
    return fetchSafeExternalUrl(target.toString(), { timeoutMs: PROXY_FETCH_TIMEOUT_MS });
  }

  /** Map proxy failures onto a status without leaking upstream detail. */
  function proxyErrorStatus(message: string): number {
    if (message.includes("not allowed")) return 403;
    if (message.includes("exceeds the")) return 413;
    if (/abort|timeout|timed out/i.test(message)) return 504;
    return 500;
  }

  app.get("/api/fetch-json", async (req, res) => {
    const target = parseExternalUrl(req.query.url);
    if (!target) {
      return res.status(400).json({ error: "Valid http/https url is required" });
    }
    try {
      const upstream = await fetchAllowlistedUrl(target, isAllowedDesignStateKey);
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        return res.status(502).json({ error: `Upstream returned ${upstream.status}` });
      }
      const body = await readUpstreamBodyWithLimit(upstream, MAX_PROXY_JSON_BYTES);
      let json: unknown;
      try {
        json = JSON.parse(body.toString("utf8"));
      } catch {
        return res.status(502).json({ error: "Upstream did not return valid JSON" });
      }
      res.setHeader("x-content-type-options", "nosniff");
      return res.json(json);
    } catch (err) {
      console.error("[fetch-json] error:", err);
      const message = err instanceof Error ? err.message : "Failed to fetch JSON";
      return res.status(proxyErrorStatus(message)).json({ error: message });
    }
  });

  app.get("/api/fetch-binary", async (req, res) => {
    const target = parseExternalUrl(req.query.url);
    if (!target) {
      return res.status(400).json({ error: "Valid http/https url is required" });
    }
    try {
      const upstream = await fetchAllowlistedUrl(target, isAllowedDesignObjectKey);
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        return res.status(502).json({ error: `Upstream returned ${upstream.status}` });
      }
      const cacheControl = upstream.headers.get("cache-control") || "public, max-age=300";
      const contentType = sanitizeProxyContentType(upstream.headers.get("content-type"));
      const body = await readUpstreamBodyWithLimit(upstream, MAX_PROXY_BINARY_BYTES);
      applyProxyDownloadHeaders(res, contentType, cacheControl);
      return res.status(200).send(body);
    } catch (err) {
      console.error("[fetch-binary] error:", err);
      const message = err instanceof Error ? err.message : "Failed to fetch binary";
      return res.status(proxyErrorStatus(message)).json({ error: message });
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
        await upstream.body?.cancel().catch(() => {});
        return res.status(502).json({ error: `R2 object read failed (${upstream.status})` });
      }
      const body = await readUpstreamBodyWithLimit(upstream, MAX_PROXY_JSON_BYTES);
      let json: unknown;
      try {
        json = JSON.parse(body.toString("utf8"));
      } catch {
        return res.status(502).json({ error: "Design state is not valid JSON" });
      }
      res.setHeader("x-content-type-options", "nosniff");
      return res.json(json);
    } catch (err) {
      console.error("[design-state] error:", err);
      const message = err instanceof Error ? err.message : "Failed to load design state";
      const status = proxyErrorStatus(message);
      return res.status(status).json({
        error: status === 500 ? "Failed to load design state" : message,
      });
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
        await upstream.body?.cancel().catch(() => {});
        return res.status(502).json({ error: `R2 object read failed (${upstream.status})` });
      }
      const contentType = sanitizeProxyContentType(upstream.headers.get("content-type"));
      const body = await readUpstreamBodyWithLimit(upstream, MAX_PROXY_BINARY_BYTES);
      applyProxyDownloadHeaders(res, contentType, "public, max-age=300");
      return res.status(200).send(body);
    } catch (err) {
      console.error("[r2-object] error:", err);
      const message = err instanceof Error ? err.message : "Failed to load object";
      const status = proxyErrorStatus(message);
      return res.status(status).json({
        error: status === 500 ? "Failed to load object" : message,
      });
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
  const BUILDER_POST_PATHS = ['/uv-dtf', '/hot-peel', '/fluorescent', '/specialty-dtf', '/embed'] as const;
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
        // `res.send(string)` replies as text/html, and a JSON parse failure
        // carries a snippet of the caller's input in its message — customer
        // input echoed into a rendered document on a path the Shopify proxy
        // forwards. The detail belongs in the log, not the response.
        console.error(`POST ${path} builder_context:`, e instanceof Error ? e.message : e);
        res.status(400).json({ error: 'Invalid builder_context' });
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
      await assertAllowedRasterFormat(imageBuffer, ["png"]);

      const resizedImage = await sharp(imageBuffer, { limitInputPixels: SHARP_PIXEL_LIMIT })
        .resize(outputWidth, outputHeight, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();

      if (enableStrokeBool && parsedStrokeWidth > 0) {
        const strokeWidthPx = Math.round(parsedStrokeWidth * (parsedDPI / 72));
        
        const strokeBuffer = await sharp(resizedImage, { limitInputPixels: SHARP_PIXEL_LIMIT })
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
      if (error instanceof UnsupportedRasterError) {
        return res.status(400).json({ error: error.message });
      }
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
      // Before the provider checks, so unsupported bytes are refused whether or
      // not an upscaler happens to be configured.
      const sourceMetadata = await assertAllowedRasterFormat(req.file.buffer, ["png"]);

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
      const token = String(process.env.REPLICATE_API_TOKEN ?? "").trim();
      if (provider === "replicate" && !token) {
        return res.status(503).json({
          error:
            "AI upscale is not configured on this server. Set REPLICATE_API_TOKEN, or install the local engine and set REAL_ESRGAN_BIN.",
        });
      }
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

      const sourceStats = await sharp(req.file.buffer, { limitInputPixels: SHARP_PIXEL_LIMIT }).stats();
      const sourceAlpha = sourceStats.channels[3];
      const sourceHasTransparency = Boolean(sourceAlpha && sourceAlpha.min < 255);
      let outputBuffer: Buffer;
      if (provider === "local") {
        outputBuffer = await runLocalUpscaleQueued(req.file.buffer, scaleFactor);
      } else {
        // Replicate caps inline base64 input at 10 MB, which a 300 DPI design
        // passes easily. Handing the SDK a File makes it upload the PNG
        // through the files API and send a URL instead of an inline data URI.
        const imageFile = new File([new Uint8Array(req.file.buffer)], "design.png", {
          type: "image/png",
        });
        const replicate = new Replicate({
          auth: token,
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
              image: imageFile,
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
        outputBuffer = await readUpstreamBodyWithLimit(outputResponse, MAX_PROXY_BINARY_BYTES);
      }
      let outputMetadata: sharp.Metadata;
      try {
        outputMetadata = await assertAllowedRasterFormat(outputBuffer, ["png", "jpeg", "webp"]);
      } catch (err) {
        if (err instanceof UnsupportedRasterError) {
          return res.status(502).json({ error: "Upscale service returned an unsupported image format" });
        }
        throw err;
      }
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
        const alphaMask = await sharp(req.file.buffer, { limitInputPixels: SHARP_PIXEL_LIMIT })
          .ensureAlpha()
          .extractChannel(3)
          .resize(outputWidth, outputHeight, { fit: "fill" })
          .png()
          .toBuffer();
        pngBuffer = await sharp(outputBuffer, { limitInputPixels: SHARP_PIXEL_LIMIT })
          .ensureAlpha()
          .composite([{ input: alphaMask, blend: "dest-in" }])
          .png()
          .toBuffer();
      } else {
        pngBuffer = await sharp(outputBuffer, { limitInputPixels: SHARP_PIXEL_LIMIT }).png().toBuffer();
      }

      const finalStats = await sharp(pngBuffer, { limitInputPixels: SHARP_PIXEL_LIMIT }).stats();
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
      if (error instanceof UnsupportedRasterError) {
        return res.status(400).json({ error: error.message });
      }
      if (error instanceof UpstreamTooLargeError) {
        return res.status(502).json({ error: "Upscale service returned an image that is too large" });
      }
      if (message.toLowerCase().includes("abort") || message.toLowerCase().includes("timeout")) {
        return res.status(504).json({ error: "Upscale service timed out. Please try again." });
      }
      const providerStatus = extractProviderErrorStatus(error);
      if (providerStatus === 401 || providerStatus === 403) {
        return res.status(503).json({
          error: "The AI upscale credential was rejected. REPLICATE_API_TOKEN is missing, expired, or revoked.",
        });
      }
      if (providerStatus === 402) {
        return res.status(503).json({ error: "The AI upscale account is out of credit." });
      }
      if (providerStatus === 404) {
        return res.status(503).json({ error: "The configured AI upscale model is no longer available." });
      }
      if (providerStatus === 413) {
        return res.status(413).json({ error: "This design is too large for the AI upscale service." });
      }
      return res.status(502).json({ error: "AI upscale failed. Please try again." });
    }
  });

  app.post("/api/image-info", rasterUpload.single("image"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
      }

      const metadata = await assertAllowedRasterFormat(req.file.buffer, ["png", "jpeg", "webp"]);

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
      if (error instanceof UnsupportedRasterError) {
        return res.status(400).json({ error: error.message });
      }
      console.error("Metadata extraction error:", error);
      res.status(500).json({
        error: "Failed to extract image metadata",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * Oversized raster prepare.
   *
   * Returns *only* an editor-sized preview PNG. The browser keeps the user's
   * original file as the print source, so nothing here caps print quality and
   * we never ship high-resolution pixels back over the wire. Everything the
   * client needs to line the preview up with the original travels in headers:
   * the content-crop rect (in source pixels), the oriented source size, and
   * whether the source alpha is binary (so halftone-ready art keeps hard
   * edges instead of being resampled soft).
   */
  app.post("/api/prepare-raster-upload", rasterUpload.single("image"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
      }

      const sharpOpts = {
        failOn: "none" as const,
        sequentialRead: true,
        limitInputPixels: SHARP_PIXEL_LIMIT,
      };

      const meta = await assertAllowedRasterFormat(req.file.buffer, ["png", "jpeg", "webp"]);
      // `metadata()` reports pre-rotation dimensions; EXIF orientations 5-8
      // swap the axes once `.rotate()` auto-orients the pipeline.
      const swapAxes = (meta.orientation ?? 0) >= 5;
      const srcW = (swapAxes ? meta.height : meta.width) ?? 0;
      const srcH = (swapAxes ? meta.width : meta.height) ?? 0;
      if (!(srcW > 0) || !(srcH > 0)) {
        return res.status(400).json({ error: "Could not read image dimensions" });
      }

      const sourceMegapixels = (srcW * srcH) / 1_000_000;
      if (sourceMegapixels > MAX_SOURCE_MEGAPIXELS) {
        return res.status(400).json({
          error: `Image is ${Math.round(sourceMegapixels)} MP; maximum is ${MAX_SOURCE_MEGAPIXELS} MP`,
        });
      }

      // Crop to content only for genuinely cut-out artwork. A PNG that carries
      // an alpha channel but no transparent pixels is treated like a photo:
      // trimming it would eat a deliberate solid border, which is exactly what
      // the inline path's opaque-raster branch avoids.
      const alpha = meta.hasAlpha
        ? await probeAlpha(req.file.buffer, sharpOpts, srcW, srcH)
        : { hasTransparentPixels: false, binaryAlpha: false };
      const bounds = alpha.hasTransparentPixels
        ? await measureContentBounds(req.file.buffer, sharpOpts, srcW, srcH)
        : { left: 0, top: 0, width: srcW, height: srcH };

      const previewScale = fitWithinMegapixels(
        bounds.width,
        bounds.height,
        MAX_INLINE_DECODE_MEGAPIXELS,
        PREPARE_PREVIEW_MAX_EDGE,
      );
      const previewW = Math.max(1, Math.round(bounds.width * previewScale));
      const previewH = Math.max(1, Math.round(bounds.height * previewScale));

      let pipeline = sharp(req.file.buffer, sharpOpts).rotate();
      if (bounds.width !== srcW || bounds.height !== srcH) {
        pipeline = pipeline.extract({
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
        });
      }
      const previewBuf = await pipeline
        .resize(previewW, previewH, {
          fit: "fill",
          // Binary alpha means halftone-ready art: nearest keeps the edges hard
          // instead of introducing a soft fringe the editor would then read as
          // anti-aliased.
          kernel: alpha.binaryAlpha ? "nearest" : "lanczos3",
        })
        .png()
        .toBuffer();

      const exposed = [
        "X-Anynest-Source-Width",
        "X-Anynest-Source-Height",
        "X-Anynest-Crop-X",
        "X-Anynest-Crop-Y",
        "X-Anynest-Crop-Width",
        "X-Anynest-Crop-Height",
        "X-Anynest-Preview-Width",
        "X-Anynest-Preview-Height",
        "X-Anynest-Density",
        "X-Anynest-Source-MP",
        "X-Anynest-Binary-Alpha",
        "X-Anynest-Has-Transparency",
      ];
      res.set({
        "Content-Type": "image/png",
        "X-Anynest-Source-Width": String(srcW),
        "X-Anynest-Source-Height": String(srcH),
        "X-Anynest-Crop-X": String(bounds.left),
        "X-Anynest-Crop-Y": String(bounds.top),
        "X-Anynest-Crop-Width": String(bounds.width),
        "X-Anynest-Crop-Height": String(bounds.height),
        "X-Anynest-Preview-Width": String(previewW),
        "X-Anynest-Preview-Height": String(previewH),
        "X-Anynest-Density": String(meta.density && meta.density > 0 ? meta.density : 72),
        "X-Anynest-Source-MP": String(Math.round(sourceMegapixels * 10) / 10),
        "X-Anynest-Binary-Alpha": alpha.binaryAlpha ? "1" : "0",
        // Measured on the *uncropped* source. The client cannot re-derive this
        // from the preview: cropping to content can remove every transparent
        // pixel, making cut-out artwork look like an opaque photo.
        "X-Anynest-Has-Transparency": alpha.hasTransparentPixels ? "1" : "0",
        "Access-Control-Expose-Headers": exposed.join(", "),
        "Cache-Control": "no-store",
      });
      return res.status(200).send(previewBuf);
    } catch (error) {
      if (error instanceof UnsupportedRasterError) {
        return res.status(400).json({ error: error.message });
      }
      console.error("[prepare-raster-upload] failed:", error);
      const message = error instanceof Error ? error.message : "Unknown error";
      if (/exceeds pixel limit/i.test(message)) {
        return res.status(400).json({
          error: `Image exceeds the ${MAX_SOURCE_MEGAPIXELS} MP limit`,
        });
      }
      return res.status(500).json({
        error: "Failed to prepare image for import",
        details: message,
      });
    }
  });

  app.post("/api/send-design", upload.none(), async (req, res) => {
    try {
      const { customerName, customerEmail, customerNotes, pdfData, fileName } = req.body;

      if (!customerName || !customerEmail) {
        return res.status(400).json({ error: "Name and email are required" });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(customerEmail)) {
        return res.status(400).json({ error: "Invalid email format" });
      }

      // The attachment is base64 straight from the browser, previously
      // *declared* application/pdf and named by the caller. Validate before
      // the mail service is involved at all, so junk never costs a send.
      let pdfAttachment: Buffer | null = null;
      if (pdfData) {
        let decoded: Buffer;
        try {
          decoded = Buffer.from(String(pdfData), "base64");
        } catch {
          return res.status(400).json({ error: "Attachment is not valid base64" });
        }
        if (decoded.length < 5 || decoded.toString("latin1", 0, 5) !== "%PDF-") {
          return res.status(400).json({ error: "Attachment must be a PDF" });
        }
        pdfAttachment = decoded;
      }

      const sendGridApiKey = process.env.SENDGRID_API_KEY;
      
      if (!sendGridApiKey) {
        console.error("SendGrid API key not configured");
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

<h3>Customer Details:</h3>
<ul>
  <li><strong>Full Name:</strong> ${safeName}</li>
  <li><strong>Email:</strong> <a href="mailto:${safeEmail}">${safeEmail}</a></li>
  <li><strong>File Name:</strong> ${safeFileName}</li>
  <li><strong>Submission Time:</strong> ${new Date().toLocaleString()}</li>
</ul>

${htmlNotesSection}

<p>The customer has confirmed that the cutline looks good and is ready to proceed with this design.</p>

${pdfData ? '<p><strong>PDF design with CutContour is attached.</strong></p>' : '<p><em>No design file was attached.</em></p>'}
`;

      const msg: sgMail.MailDataRequired = {
        to: "support@anynestapp.com",
        from: "support@anynestapp.com",
        subject: `New Sticker Design Submission from ${safeName}`,
        text: emailContent,
        html: htmlContent,
      };

      if (pdfAttachment) {
        // Server-generated filename: a caller-supplied one let an operator
        // opening the ticket be handed `invoice.pdf.html`.
        msg.attachments = [
          {
            content: pdfAttachment.toString("base64"),
            filename: `design-${Date.now()}.pdf`,
            type: "application/pdf",
            disposition: "attachment",
          },
        ];
      }

      await sgMail.send(msg);

      res.json({ success: true, message: "Design sent successfully" });
    } catch (error) {
      console.error("Email sending error:", error);
      
      let errorMessage = "Failed to send design";
      if (error instanceof Error) {
        errorMessage = error.message;
      }
      
      res.status(500).json({
        error: "Failed to send design",
        details: errorMessage,
      });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}

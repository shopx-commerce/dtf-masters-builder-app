import { existsSync } from "node:fs";
import express, { type Request, Response, NextFunction } from "express";
import helmet from "helmet";
import { loadClientEnv } from "./load-env";
import { registerRoutes, runCleanup } from "./routes";
import { setupVite, serveStatic, log } from "./vite";

loadClientEnv();

// Replit injects secrets straight into the environment. Local runs have no
// such mechanism, so an optional .env file is the only way to supply keys
// like REPLICATE_API_TOKEN without exporting them by hand every session.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const app = express();

// Per-IP rate limiting in routes.ts keys off `req.ip`, which is the immediate
// peer unless Express is told how many proxies sit in front. Behind a load
// balancer or CDN that would put every customer in one bucket, so set
// TRUST_PROXY to the hop count (or `true`) in those deployments. Left off by
// default: trusting X-Forwarded-For when nothing sets it lets a caller forge
// its own rate-limit key.
const trustProxy = String(process.env.TRUST_PROXY ?? "").trim();
if (trustProxy) {
  const hops = Number(trustProxy);
  app.set("trust proxy", Number.isFinite(hops) && hops > 0 ? hops : trustProxy);
}

/**
 * Framing allowlist for the builder iframe.
 *
 * The builder is embedded in a Shopify storefront, so framing cannot simply be
 * denied — but leaving it open to every origin is what makes the
 * `postMessage` trust between shell and frame worth attacking. Derived from the
 * shop domains this app is already configured with, and overridable wholesale
 * with FRAME_ANCESTORS (space-separated CSP source list).
 */
function frameAncestorsDirective(): string | null {
  const override = String(process.env.FRAME_ANCESTORS ?? "").trim();
  if (override) return `frame-ancestors ${override}`;

  const sources = new Set<string>(["'self'"]);
  for (const envName of ["SHOP_CUSTOM_DOMAIN", "SHOPIFY_STORE_DOMAIN"]) {
    const raw = String(process.env[envName] ?? "").trim();
    if (!raw) continue;
    const host = raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim();
    if (host) sources.add(`https://${host}`);
  }
  // Nothing configured means we cannot know the storefront origin; guessing
  // would break the embed, so framing is left as-is and reported instead.
  if (sources.size === 1) return null;
  sources.add("https://*.myshopify.com");
  sources.add("https://admin.shopify.com");
  return `frame-ancestors ${[...sources].join(" ")}`;
}

app.use(
  helmet({
    // A full CSP is not landed yet: this SPA needs inline/eval in Vite dev,
    // `wasm-unsafe-eval` for the ONNX Runtime upscaler, plus blob: workers and
    // blob:/data: images. Shipping an approximate policy would break the
    // builder, so only the framing directive is emitted here (it constrains
    // nothing the app loads).
    contentSecurityPolicy: false,
    // helmet's default is SAMEORIGIN, which would break the storefront embed
    // outright. frame-ancestors below is the modern replacement.
    frameguard: false,
    // Cross-origin isolation headers change how the storefront shell and the
    // builder frame can reach each other; not safe to flip blind.
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  }),
);

const frameAncestors = frameAncestorsDirective();
if (frameAncestors) {
  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", frameAncestors);
    next();
  });
}

// Die-cut sticker PDFs are base64 in JSON — allow larger payloads
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: false, limit: "25mb" }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      const safePath = path.replace(/[\x00-\x1f\x7f]/g, "");
      let logLine = `${req.method} ${safePath} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }
      log(logLine);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    // Message and stack only, never the error object. Inspecting a whole error
    // can print properties it merely happens to carry: Replicate's `ApiError`
    // hangs the originating `request` off the error, and whether Node's
    // inspector renders that request's `Authorization` header depends on the
    // undici version underneath. That is an API token in the server log.
    console.error("Server error:", message, err?.stack ?? "");
    res.status(status).json({ message });
  });

  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const port = Number(process.env.PORT) || 5000;
  server.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      log(`serving on port ${port}`);
      const dayMs = 24 * 60 * 60 * 1000;
      setInterval(() => {
        runCleanup().catch((err) =>
          console.warn("[cleanup] scheduled run failed:", err),
        );
      }, dayMs);
    },
  );
})();

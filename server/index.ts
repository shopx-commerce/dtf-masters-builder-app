import express, { type Request, Response, NextFunction } from "express";
import { loadClientEnv } from "./load-env";
import { registerRoutes, runCleanup } from "./routes";
import { setupVite, serveStatic, log } from "./vite";

loadClientEnv();

const app = express();

// Die-cut sticker PDFs are base64 in JSON — allow larger payloads
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: false, limit: "25mb" }));

// Allow iframe embedding for Shopify die-cut sticker / builder shells
app.use((_req, res, next) => {
  const allowedOrigins = process.env.ALLOWED_EMBED_ORIGINS || "*";
  res.setHeader("Content-Security-Policy", `frame-ancestors ${allowedOrigins}`);
  res.setHeader("X-Frame-Options", "ALLOWALL");
  next();
});

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
    console.error("Server error:", err);
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

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

/**
 * Serve pdf.js's CMap tables and standard-font data from our own origin.
 *
 * pdf.js needs the Adobe CMaps to decode CJK text and the standard-font data
 * to render the 14 PDF base fonts that documents are allowed to leave
 * un-embedded. Both were previously fetched from a public CDN at render time,
 * which makes correct output depend on an external host: a strict Shopify CSP
 * or a network blip turns Japanese text into empty boxes and silently
 * substitutes fonts, with nothing in the UI to explain why.
 *
 * The files already ship inside `pdfjs-dist`, so this copies them into the
 * Vite public directory instead. Vite serves that directory in dev and copies
 * it into the build output, so one copy step covers both. The marker file
 * records which package version was copied so a dependency bump refreshes the
 * assets instead of leaving stale CMaps behind.
 */
function pdfjsAssets(): Plugin {
  return {
    name: "anynest-pdfjs-assets",
    buildStart() {
      const pkgPath = path.resolve(import.meta.dirname, "node_modules/pdfjs-dist/package.json");
      if (!fs.existsSync(pkgPath)) return;
      const version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version as string;
      const source = path.dirname(pkgPath);
      const target = path.resolve(import.meta.dirname, "client/public/pdfjs");
      const marker = path.join(target, ".version");

      if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === version) return;

      fs.rmSync(target, { recursive: true, force: true });
      for (const dir of ["cmaps", "standard_fonts"]) {
        const from = path.join(source, dir);
        if (fs.existsSync(from)) {
          fs.cpSync(from, path.join(target, dir), { recursive: true });
        }
      }
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(marker, version);
    },
  };
}

/**
 * Serve onnxruntime-web's WebAssembly binary from our own origin.
 *
 * The `onnxruntime-web/webgpu` entry point is the "bundle" build, so its JS
 * glue is inlined by the bundler — but the `.wasm` payload that carries the
 * WebGPU execution provider is still fetched at runtime. Left to itself ORT
 * resolves that from a public CDN, which a strict Shopify CSP blocks and
 * which makes the upscaler's availability depend on a third-party host.
 *
 * Copying it into the Vite public directory covers dev and build in one step,
 * exactly as `pdfjsAssets` does. The runtime points `env.wasm.wasmPaths` at
 * `/ort/`. The marker file records the copied package version so a dependency
 * bump refreshes the binary instead of leaving a mismatched one behind.
 */
function ortAssets(): Plugin {
  return {
    name: "anynest-ort-assets",
    buildStart() {
      const pkgPath = path.resolve(import.meta.dirname, "node_modules/onnxruntime-web/package.json");
      if (!fs.existsSync(pkgPath)) return;
      const version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version as string;
      const source = path.join(path.dirname(pkgPath), "dist");
      const target = path.resolve(import.meta.dirname, "client/public/ort");
      const marker = path.join(target, ".version");

      if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === version) return;

      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(target, { recursive: true });
      // `onnxruntime-web/webgpu` is compiled with the wasm variant fixed at
      // *its* build time, and 1.27 pins it to the Asyncify build — the WebGPU
      // EP lives inside that binary and needs Asyncify to suspend across its
      // async GPU callbacks. Copying the jsep or plain variants instead gets a
      // "Failed to fetch dynamically imported module" at first use.
      for (const file of ["ort-wasm-simd-threaded.asyncify.wasm", "ort-wasm-simd-threaded.asyncify.mjs"]) {
        const from = path.join(source, file);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(target, file));
      }
      fs.writeFileSync(marker, version);
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    runtimeErrorOverlay(),
    pdfjsAssets(),
    ortAssets(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});

import path from "path";

/**
 * Module aliases shared by the app build (`vite.config.ts`) and the unit test
 * run (`vitest.config.ts`).
 *
 * The two configs are deliberately separate — the app config also copies
 * pdf.js/onnxruntime assets and loads dev-only plugins, none of which a test
 * run wants — but an import that resolves in the app and not in a test (or
 * vice-versa) is a pure waste of debugging time, so the one thing they must
 * agree on lives here.
 */
export const moduleAliases = {
  "@": path.resolve(import.meta.dirname, "client", "src"),
  "@shared": path.resolve(import.meta.dirname, "shared"),
  "@assets": path.resolve(import.meta.dirname, "attached_assets"),
};

import { defineConfig } from "vitest/config";
import { moduleAliases } from "./vite.aliases.ts";

/**
 * Unit tests run in their own config rather than reusing `vite.config.ts`.
 *
 * The app config exists to build a browser bundle: it copies pdf.js and
 * onnxruntime assets on `buildStart`, installs the React Fast Refresh plugin
 * and the Replit dev-only plugins, and roots Vite at `client/`. None of that
 * helps a test run, and the asset plugins would do real filesystem work on
 * every invocation. The one thing that must match the app is module
 * resolution, so both configs import the same alias map.
 */
export default defineConfig({
  resolve: { alias: moduleAliases },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["client/src/**/*.test.ts", "client/src/**/*.test.tsx", "shared/**/*.test.ts"],
    // The `scripts/verify-*.ts` checkers are standalone programs run with tsx,
    // not test files; picking them up here would execute them twice over.
    exclude: ["node_modules/**", "dist/**", "scripts/**"],
  },
});

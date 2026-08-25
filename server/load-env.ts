import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Load client/.env into process.env for keys that are not already set.
 * Vite already loads VITE_* for the client; the Express server needs the
 * same file for standalone R2 upload (R2_ACCOUNT_ID, etc.).
 */
export function loadClientEnv(): void {
  const envPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../client/.env",
  );
  if (!fs.existsSync(envPath)) return;

  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}

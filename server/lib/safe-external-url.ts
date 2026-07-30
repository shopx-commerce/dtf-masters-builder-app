function isPrivateOrBlockedHost(hostname: string): boolean {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "metadata.google.internal" || host === "metadata.google") return true;
  if (host === "[::1]" || host === "::1") return true;
  const ipMatch = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    const parts = ipMatch.slice(1).map(Number);
    if (parts.some((n) => !Number.isFinite(n) || n > 255)) return true;
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

function allowedExternalFetchHosts(): Set<string> {
  const hosts = new Set<string>();
  const fromEnv = String(process.env.R2_PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  if (fromEnv) {
    try {
      hosts.add(new URL(fromEnv).hostname.toLowerCase());
    } catch {}
  }
  return hosts;
}

function isAllowedR2PublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host.endsWith(".r2.dev")) return true;
  if (host.includes(".r2.cloudflarestorage.com")) return true;
  const allowed = allowedExternalFetchHosts();
  return allowed.size > 0 && allowed.has(host);
}

export function parseExternalUrl(raw: unknown): URL | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

export function assertSafeExternalUrl(urlString: string): URL {
  const parsed = parseExternalUrl(urlString);
  if (!parsed) throw new Error("Invalid URL");
  if (isPrivateOrBlockedHost(parsed.hostname)) throw new Error("URL host not allowed");
  if (!isAllowedR2PublicHost(parsed.hostname)) {
    throw new Error("URL must point to configured R2 public host");
  }
  return parsed;
}

export async function fetchSafeExternalUrl(urlString: string): Promise<Response> {
  const safeUrl = assertSafeExternalUrl(urlString);
  const res = await fetch(safeUrl.toString(), { redirect: "follow" });
  const finalUrl = res.url || safeUrl.toString();
  assertSafeExternalUrl(finalUrl);
  return res;
}

export function isAllowedDesignStateKey(key: string): boolean {
  const k = String(key || "").trim().replace(/^\/+/, "");
  if (!k || k.includes("..")) return false;
  return /^designs\/[^/]+\/[^/]+\/state\/design-state\.json$/i.test(k);
}

export function isAllowedDesignObjectKey(key: string): boolean {
  const k = String(key || "").trim().replace(/^\/+/, "");
  if (!k || k.includes("..")) return false;
  return /^designs\/[^/]+\/[^/]+\/.+/i.test(k);
}

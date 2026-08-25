import { lookup } from "node:dns/promises";
import net from "node:net";

/** Redirect hops allowed before a fetch is abandoned. */
const MAX_REDIRECT_HOPS = 5;
/** Wall-clock ceiling for a single upstream request, including redirects. */
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

/**
 * Routes map any error message containing "not allowed" to a 403, so every
 * rejection raised here keeps that phrase.
 */
function rejection(reason: string): Error {
  return new Error(`URL ${reason} — not allowed`);
}

function stripHostBrackets(hostname: string): string {
  const host = String(hostname || "").trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

/**
 * Every IPv4 range that must never be reachable from a user-supplied URL:
 * loopback, RFC1918, link-local (which covers the cloud metadata endpoints),
 * CGNAT, benchmarking, multicast and broadcast.
 */
function isBlockedIpv4(a: number, b: number, c: number, d: number): boolean {
  if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (a === 0) return true; // 0.0.0.0/8 — "this host"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // protocol assignments / TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function parseIpv4(value: string): [number, number, number, number] | null {
  const m = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number) as [number, number, number, number];
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups.
 *
 * A literal-string blocklist misses every alternate spelling of the same
 * address, so the only reliable check is to normalize first and compare
 * numerically.
 */
function parseIpv6(value: string): number[] | null {
  let s = stripHostBrackets(value);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!net.isIPv6(s)) return null;

  // Rewrite a trailing dotted-quad (::ffff:127.0.0.1) into two hex groups so
  // the expansion below only ever deals with hextets.
  const lastColon = s.lastIndexOf(":");
  if (lastColon >= 0 && s.slice(lastColon + 1).includes(".")) {
    const quad = parseIpv4(s.slice(lastColon + 1));
    if (!quad) return null;
    const [a, b, c, d] = quad;
    s = `${s.slice(0, lastColon + 1)}${(((a << 8) | b) >>> 0).toString(16)}:${(((c << 8) | d) >>> 0).toString(16)}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array.from({ length: fill }, () => "0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const parsed = groups.map((g) => parseInt(g || "0", 16));
  if (parsed.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff)) return null;
  return parsed;
}

function isBlockedIpv6(groups: number[]): boolean {
  const g = groups;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) carry an
  // IPv4 address in the low 32 bits; classify it as IPv4.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return isBlockedIpv4((g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff);
  }
  // NAT64 well-known prefix 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isBlockedIpv4((g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff);
  }
  // 6to4 (2002::/16) embeds the IPv4 address in the next 32 bits.
  if (g[0] === 0x2002) {
    return isBlockedIpv4((g[1] >> 8) & 0xff, g[1] & 0xff, (g[2] >> 8) & 0xff, g[2] & 0xff);
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

/** True when `address` is an IP literal in a range we refuse to connect to. */
export function isBlockedIpAddress(address: string): boolean {
  const value = stripHostBrackets(address);
  const v4 = parseIpv4(value);
  if (v4) return isBlockedIpv4(...v4);
  const v6 = parseIpv6(value);
  if (v6) return isBlockedIpv6(v6);
  return false;
}

function isPrivateOrBlockedHost(hostname: string): boolean {
  const host = stripHostBrackets(hostname);
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "metadata.google.internal" || host === "metadata.google") return true;
  if (net.isIP(host) && isBlockedIpAddress(host)) return true;
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

/**
 * `includes` here used to accept `x.r2.cloudflarestorage.com.attacker.tld`,
 * which let an attacker-controlled name satisfy the allowlist. Suffix
 * matching is the whole point of the check.
 */
function isAllowedR2PublicHost(hostname: string): boolean {
  const host = stripHostBrackets(hostname);
  if (host.endsWith(".r2.dev")) return true;
  if (host.endsWith(".r2.cloudflarestorage.com")) return true;
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
  if (isPrivateOrBlockedHost(parsed.hostname)) throw rejection("host is private or blocked");
  if (!isAllowedR2PublicHost(parsed.hostname)) {
    throw rejection("must point to configured R2 public host");
  }
  return parsed;
}

/**
 * Resolve `hostname` and refuse it if *any* answer is an address we would not
 * connect to directly.
 *
 * The allowlist alone cannot catch this: a name that legitimately ends in
 * `.r2.dev` is still just a name, and a hostname the attacker controls can
 * point anywhere, including loopback and the cloud metadata service. Checking
 * before connecting is what turns the allowlist into an actual network
 * boundary.
 */
export async function assertSafeResolvedHost(hostname: string): Promise<string[]> {
  const host = stripHostBrackets(hostname);
  if (!host) throw rejection("host is missing");
  if (net.isIP(host)) {
    if (isBlockedIpAddress(host)) throw rejection("host is a blocked address");
    return [host];
  }

  let answers: Array<{ address: string }>;
  try {
    answers = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw rejection("host could not be resolved");
  }
  if (!answers.length) throw rejection("host could not be resolved");
  for (const answer of answers) {
    if (isBlockedIpAddress(answer.address)) {
      throw rejection("host resolves to a private or blocked address");
    }
  }
  return answers.map((a) => a.address);
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {}
}

/**
 * Fetch an allowlisted external URL, validating every hop.
 *
 * `redirect: "manual"` is deliberate. Letting the runtime follow redirects and
 * re-checking only `res.url` validates the *last* hop after every intermediate
 * request has already been issued, so an allowlisted host could bounce the
 * request through anything it liked. Each hop is re-validated — allowlist and
 * resolved address — before it is followed.
 */
export async function fetchSafeExternalUrl(
  urlString: string,
  options: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let current = assertSafeExternalUrl(urlString);

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    await assertSafeResolvedHost(current.hostname);
    const remaining = Math.max(1, deadline - Date.now());
    const res = await fetch(current.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(remaining),
      headers: options.headers,
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      await discardBody(res);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw rejection("redirect target is invalid");
      }
      current = assertSafeExternalUrl(next.toString());
      continue;
    }
    return res;
  }
  throw rejection("redirected too many times");
}

export function isAllowedDesignStateKey(key: string): boolean {
  const k = String(key || "").trim().replace(/^\/+/, "");
  if (!k || k.includes("..")) return false;
  return /^designs\/[^/]+\/[^/]+\/state\/design-state\.json$/i.test(k);
}

/** Die-cut production/preview keys written by the standalone AnyNest upload path. */
export function isAllowedDieCutObjectKey(key: string): boolean {
  const k = String(key || "").trim().replace(/^\/+/, "");
  if (!k || k.includes("..")) return false;
  return /^designs\/die-cut\/[A-Z0-9]+\/(production\.pdf|preview\.png)$/i.test(k);
}

export function isAllowedDesignObjectKey(key: string): boolean {
  const k = String(key || "").trim().replace(/^\/+/, "");
  if (!k || k.includes("..")) return false;
  return (
    /^designs\/[^/]+\/[^/]+\/.+/i.test(k) ||
    isAllowedDieCutObjectKey(k)
  );
}

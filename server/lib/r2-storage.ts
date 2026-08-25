/** Cloudflare R2 helpers using AnyNest R2 API token credentials. */

function r2Config() {
  const accountId = String(process.env.R2_ACCOUNT_ID || "").trim();
  const apiToken = String(process.env.R2_API_TOKEN || "").trim();
  const bucketName = String(process.env.R2_BUCKET_NAME || "stickers").trim();
  const publicBase = String(process.env.R2_PUBLIC_BASE_URL || "")
    .trim()
    .replace(/\/$/, "");
  return { accountId, apiToken, bucketName, publicBase };
}

export function isR2Configured(): boolean {
  const { accountId, apiToken, bucketName } = r2Config();
  return !!(accountId && apiToken && bucketName);
}

function objectApiUrl(key: string): string {
  const { accountId, bucketName } = r2Config();
  const cleanKey = key.replace(/^\/+/, "");
  const encodedKey = cleanKey
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodedKey}`;
}

export function publicUrlForKey(key: string): string | null {
  const { publicBase } = r2Config();
  if (!publicBase) return null;
  return `${publicBase}/${key.replace(/^\/+/, "")}`;
}

export async function uploadR2Object(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  if (!isR2Configured()) {
    throw new Error(
      "R2 credentials are not configured (R2_ACCOUNT_ID / R2_API_TOKEN / R2_BUCKET_NAME)",
    );
  }
  const { apiToken } = r2Config();
  const res = await fetch(objectApiUrl(key), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": contentType,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`R2 upload failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

export async function downloadR2Object(key: string): Promise<Buffer> {
  if (!isR2Configured()) {
    throw new Error("R2 credentials are not configured");
  }
  const { apiToken } = r2Config();
  const res = await fetch(objectApiUrl(key), {
    method: "GET",
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!res.ok) {
    throw new Error(`R2 download failed (${res.status}) for key ${key}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function deleteR2Object(key: string): Promise<void> {
  if (!isR2Configured()) return;
  const { apiToken } = r2Config();
  const res = await fetch(objectApiUrl(key), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!res.ok && res.status !== 404) {
    console.warn(`R2 delete failed (${res.status}) for key ${key}`);
  }
}

export function dieCutProductionKey(referenceCode: string): string {
  return `designs/die-cut/${referenceCode}/production.pdf`;
}

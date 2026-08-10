import { isTrustedShellMessage } from "./shell-message";
import { isMobileDevice } from "./upload-queue";

type UploadJson = Record<string, unknown>;
export type R2UploadBody = Blob | ArrayBuffer | Uint8Array;

export type R2PrepareMeta = {
  sessionId: string;
  singlePut?: boolean;
  putUrl?: string;
  putHeaders?: Record<string, string>;
  parts?: Array<{ partNumber: number; url: string }>;
  partSize?: number;
  totalParts?: number;
  parallelism?: number;
};

export type R2UploadResult = {
  productionUrl: string;
  key: string | null;
  previewUrl: string | null;
  cartPreviewUrl: string | null;
};

export type R2UploadOptions = {
  objectKey?: string | null;
  onProgress?: (message: string) => void;
  contentType?: string;
  productionFormat?: "png" | "pdf";
  /** When true, prepare/complete JSON goes through parent proxy shell (same-origin), not cross-origin fetch. */
  useShellRelay?: boolean;
  /**
   * Cap for the relay prepare handshake. Set only by the direct→relay
   * fallback, where the open question is whether the parent implements the
   * relay at all — a parent without handlers should fail in seconds, not
   * hold the customer for the full normal-relay timeout.
   */
  relayPrepareTimeoutMs?: number;
};

const SHELL_RELAY_TIMEOUT_MS = 180_000;

/**
 * The builder→store prepare/complete fetch failed at the transport layer
 * (CORS/network), before any HTTP status. Only this failure is worth retrying
 * through the parent relay — an HTTP error or a failed R2 part PUT would fail
 * the same way (or worse, double-upload) on a second pass.
 */
class StoreApiUnreachableError extends Error {}

/**
 * The relay prepare handshake failed — timeout, shell-reported error, or a
 * malformed response. Its defining property: no file bytes have moved yet,
 * so falling back to another route is free. Failures after prepare (part
 * PUTs, complete) are deliberately NOT this type; by then the shell has
 * proven it speaks the protocol and bytes may already be in flight.
 */
class RelayPrepareError extends Error {}

function newRelayId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function canUseShellRelay(): boolean {
  try {
    return typeof window !== "undefined" && window.parent !== window;
  } catch {
    return false;
  }
}

function shouldUseShellRelay(options: R2UploadOptions = {}): boolean {
  if (options.useShellRelay === false) return false;
  if (options.useShellRelay === true) return true;
  return canUseShellRelay();
}

function waitForShellMessage<T>(
  requestId: string,
  responseType: string,
  timeoutMs: number,
  onMatch: (data: Record<string, unknown>) => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Upload shell relay timed out"));
    }, timeoutMs);
    const onMessage = (e: MessageEvent) => {
      const data = e.data as Record<string, unknown> | null;
      if (!data || data.type !== responseType || String(data.requestId || "") !== requestId) return;
      // The requestId already stops unrelated windows from resolving this wait;
      // the origin check stops one that can observe the outgoing relay request
      // from answering it with signed URLs of its own choosing.
      if (!isTrustedShellMessage(e, `relay:${responseType}`)) return;
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      const err = typeof data.error === "string" ? data.error.trim() : "";
      if (err) {
        reject(new Error(err));
        return;
      }
      try {
        resolve(onMatch(data));
      } catch (matchErr) {
        reject(matchErr instanceof Error ? matchErr : new Error("Shell relay response invalid"));
      }
    };
    window.addEventListener("message", onMessage);
  });
}

async function prepareViaShellRelay(
  filename: string,
  totalBytes: number,
  options: Pick<R2UploadOptions, "objectKey" | "contentType" | "productionFormat" | "relayPrepareTimeoutMs"> = {},
): Promise<R2PrepareMeta> {
  const requestId = newRelayId("prep");
  const timeoutMs = options.relayPrepareTimeoutMs ?? SHELL_RELAY_TIMEOUT_MS;
  const wait = waitForShellMessage(requestId, "dtf-builder-r2-prepared", timeoutMs, (data) => {
    const meta = data.meta as R2PrepareMeta | undefined;
    if (!meta?.sessionId) throw new Error("Upload prepare failed");
    return meta;
  });
  window.parent.postMessage(
    {
      type: "dtf-builder-r2-prepare",
      requestId,
      filename,
      totalBytes,
      ...(options.contentType ? { contentType: options.contentType } : {}),
      ...(options.productionFormat ? { productionFormat: options.productionFormat } : {}),
      ...(options.objectKey ? { objectKey: options.objectKey } : {}),
    },
    // Relay prepare/complete messages carry no secrets — use "*" so a
    // mis-resolved target origin never silently drops the message and
    // causes a 3-minute relay timeout.
    "*",
  );
  try {
    return await wait;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/timed out/i.test(detail)) {
      throw new RelayPrepareError(
        "Upload prepare timed out — deploy the latest proxy app (shell R2 relay) or refresh the builder page.",
      );
    }
    // Typed so callers can tell "prepare never worked" (safe to reroute —
    // zero bytes sent) apart from failures later in the relay flow.
    throw new RelayPrepareError(detail);
  }
}

async function completeViaShellRelay(
  sessionId: string,
  singlePut: boolean,
  totalParts: number,
  uploadedParts?: Array<{ partNumber: number; etag: string }>,
): Promise<UploadJson> {
  const requestId = newRelayId("done");
  const wait = waitForShellMessage(requestId, "dtf-builder-r2-completed", SHELL_RELAY_TIMEOUT_MS, (data) => {
    const result = data.result as UploadJson | undefined;
    if (!result) throw new Error("Upload finalize failed");
    return result;
  });
  window.parent.postMessage(
    {
      type: "dtf-builder-r2-complete",
      requestId,
      sessionId,
      singlePut,
      totalParts,
      ...(uploadedParts?.length ? { parts: uploadedParts } : {}),
    },
    // Same reasoning as prepareViaShellRelay — no secrets, use "*".
    "*",
  );
  return wait;
}

async function builderFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Chrome reports a blocked/unreachable fetch as "Failed to fetch", Safari
    // as "Load failed", Firefox as "NetworkError when attempting to fetch
    // resource." — same network/CORS failure, three spellings.
    const isNetworkError =
      detail === "Failed to fetch" || detail === "Load failed" || /^NetworkError\b/.test(detail);
    if (isNetworkError && canUseShellRelay()) {
      throw new StoreApiUnreachableError(
        "Could not reach the store upload API from the builder (cross-origin). Use storefront embed shell relay.",
      );
    }
    throw new Error(isNetworkError ? `Could not reach upload API: ${url.slice(0, 120)}` : detail);
  }
}

function readUploadJson(r: Response, url: string): Promise<UploadJson> {
  return r.text().then((t) => {
    if (!r.ok) {
      if (t && t.charAt(0) === "{") {
        try {
          const j = JSON.parse(t) as { error?: string };
          if (j?.error) throw new Error(`${r.status} ${String(j.error).slice(0, 240)}`);
        } catch (parseErr) {
          if (parseErr instanceof Error && parseErr.message.match(/^\d{3} /)) throw parseErr;
        }
      }
      if (t && t.charAt(0) === "<") {
        throw new Error(
          `${r.status} (HTML or proxy error, not JSON) url=${url.slice(0, 120)}`,
        );
      }
      throw new Error(`${r.status} ${t ? t.slice(0, 200) : "(empty)"} url=${url.slice(0, 120)}`);
    }
    if (!t.trim()) throw new Error("Empty upload response");
    return JSON.parse(t) as UploadJson;
  });
}

function bodySize(body: R2UploadBody): number {
  if (body == null) throw new Error("Empty design image");
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  return body.byteLength;
}

function isLegacyDesignUploadUrl(uploadUrl: string): boolean {
  try {
    return new URL(uploadUrl, window.location.href).pathname.replace(/\/+$/, "").endsWith("/api/upload-design");
  } catch {
    return uploadUrl.replace(/[?#].*$/, "").replace(/\/+$/, "").endsWith("/api/upload-design");
  }
}

async function uploadViaLegacyDesignEndpoint(
  body: R2UploadBody,
  filename: string,
  uploadUrl: string,
  contentType: string,
  productionFormat: "png" | "pdf",
  onProgress?: (message: string) => void,
): Promise<R2UploadResult> {
  onProgress?.("Uploading print file to store...");
  const file = body instanceof Blob
    ? new File([body], filename, { type: contentType })
    : new File([body instanceof Uint8Array ? body : new Uint8Array(body)], filename, { type: contentType });
  const form = new FormData();
  form.append("file", file);
  form.append("filename", filename);
  form.append("contentType", contentType);
  form.append("productionFormat", productionFormat);
  const response = await builderFetch(uploadUrl, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: form,
  });
  const result = await readUploadJson(response, uploadUrl);
  const productionUrl = String(result.productionUrl || result.url || result.location || "");
  if (!productionUrl) throw new Error("Store upload returned no production URL");
  const returnedPath = (() => {
    try {
      return new URL(productionUrl, window.location.href).pathname.toLowerCase();
    } catch {
      return productionUrl.toLowerCase();
    }
  })();
  if (!returnedPath.endsWith(`.${productionFormat}`)) {
    throw new Error(`Store upload returned a non-${productionFormat.toUpperCase()} production URL`);
  }
  return {
    productionUrl,
    key: result.key ? String(result.key) : null,
    previewUrl: result.previewUrl ? String(result.previewUrl) : productionUrl,
    cartPreviewUrl: result.cartPreviewUrl ? String(result.cartPreviewUrl) : productionUrl,
  };
}

/** Slice upload body without copying the full PNG (Blob.slice is cheap). */
function bodyPart(body: R2UploadBody, start: number, end: number): Blob | Uint8Array {
  if (body instanceof Blob) return body.slice(start, end);
  const view = body instanceof Uint8Array ? body : new Uint8Array(body);
  return view.subarray(start, end);
}

function putBody(body: R2UploadBody): Blob | Uint8Array {
  if (body instanceof Blob) return body;
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(body);
}

async function r2DirectComplete(
  uploadUrl: string,
  sessionId: string,
  singlePut: boolean,
  totalParts: number,
  uploadedParts?: Array<{ partNumber: number; etag: string }>,
  options: R2UploadOptions = {},
): Promise<UploadJson> {
  if (shouldUseShellRelay(options)) {
    return completeViaShellRelay(sessionId, singlePut, totalParts, uploadedParts);
  }
  const res = await builderFetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      step: "r2-direct-complete",
      sessionId,
      singlePut,
      totalParts,
      ...(uploadedParts?.length ? { parts: uploadedParts } : {}),
    }),
  });
  return readUploadJson(res, uploadUrl);
}

export async function prepareR2DirectUpload(
  uploadUrl: string,
  filename: string,
  totalBytes: number,
  options: Pick<R2UploadOptions, "objectKey" | "useShellRelay" | "contentType" | "productionFormat" | "relayPrepareTimeoutMs"> = {},
): Promise<R2PrepareMeta> {
  if (shouldUseShellRelay(options)) {
    return prepareViaShellRelay(filename, totalBytes, options);
  }
  const prepareRes = await builderFetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      step: "r2-direct-prepare",
      filename,
      totalBytes,
      ...(options.contentType ? { contentType: options.contentType } : {}),
      ...(options.productionFormat ? { productionFormat: options.productionFormat } : {}),
      ...(options.objectKey ? { objectKey: options.objectKey } : {}),
    }),
  });
  const meta = await readUploadJson(prepareRes, uploadUrl);
  if (!meta.sessionId) throw new Error("Upload prepare failed");
  return meta as R2PrepareMeta;
}

export async function uploadPreparedPartsToR2(
  body: R2UploadBody,
  meta: R2PrepareMeta,
  onProgress?: (message: string) => void,
): Promise<Array<{ partNumber: number; etag: string }>> {
  const total = bodySize(body);
  if (!total) throw new Error("Empty design image");

  if (meta.singlePut && meta.putUrl) {
    onProgress?.("Uploading print file to cloud (1 request)...");
    const putHeaders = meta.putHeaders || {
      "Content-Type": body instanceof Blob && body.type ? body.type : "application/octet-stream",
    };
    const putRes = await fetch(String(meta.putUrl), {
      method: "PUT",
      body: putBody(body),
      headers: putHeaders,
    });
    if (!putRes.ok) throw new Error(`Cloud upload failed: ${putRes.status}`);
    return [];
  }

  const parts = Array.isArray(meta.parts) ? meta.parts : [];
  if (!parts.length) throw new Error("Upload prepare incomplete");

  const partSize = Number(meta.partSize) || 64 * 1024 * 1024;
  const totalParts = Number(meta.totalParts) || parts.length;
  // Parts are 64 MB by default, and each one in flight is that much memory held by the
  // network stack. Sixteen at once is fine on a desktop and is roughly a gigabyte on a phone
  // that has already just built the sheet — over the budget iOS allows a tab, where the
  // failure surfaces as an upload error rather than anything mentioning memory.
  const maxInFlight = isMobileDevice() ? 2 : 16;
  const parallelism = Math.max(1, Math.min(Number(meta.parallelism) || maxInFlight, maxInFlight, totalParts));
  const sorted = parts.slice().sort((a, b) => Number(a.partNumber) - Number(b.partNumber));
  let nextIndex = 0;
  const uploadedParts: Array<{ partNumber: number; etag: string }> = [];

  async function uploadPart(part: { partNumber: number; url: string }) {
    const pn = Number(part.partNumber);
    const start = (pn - 1) * partSize;
    const end = Math.min(start + partSize, total);
    onProgress?.(`Uploading part ${pn} of ${totalParts}...`);
    let res: Response;
    try {
      res = await fetch(String(part.url), { method: "PUT", body: bodyPart(body, start, end) });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        detail === "Failed to fetch"
          ? `Cloud upload part ${pn} failed (network/CORS). Check R2 CORS and try again.`
          : `Cloud upload part ${pn} failed: ${detail}`,
      );
    }
    if (!res.ok) throw new Error(`Cloud upload part ${pn} failed: ${res.status}`);
    const etag = res.headers.get("etag") || res.headers.get("ETag");
    if (etag) uploadedParts.push({ partNumber: pn, etag });
  }

  async function worker() {
    while (nextIndex < sorted.length) {
      const part = sorted[nextIndex++];
      await uploadPart(part);
    }
  }

  await Promise.all(Array.from({ length: parallelism }, () => worker()));
  return uploadedParts;
}

export async function uploadProductionToR2(
  body: R2UploadBody,
  filename: string,
  uploadUrl: string,
  onProgress?: (message: string) => void,
  options: R2UploadOptions = {},
): Promise<R2UploadResult> {
  const total = bodySize(body);
  if (!total) throw new Error("Empty design image");

  const contentType = body instanceof Blob && body.type ? body.type : undefined;
  const expectedFormat = options.productionFormat || (contentType === "application/pdf" ? "pdf" : "png");
  const effectiveContentType = contentType || (expectedFormat === "pdf" ? "application/pdf" : "image/png");
  if (isLegacyDesignUploadUrl(uploadUrl)) {
    // A legacy /api/upload-design URL form-POSTs the entire production file
    // through the storefront proxy — the most fragile route for multi-MB
    // sheets: proxy body limits and worker timeouts surface as 500 HTML
    // pages, and per-customer extensions/privacy modes block the
    // cross-origin fetch outright. The live shell that hands this URL out
    // also implements the R2 relay, so with a parent present the relay goes
    // first and the heavy bytes PUT straight to R2. The legacy POST remains
    // the fallback, gated on RelayPrepareError (prepare never worked — no
    // bytes sent yet, e.g. a handler-less shell hitting the 20s cap); after
    // a successful prepare the shell speaks the protocol, and re-sending a
    // half-uploaded sheet through the proxy would double the bandwidth
    // without fixing anything.
    if (canUseShellRelay()) {
      try {
        return await uploadProductionToR2(body, filename, "", onProgress, {
          ...options,
          useShellRelay: true,
          relayPrepareTimeoutMs: 20_000,
        });
      } catch (relayErr) {
        if (!(relayErr instanceof RelayPrepareError)) throw relayErr;
        const relayDetail = relayErr.message;
        onProgress?.("Store relay unavailable — sending the file to the store directly...");
        try {
          return await uploadViaLegacyDesignEndpoint(
            body,
            filename,
            uploadUrl,
            effectiveContentType,
            expectedFormat,
            onProgress,
          );
        } catch (legacyErr) {
          const legacyDetail = legacyErr instanceof Error ? legacyErr.message : String(legacyErr);
          throw new Error(`relay: ${relayDetail}; store upload: ${legacyDetail}`);
        }
      }
    }
    return uploadViaLegacyDesignEndpoint(
      body,
      filename,
      uploadUrl,
      effectiveContentType,
      expectedFormat,
      onProgress,
    );
  }
  try {
    onProgress?.("Preparing cloud upload...");
    const meta = await prepareR2DirectUpload(uploadUrl, filename, total, {
      ...options,
      contentType: effectiveContentType,
      productionFormat: expectedFormat,
    });

    const uploadedParts = await uploadPreparedPartsToR2(body, meta, onProgress);

    onProgress?.("Finalizing upload...");
    const done = await r2DirectComplete(
      uploadUrl,
      String(meta.sessionId),
      Boolean(meta.singlePut),
      Number(meta.totalParts) || 1,
      uploadedParts.length ? uploadedParts : undefined,
      options,
    );
    const prod = String(done.productionUrl || done.url || "");
    if (!prod) throw new Error("No production URL");
    const returnedPath = (() => {
      try {
        return new URL(prod, window.location.href).pathname.toLowerCase();
      } catch {
        return prod.toLowerCase();
      }
    })();
    const expectedExtension = expectedFormat === "pdf" ? ".pdf" : ".png";
    if (!returnedPath.endsWith(expectedExtension)) {
      throw new Error(`Upload returned a non-${expectedFormat.toUpperCase()} production URL`);
    }
    return {
      productionUrl: prod,
      key: done.key ? String(done.key) : null,
      previewUrl: prod,
      cartPreviewUrl: done.cartPreviewUrl ? String(done.cartPreviewUrl) : prod,
    };
  } catch (err) {
    // A shell-provided direct upload URL is unreachable for some customers
    // from inside the builder iframe — CORS-blocking extensions, Safari
    // privacy modes, or proxies that expect storefront cookies the
    // cross-origin fetch never sends. The parent page can still do
    // prepare/complete on our behalf, so that one failure — and only that
    // one — gets a retry through the relay instead of failing the order.
    // HTTP errors and failed R2 part PUTs rethrow untouched: the relay
    // changes neither, and retrying mid-multipart would re-upload the sheet
    // while first-attempt PUTs may still be in flight.
    if (!(err instanceof StoreApiUnreachableError)) throw err;
    // The retry sets useShellRelay, so a failure inside it rethrows here
    // without recursing again.
    if (shouldUseShellRelay(options) || !canUseShellRelay()) throw err;
    const directDetail = err.message;
    onProgress?.("Store endpoint unreachable — retrying through the store page...");
    try {
      // Short prepare cap: a parent that never implemented the relay should
      // surface the combined error in ~20s, not hold checkout for the full
      // 180s handshake timeout. Once prepare answers, the parent clearly
      // speaks the protocol, so complete keeps the normal generous timeout.
      return await uploadProductionToR2(body, filename, "", onProgress, {
        ...options,
        useShellRelay: true,
        relayPrepareTimeoutMs: 20_000,
      });
    } catch (relayErr) {
      const relayDetail = relayErr instanceof Error ? relayErr.message : String(relayErr);
      throw new Error(`direct: ${directDetail}; relay retry: ${relayDetail}`);
    }
  }
}

type WorkerR2UploadResult = {
  type: "r2-upload-done";
  requestId: string;
  uploadedParts: Array<{ partNumber: number; etag: string }>;
};

/** Upload from export worker thread so the main thread is not blocked on large PUTs. */
export function uploadProductionToR2FromWorker(
  worker: Worker,
  buffer: ArrayBuffer,
  meta: R2PrepareMeta,
  requestId: string,
  onProgress?: (message: string) => void,
): Promise<Array<{ partNumber: number; etag: string }>> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("Cloud upload timed out — sheet may be too large.")),
      600_000,
    );
    const onMessage = (e: MessageEvent) => {
      if (e.data?.requestId !== requestId) return;
      if (e.data?.type === "r2-upload-progress" && typeof e.data.message === "string") {
        onProgress?.(e.data.message);
        return;
      }
      if (e.data?.type === "error") {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        window.clearTimeout(timer);
        reject(new Error(String(e.data.error || "Worker upload failed")));
        return;
      }
      if (e.data?.type !== "r2-upload-done") return;
      worker.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      const result = e.data as WorkerR2UploadResult;
      resolve(result.uploadedParts || []);
    };
    const onError = (err: ErrorEvent) => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      window.clearTimeout(timer);
      reject(err.error || new Error("Worker upload failed"));
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage(
      { type: "r2-upload", requestId, meta },
      [buffer],
    );
  });
}

export async function uploadProductionToR2WithWorker(
  worker: Worker,
  buffer: ArrayBuffer,
  filename: string,
  uploadUrl: string,
  onProgress?: (message: string) => void,
  options: R2UploadOptions = {},
): Promise<R2UploadResult> {
  void worker;
  if (!buffer || !(buffer instanceof ArrayBuffer) || !buffer.byteLength) {
    throw new Error("Empty design image");
  }
  // Main-thread Blob upload (blob.slice per part) — do not transfer buffer back to worker.
  return uploadProductionToR2(new Blob([buffer], { type: "image/png" }), filename, uploadUrl, onProgress, options);
}

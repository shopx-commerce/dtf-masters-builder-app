import { createHash, randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import sharp from "sharp";

const LOCAL_UPSCALE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_PENDING_LOCAL_UPSCALE_JOBS = 2;
const MAX_CACHED_UPSCALE_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_UPSCALE_ENTRIES = 8;

type PendingJob = {
  key: string;
  input: Buffer;
  scaleFactor: number;
  resolve: (value: Buffer) => void;
  reject: (error: Error) => void;
};

const pendingJobs: PendingJob[] = [];
const inFlightJobs = new Map<string, Promise<Buffer>>();
const resultCache = new Map<string, Buffer>();
let cachedBytes = 0;
let activeJob = false;

function getConfiguredBinary(): string | null {
  const configured = String(process.env.REAL_ESRGAN_BIN ?? "").trim();
  return configured || null;
}

function getConfiguredModelDirectory(binary: string): string {
  const configured = String(process.env.REAL_ESRGAN_MODEL_DIR ?? "").trim();
  return configured || path.join(path.dirname(binary), "models");
}

export function isLocalUpscaleConfigured(): boolean {
  const binary = getConfiguredBinary();
  if (!binary || !existsSync(binary)) return false;
  const modelDirectory = getConfiguredModelDirectory(binary);
  return (
    existsSync(path.join(modelDirectory, "realesrgan-x4plus.param")) &&
    existsSync(path.join(modelDirectory, "realesrgan-x4plus.bin"))
  );
}

export function getUpscaleProvider(): "local" | "replicate" {
  const requested = String(process.env.UPSCALE_PROVIDER ?? "auto").trim().toLowerCase();
  if (requested === "replicate") return "replicate";
  if (requested === "local") return "local";
  return isLocalUpscaleConfigured() ? "local" : "replicate";
}

export function createUpscaleCacheKey(
  input: Buffer,
  scaleFactor: number,
  provider: "local" | "replicate",
): string {
  const binary = provider === "local" ? getConfiguredBinary() ?? "unconfigured" : "replicate";
  const digest = createHash("sha256").update(input).digest("hex");
  return `${provider}:${binary}:${scaleFactor}:${digest}`;
}

export function getCachedUpscaleResult(key: string): Buffer | null {
  const cached = resultCache.get(key);
  if (!cached) return null;
  // Refresh insertion order for LRU eviction.
  resultCache.delete(key);
  resultCache.set(key, cached);
  return Buffer.from(cached);
}

export function setCachedUpscaleResult(key: string, result: Buffer): void {
  const previous = resultCache.get(key);
  if (previous) cachedBytes -= previous.length;
  const stored = Buffer.from(result);
  resultCache.set(key, stored);
  cachedBytes += stored.length;

  while (
    resultCache.size > MAX_CACHED_UPSCALE_ENTRIES ||
    cachedBytes > MAX_CACHED_UPSCALE_BYTES
  ) {
    const oldest = resultCache.entries().next().value as [string, Buffer] | undefined;
    if (!oldest) break;
    resultCache.delete(oldest[0]);
    cachedBytes -= oldest[1].length;
  }
}

function executeBinary(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message).trim().slice(-1200);
          reject(new Error(`Local Real-ESRGAN failed: ${detail}`));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function runLocalUpscale(input: Buffer, scaleFactor: number): Promise<Buffer> {
  const binary = getConfiguredBinary();
  if (!binary) {
    throw new Error("Local Real-ESRGAN is not configured. Set REAL_ESRGAN_BIN.");
  }

  const sourceMetadata = await sharp(input).metadata();
  const sourceWidth = sourceMetadata.width ?? 0;
  const sourceHeight = sourceMetadata.height ?? 0;
  if (!sourceWidth || !sourceHeight) {
    throw new Error("Could not read PNG dimensions before local upscale.");
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "dtf-upscale-"));
  const inputPath = path.join(workDir, `${randomUUID()}-input.png`);
  const rawOutputPath = path.join(workDir, `${randomUUID()}-output.png`);
  try {
    await fs.writeFile(inputPath, input);

    // The official ncnn release uses the x4plus model and accepts native
    // output scales of 2, 3, or 4. Using the CLI's native scale preserves
    // quality and avoids an extra resize pass for x3.
    const model = "realesrgan-x4plus";
    const nativeScale = scaleFactor;
    const modelDirectory = getConfiguredModelDirectory(binary);
    try {
      await fs.access(path.join(modelDirectory, `${model}.param`));
      await fs.access(path.join(modelDirectory, `${model}.bin`));
    } catch {
      throw new Error(
        `Real-ESRGAN model files are missing from ${modelDirectory}. Run scripts/setup-local-upscaler.sh or set REAL_ESRGAN_MODEL_DIR.`,
      );
    }
    const tileSize = String(process.env.REAL_ESRGAN_TILE ?? "").trim();
    const gpuId = String(process.env.REAL_ESRGAN_GPU ?? "").trim();
    const threads = String(process.env.REAL_ESRGAN_THREADS ?? "").trim();
    const optionalArgs = [
      ...(tileSize ? ["-t", tileSize] : []),
      ...(gpuId ? ["-g", gpuId] : []),
      ...(threads ? ["-j", threads] : []),
    ];
    await executeBinary(
      binary,
      [
        "-i", inputPath,
        "-o", rawOutputPath,
        "-m", modelDirectory,
        "-n", model,
        "-s", String(nativeScale),
        "-f", "png",
        ...optionalArgs,
      ],
      LOCAL_UPSCALE_TIMEOUT_MS,
    );

    let output = await fs.readFile(rawOutputPath);
    return output;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function drainQueue(): void {
  if (activeJob) return;
  const job = pendingJobs.shift();
  if (!job) return;
  activeJob = true;
  void runLocalUpscale(job.input, job.scaleFactor)
    .then(job.resolve, job.reject)
    .finally(() => {
      activeJob = false;
      drainQueue();
    });
}

export function runLocalUpscaleQueued(input: Buffer, scaleFactor: number): Promise<Buffer> {
  const key = createHash("sha256")
    .update(input)
    .update(`:${scaleFactor}`)
    .digest("hex");

  const existing = inFlightJobs.get(key);
  if (existing) return existing;
  if (pendingJobs.length >= MAX_PENDING_LOCAL_UPSCALE_JOBS) {
    return Promise.reject(new Error("Local upscale queue is full. Please try again shortly."));
  }

  const promise = new Promise<Buffer>((resolve, reject) => {
    pendingJobs.push({
      key,
      input,
      scaleFactor,
      resolve: (result) => {
        resolve(result);
      },
      reject,
    });
    drainQueue();
  });
  inFlightJobs.set(key, promise);
  void promise.then(
    () => inFlightJobs.delete(key),
    () => inFlightJobs.delete(key),
  );
  return promise;
}
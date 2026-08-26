import { beforeEach, describe, expect, it, vi } from "vitest";
import { runColorChangeAnalyze, runColorChangeRecolor } from "./color-change-run";
import { COLOR_CHANGE_MAX_SOURCE_BYTES } from "./color-change-limits";

/**
 * Which engine answers, and on what terms.
 *
 * The streaming reader is mocked here on purpose: its own tests prove it
 * rewrites pixels correctly, while what matters at this layer is the routing —
 * that a large file reaches the streaming path at all (the bug this replaced:
 * ordinary print-resolution artwork refused as "too large"), and that the
 * whole-image decoder still catches what streaming cannot walk, ceilings and
 * all.
 */
const stream = vi.hoisted(() => ({
  canStreamRecolor: vi.fn(() => true),
  streamAnalyzePng: vi.fn(),
  streamRecolorPng: vi.fn(),
}));

vi.mock("./png-recolor-stream", () => stream);

const core = vi.hoisted(() => ({
  analyzeColorChangePng: vi.fn(() => ({ eligible: false as const, reason: "invalid-png" as const })),
  recolorPng: vi.fn(() => ({ ok: false as const, reason: "invalid-png" as const })),
}));

vi.mock("./color-change-core", () => core);

/** A blob far past the old ceiling, without allocating one. */
function hugeBlob(size: number): Blob {
  return { size, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Blob;
}

const TARGET = { r: 1, g: 2, b: 3 };

beforeEach(() => {
  stream.canStreamRecolor.mockReturnValue(true);
  stream.streamAnalyzePng.mockReset();
  stream.streamRecolorPng.mockReset();
  core.analyzeColorChangePng.mockClear();
  core.recolorPng.mockClear();
});

describe("color change routing", () => {
  it("streams artwork the old decoder refused as too large", async () => {
    const blob = hugeBlob(COLOR_CHANGE_MAX_SOURCE_BYTES * 3);
    stream.streamAnalyzePng.mockResolvedValue({ eligible: true, sourceColor: TARGET, width: 9000, height: 9000 });
    stream.streamRecolorPng.mockResolvedValue({
      ok: true, blob: new Blob(["png"]), sourceColor: TARGET, width: 9000, height: 9000,
    });

    await expect(runColorChangeAnalyze(blob)).resolves.toMatchObject({ eligible: true });
    await expect(runColorChangeRecolor(blob, TARGET)).resolves.toMatchObject({ ok: true });
    // Nothing was decoded whole, so no ceiling applied.
    expect(core.analyzeColorChangePng).not.toHaveBeenCalled();
    expect(core.recolorPng).not.toHaveBeenCalled();
  });

  it("falls back to the whole-image decoder for files it cannot walk", async () => {
    // Null is the streaming reader saying "interlaced, not mine".
    stream.streamAnalyzePng.mockResolvedValue(null);
    stream.streamRecolorPng.mockResolvedValue(null);
    core.analyzeColorChangePng.mockReturnValue({ eligible: false, reason: "no-visible-pixels" } as never);
    core.recolorPng.mockReturnValue({ ok: false, reason: "no-visible-pixels" } as never);
    const blob = new Blob([new Uint8Array(4)]);

    await expect(runColorChangeAnalyze(blob)).resolves.toMatchObject({ reason: "no-visible-pixels" });
    await expect(runColorChangeRecolor(blob, TARGET)).resolves.toMatchObject({ reason: "no-visible-pixels" });
    expect(core.analyzeColorChangePng).toHaveBeenCalledTimes(1);
    expect(core.recolorPng).toHaveBeenCalledTimes(1);
  });

  it("keeps the memory ceiling on the fallback decoder", async () => {
    stream.canStreamRecolor.mockReturnValue(false);
    const blob = hugeBlob(COLOR_CHANGE_MAX_SOURCE_BYTES + 1);

    await expect(runColorChangeAnalyze(blob)).resolves.toEqual({ eligible: false, reason: "image-too-large" });
    await expect(runColorChangeRecolor(blob, TARGET)).resolves.toEqual({ ok: false, reason: "image-too-large" });
    expect(core.analyzeColorChangePng).not.toHaveBeenCalled();
    expect(stream.streamAnalyzePng).not.toHaveBeenCalled();
  });

  it("hands the fallback's bytes back as a blob", async () => {
    stream.streamRecolorPng.mockResolvedValue(null);
    core.recolorPng.mockReturnValue({
      ok: true, png: new Uint8Array([1, 2, 3]), sourceColor: TARGET, width: 2, height: 2,
    } as never);

    const result = await runColorChangeRecolor(new Blob([new Uint8Array(4)]), TARGET);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both engines must hand the caller the same shape, or the commit path has
    // to know which one ran.
    expect(result.blob).toBeInstanceOf(Blob);
    expect(Array.from(new Uint8Array(await result.blob.arrayBuffer()))).toEqual([1, 2, 3]);
  });
});

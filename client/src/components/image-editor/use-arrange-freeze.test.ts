import { createElement, StrictMode, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useArrangeFreeze } from "./use-arrange-freeze";

/**
 * The hook decides which frame the customer is looking at while the sheet is being packed,
 * and it gets that decision right by reading a ref during render. That is deliberate — an
 * effect would let one intermediate frame through first — but it means the ordering rules it
 * relies on are worth pinning down rather than trusting.
 *
 * The case that matters most is the second one below. Adding copies raises the busy flag and
 * puts the new copies into state in the same commit, so a naive "remember what I was handed
 * when busy went up" would remember the copies already stacked in the middle of the sheet:
 * the single ugliest frame of the operation, held on screen for its whole duration.
 */
interface Frame {
  designs: string[];
  height: number;
}

const setup = (initialProps: { live: Frame; busy: boolean; maxHoldMs?: number }, strict = false) =>
  renderHook(
    ({ live, busy, maxHoldMs }: { live: Frame; busy: boolean; maxHoldMs?: number }) =>
      useArrangeFreeze(live, busy, maxHoldMs),
    {
      initialProps,
      ...(strict
        ? { wrapper: ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children) }
        : {}),
    },
  );

describe("useArrangeFreeze", () => {
  it("passes the live frame straight through while the sheet is idle", () => {
    const first = { designs: ["a"], height: 24 };
    const { result, rerender } = setup({ live: first, busy: false });
    expect(result.current).toBe(first);

    const second = { designs: ["a", "b"], height: 24 };
    rerender({ live: second, busy: false });
    expect(result.current).toBe(second);
  });

  it("holds the frame from before the operation when copies arrive in the same commit", () => {
    const before = { designs: ["a"], height: 24 };
    const { result, rerender } = setup({ live: before, busy: false });

    // One commit: the copies land in state and the sheet reports itself busy together.
    rerender({ live: { designs: ["a", "b", "c"], height: 24 }, busy: true });
    expect(result.current).toBe(before);
  });

  it("keeps holding through every intermediate commit of a multi-rung arrange", () => {
    const before = { designs: ["a"], height: 24 };
    const { result, rerender } = setup({ live: before, busy: false });

    rerender({ live: { designs: ["a", "b"], height: 24 }, busy: true });
    // The sheet grows a rung, is repacked, grows again — each one its own commit.
    rerender({ live: { designs: ["a", "b"], height: 60 }, busy: true });
    rerender({ live: { designs: ["a", "b"], height: 120 }, busy: true });
    expect(result.current).toBe(before);
  });

  it("hands over the settled frame as soon as the sheet is no longer busy", () => {
    const before = { designs: ["a"], height: 24 };
    const settled = { designs: ["a", "b"], height: 120 };
    const { result, rerender } = setup({ live: before, busy: false });

    rerender({ live: { designs: ["a", "b"], height: 24 }, busy: true });
    expect(result.current).toBe(before);

    rerender({ live: settled, busy: false });
    expect(result.current).toBe(settled);
  });

  it("starts the next operation from the frame the last one settled on", () => {
    const first = { designs: ["a"], height: 24 };
    const settled = { designs: ["a", "b"], height: 60 };
    const { result, rerender } = setup({ live: first, busy: false });

    rerender({ live: { designs: ["a", "b"], height: 24 }, busy: true });
    rerender({ live: settled, busy: false });

    rerender({ live: { designs: ["a", "b", "c"], height: 60 }, busy: true });
    expect(result.current).toBe(settled);
  });

  it("returns the identical object every render while held", () => {
    // What actually stops the preview repainting: unchanged props, not a cleverer preview.
    const before = { designs: ["a"], height: 24 };
    const { result, rerender } = setup({ live: before, busy: false });

    rerender({ live: { designs: ["a", "b"], height: 24 }, busy: true });
    const held = result.current;
    rerender({ live: { designs: ["a", "b"], height: 60 }, busy: true });
    expect(result.current).toBe(held);
  });

  it("survives the double render React does in development", () => {
    const before = { designs: ["a"], height: 24 };
    const { result, rerender } = setup({ live: before, busy: false }, true);

    rerender({ live: { designs: ["a", "b"], height: 24 }, busy: true });
    expect(result.current).toBe(before);

    const settled = { designs: ["a", "b"], height: 60 };
    rerender({ live: settled, busy: false });
    expect(result.current).toBe(settled);
  });

  describe("failsafe", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("lets go of the frame if the sheet never reports itself finished", () => {
      // A held picture that stopped being true minutes ago is worse than untidy nesting.
      const before = { designs: ["a"], height: 24 };
      const stuck = { designs: ["a", "b"], height: 24 };
      const { result, rerender } = setup({ live: before, busy: false, maxHoldMs: 1000 });

      rerender({ live: stuck, busy: true, maxHoldMs: 1000 });
      expect(result.current).toBe(before);

      act(() => { vi.advanceTimersByTime(1001); });
      expect(result.current).toBe(stuck);
    });

    it("is armed again for the operation after a release", () => {
      const before = { designs: ["a"], height: 24 };
      const { result, rerender } = setup({ live: before, busy: false, maxHoldMs: 1000 });

      rerender({ live: { designs: ["a", "b"], height: 24 }, busy: true, maxHoldMs: 1000 });
      act(() => { vi.advanceTimersByTime(1001); });

      const settled = { designs: ["a", "b"], height: 60 };
      rerender({ live: settled, busy: false, maxHoldMs: 1000 });
      expect(result.current).toBe(settled);

      rerender({ live: { designs: ["a", "b", "c"], height: 60 }, busy: true, maxHoldMs: 1000 });
      expect(result.current).toBe(settled);
    });
  });
});

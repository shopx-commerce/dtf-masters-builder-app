import { describe, it, expect } from "vitest";
import {
  SELECTED_DETAIL_MAX_INSET_CSS_PX,
  SELECTED_DETAIL_MIN_INSET_CSS_PX,
  selectedDetailClipInsetCssPx,
  selectedDetailInsetCssPx,
} from "./selected-detail-overlay";

/** A desktop corner handle is 12 CSS px across, on screen, at every zoom. */
const DESKTOP_CHROME = 12;
/** Touch handles are drawn larger. */
const TOUCH_CHROME = 16;

describe("selected detail overlay inset", () => {
  it("holds the same band on screen however far the customer zooms in", () => {
    // The property that matters. The band is measured in preview px, but what the customer
    // sees is preview px times zoom — and that product is what used to grow without bound,
    // wrapping their artwork in an ever-thicker ring of low-resolution pixels.
    for (const zoom of [3, 4.5, 6, 8, 10, 12]) {
      const onScreen = selectedDetailInsetCssPx(zoom, DESKTOP_CHROME) * zoom;
      expect(onScreen).toBeCloseTo(DESKTOP_CHROME, 6);
    }
  });

  it("never gives back less room than the chrome needs", () => {
    // Under-covering is the other failure: the handles are what the band exists for, and an
    // overlay that paints over them leaves the customer nothing to grab on opaque artwork.
    for (const zoom of [1.5, 2, 3, 6, 12]) {
      for (const chrome of [DESKTOP_CHROME, TOUCH_CHROME]) {
        const onScreen = selectedDetailInsetCssPx(zoom, chrome) * zoom;
        expect(onScreen).toBeGreaterThanOrEqual(Math.min(chrome, SELECTED_DETAIL_MAX_INSET_CSS_PX * zoom) - 1e-6);
      }
    }
  });

  it("does not widen the band beyond what it always was", () => {
    // At the zooms where the overlay first appears the old fixed inset was already generous.
    // Capping there keeps this change invisible at the bottom of the range: no more of the
    // design is handed back to the low-resolution path than before.
    expect(selectedDetailInsetCssPx(1.5, DESKTOP_CHROME)).toBe(SELECTED_DETAIL_MAX_INSET_CSS_PX);
    expect(selectedDetailInsetCssPx(2, DESKTOP_CHROME)).toBe(SELECTED_DETAIL_MAX_INSET_CSS_PX);
    expect(selectedDetailInsetCssPx(0.5, TOUCH_CHROME)).toBe(SELECTED_DETAIL_MAX_INSET_CSS_PX);
  });

  it("shrinks the band as zoom rises", () => {
    expect(selectedDetailInsetCssPx(3, DESKTOP_CHROME)).toBe(4);
    expect(selectedDetailInsetCssPx(6, DESKTOP_CHROME)).toBe(2);
    expect(selectedDetailInsetCssPx(12, DESKTOP_CHROME)).toBe(1);
    expect(selectedDetailInsetCssPx(12, TOUCH_CHROME)).toBeCloseTo(16 / 12, 6);
  });

  it("keeps a hairline rather than collapsing to nothing", () => {
    // A zero-width band is a zero-area clip: the ring the sheet canvas draws would disappear
    // and take the chrome with it.
    expect(selectedDetailInsetCssPx(1000, DESKTOP_CHROME)).toBe(SELECTED_DETAIL_MIN_INSET_CSS_PX);
  });

  describe("clip while the band catches up", () => {
    /**
     * The invariant the seam depends on: whatever the two layers hold at any instant, the
     * overlay's clip must never sit further in than the band the sheet canvas painted, or the
     * strip between them belongs to nobody and the design shows through it.
     */
    const noGap = (clip: number, band: number) => clip <= band + 1e-9;

    it("never lets the clip outrun the painted band, in either zoom direction", () => {
      const zooms = [1.5, 2, 3, 4, 5, 6, 8, 10, 12];
      for (const from of zooms) {
        for (const to of zooms) {
          const painted = selectedDetailInsetCssPx(from, DESKTOP_CHROME);
          const pending = selectedDetailInsetCssPx(to, DESKTOP_CHROME);
          // The frame where the clip has committed but the canvas still holds the old band.
          expect(noGap(selectedDetailClipInsetCssPx(pending, painted), painted)).toBe(true);
          // And the frame where the canvas repainted first.
          expect(noGap(selectedDetailClipInsetCssPx(pending, painted), pending)).toBe(true);
        }
      }
    });

    it("settles on the shared value once both agree", () => {
      const inset = selectedDetailInsetCssPx(6, DESKTOP_CHROME);
      expect(selectedDetailClipInsetCssPx(inset, inset)).toBe(inset);
    });

    it("treats a missing value as the old fixed band rather than as zero", () => {
      // Zero would be a clip covering the whole design, burying the chrome the band exists for.
      expect(selectedDetailClipInsetCssPx(Number.NaN, 4)).toBe(4);
      expect(selectedDetailClipInsetCssPx(4, Number.NaN)).toBe(4);
      expect(selectedDetailClipInsetCssPx(Number.NaN, Number.NaN)).toBe(
        SELECTED_DETAIL_MAX_INSET_CSS_PX,
      );
    });

    it("never asks for a negative clip", () => {
      expect(selectedDetailClipInsetCssPx(-5, 4)).toBe(0);
    });
  });

  describe("clip against the band through every interleaving", () => {
    /**
     * A model of the two mechanisms that move the inset, so the invariant can be checked
     * against sequences rather than pairs.
     *
     * `band` is what the sheet canvas has actually painted — the only thing the clip has to
     * stay inside of. `clip` is what the overlay element is clipped to at this instant, which
     * two writers touch: React's commit, using the declarative value, and the repaint, which
     * pulls it onto the band it just drew.
     *
     * One assumption is baked in and worth stating: a render never reads a state update that
     * has been queued and not yet applied. That is React's contract for `setState` — the queue
     * is drained by the render it schedules — and it is what makes the declarative value safe
     * on its own; the repaint's own write is what makes it safe without depending on that.
     */
    class Seam {
      band: number;
      clip: number;
      published: number;
      pending: number;
      queued: number | null = null;

      constructor(inset: number) {
        this.band = inset;
        this.clip = inset;
        this.published = inset;
        this.pending = inset;
      }

      /** A settled zoom change renders and commits the DOM with the declarative clip. */
      commit(nextInset: number) {
        this.drain();
        this.pending = nextInset;
        this.clip = selectedDetailClipInsetCssPx(this.pending, this.published);
      }

      /** The passive effect repaints the band, then pulls the clip onto it. */
      paint() {
        this.band = this.pending;
        this.clip = this.pending;
        this.queued = this.pending;
      }

      /** React applies the repaint's state update and re-renders. */
      flush() {
        if (this.queued == null) return;
        this.drain();
        this.clip = selectedDetailClipInsetCssPx(this.pending, this.published);
      }

      private drain() {
        if (this.queued == null) return;
        this.published = this.queued;
        this.queued = null;
      }
    }

    it("keeps the clip inside the painted band at every step of every order", () => {
      const insets = [
        selectedDetailInsetCssPx(3, DESKTOP_CHROME),
        selectedDetailInsetCssPx(12, DESKTOP_CHROME),
        SELECTED_DETAIL_MAX_INSET_CSS_PX,
      ];
      type Op = { kind: "commit"; inset: number } | { kind: "paint" } | { kind: "flush" };
      const ops: Op[] = [
        ...insets.map(inset => ({ kind: "commit" as const, inset })),
        { kind: "paint" },
        { kind: "flush" },
      ];

      const walk = (seam: Seam, depth: number) => {
        if (depth === 0) return;
        for (const op of ops) {
          const next = Object.assign(Object.create(Seam.prototype) as Seam, seam);
          if (op.kind === "commit") next.commit(op.inset);
          else if (op.kind === "paint") next.paint();
          else next.flush();
          // The whole point: no strip of the design is ever owned by neither layer.
          expect(next.clip).toBeLessThanOrEqual(next.band + 1e-9);
          walk(next, depth - 1);
        }
      };

      walk(new Seam(SELECTED_DETAIL_MAX_INSET_CSS_PX), 5);
    });

    it("converges on the pending inset once the transition finishes", () => {
      // The invariant is satisfied trivially by a clip that shrinks and never grows back, so
      // the band has to be shown returning to full width too.
      const seam = new Seam(SELECTED_DETAIL_MAX_INSET_CSS_PX);
      const tight = selectedDetailInsetCssPx(12, DESKTOP_CHROME);
      seam.commit(tight);
      seam.paint();
      seam.flush();
      expect(seam.clip).toBe(tight);
      expect(seam.band).toBe(tight);

      seam.commit(SELECTED_DETAIL_MAX_INSET_CSS_PX);
      seam.paint();
      seam.flush();
      expect(seam.clip).toBe(SELECTED_DETAIL_MAX_INSET_CSS_PX);
      expect(seam.band).toBe(SELECTED_DETAIL_MAX_INSET_CSS_PX);
    });
  });

  it("falls back to the old fixed band on nonsense input", () => {
    for (const zoom of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(selectedDetailInsetCssPx(zoom, DESKTOP_CHROME)).toBe(SELECTED_DETAIL_MAX_INSET_CSS_PX);
    }
    expect(selectedDetailInsetCssPx(4, 0)).toBe(SELECTED_DETAIL_MAX_INSET_CSS_PX);
    expect(selectedDetailInsetCssPx(4, Number.NaN)).toBe(SELECTED_DETAIL_MAX_INSET_CSS_PX);
  });
});

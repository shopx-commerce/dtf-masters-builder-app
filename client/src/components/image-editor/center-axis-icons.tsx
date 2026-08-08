/**
 * Icons for the two centre-on-axis toolbar buttons.
 *
 * These replace Lucide's `AlignCenterVertical` / `AlignCenterHorizontal`. Those are the
 * industry-standard glyphs, but their mirrored outlined wings were reported as reading like a
 * butterfly and a sideways aeroplane at toolbar size, and the tiny "X"/"Y" letter layered in
 * the corner only added noise.
 *
 * The replacements keep the Illustrator idiom — a centre line with objects sitting on it —
 * but draw the objects as two solid bars of unequal length. Solid fills survive being shrunk
 * to 18px where outlines with notches turn to mush, and the unequal lengths are what makes it
 * read as "these got lined up" rather than as an abstract symbol. The bars' orientation is
 * what distinguishes the pair: bars stacked across the line for left-to-right, bars standing
 * side by side for top-to-bottom.
 *
 * Element count is deliberately kept to three per icon. An earlier attempt added arrowheads
 * showing the direction of travel and it was illegible at this size.
 *
 * GEOMETRY IS TUNED FOR 18px — see the numbers below before changing any of them.
 * The desktop toolbar draws these in an 18px box, so one viewBox unit is 0.75 device pixels.
 * The first version used 6-unit bars separated by 3 units, with a 1.5-unit centre line. That
 * left the line only 2.25px of clear run in each gap, at 1.125px wide straddling a pixel
 * boundary — so it rendered as a pair of pale grey half-pixels wedged between two 4.5px slabs
 * of solid black, and the whole glyph collapsed into a blob. The line, which carries the
 * entire meaning, was the part that disappeared.
 *
 * The current numbers fix that in three ways:
 *   - Bars are 4 units (exactly 3px) and sit at multiples of 4/3, so every bar edge lands on
 *     a whole device pixel and the bars render dead crisp instead of soft-edged.
 *   - Bars are thinner and pushed apart, so the axis has an 8-unit (6px) clear run through the
 *     middle plus a 3.5-unit (2.6px) overshoot past each bar. Overshooting at both ends is
 *     what makes it read as a guide the shapes are sitting on, rather than a bar joining them.
 *   - The line is 2 units (1.5px), which covers two device pixels at 75% each. Deliberately
 *     not heavier: at 2.5+ units the line matches the bars in weight and the glyph reads as a
 *     plus sign or a dagger instead of objects on an axis.
 *
 * Rejected on the evidence: gapping the bars where the axis crosses (the short bar is only
 * 8 units long, so a gap wide enough to show the line leaves two 1.5px stubs and the glyph
 * turns into a division sign), and pushing the bars right out to the edges of the box (the
 * axis reads beautifully, but the silhouette becomes an aeroplane and a dumbbell — the exact
 * complaint that retired the Lucide icons).
 */

type IconProps = { className?: string };

/** Centres the design left to right: it slides horizontally onto the vertical centre line. */
export function CenterHorizontalIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <line
        x1="12" y1="0.5" x2="12" y2="23.5"
        stroke="currentColor" strokeWidth="2"
      />
      <rect x="4" y="4" width="16" height="4" rx="1" fill="currentColor" />
      <rect x="8" y="16" width="8" height="4" rx="1" fill="currentColor" />
    </svg>
  );
}

/** Centres the design top to bottom: it slides vertically onto the horizontal centre line. */
export function CenterVerticalIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <line
        x1="0.5" y1="12" x2="23.5" y2="12"
        stroke="currentColor" strokeWidth="2"
      />
      <rect x="4" y="4" width="4" height="16" rx="1" fill="currentColor" />
      <rect x="16" y="8" width="4" height="8" rx="1" fill="currentColor" />
    </svg>
  );
}

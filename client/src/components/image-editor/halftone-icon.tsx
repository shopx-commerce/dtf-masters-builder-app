/**
 * Halftone icon — a grid of circles shrinking diagonally.
 *
 * Own module (not defined in the view) because both the view's mobile
 * Design-tools sheet and the desktop toolbar's Design-tools dropdown render
 * it, and the toolbar cannot import from the view without a cycle.
 */
export const HalftoneIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
    <circle cx="2.5"  cy="2.5"  r="2.2"/>
    <circle cx="8"    cy="2.5"  r="1.6"/>
    <circle cx="13.5" cy="2.5"  r="0.9"/>
    <circle cx="2.5"  cy="8"    r="1.6"/>
    <circle cx="8"    cy="8"    r="1.1"/>
    <circle cx="13.5" cy="8"    r="0.6"/>
    <circle cx="2.5"  cy="13.5" r="0.9"/>
    <circle cx="8"    cy="13.5" r="0.6"/>
    <circle cx="13.5" cy="13.5" r="0.3"/>
  </svg>
);

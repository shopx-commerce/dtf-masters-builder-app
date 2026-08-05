import { memo } from "react";
import { useActiveTransformField, useHasActiveTransform } from "@/state/transform-store";

interface RotationBadgeProps {
  title?: string;
  className?: string;
  onEdit: (currentRotation: number) => void;
}

/**
 * Display-only rotation badge for the preview toolbar.
 *
 * Subscribes to the active transform's `rotation` field via the transform
 * store selector — meaning this component re-renders *only* when the
 * rotation number changes. Typing in the gap slider, toggling halftone,
 * or updating an unrelated design field will not cause a re-render here.
 *
 * Rendering is gated on `useHasActiveTransform` so the badge disappears
 * when no design is selected. Both hooks are primitives-only, so the
 * `memo` wrapper short-circuits every unrelated parent re-render.
 */
function RotationBadgeComponent({ title, className, onEdit }: RotationBadgeProps) {
  const rotation = useActiveTransformField("rotation");
  const hasActive = useHasActiveTransform();
  if (!hasActive) return null;
  const value = Math.round(rotation ?? 0);
  return (
    <span
      className={
        className ??
        "text-[12px] text-gray-700 font-semibold cursor-pointer hover:text-gray-900 tabular-nums"
      }
      title={title}
      onClick={() => onEdit(rotation ?? 0)}
    >
      {value}°
    </span>
  );
}

export const RotationBadge = memo(RotationBadgeComponent);

/**
 * Keeping artwork on the sheet without taking a group apart.
 *
 * Every whole-sheet operation ends by pulling anything that hangs off the film back on: an
 * arrange commits new positions, the height ladder grows the sheet, a resize makes a design
 * bigger than the space it was sitting in. Doing that one design at a time is correct right
 * up until two designs are meant to hold a fixed relationship to each other, and then it is
 * silently destructive: if a group's lowest member is the only one over the edge, only that
 * member moves, and the arrangement the customer built inside the group is now a different
 * arrangement. It is not visible as a bug either — nothing jumps, the margins just quietly
 * stop being the margins they were, a little more with every sheet-sized operation.
 *
 * So the unit of clamping is the *group*, not the design. A group is measured as the union of
 * its members' ink, offered one shift, and every member gets that same shift. Relative
 * geometry is therefore preserved by construction rather than by each member happening to
 * need the same correction.
 *
 * An ungrouped design is a unit of one, and for it this is arithmetically identical to
 * clamping it on its own — which is what makes this safe to use everywhere the per-design
 * clamp was used.
 *
 * Deliberately pure and geometry-only: it is handed boxes that somebody else measured, so the
 * unit logic can be tested without a canvas, an image decode or a nest mask. The caller
 * decides what "the bounds of a design" means — in this app that is its *ink*, not its image
 * box, because nested designs are supposed to let their empty corners hang off the edge.
 */

/** A design's bounds in artboard inches, absolute — the caller has already added its centre. */
export interface ClampBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface ClampMember {
  id: string;
  /** Members sharing a groupId move together. Undefined means a unit of one. */
  groupId?: string;
  /** Normalised centre, as stored on the transform. */
  nx: number;
  ny: number;
  /** Absolute bounds of this member's artwork on the sheet. */
  box: ClampBox;
}

/**
 * How far a unit has to move along one axis to sit inside `extent`.
 *
 * Returns 0 for a unit that is simply too big to fit. That is not an oversight: shoving a
 * design wider than the sheet against the left edge does not make it fit, it just picks which
 * half gets cut off, and it would fight the customer every time they nudged it. Leaving it
 * where it is keeps the overflow visible and the design draggable, which is what the overlap
 * warnings are for. It also matches what the per-design clamp did before this existed.
 */
function axisShift(min: number, max: number, extent: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
  if (max - min > extent) return 0;
  if (min < 0) return -min;
  if (max > extent) return extent - max;
  return 0;
}

/**
 * Positions that put every unit back on the sheet, keyed by design id.
 *
 * Only ids whose position actually changes are present, so a caller can use the map's size to
 * tell whether the clamp did anything at all.
 */
export function planUnitClamp(
  members: ClampMember[],
  artboardWidth: number,
  artboardHeight: number,
): Map<string, { nx: number; ny: number }> {
  const moves = new Map<string, { nx: number; ny: number }>();
  if (!(artboardWidth > 0) || !(artboardHeight > 0)) return moves;

  interface Unit {
    members: ClampMember[];
    box: ClampBox;
  }
  const units = new Map<string, Unit>();

  for (const m of members) {
    // Ungrouped designs are keyed by their own id, which cannot collide with a group key: one
    // is prefixed `design:` and the other `group:`.
    const key = m.groupId ? `group:${m.groupId}` : `design:${m.id}`;
    const unit = units.get(key);
    if (!unit) {
      units.set(key, { members: [m], box: { ...m.box } });
      continue;
    }
    unit.members.push(m);
    if (m.box.minX < unit.box.minX) unit.box.minX = m.box.minX;
    if (m.box.maxX > unit.box.maxX) unit.box.maxX = m.box.maxX;
    if (m.box.minY < unit.box.minY) unit.box.minY = m.box.minY;
    if (m.box.maxY > unit.box.maxY) unit.box.maxY = m.box.maxY;
  }

  for (const unit of units.values()) {
    const dx = axisShift(unit.box.minX, unit.box.maxX, artboardWidth);
    const dy = axisShift(unit.box.minY, unit.box.maxY, artboardHeight);
    if (dx === 0 && dy === 0) continue;
    // One shift, converted to normalised space once and shared, so members cannot drift apart
    // through rounding the way they would if each derived its own correction.
    const dnx = dx / artboardWidth;
    const dny = dy / artboardHeight;
    for (const m of unit.members) {
      moves.set(m.id, { nx: m.nx + dnx, ny: m.ny + dny });
    }
  }

  return moves;
}

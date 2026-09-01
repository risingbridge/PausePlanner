import type { OpeningsGrid, Position, Staff } from "../../../types";
import { findActiveBlock, isWithinShift } from "../../../utils/time";

// At any slot, the fewest possible unstaffed positions is max(0, demand -
// onShift): if there are more open positions than bodies present, no rule
// can conjure a person, and every inter-slot rule (max-time, min-length,
// no-bounce) can only ever force someone OFF a position, never add one — so
// the rules only ever make coverage worse, never better. Summed as a suffix
// (from each slot to the end of the day), this gives a valid lower bound on
// remaining unstaffed slots at every point in the search, cheap enough to
// compute once up front and index into for free during branch-and-bound.
export function computeSuffixLowerBound(
  positions: Position[],
  openings: OpeningsGrid,
  staff: Staff[],
  slots: string[]
): number[] {
  const perSlot = slots.map((slot) => {
    const demand = positions.filter((p) => openings[p.id]?.[slot] === true).length;
    const onShift = staff.filter(
      (s) => isWithinShift(slot, s.start, s.end) && !findActiveBlock(slot, s.blocks)
    ).length;
    return Math.max(0, demand - onShift);
  });
  const suffix = new Array(slots.length + 1).fill(0);
  for (let i = slots.length - 1; i >= 0; i--) {
    suffix[i] = suffix[i + 1] + perSlot[i];
  }
  return suffix;
}

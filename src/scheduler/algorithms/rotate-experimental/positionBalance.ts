import type { OpeningsGrid, Position, Staff } from "../../../types";
import { findActiveBlock, isWithinShift, SLOT_MINUTES } from "../../../utils/time";
import type { Action } from "../../shared/action";
import type { PersonState } from "./state";

// ideal[staffIndex][positionIndex] — each person's fair share of that
// position's total worked time, weighted by how much of the position's
// open time they were actually present for, and computed net of any
// requirement-forced time (see the two correctness notes below). This is
// static input to the search, computed once up front — never touched
// during search — so it's a plain nested array, not part of SearchContext's
// mutable per-node state.
export type PositionIdeal = number[][];

// maxRemaining[t][staffIndex][positionIndex] — the most additional minutes
// that person could possibly still add to that position's tally from slot
// t onward. Deliberately a loose upper bound rather than a tight one: at a
// single free slot with several open positions, the same slot-minutes are
// credited toward *every* open position's remaining capacity, since in
// isolation the person really could dedicate that slot to any one of them.
// That looseness is fine — it only makes the pruning bound weaker, never
// wrong — see positionImbalanceLowerBound below for why per-cell looseness
// can't turn into an inadmissible (over-optimistic) bound.
export type MaxRemainingByStaffPosition = number[][][];

function buildPositionIndex(positions: Position[]): Map<string, number> {
  return new Map(positions.map((p, idx) => [p.id, idx]));
}

// Net of forced (requirement) assignments, per the parent fork's two
// correctness requirements:
//  1. Required minutes count toward both a position's total demand and
//     that person's own tally (forced[i][p]), same as freely-chosen work.
//  2. The ideal for the *remaining, freely-assignable* time is what
//     actually needs to equalize — treating forced time as if it didn't
//     happen would double-count it and over-penalize the person who was
//     required into a position from also being sent there voluntarily.
export function computePositionIdeal(
  positions: Position[],
  staff: Staff[],
  openings: OpeningsGrid,
  slots: string[],
  requiredPositionByStaffSlot: Array<Map<number, string>>
): PositionIdeal {
  const n = staff.length;
  const m = positions.length;
  const positionIndexById = buildPositionIndex(positions);

  const openMinutes = new Array(m).fill(0);
  const avail: number[][] = Array.from({ length: n }, () => new Array(m).fill(0));
  const forced: number[][] = Array.from({ length: n }, () => new Array(m).fill(0));

  for (let t = 0; t < slots.length; t++) {
    const slot = slots[t];
    for (let p = 0; p < m; p++) {
      if (openings[positions[p].id]?.[slot] === true) openMinutes[p] += SLOT_MINUTES;
    }
    for (let i = 0; i < n; i++) {
      const s = staff[i];
      if (!isWithinShift(slot, s.start, s.end)) continue;
      if (findActiveBlock(slot, s.blocks)) continue;
      const requiredPositionId = requiredPositionByStaffSlot[i].get(t);
      if (requiredPositionId !== undefined) {
        const p = positionIndexById.get(requiredPositionId);
        if (p !== undefined) {
          avail[i][p] += SLOT_MINUTES;
          forced[i][p] += SLOT_MINUTES;
        }
        continue; // locked into the required position this slot, not available to any other
      }
      for (let p = 0; p < m; p++) {
        if (openings[positions[p].id]?.[slot] === true) avail[i][p] += SLOT_MINUTES;
      }
    }
  }

  const ideal: PositionIdeal = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let p = 0; p < m; p++) {
    let forcedTotal = 0;
    for (let i = 0; i < n; i++) forcedTotal += forced[i][p];
    const remainingToDistribute = Math.max(0, openMinutes[p] - forcedTotal);

    let totalRemainingAvail = 0;
    for (let i = 0; i < n; i++) totalRemainingAvail += Math.max(0, avail[i][p] - forced[i][p]);

    for (let i = 0; i < n; i++) {
      const remainingAvail = Math.max(0, avail[i][p] - forced[i][p]);
      const share = totalRemainingAvail > 0 ? (remainingToDistribute * remainingAvail) / totalRemainingAvail : 0;
      ideal[i][p] = forced[i][p] + share;
    }
  }
  return ideal;
}

// Suffix table: maxRemaining[t] is the per-(staff,position) remaining
// capacity from slot t through the end of the day. Precomputed once (like
// the coverage suffix bound in bound.ts) so indexing into it during search
// is free.
export function computeMaxRemainingSuffix(
  positions: Position[],
  staff: Staff[],
  openings: OpeningsGrid,
  slots: string[],
  requiredPositionByStaffSlot: Array<Map<number, string>>
): MaxRemainingByStaffPosition {
  const n = staff.length;
  const m = positions.length;
  const positionIndexById = buildPositionIndex(positions);

  const suffix: MaxRemainingByStaffPosition = Array.from({ length: slots.length + 1 }, () =>
    Array.from({ length: n }, () => new Array(m).fill(0))
  );

  for (let t = slots.length - 1; t >= 0; t--) {
    const slot = slots[t];
    for (let i = 0; i < n; i++) {
      const carry = suffix[t + 1][i];
      const row = suffix[t][i];
      for (let p = 0; p < m; p++) row[p] = carry[p];

      const s = staff[i];
      if (!isWithinShift(slot, s.start, s.end)) continue;
      if (findActiveBlock(slot, s.blocks)) continue;
      const requiredPositionId = requiredPositionByStaffSlot[i].get(t);
      if (requiredPositionId !== undefined) {
        const p = positionIndexById.get(requiredPositionId);
        if (p !== undefined) row[p] += SLOT_MINUTES;
        continue;
      }
      for (let p = 0; p < m; p++) {
        if (openings[positions[p].id]?.[slot] === true) row[p] += SLOT_MINUTES;
      }
    }
  }

  return suffix;
}

// Sum of squared deviations from the fair-share ideal, across every
// (staff, position) cell — the leaf-level rotation score. "Column variance"
// per the design doc; summed rather than averaged since only relative
// ordering between candidates matters for the lexicographic comparison.
export function positionImbalanceScore(states: PersonState[], ideal: PositionIdeal): number {
  return positionImbalanceScoreFromMatrix(
    states.map((s) => s.positionMinutes),
    ideal
  );
}

export function positionImbalanceScoreFromMatrix(matrix: number[][], ideal: PositionIdeal): number {
  let sum = 0;
  for (let i = 0; i < matrix.length; i++) {
    const M = matrix[i];
    const idealRow = ideal[i];
    for (let p = 0; p < M.length; p++) {
      const dev = M[p] - idealRow[p];
      sum += dev * dev;
    }
  }
  return sum;
}

// Rebuilds the person x position minutes matrix from a full decision log —
// used only to seed phase 2's incumbent from the Quick/Balanced warm start,
// which has no PersonState (and therefore no running positionMinutes) of
// its own. Mirrors shared/objectives.ts's deriveFairnessInputs.
export function derivePositionMinutes(
  decisions: Action[][],
  staffCount: number,
  positionCount: number,
  positionIndexById: Map<string, number>
): number[][] {
  const matrix: number[][] = Array.from({ length: staffCount }, () => new Array(positionCount).fill(0));
  for (const slotActions of decisions) {
    for (let i = 0; i < staffCount; i++) {
      const action = slotActions[i];
      if (action.kind === "WORK") {
        const idx = positionIndexById.get(action.positionId);
        if (idx !== undefined) matrix[i][idx] += SLOT_MINUTES;
      }
    }
  }
  return matrix;
}

// Admissible lower bound on the final positionImbalanceScore, given a
// partial matrix at slot t. Decomposes per cell:
//  - already past the ideal (M[i][p] >= ideal): M only ever grows, so the
//    final deviation can only be >= the current one — (M - ideal)^2 is a
//    valid, in fact exactly-achieved-in-the-worst-case, floor.
//  - short of the ideal: the best this cell can possibly finish at is
//    min(ideal, M + remaining capacity) — if remaining capacity can't
//    reach the ideal, the shortfall is locked in regardless of how the
//    rest of the day plays out.
// Each per-cell floor is independently valid regardless of what any other
// cell does, so the sum is a valid lower bound on the true sum even though
// the per-cell "best cases" aren't necessarily simultaneously achievable
// (the same free slot can count toward more than one cell's remaining
// capacity — see MaxRemainingByStaffPosition above). That only makes the
// bound looser, never wrong: pruning stays safe.
export function positionImbalanceLowerBound(
  states: PersonState[],
  t: number,
  ideal: PositionIdeal,
  maxRemainingSuffix: MaxRemainingByStaffPosition
): number {
  let sum = 0;
  const remainingByStaff = maxRemainingSuffix[t];
  for (let i = 0; i < states.length; i++) {
    const M = states[i].positionMinutes;
    const idealRow = ideal[i];
    const remainingRow = remainingByStaff[i];
    for (let p = 0; p < M.length; p++) {
      const cur = M[p];
      const target = idealRow[p];
      let floor: number;
      if (cur >= target) {
        const dev = cur - target;
        floor = dev * dev;
      } else {
        const bestCase = Math.min(target, cur + remainingRow[p]);
        const shortfall = target - bestCase;
        floor = shortfall * shortfall;
      }
      sum += floor;
    }
  }
  return sum;
}

import type { OpeningsGrid, Position, Staff } from "../../../types";
import { findActiveBlock, generateSlots, isWithinShift, SLOT_MINUTES, toHHMM, toMinutes } from "../../../utils/time";
import type { ScheduleSettings } from "../../types";

export interface BreakInterval {
  start: string;
  end: string;
}

// Recursive DFS calls are budgeted rather than time-boxed, since call count
// is deterministic and portable across machines; each call does at most one
// person's domain worth of work, so total work stays bounded even at the
// budget ceiling.
const NODE_BUDGET = 20000;

interface StaffWindow {
  id: string;
  // Candidate break-start minutes, most-preferred (inside the target
  // window, earliest first) before least-preferred (past the window, only
  // reachable when the window itself can't fit a whole break).
  domain: number[];
}

function breakFits(staff: Staff, startMinute: number, minBreakLength: number): boolean {
  const endMinute = startMinute + minBreakLength;
  return staff.blocks.every((b) => startMinute >= toMinutes(b.end) || endMinute <= toMinutes(b.start));
}

function buildDomain(staff: Staff, settings: ScheduleSettings, slots: string[]): number[] {
  const shiftStart = toMinutes(staff.start);
  const shiftEnd = toMinutes(staff.end);
  const duration = shiftEnd - shiftStart;
  const windowStart = shiftStart + Math.round((duration * settings.earliestBreakPercent) / 100);
  const windowEnd = shiftStart + Math.round((duration * settings.latestBreakPercent) / 100);
  const latestPossibleStart = shiftEnd - settings.minBreakLength;

  const inWindow: number[] = [];
  const pastWindow: number[] = [];
  for (const slot of slots) {
    const t = toMinutes(slot);
    if (t < windowStart || t > latestPossibleStart) continue;
    if (!breakFits(staff, t, settings.minBreakLength)) continue;
    if (t <= windowEnd) inWindow.push(t);
    else pastWindow.push(t);
  }
  if (inWindow.length > 0 || pastWindow.length > 0) return [...inWindow, ...pastWindow];

  // The window (and any room past it) couldn't fit a whole break anywhere —
  // widen to the full shift as a last resort, the same spirit as Quick's
  // absolute-guarantee backstop.
  const widened: number[] = [];
  for (const slot of slots) {
    const t = toMinutes(slot);
    if (t < shiftStart || t > latestPossibleStart) continue;
    if (!breakFits(staff, t, settings.minBreakLength)) continue;
    widened.push(t);
  }
  return widened;
}

function computeSlotRoom(positions: Position[], openings: OpeningsGrid, staff: Staff[], slots: string[]): number[] {
  return slots.map((slot) => {
    const demand = positions.filter((p) => openings[p.id]?.[slot] === true).length;
    const onShift = staff.filter(
      (s) => isWithinShift(slot, s.start, s.end) && !findActiveBlock(slot, s.blocks)
    ).length;
    return Math.max(0, onShift - demand);
  });
}

// Places every staff member's one break as a constraint-satisfaction search:
// each break's start time is a variable, its domain the window-preferred
// candidate slots, and the shared constraint that simultaneous breaks never
// exceed a slot's surplus room. Solved with most-constrained-first ordering
// and forward-checking pruning; if the day is too tight to satisfy every
// break with zero surplus violations, falls back to a budgeted
// branch-and-bound minimizing total violation instead of giving up.
export function computeBreakPlacements(
  positions: Position[],
  openings: OpeningsGrid,
  staff: Staff[],
  settings: ScheduleSettings
): Map<string, BreakInterval | null> {
  const slots = generateSlots(settings.dayStart, settings.dayEnd);
  const slotIndexByMinute = new Map(slots.map((s, i) => [toMinutes(s), i]));
  const room = computeSlotRoom(positions, openings, staff, slots);
  const breakSpan = Math.max(1, Math.ceil(settings.minBreakLength / SLOT_MINUTES));

  const windows: StaffWindow[] = staff.map((s) => ({ id: s.id, domain: buildDomain(s, settings, slots) }));
  const order = [...windows].sort((a, b) => a.domain.length - b.domain.length);

  function coveredIndices(startMinute: number): number[] {
    const startIdx = slotIndexByMinute.get(startMinute)!;
    const indices: number[] = [];
    for (let i = startIdx; i < Math.min(slots.length, startIdx + breakSpan); i++) indices.push(i);
    return indices;
  }
  function canPlace(startMinute: number, roomState: number[]): boolean {
    return coveredIndices(startMinute).every((i) => roomState[i] > 0);
  }
  function applyDelta(startMinute: number, roomState: number[], delta: number) {
    for (const i of coveredIndices(startMinute)) roomState[i] += delta;
  }
  function addedViolation(startMinute: number, roomState: number[]): number {
    return coveredIndices(startMinute).filter((i) => roomState[i] <= 0).length;
  }

  let nodes = 0;
  const strictAssignment: (number | null)[] = new Array(order.length).fill(null);

  function strictSearch(idx: number, roomState: number[]): boolean {
    if (idx === order.length) return true;
    if (++nodes > NODE_BUDGET) return false;
    const domain = order[idx].domain;
    if (domain.length === 0) return strictSearch(idx + 1, roomState);
    for (const startMinute of domain) {
      if (!canPlace(startMinute, roomState)) continue;
      applyDelta(startMinute, roomState, -1);
      strictAssignment[idx] = startMinute;
      if (strictSearch(idx + 1, roomState)) return true;
      applyDelta(startMinute, roomState, 1);
      strictAssignment[idx] = null;
    }
    return false;
  }

  const strictSucceeded = strictSearch(0, room.slice());

  let finalAssignment: (number | null)[];
  if (strictSucceeded) {
    finalAssignment = strictAssignment;
  } else {
    let bestCost = Infinity;
    let bestAssignment: (number | null)[] | null = null;
    const current: (number | null)[] = new Array(order.length).fill(null);

    function relaxedSearch(idx: number, roomState: number[], costSoFar: number) {
      if (++nodes > NODE_BUDGET) return;
      if (costSoFar >= bestCost) return;
      if (idx === order.length) {
        bestCost = costSoFar;
        bestAssignment = current.slice();
        return;
      }
      const domain = order[idx].domain;
      if (domain.length === 0) {
        current[idx] = null;
        relaxedSearch(idx + 1, roomState, costSoFar);
        return;
      }
      for (const startMinute of domain) {
        const added = addedViolation(startMinute, roomState);
        applyDelta(startMinute, roomState, -1);
        current[idx] = startMinute;
        relaxedSearch(idx + 1, roomState, costSoFar + added);
        applyDelta(startMinute, roomState, 1);
      }
      current[idx] = null;
    }

    relaxedSearch(0, room.slice(), 0);
    finalAssignment = bestAssignment ?? current;
  }

  const result = new Map<string, BreakInterval | null>();
  order.forEach((w, idx) => {
    const startMinute = finalAssignment[idx];
    result.set(w.id, startMinute == null ? null : { start: toHHMM(startMinute), end: toHHMM(startMinute + settings.minBreakLength) });
  });
  return result;
}

import type { OpeningsGrid, Position, ScheduleResult, Staff, TimelineEntry } from "../../../types";
import { findActiveBlock, generateSlots, isWithinShift, SLOT_MINUTES } from "../../../utils/time";
import type { ScheduleSettings } from "../../types";
import { runQuick } from "../quick";
import { computeBreakPlacements, type BreakInterval } from "./breakPlacement";
import { solveAssignment } from "./hungarian";

interface StaffState {
  currentPositionId: string | null;
  continuousMinutes: number;
  restRemaining: number;
  idleMinutes: number;
  elapsedMinutes: number;
}

function idleRate(state: StaffState): number {
  if (state.elapsedMinutes === 0) return Infinity;
  return state.idleMinutes / state.elapsedMinutes;
}

// Cost-matrix constants: real assignments always land well under
// UNFILLED_PENALTY so covering a position is always preferred over leaving
// it to its dummy row, and BOUNCE_FORBIDDEN sits an order of magnitude above
// that so a claimant's forbidden (non-current) position edge is never
// chosen over its dummy fallback either.
const BASE_COST = 1000;
const FAIRNESS_WEIGHT = 500;
const STAY_BONUS = 50;
const IDLE_RATE_CAP = 1000;
const UNFILLED_PENALTY = 100000;
const BOUNCE_FORBIDDEN = 10000000;

function costFor(rate: number): number {
  const clamped = Number.isFinite(rate) ? rate : IDLE_RATE_CAP;
  return BASE_COST - clamped * FAIRNESS_WEIGHT;
}

function isOnBreak(breaks: Map<string, BreakInterval | null>, staffId: string, t: number): boolean {
  const interval = breaks.get(staffId);
  if (!interval) return false;
  return t >= toMinutesLocal(interval.start) && t < toMinutesLocal(interval.end);
}

// Small local re-implementation to avoid importing toMinutes twice under
// different names; kept private since it's only ever called with slot-grid
// aligned strings already validated by breakPlacement.ts.
function toMinutesLocal(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Fills a slot's open positions from the eligible pool via a minimum-cost
// bipartite matching rather than Quick's greedy rank-then-evict: claimants
// only ever get an edge back to their own position (or a zero-cost "go
// idle" dummy) so a direct position-to-position bounce is structurally
// impossible, and seekers get an edge to every open position, weighted by
// idle rate the same way Quick's fairness ranking is, letting the solver
// pick the globally best trade-off in one shot instead of one eviction at a
// time.
function matchCoverage(
  pool: Staff[],
  openPositions: Position[],
  state: Map<string, StaffState>
): Map<string, string> {
  const assigned = new Map<string, string>();
  const R = pool.length;
  const C = openPositions.length;
  if (R === 0 || C === 0) return assigned;

  const N = R + C;
  const cost: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < R; i++) {
    const st = state.get(pool[i].id)!;
    const isClaimant = st.currentPositionId !== null;
    for (let j = 0; j < C; j++) {
      if (isClaimant) {
        cost[i][j] = openPositions[j].id === st.currentPositionId ? costFor(idleRate(st)) - STAY_BONUS : BOUNCE_FORBIDDEN;
      } else {
        cost[i][j] = costFor(idleRate(st));
      }
    }
  }
  for (let m = 0; m < C; m++) {
    for (let j = 0; j < C; j++) cost[R + m][j] = UNFILLED_PENALTY;
  }

  const colOfRow = solveAssignment(cost);
  for (let i = 0; i < R; i++) {
    const col = colOfRow[i];
    if (col < C) assigned.set(pool[i].id, openPositions[col].id);
  }
  return assigned;
}

// Conservative gap-fill: only claims an unstaffed slot with someone
// genuinely idle who wasn't (and isn't about to be) working an adjacent
// slot, so it can never retroactively create a same-slot bounce or a
// max-time-in-position violation — the properties Passes 2–3 already
// guarantee stay intact. Anything Pass 3 couldn't cover this cheaply is
// left as an honest gap rather than force-fit.
function repairGaps(
  slots: string[],
  staff: Staff[],
  assignments: Record<string, Record<string, string | null>>,
  staffTimeline: Record<string, Record<string, TimelineEntry>>,
  unstaffed: Array<{ slot: string; positionId: string }>
) {
  const slotIndex = new Map(slots.map((s, i) => [s, i]));
  const remaining: Array<{ slot: string; positionId: string }> = [];
  for (const gap of unstaffed) {
    const idx = slotIndex.get(gap.slot)!;
    const prevSlot = idx > 0 ? slots[idx - 1] : null;
    const nextSlot = idx < slots.length - 1 ? slots[idx + 1] : null;
    const filler = staff.find((s) => {
      const entry = staffTimeline[s.id][gap.slot];
      if (!entry || entry.status !== "IDLE") return false;
      if (prevSlot && staffTimeline[s.id][prevSlot]?.status === "WORK") return false;
      if (nextSlot && staffTimeline[s.id][nextSlot]?.status === "WORK") return false;
      return true;
    });
    if (filler) {
      assignments[gap.slot][gap.positionId] = filler.id;
      staffTimeline[filler.id][gap.slot] = { status: "WORK", positionId: gap.positionId };
    } else {
      remaining.push(gap);
    }
  }
  unstaffed.length = 0;
  unstaffed.push(...remaining);
}

function computeBalancedResult(
  positions: Position[],
  openings: OpeningsGrid,
  staff: Staff[],
  settings: ScheduleSettings
): ScheduleResult {
  const slots = generateSlots(settings.dayStart, settings.dayEnd);
  const slotMinutes = SLOT_MINUTES;
  const breaks = computeBreakPlacements(positions, openings, staff, settings);

  const assignments: Record<string, Record<string, string | null>> = {};
  const staffTimeline: Record<string, Record<string, TimelineEntry>> = {};
  const unstaffed: Array<{ slot: string; positionId: string }> = [];

  const state = new Map<string, StaffState>();
  for (const s of staff) {
    state.set(s.id, { currentPositionId: null, continuousMinutes: 0, restRemaining: 0, idleMinutes: 0, elapsedMinutes: 0 });
    staffTimeline[s.id] = {};
  }

  function stop(s: Staff, slot: string) {
    const st = state.get(s.id)!;
    st.currentPositionId = null;
    st.continuousMinutes = 0;
    st.restRemaining = settings.minIdleTime - slotMinutes;
    st.idleMinutes += slotMinutes;
    st.elapsedMinutes += slotMinutes;
    staffTimeline[s.id][slot] = { status: "IDLE" };
  }

  function goIdle(s: Staff, slot: string, wasWorking: boolean) {
    if (wasWorking) {
      stop(s, slot);
      return;
    }
    const st = state.get(s.id)!;
    st.currentPositionId = null;
    st.continuousMinutes = 0;
    st.idleMinutes += slotMinutes;
    st.elapsedMinutes += slotMinutes;
    staffTimeline[s.id][slot] = { status: "IDLE" };
  }

  for (const slot of slots) {
    assignments[slot] = {};
    const t = toMinutesLocal(slot);
    const openPositions = positions.filter((p) => openings[p.id]?.[slot] === true);
    const openPositionIds = new Set(openPositions.map((p) => p.id));
    const positionFilled = new Set<string>();

    const eligible: Staff[] = [];
    for (const s of staff) {
      const st = state.get(s.id)!;
      if (!isWithinShift(slot, s.start, s.end)) {
        staffTimeline[s.id][slot] = { status: "OFF" };
        st.currentPositionId = null;
        st.continuousMinutes = 0;
        continue;
      }
      const activeBlock = findActiveBlock(slot, s.blocks);
      if (activeBlock) {
        staffTimeline[s.id][slot] = { status: "BLOCKED", label: activeBlock.label };
        st.currentPositionId = null;
        st.continuousMinutes = 0;
        continue;
      }
      if (isOnBreak(breaks, s.id, t)) {
        staffTimeline[s.id][slot] = { status: "BREAK" };
        st.currentPositionId = null;
        st.continuousMinutes = 0;
        continue;
      }
      if (st.restRemaining > 0) {
        st.restRemaining -= slotMinutes;
        st.idleMinutes += slotMinutes;
        st.elapsedMinutes += slotMinutes;
        staffTimeline[s.id][slot] = { status: "IDLE" };
        continue;
      }
      eligible.push(s);
    }

    const forcedStop = new Set<string>();
    for (const s of eligible) {
      const st = state.get(s.id)!;
      if (
        st.currentPositionId !== null &&
        openPositionIds.has(st.currentPositionId) &&
        st.continuousMinutes + slotMinutes > settings.maxTimeInPosition
      ) {
        forcedStop.add(s.id);
      }
    }
    const positionClosed = new Set<string>();
    for (const s of eligible) {
      if (forcedStop.has(s.id)) continue;
      const st = state.get(s.id)!;
      if (st.currentPositionId !== null && !openPositionIds.has(st.currentPositionId)) positionClosed.add(s.id);
    }
    for (const s of eligible) {
      if (forcedStop.has(s.id) || positionClosed.has(s.id)) stop(s, slot);
    }

    const protectedIds = new Set<string>();
    for (const s of eligible) {
      if (forcedStop.has(s.id) || positionClosed.has(s.id)) continue;
      const st = state.get(s.id)!;
      if (st.currentPositionId !== null && st.continuousMinutes < settings.minPositionLength) {
        protectedIds.add(s.id);
        positionFilled.add(st.currentPositionId);
        st.continuousMinutes += slotMinutes;
        st.elapsedMinutes += slotMinutes;
        assignments[slot][st.currentPositionId] = s.id;
        staffTimeline[s.id][slot] = { status: "WORK", positionId: st.currentPositionId };
      }
    }

    const pool = eligible.filter((s) => !forcedStop.has(s.id) && !positionClosed.has(s.id) && !protectedIds.has(s.id));
    const openForMatching = openPositions.filter((p) => !positionFilled.has(p.id));
    const matched = matchCoverage(pool, openForMatching, state);

    for (const s of pool) {
      const st = state.get(s.id)!;
      const positionId = matched.get(s.id);
      if (positionId) {
        const continuing = st.currentPositionId === positionId;
        st.currentPositionId = positionId;
        st.continuousMinutes = continuing ? st.continuousMinutes + slotMinutes : slotMinutes;
        st.elapsedMinutes += slotMinutes;
        positionFilled.add(positionId);
        assignments[slot][positionId] = s.id;
        staffTimeline[s.id][slot] = { status: "WORK", positionId };
      } else {
        goIdle(s, slot, st.currentPositionId !== null);
      }
    }

    for (const p of openPositions) {
      if (!positionFilled.has(p.id)) {
        assignments[slot][p.id] = null;
        unstaffed.push({ slot, positionId: p.id });
      }
    }
  }

  repairGaps(slots, staff, assignments, staffTimeline, unstaffed);

  return { slots, assignments, staffTimeline, unstaffed, generatedAt: new Date().toISOString() };
}

// Balanced is always compared against Quick's result and the better of the
// two (by unstaffed-slot count) is returned — the literal implementation of
// "you never get a worse result than Quick mode would have produced,"
// simpler and more honest than trying to structurally guarantee it through
// the search itself.
export function runBalanced(
  positions: Position[],
  openings: OpeningsGrid,
  staff: Staff[],
  settings: ScheduleSettings
): ScheduleResult {
  const quickResult = runQuick(positions, openings, staff, settings);
  const balancedResult = computeBalancedResult(positions, openings, staff, settings);
  return balancedResult.unstaffed.length <= quickResult.unstaffed.length ? balancedResult : quickResult;
}

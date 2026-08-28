import type { OpeningsGrid, Position, ScheduleResult, Settings, Staff, TimelineEntry } from "../types";
import { generateSlots, isWithinShift, SLOT_MINUTES } from "../utils/time";

interface StaffState {
  currentPositionId: string | null;
  continuousMinutes: number;
  breakRemaining: number;
}

export function generateSchedule(
  positions: Position[],
  openings: OpeningsGrid,
  staff: Staff[],
  settings: Settings
): ScheduleResult {
  const slots = generateSlots(settings.dayStart, settings.dayEnd);
  const slotMinutes = SLOT_MINUTES;

  const assignments: Record<string, Record<string, string | null>> = {};
  const staffTimeline: Record<string, Record<string, TimelineEntry>> = {};
  const unstaffed: Array<{ slot: string; positionId: string }> = [];

  const state = new Map<string, StaffState>();
  for (const s of staff) {
    state.set(s.id, { currentPositionId: null, continuousMinutes: 0, breakRemaining: 0 });
    staffTimeline[s.id] = {};
  }

  for (const slot of slots) {
    assignments[slot] = {};
    const openPositions = positions.filter((p) => openings[p.id]?.[slot] === true);
    const positionFilled = new Set<string>();
    const handledThisSlot = new Set<string>();

    const onShift = staff.filter((s) => isWithinShift(slot, s.start, s.end));
    const offShift = staff.filter((s) => !onShift.includes(s));

    for (const s of offShift) {
      staffTimeline[s.id][slot] = { status: "OFF" };
    }

    // Staff currently on a mandatory break
    for (const s of onShift) {
      const st = state.get(s.id)!;
      if (st.breakRemaining > 0) {
        staffTimeline[s.id][slot] = { status: "BREAK" };
        st.breakRemaining -= slotMinutes;
        handledThisSlot.add(s.id);
      }
    }

    // Staff continuing in their current position
    const freedForReassignment: Staff[] = [];
    for (const s of onShift) {
      if (handledThisSlot.has(s.id)) continue;
      const st = state.get(s.id)!;
      if (st.currentPositionId === null) continue;

      const stillOpen = openPositions.some((p) => p.id === st.currentPositionId);
      if (!stillOpen) {
        // Position closed; staffer is freed to be reassigned this slot without a forced break.
        st.currentPositionId = null;
        st.continuousMinutes = 0;
        freedForReassignment.push(s);
        continue;
      }

      const projected = st.continuousMinutes + slotMinutes;
      if (projected <= settings.maxTimeInPosition) {
        assignments[slot][st.currentPositionId] = s.id;
        staffTimeline[s.id][slot] = { status: "WORK", positionId: st.currentPositionId };
        positionFilled.add(st.currentPositionId);
        st.continuousMinutes = projected;
        handledThisSlot.add(s.id);
      } else {
        // Hit max time in position: mandatory break.
        staffTimeline[s.id][slot] = { status: "BREAK" };
        st.currentPositionId = null;
        st.continuousMinutes = 0;
        st.breakRemaining = settings.minBreakLength - slotMinutes;
        handledThisSlot.add(s.id);
      }
    }

    // Remaining open positions get filled from freed/fresh available staff.
    const availablePool = onShift.filter((s) => !handledThisSlot.has(s.id));
    const remainingPositions = openPositions.filter((p) => !positionFilled.has(p.id));

    let poolIndex = 0;
    for (const pos of remainingPositions) {
      if (poolIndex >= availablePool.length) {
        assignments[slot][pos.id] = null;
        unstaffed.push({ slot, positionId: pos.id });
        continue;
      }
      const s = availablePool[poolIndex++];
      const st = state.get(s.id)!;
      assignments[slot][pos.id] = s.id;
      staffTimeline[s.id][slot] = { status: "WORK", positionId: pos.id };
      st.currentPositionId = pos.id;
      st.continuousMinutes = slotMinutes;
      handledThisSlot.add(s.id);
    }

    // Anyone on shift, available, but with no open position left for them: idle.
    for (const s of onShift) {
      if (!handledThisSlot.has(s.id)) {
        staffTimeline[s.id][slot] = { status: "IDLE" };
        const st = state.get(s.id)!;
        st.currentPositionId = null;
        st.continuousMinutes = 0;
      }
    }
  }

  return {
    slots,
    assignments,
    staffTimeline,
    unstaffed,
    generatedAt: new Date().toISOString(),
  };
}

import type { OpeningsGrid, Position, ScheduleResult, Settings, Staff, TimelineEntry } from "../types";
import { findActiveBlock, generateSlots, isWithinShift, SLOT_MINUTES, toMinutes } from "../utils/time";

interface StaffState {
  currentPositionId: string | null;
  continuousMinutes: number;
  restRemaining: number;
  restIsBreak: boolean;
  hasHadBreak: boolean;
  idleMinutes: number;
  elapsedMinutes: number;
}

// Fraction of elapsed on-shift time spent idle so far. Staff who haven't
// started their shift yet get top priority (Infinity) so they're put to
// work right away rather than defaulting to the back of the queue.
function idleRate(state: StaffState): number {
  if (state.elapsedMinutes === 0) return Infinity;
  return state.idleMinutes / state.elapsedMinutes;
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
  const staffIndex = new Map(staff.map((s, i) => [s.id, i]));
  // Each person only needs one real break per shift, ideally taken around
  // the midpoint of their shift. Natural stops before the midpoint are just
  // brief idle gaps; the first one at or after the midpoint becomes the
  // real break.
  const midpointMinutes = new Map(
    staff.map((s) => [s.id, toMinutes(s.start) + Math.floor((toMinutes(s.end) - toMinutes(s.start)) / 2)])
  );
  for (const s of staff) {
    state.set(s.id, {
      currentPositionId: null,
      continuousMinutes: 0,
      restRemaining: 0,
      restIsBreak: false,
      hasHadBreak: false,
      idleMinutes: 0,
      elapsedMinutes: 0,
    });
    staffTimeline[s.id] = {};
  }

  // Stop a staffer's current stint (if any) and decide whether this is
  // "the" break or just a brief idle gap: the first stop at or after their
  // shift midpoint (while they haven't had a break yet) is promoted to the
  // real break; every other stop is a short idle gap instead.
  function applyStop(s: Staff, slot: string) {
    const st = state.get(s.id)!;
    const isBreak = !st.hasHadBreak && toMinutes(slot) >= midpointMinutes.get(s.id)!;
    st.currentPositionId = null;
    st.continuousMinutes = 0;
    st.elapsedMinutes += slotMinutes;
    if (isBreak) {
      st.hasHadBreak = true;
      st.restIsBreak = true;
      st.restRemaining = settings.minBreakLength - slotMinutes;
      staffTimeline[s.id][slot] = { status: "BREAK" };
    } else {
      st.restIsBreak = false;
      st.restRemaining = settings.minIdleTime - slotMinutes;
      st.idleMinutes += slotMinutes;
      staffTimeline[s.id][slot] = { status: "IDLE" };
    }
  }

  for (const slot of slots) {
    assignments[slot] = {};
    const openPositions = positions.filter((p) => openings[p.id]?.[slot] === true);
    const openPositionIds = new Set(openPositions.map((p) => p.id));

    // Staff who are off shift, blocked out (meetings, etc.), or still
    // resting from an earlier stop are unavailable this slot. Anyone who
    // hasn't had their one real break yet, and is running out of shift time
    // to fit it in, is forced into it now — this overrides everything else,
    // including a stint still in progress or protected by the minimum
    // position length, since it's a hard guarantee rather than a fairness
    // choice.
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
      if (st.restRemaining > 0) {
        staffTimeline[s.id][slot] = { status: st.restIsBreak ? "BREAK" : "IDLE" };
        st.restRemaining -= slotMinutes;
        if (!st.restIsBreak) st.idleMinutes += slotMinutes;
        st.elapsedMinutes += slotMinutes;
        continue;
      }
      const remainingShiftMinutes = toMinutes(s.end) - toMinutes(slot);
      if (!st.hasHadBreak && remainingShiftMinutes <= settings.minBreakLength) {
        st.currentPositionId = null;
        st.continuousMinutes = 0;
        st.hasHadBreak = true;
        st.restIsBreak = true;
        st.restRemaining = settings.minBreakLength - slotMinutes;
        st.elapsedMinutes += slotMinutes;
        staffTimeline[s.id][slot] = { status: "BREAK" };
        continue;
      }
      eligible.push(s);
    }

    // Snapshot who was actively working coming into this slot, so anyone
    // displaced later shows up resting rather than merely idle-with-no-history.
    const wasWorking = new Map(eligible.map((s) => [s.id, state.get(s.id)!.currentPositionId !== null]));

    // Hard cap: exceeding max time in position always forces a stop.
    const forcedStop = new Set<string>();
    for (const s of eligible) {
      const st = state.get(s.id)!;
      if (st.currentPositionId !== null && openPositionIds.has(st.currentPositionId)) {
        if (st.continuousMinutes + slotMinutes > settings.maxTimeInPosition) {
          forcedStop.add(s.id);
        }
      }
    }
    for (const s of eligible) {
      if (!forcedStop.has(s.id)) continue;
      applyStop(s, slot);
    }

    // A position closing also forces a stop — a staffer is never bounced
    // straight from one position into another in the same slot.
    const positionClosed = new Set<string>();
    for (const s of eligible) {
      if (forcedStop.has(s.id)) continue;
      const st = state.get(s.id)!;
      if (st.currentPositionId !== null && !openPositionIds.has(st.currentPositionId)) {
        positionClosed.add(s.id);
      }
    }
    for (const s of eligible) {
      if (!positionClosed.has(s.id)) continue;
      applyStop(s, slot);
    }

    const positionFilled = new Set<string>();

    // Protect short stints: nobody below the minimum position length can be
    // pulled off their position, no matter how deserving someone else is.
    const protectedIds = new Set<string>();
    for (const s of eligible) {
      if (forcedStop.has(s.id) || positionClosed.has(s.id)) continue;
      const st = state.get(s.id)!;
      if (
        st.currentPositionId !== null &&
        openPositionIds.has(st.currentPositionId) &&
        st.continuousMinutes < settings.minPositionLength
      ) {
        protectedIds.add(s.id);
        positionFilled.add(st.currentPositionId);
        st.continuousMinutes += slotMinutes;
        st.elapsedMinutes += slotMinutes;
        assignments[slot][st.currentPositionId] = s.id;
        staffTimeline[s.id][slot] = { status: "WORK", positionId: st.currentPositionId };
      }
    }

    // Rank everyone else by who has been idle the largest share of their
    // shift so far. Anyone reaching this point whose currentPositionId is
    // still set is necessarily still holding an open position (stops were
    // already routed above), so seekers here are always genuinely free.
    const rankable = eligible.filter(
      (s) => !forcedStop.has(s.id) && !positionClosed.has(s.id) && !protectedIds.has(s.id)
    );
    rankable.sort((a, b) => {
      const rA = idleRate(state.get(a.id)!);
      const rB = idleRate(state.get(b.id)!);
      if (rA !== rB) return rB - rA;
      return staffIndex.get(a.id)! - staffIndex.get(b.id)!;
    });

    // Staff still holding an open position are "claimants"; everyone else
    // ("seekers") needs a new assignment this slot.
    const claimants: Staff[] = [];
    const seekers: Staff[] = [];
    for (const s of rankable) {
      const st = state.get(s.id)!;
      if (st.currentPositionId !== null && openPositionIds.has(st.currentPositionId)) {
        claimants.push(s);
      } else {
        seekers.push(s);
      }
    }

    const claimedPositionIds = new Set(claimants.map((s) => state.get(s.id)!.currentPositionId!));
    const vacantPositions = openPositions.filter(
      (p) => !positionFilled.has(p.id) && !claimedPositionIds.has(p.id)
    );

    // Seekers fill genuinely vacant positions first, in fairness order.
    // This is what avoids bouncing someone straight from one position into
    // a different one whenever an uncontested slot is available instead.
    const remainingSeekers: Staff[] = [];
    let vacantIndex = 0;
    for (const s of seekers) {
      if (vacantIndex < vacantPositions.length) {
        const pos = vacantPositions[vacantIndex++];
        const st = state.get(s.id)!;
        positionFilled.add(pos.id);
        st.currentPositionId = pos.id;
        st.continuousMinutes = slotMinutes;
        st.elapsedMinutes += slotMinutes;
        assignments[slot][pos.id] = s.id;
        staffTimeline[s.id][slot] = { status: "WORK", positionId: pos.id };
      } else {
        remainingSeekers.push(s);
      }
    }

    // No vacant positions left: only now consider pulling a position away
    // from whichever claimant currently deserves it least, and only when
    // doing so genuinely improves the balance.
    const evictable = [...claimants].sort(
      (a, b) => idleRate(state.get(a.id)!) - idleRate(state.get(b.id)!)
    );
    const keptClaimants = new Set(claimants.map((s) => s.id));
    let evictIndex = 0;
    const finalSeekers: Staff[] = [];
    for (const seeker of remainingSeekers) {
      const seekerRate = idleRate(state.get(seeker.id)!);
      const candidate = evictable[evictIndex];
      if (candidate && seekerRate > idleRate(state.get(candidate.id)!)) {
        evictIndex++;
        keptClaimants.delete(candidate.id);
        const vacatedPositionId = state.get(candidate.id)!.currentPositionId!;
        applyStop(candidate, slot);

        const seekerSt = state.get(seeker.id)!;
        positionFilled.add(vacatedPositionId);
        seekerSt.currentPositionId = vacatedPositionId;
        seekerSt.continuousMinutes = slotMinutes;
        seekerSt.elapsedMinutes += slotMinutes;
        assignments[slot][vacatedPositionId] = seeker.id;
        staffTimeline[seeker.id][slot] = { status: "WORK", positionId: vacatedPositionId };
      } else {
        finalSeekers.push(seeker);
      }
    }

    // Remaining claimants (not evicted) keep working their position.
    for (const s of claimants) {
      if (!keptClaimants.has(s.id)) continue;
      const st = state.get(s.id)!;
      positionFilled.add(st.currentPositionId!);
      st.continuousMinutes += slotMinutes;
      st.elapsedMinutes += slotMinutes;
      assignments[slot][st.currentPositionId!] = s.id;
      staffTimeline[s.id][slot] = { status: "WORK", positionId: st.currentPositionId! };
    }

    // Anyone left with no position: resting if they were just working,
    // genuinely idle (no minimum) otherwise.
    for (const s of finalSeekers) {
      const st = state.get(s.id)!;
      const hadPosition = wasWorking.get(s.id) ?? false;
      if (hadPosition) {
        applyStop(s, slot);
      } else {
        st.currentPositionId = null;
        st.continuousMinutes = 0;
        st.elapsedMinutes += slotMinutes;
        st.idleMinutes += slotMinutes;
        staffTimeline[s.id][slot] = { status: "IDLE" };
      }
    }

    for (const p of openPositions) {
      if (!positionFilled.has(p.id)) {
        assignments[slot][p.id] = null;
        unstaffed.push({ slot, positionId: p.id });
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

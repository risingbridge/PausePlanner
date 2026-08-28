import type { OpeningsGrid, Position, ScheduleResult, Settings, Staff, TimelineEntry } from "../types";
import { findActiveBlock, generateSlots, isWithinShift, SLOT_MINUTES } from "../utils/time";

interface StaffState {
  currentPositionId: string | null;
  continuousMinutes: number;
  breakRemaining: number;
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
  for (const s of staff) {
    state.set(s.id, {
      currentPositionId: null,
      continuousMinutes: 0,
      breakRemaining: 0,
      idleMinutes: 0,
      elapsedMinutes: 0,
    });
    staffTimeline[s.id] = {};
  }

  for (const slot of slots) {
    assignments[slot] = {};
    const openPositions = positions.filter((p) => openings[p.id]?.[slot] === true);
    const openPositionIds = new Set(openPositions.map((p) => p.id));

    // Staff who are off shift or blocked out (meetings, etc.) this slot are
    // entirely unavailable: their position, if any, is freed with no
    // penalty, and the time doesn't count toward their fairness ratio.
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
      if (st.breakRemaining > 0) {
        staffTimeline[s.id][slot] = { status: "BREAK" };
        st.breakRemaining -= slotMinutes;
        st.elapsedMinutes += slotMinutes;
        continue;
      }
      eligible.push(s);
    }

    // Snapshot who was actively working coming into this slot, so anyone
    // displaced later shows up resting on a break rather than merely idle.
    const wasWorking = new Map(eligible.map((s) => [s.id, state.get(s.id)!.currentPositionId !== null]));

    // Hard cap: exceeding max time in position always forces a break,
    // regardless of fairness or the minimum position length.
    const forcedBreak = new Set<string>();
    for (const s of eligible) {
      const st = state.get(s.id)!;
      if (st.currentPositionId !== null && openPositionIds.has(st.currentPositionId)) {
        if (st.continuousMinutes + slotMinutes > settings.maxTimeInPosition) {
          forcedBreak.add(s.id);
        }
      }
    }
    for (const s of eligible) {
      if (!forcedBreak.has(s.id)) continue;
      const st = state.get(s.id)!;
      staffTimeline[s.id][slot] = { status: "BREAK" };
      st.currentPositionId = null;
      st.continuousMinutes = 0;
      st.breakRemaining = settings.minBreakLength - slotMinutes;
      st.elapsedMinutes += slotMinutes;
    }

    const positionFilled = new Set<string>();

    // Protect short stints: nobody below the minimum position length can be
    // pulled off their position, no matter how deserving someone else is.
    const protectedIds = new Set<string>();
    for (const s of eligible) {
      if (forcedBreak.has(s.id)) continue;
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
    // shift so far.
    const rankable = eligible.filter((s) => !forcedBreak.has(s.id) && !protectedIds.has(s.id));
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

        const evictedSt = state.get(candidate.id)!;
        const vacatedPositionId = evictedSt.currentPositionId!;
        evictedSt.currentPositionId = null;
        evictedSt.continuousMinutes = 0;
        evictedSt.breakRemaining = settings.minBreakLength - slotMinutes;
        evictedSt.elapsedMinutes += slotMinutes;
        staffTimeline[candidate.id][slot] = { status: "BREAK" };

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
    // genuinely idle otherwise.
    for (const s of finalSeekers) {
      const st = state.get(s.id)!;
      const hadPosition = wasWorking.get(s.id) ?? false;
      st.currentPositionId = null;
      st.continuousMinutes = 0;
      st.elapsedMinutes += slotMinutes;
      if (hadPosition) {
        st.breakRemaining = settings.minBreakLength - slotMinutes;
        staffTimeline[s.id][slot] = { status: "BREAK" };
      } else {
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

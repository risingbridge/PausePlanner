import type { OpeningsGrid, Position, ScheduleResult, Staff, TimelineEntry } from "../../types";
import { findActiveBlock, generateSlots, isWithinShift, SLOT_MINUTES, toMinutes } from "../../utils/time";
import type { ScheduleSettings } from "../types";

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

export function runQuick(
  positions: Position[],
  openings: OpeningsGrid,
  staff: Staff[],
  settings: ScheduleSettings
): ScheduleResult {
  const slots = generateSlots(settings.dayStart, settings.dayEnd);
  const slotMinutes = SLOT_MINUTES;

  const assignments: Record<string, Record<string, string | null>> = {};
  const staffTimeline: Record<string, Record<string, TimelineEntry>> = {};
  const unstaffed: Array<{ slot: string; positionId: string }> = [];

  const state = new Map<string, StaffState>();
  const staffIndex = new Map(staff.map((s, i) => [s.id, i]));
  // Each person only needs one real break per shift, targeted at a window
  // of their shift set by earliestBreakPercent/latestBreakPercent (default
  // 25%-75%). Natural stops before that window are just brief idle gaps;
  // the first one inside the window becomes the real break. If nothing
  // natural happens by the end of the window, or an idle gap is already
  // running when the window opens, the break is forced right then rather
  // than left to drift to whenever a stop next happens to occur.
  const windowStartMinutes = new Map(
    staff.map((s) => {
      const duration = toMinutes(s.end) - toMinutes(s.start);
      return [s.id, toMinutes(s.start) + Math.round((duration * settings.earliestBreakPercent) / 100)];
    })
  );
  const windowEndMinutes = new Map(
    staff.map((s) => {
      const duration = toMinutes(s.end) - toMinutes(s.start);
      return [s.id, toMinutes(s.start) + Math.round((duration * settings.latestBreakPercent) / 100)];
    })
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

  // How many more staff can newly start their one break this slot. Breaks
  // can span several slots, so simply limiting *new* starts per slot isn't
  // enough on its own — someone whose break started a slot or two ago can
  // still be resting when a new one begins, overlapping for most of their
  // duration. Instead this is recomputed every slot as the surplus of
  // on-shift staff over open positions, minus however many are already
  // mid-break — so a new break is only allowed to start while doing so
  // still leaves enough people to cover current demand. The absolute,
  // must-happen-now guarantee (below) deliberately ignores this cap, since
  // it's a hard promise rather than an opportunistic pick.
  let newBreaksThisSlot = 0;
  let maxNewBreaksThisSlot = 0;

  // Try to start a staffer's one real break right now: only possible inside
  // their target window, before they've already had one, and subject to the
  // per-slot stagger cap above. `minAllowance` raises that cap's floor for
  // this one attempt — used past the target window so a team with zero
  // spare capacity (e.g. a lone worker) still makes forward progress each
  // slot instead of deferring all the way to the absolute last resort.
  function tryStartBreak(s: Staff, slot: string, minAllowance = 0): boolean {
    const st = state.get(s.id)!;
    if (st.hasHadBreak) return false;
    if (toMinutes(slot) < windowStartMinutes.get(s.id)!) return false;
    if (newBreaksThisSlot >= Math.max(maxNewBreaksThisSlot, minAllowance)) return false;
    st.hasHadBreak = true;
    st.restIsBreak = true;
    st.restRemaining = Math.max(st.restRemaining, settings.minBreakLength - slotMinutes);
    newBreaksThisSlot++;
    return true;
  }

  // Stop a staffer's current stint (if any) and decide whether this is
  // "the" break or just a brief idle gap: the first stop inside the target
  // window (while they haven't had a break yet, and the stagger cap allows
  // it) is promoted to the real break; every other stop is a short idle gap
  // instead.
  function applyStop(s: Staff, slot: string) {
    const st = state.get(s.id)!;
    st.currentPositionId = null;
    st.continuousMinutes = 0;
    st.elapsedMinutes += slotMinutes;
    if (tryStartBreak(s, slot)) {
      staffTimeline[s.id][slot] = { status: "BREAK" };
    } else {
      st.restIsBreak = false;
      st.restRemaining = settings.minIdleTime - slotMinutes;
      st.idleMinutes += slotMinutes;
      staffTimeline[s.id][slot] = { status: "IDLE" };
    }
  }

  function openPositionsCountAt(slot: string): number {
    return positions.filter((p) => openings[p.id]?.[slot] === true).length;
  }

  // The most positions open at any point during a break started at this
  // slot. A break lasts a while, so a momentary dip in demand right now
  // doesn't mean it's safe to send people on break — what matters is the
  // worst case over the whole time they'll be gone.
  function maxOpenPositionsDuringBreakFrom(slotIndex: number): number {
    const endMinute = toMinutes(slots[slotIndex]) + settings.minBreakLength;
    let max = 0;
    for (let i = slotIndex; i < slots.length && toMinutes(slots[i]) < endMinute; i++) {
      const count = openPositionsCountAt(slots[i]);
      if (count > max) max = count;
    }
    return max;
  }

  for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
    const slot = slots[slotIndex];
    assignments[slot] = {};
    const openPositions = positions.filter((p) => openings[p.id]?.[slot] === true);
    const openPositionIds = new Set(openPositions.map((p) => p.id));

    // Recompute this slot's break-stagger budget: staff on shift and not
    // blocked out, minus how many are already mid-break, capped by the most
    // positions that will need covering at any point during a break started
    // now (not just this instant, since a temporary lull shouldn't look
    // like safe surplus when demand is about to spike back up).
    const onShiftNow = staff.filter(
      (s) => isWithinShift(slot, s.start, s.end) && !findActiveBlock(slot, s.blocks)
    );
    const alreadyOnBreak = onShiftNow.filter((s) => {
      const st = state.get(s.id)!;
      return st.restRemaining > 0 && st.restIsBreak;
    }).length;
    const peakDemandDuringBreak = maxOpenPositionsDuringBreakFrom(slotIndex);
    const safeBreakSurplus = Math.max(0, onShiftNow.length - peakDemandDuringBreak);
    newBreaksThisSlot = 0;
    maxNewBreaksThisSlot = Math.max(0, safeBreakSurplus - alreadyOnBreak);

    // Staff who are off shift or blocked out (meetings, etc.) are
    // unavailable this slot. Anyone still resting from an earlier stop, or
    // still working past the end of their target break window without a
    // break yet, is forced into (or upgraded to) the real break now — this
    // overrides everything else, including a stint still in progress or
    // protected by the minimum position length, since it's a hard guarantee
    // rather than a fairness choice.
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
      const t = toMinutes(slot);
      if (st.restRemaining > 0) {
        // An idle gap already running when the target window opens becomes
        // the real break from this point on, instead of leaving it as a
        // long idle stretch and forcing a separate break later.
        if (!st.restIsBreak) tryStartBreak(s, slot);
        staffTimeline[s.id][slot] = { status: st.restIsBreak ? "BREAK" : "IDLE" };
        st.restRemaining -= slotMinutes;
        if (!st.restIsBreak) st.idleMinutes += slotMinutes;
        st.elapsedMinutes += slotMinutes;
        continue;
      }
      const remainingShiftMinutes = toMinutes(s.end) - t;
      if (!st.hasHadBreak && remainingShiftMinutes <= settings.minBreakLength) {
        // Absolute last resort: there's no more shift time to spare, so
        // this ignores the stagger cap — the one-break guarantee must never
        // actually be missed.
        st.currentPositionId = null;
        st.continuousMinutes = 0;
        st.hasHadBreak = true;
        st.restIsBreak = true;
        st.restRemaining = settings.minBreakLength - slotMinutes;
        st.elapsedMinutes += slotMinutes;
        staffTimeline[s.id][slot] = { status: "BREAK" };
        continue;
      }
      if (!st.hasHadBreak && t >= windowEndMinutes.get(s.id)! && tryStartBreak(s, slot, 1)) {
        // Past the target window: start the break now. At least one person
        // gets through even with zero calculated surplus, so a team with no
        // slack still makes progress each slot rather than deferring
        // everyone all the way to the absolute cutoff above.
        st.currentPositionId = null;
        st.continuousMinutes = 0;
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
    // genuinely idle (no minimum) otherwise. Either way, if this idle
    // stretch is still going once the target window opens, it becomes the
    // real break instead of an ever-longer idle run.
    for (const s of finalSeekers) {
      const st = state.get(s.id)!;
      const hadPosition = wasWorking.get(s.id) ?? false;
      if (hadPosition) {
        applyStop(s, slot);
      } else {
        st.currentPositionId = null;
        st.continuousMinutes = 0;
        st.elapsedMinutes += slotMinutes;
        if (tryStartBreak(s, slot)) {
          staffTimeline[s.id][slot] = { status: "BREAK" };
        } else {
          st.idleMinutes += slotMinutes;
          staffTimeline[s.id][slot] = { status: "IDLE" };
        }
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

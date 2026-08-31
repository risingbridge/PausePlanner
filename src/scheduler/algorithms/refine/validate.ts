import { findActiveBlock, isWithinShift, SLOT_MINUTES } from "../../../utils/time";
import type { Action } from "../../shared/action";
import type { RefineContext } from "./context";

// Unlike Thorough (which validates incrementally, slot by slot, while a
// schedule is still under construction), Refine's moves always start from
// and produce a *complete* candidate schedule, so it's simplest and safest
// to just replay each person's whole day and confirm the declared actions
// correspond to a legal run of the same state machine every other mode
// uses — one hard-rule violation anywhere and the candidate is rejected
// outright, never repaired.
export function isValidSchedule(decisions: Action[][], ctx: RefineContext): boolean {
  for (let t = 0; t < ctx.slots.length; t++) {
    const openIds = new Set(ctx.openPositionsBySlot[t].map((p) => p.id));
    const claimed = new Set<string>();
    for (let i = 0; i < ctx.staff.length; i++) {
      const a = decisions[t][i];
      if (a.kind === "WORK") {
        if (!openIds.has(a.positionId)) return false;
        if (claimed.has(a.positionId)) return false;
        claimed.add(a.positionId);
      }
    }
  }

  for (let i = 0; i < ctx.staff.length; i++) {
    if (!isValidPersonTimeline(decisions, i, ctx)) return false;
  }
  return true;
}

function isValidPersonTimeline(decisions: Action[][], i: number, ctx: RefineContext): boolean {
  const s = ctx.staff[i];
  let positionId: string | null = null;
  let continuousMinutes = 0;
  let hasHadBreak = false;
  let breakRemaining = 0;
  let idleRemaining = 0;

  for (let t = 0; t < ctx.slots.length; t++) {
    const slot = ctx.slots[t];
    const action = decisions[t][i];

    if (!isWithinShift(slot, s.start, s.end)) {
      if (action.kind !== "OFF") return false;
      positionId = null;
      continuousMinutes = 0;
      continue;
    }
    if (findActiveBlock(slot, s.blocks)) {
      if (action.kind !== "BLOCKED") return false;
      positionId = null;
      continuousMinutes = 0;
      continue;
    }
    if (breakRemaining > 0) {
      if (action.kind !== "BREAK") return false;
      breakRemaining -= SLOT_MINUTES;
      positionId = null;
      continuousMinutes = 0;
      continue;
    }
    if (idleRemaining > 0) {
      if (action.kind !== "IDLE") return false;
      idleRemaining -= SLOT_MINUTES;
      positionId = null;
      continuousMinutes = 0;
      continue;
    }

    const openIds = new Set(ctx.openPositionsBySlot[t].map((p) => p.id));
    const holdingOpen = positionId !== null && openIds.has(positionId);
    const forcedOff =
      positionId !== null && (!openIds.has(positionId) || continuousMinutes + SLOT_MINUTES > ctx.settings.maxTimeInPosition);
    const canVoluntarilyLeave = holdingOpen && !forcedOff && continuousMinutes >= ctx.settings.minPositionLength;
    const freeToChoose = positionId === null || forcedOff || canVoluntarilyLeave;

    if (action.kind === "OFF" || action.kind === "BLOCKED") return false;

    if (action.kind === "WORK") {
      if (positionId !== null && !(holdingOpen && !forcedOff && action.positionId === positionId)) return false;
      const continuing = positionId === action.positionId;
      continuousMinutes = continuing ? continuousMinutes + SLOT_MINUTES : SLOT_MINUTES;
      positionId = action.positionId;
      if (continuousMinutes > ctx.settings.maxTimeInPosition) return false;
      continue;
    }

    if (!freeToChoose) return false;

    if (action.kind === "BREAK") {
      if (hasHadBreak || !ctx.breakDomainByStaff[i].has(t)) return false;
      hasHadBreak = true;
      breakRemaining = ctx.settings.minBreakLength - SLOT_MINUTES;
      positionId = null;
      continuousMinutes = 0;
      continue;
    }

    idleRemaining = ctx.settings.minIdleTime - SLOT_MINUTES;
    positionId = null;
    continuousMinutes = 0;
  }

  return hasHadBreak || ctx.breakDomainByStaff[i].size === 0;
}

import type { Position } from "../../../types";
import { findActiveBlock, isWithinShift, SLOT_MINUTES } from "../../../utils/time";
import type { SearchContext } from "./context";
import type { Action } from "../../shared/action";
import { stateSignature, type PersonState } from "./state";

type FreeOption = { kind: "work"; positionId: string } | { kind: "break" } | { kind: "idle" };

export interface SlotOutcome {
  actions: Action[];
  nextStates: PersonState[];
  unstaffedThisSlot: number;
}

// A free person's legal single-slot choices, derived purely from their
// current state — this is what makes minPositionLength protection, the
// max-time cap, and the no-direct-bounce rule fall out naturally instead of
// needing separate "protected"/"forced" bookkeeping: a protected claimant
// simply has exactly one legal option (continue), and a forced-off claimant
// never has a "work" option pointing at a *different* position, only idle
// or break. `openPositions` is passed in rather than read from
// ctx.openPositionsBySlot directly so a caller can exclude positions
// already claimed by someone else's requirement this slot — from this
// person's point of view that position is exactly as unavailable as one
// that's genuinely closed, which is what makes losing it to someone else's
// requirement correctly evict/force them off via the exact same path a
// closing position already does, no separate eviction logic needed.
function legalOptionsFor(
  state: PersonState,
  t: number,
  staffIndex: number,
  ctx: SearchContext,
  openPositions: Position[]
): FreeOption[] {
  const settings = ctx.settings;
  const openIds = new Set(openPositions.map((p) => p.id));

  const holdingOpen = state.positionId !== null && openIds.has(state.positionId);
  const forcedOff =
    state.positionId !== null &&
    (!openIds.has(state.positionId) || state.continuousMinutes + SLOT_MINUTES > settings.maxTimeInPosition);
  const canVoluntarilyLeave = holdingOpen && !forcedOff && state.continuousMinutes >= settings.minPositionLength;
  const freeToChoose = state.positionId === null || forcedOff || canVoluntarilyLeave;

  const options: FreeOption[] = [];

  if (holdingOpen && !forcedOff) {
    options.push({ kind: "work", positionId: state.positionId! });
  }
  if (state.positionId === null) {
    for (const p of openPositions) options.push({ kind: "work", positionId: p.id });
  }
  if (freeToChoose) {
    options.push({ kind: "idle" });
    if (!state.hasHadBreak && ctx.breakDomainByStaff[staffIndex].has(t)) {
      options.push({ kind: "break" });
    }
  }

  return options;
}

function optionRank(opt: FreeOption): string {
  return opt.kind === "work" ? `0:${opt.positionId}` : opt.kind === "idle" ? "1" : "2";
}

// Enumerates every valid joint assignment of the slot's free people,
// breaking symmetry among any who currently share an identical state:
// among such a group, only assignments in non-decreasing option rank are
// generated, which discards every permutation-duplicate branch without
// ever discarding a genuinely distinct outcome.
function enumerateJointAssignments(
  freeIndices: number[],
  optionsByIndex: Map<number, FreeOption[]>,
  states: PersonState[],
  budget: { nodes: number; limit: number; deadlineMs: number }
): Array<Map<number, FreeOption>> {
  const withSig = freeIndices
    .map((index) => ({ index, sig: stateSignature(states[index]) }))
    .sort((a, b) => (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : a.index - b.index));

  const results: Array<Map<number, FreeOption>> = [];
  const current = new Map<number, FreeOption>();

  function recurse(pos: number, claimed: Set<string>, prevSig: string | null, prevRank: string | null) {
    budget.nodes++;
    if (budget.nodes > budget.limit || Date.now() > budget.deadlineMs) return;
    if (pos === withSig.length) {
      results.push(new Map(current));
      return;
    }
    const { index, sig } = withSig[pos];
    const sameAsPrev = sig === prevSig;
    for (const opt of optionsByIndex.get(index)!) {
      if (opt.kind === "work" && claimed.has(opt.positionId)) continue;
      const rank = optionRank(opt);
      if (sameAsPrev && prevRank !== null && rank < prevRank) continue;
      const nextClaimed = opt.kind === "work" ? new Set(claimed).add(opt.positionId) : claimed;
      current.set(index, opt);
      recurse(pos + 1, nextClaimed, sig, rank);
      current.delete(index);
    }
  }

  recurse(0, new Set(), null, null);
  return results;
}

export function enumerateSlotOutcomes(
  t: number,
  states: PersonState[],
  ctx: SearchContext,
  budget: { nodes: number; limit: number; deadlineMs: number }
): SlotOutcome[] {
  const slot = ctx.slots[t];
  const slotMinutes = SLOT_MINUTES;
  const allOpenPositions = ctx.openPositionsBySlot[t];

  const baseActions: (Action | null)[] = new Array(ctx.staff.length).fill(null);
  const baseNextStates: PersonState[] = new Array(ctx.staff.length);
  const freeIndices: number[] = [];
  const requiredByIndex = new Map<number, string>();

  for (let i = 0; i < ctx.staff.length; i++) {
    const s = ctx.staff[i];
    const st = states[i];
    if (!isWithinShift(slot, s.start, s.end)) {
      baseActions[i] = { kind: "OFF" };
      baseNextStates[i] = { ...st, positionId: null, continuousMinutes: 0 };
      continue;
    }
    const block = findActiveBlock(slot, s.blocks);
    if (block) {
      baseActions[i] = { kind: "BLOCKED", label: block.label };
      baseNextStates[i] = { ...st, positionId: null, continuousMinutes: 0 };
      continue;
    }
    const requiredPositionId = ctx.requiredPositionByStaffSlot[i].get(t);
    if (requiredPositionId !== undefined) {
      requiredByIndex.set(i, requiredPositionId);
      continue;
    }
    if (st.breakRemaining > 0) {
      baseActions[i] = { kind: "BREAK" };
      baseNextStates[i] = {
        ...st,
        positionId: null,
        continuousMinutes: 0,
        breakRemaining: st.breakRemaining - slotMinutes,
      };
      continue;
    }
    if (st.idleRemaining > 0) {
      baseActions[i] = { kind: "IDLE" };
      baseNextStates[i] = {
        ...st,
        positionId: null,
        continuousMinutes: 0,
        idleRemaining: st.idleRemaining - slotMinutes,
        idleMinutes: st.idleMinutes + slotMinutes,
        elapsedMinutes: st.elapsedMinutes + slotMinutes,
      };
      continue;
    }
    freeIndices.push(i);
  }

  // Required assignments are resolved as a group, once every claim this
  // slot is known: a requirement always wins the position it names — an
  // unavoidable same-slot bounce into it (this person was mid-stint in a
  // *different* position with no rest in between) makes this slot
  // impossible to complete legally, so the whole outcome set is empty
  // rather than silently letting the bounce through.
  const requiredPositionIds = new Set(requiredByIndex.values());
  for (const [i, positionId] of requiredByIndex) {
    const st = states[i];
    if (st.positionId !== null && st.positionId !== positionId) {
      return [];
    }
    const isRequirementStart = ctx.requirementStartSlotByStaff[i].has(t);
    baseActions[i] = { kind: "WORK", positionId };
    baseNextStates[i] = {
      ...st,
      positionId,
      continuousMinutes: isRequirementStart ? slotMinutes : st.continuousMinutes + slotMinutes,
      elapsedMinutes: st.elapsedMinutes + slotMinutes,
    };
  }

  const openPositions = allOpenPositions.filter((p) => !requiredPositionIds.has(p.id));

  if (freeIndices.length === 0) {
    return [{ actions: baseActions as Action[], nextStates: baseNextStates, unstaffedThisSlot: openPositions.length }];
  }

  const optionsByIndex = new Map<number, FreeOption[]>();
  for (const i of freeIndices) optionsByIndex.set(i, legalOptionsFor(states[i], t, i, ctx, openPositions));

  const jointAssignments = enumerateJointAssignments(freeIndices, optionsByIndex, states, budget);

  return jointAssignments.map((assignment) => {
    const actions = baseActions.slice();
    const nextStates = baseNextStates.slice();
    const claimed = new Set<string>();

    for (const i of freeIndices) {
      const opt = assignment.get(i)!;
      const st = states[i];
      if (opt.kind === "work") {
        actions[i] = { kind: "WORK", positionId: opt.positionId };
        claimed.add(opt.positionId);
        const continuing = st.positionId === opt.positionId;
        nextStates[i] = {
          ...st,
          positionId: opt.positionId,
          continuousMinutes: continuing ? st.continuousMinutes + slotMinutes : slotMinutes,
          elapsedMinutes: st.elapsedMinutes + slotMinutes,
        };
      } else if (opt.kind === "break") {
        // Break time counts toward neither idleMinutes nor elapsedMinutes —
        // a real rest shouldn't move the fairness ratio either way, same as
        // time outside the shift.
        actions[i] = { kind: "BREAK" };
        nextStates[i] = {
          ...st,
          positionId: null,
          continuousMinutes: 0,
          hasHadBreak: true,
          breakRemaining: ctx.settings.minBreakLength - slotMinutes,
        };
      } else {
        actions[i] = { kind: "IDLE" };
        nextStates[i] = {
          ...st,
          positionId: null,
          continuousMinutes: 0,
          idleRemaining: ctx.settings.minIdleTime - slotMinutes,
          idleMinutes: st.idleMinutes + slotMinutes,
          elapsedMinutes: st.elapsedMinutes + slotMinutes,
        };
      }
    }

    let unstaffedThisSlot = 0;
    for (const p of openPositions) {
      if (!claimed.has(p.id)) unstaffedThisSlot++;
    }

    return { actions: actions as Action[], nextStates, unstaffedThisSlot };
  });
}

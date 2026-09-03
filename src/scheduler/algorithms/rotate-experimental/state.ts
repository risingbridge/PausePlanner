import type { Staff } from "../../../types";

export interface PersonState {
  positionId: string | null;
  continuousMinutes: number;
  hasHadBreak: boolean;
  breakRemaining: number;
  idleRemaining: number;
  idleMinutes: number;
  elapsedMinutes: number;
  // Cumulative minutes this person has spent in each position so far,
  // indexed the same way as ctx.positions — the rotation objective's whole
  // reason for existing. Carried in state (not derived from the decision
  // log at the leaf, the way idleMinutes/churn/breakCentering already are)
  // because the search needs it mid-node, twice over: to bound the
  // objective for pruning, and to keep symmetry-breaking sound (see
  // stateSignature below).
  positionMinutes: number[];
}

export function initialState(positionCount: number): PersonState {
  return {
    positionId: null,
    continuousMinutes: 0,
    hasHadBreak: false,
    breakRemaining: 0,
    idleRemaining: 0,
    idleMinutes: 0,
    elapsedMinutes: 0,
    positionMinutes: new Array(positionCount).fill(0),
  };
}

export function initialStates(staff: Staff[], positionCount: number): PersonState[] {
  return staff.map(() => initialState(positionCount));
}

// Two people are only ever treated as interchangeable by the symmetry
// breaker when every one of these fields matches exactly, so the reduction
// is always sound (never collapses two branches that could legally
// diverge). positionMinutes has to be part of that comparison here: two
// people who are otherwise identical but have spent their day differently
// across positions are *not* interchangeable for the rotation objective —
// assigning the under-served one to an open position is a genuinely
// different (and likely better) outcome than assigning the other, even
// though Thorough (Experimental)'s own symmetry-breaking would have
// treated them as the same. The cost is a larger signature space (fewer
// merges in phase 1's dominance pruning, a bigger tree) — an accepted
// tradeoff, not an oversight.
export function stateSignature(s: PersonState): string {
  return `${s.positionId ?? ""}|${s.continuousMinutes}|${s.hasHadBreak ? 1 : 0}|${s.breakRemaining}|${s.idleRemaining}|${s.idleMinutes}|${s.elapsedMinutes}|${s.positionMinutes.join(",")}`;
}

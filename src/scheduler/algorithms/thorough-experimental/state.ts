import type { Staff } from "../../../types";

export interface PersonState {
  positionId: string | null;
  continuousMinutes: number;
  hasHadBreak: boolean;
  breakRemaining: number;
  idleRemaining: number;
  idleMinutes: number;
  elapsedMinutes: number;
}

export function initialState(): PersonState {
  return {
    positionId: null,
    continuousMinutes: 0,
    hasHadBreak: false,
    breakRemaining: 0,
    idleRemaining: 0,
    idleMinutes: 0,
    elapsedMinutes: 0,
  };
}

export function initialStates(staff: Staff[]): PersonState[] {
  return staff.map(() => initialState());
}

// Two people are only ever treated as interchangeable by the symmetry
// breaker when every one of these fields matches exactly, so the reduction
// is always sound (never collapses two branches that could legally diverge).
export function stateSignature(s: PersonState): string {
  return `${s.positionId ?? ""}|${s.continuousMinutes}|${s.hasHadBreak ? 1 : 0}|${s.breakRemaining}|${s.idleRemaining}|${s.idleMinutes}|${s.elapsedMinutes}`;
}

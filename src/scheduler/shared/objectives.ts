import type { Staff } from "../../types";
import { SLOT_MINUTES, toMinutes } from "../../utils/time";
import type { ScheduleSettings } from "../types";
import type { Action } from "./action";

// A lexicographic tuple, always compared in this order: fairness variance,
// then churn, then break-off-center cost (all "lower is better", so
// break-centering is stored as a cost to minimize rather than a score to
// maximize, keeping every element of the tuple minimize-oriented). Shared
// between Thorough (which compares this as a tuple) and Refine (which
// folds it into one weighted score) so both modes agree on exactly what
// "fairer", "calmer", and "better-centered" mean.
export type SecondaryCost = [number, number, number];

export function compareSecondary(a: SecondaryCost, b: SecondaryCost): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// Derives idleMinutes/elapsedMinutes per staff index directly from status
// counts in a decision log — cheaper than replaying the full per-person
// state machine, and the only fairness inputs fairnessVariance needs.
export function deriveFairnessInputs(decisions: Action[][], staffCount: number): Array<{ idleMinutes: number; elapsedMinutes: number }> {
  const idleMinutes = new Array(staffCount).fill(0);
  const elapsedMinutes = new Array(staffCount).fill(0);
  for (const slotActions of decisions) {
    for (let i = 0; i < staffCount; i++) {
      const action = slotActions[i];
      if (action.kind === "IDLE") {
        idleMinutes[i] += SLOT_MINUTES;
        elapsedMinutes[i] += SLOT_MINUTES;
      } else if (action.kind === "WORK") {
        elapsedMinutes[i] += SLOT_MINUTES;
      }
    }
  }
  return idleMinutes.map((im, i) => ({ idleMinutes: im, elapsedMinutes: elapsedMinutes[i] }));
}

// Only idleMinutes/elapsedMinutes are read, so any per-person running
// totals satisfy this — Thorough's full PersonState included.
export function fairnessVariance(rates: Array<{ idleMinutes: number; elapsedMinutes: number }>): number {
  const idleRates = rates.map((s) => (s.elapsedMinutes === 0 ? 0 : s.idleMinutes / s.elapsedMinutes));
  const mean = idleRates.reduce((a, b) => a + b, 0) / (idleRates.length || 1);
  return idleRates.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (idleRates.length || 1);
}

export function churnCount(decisions: Action[][], staffCount: number): number {
  let churn = 0;
  for (let i = 0; i < staffCount; i++) {
    let lastStintPosition: string | null = null;
    let inStint = false;
    for (const slotActions of decisions) {
      const action = slotActions[i];
      if (action.kind === "WORK") {
        if (!inStint) {
          if (lastStintPosition !== null && lastStintPosition !== action.positionId) churn++;
          lastStintPosition = action.positionId;
        }
        inStint = true;
      } else {
        inStint = false;
      }
    }
  }
  return churn;
}

export function breakOffCenterCost(decisions: Action[][], staff: Staff[], slots: string[], settings: ScheduleSettings): number {
  let total = 0;
  for (let i = 0; i < staff.length; i++) {
    const s = staff[i];
    const shiftStart = toMinutes(s.start);
    const shiftEnd = toMinutes(s.end);
    const idealMid = shiftStart + ((shiftEnd - shiftStart) * (settings.earliestBreakPercent + settings.latestBreakPercent)) / 200;

    let breakStart = -1;
    let breakSlots = 0;
    for (let t = 0; t < decisions.length; t++) {
      if (decisions[t][i].kind === "BREAK") {
        if (breakStart === -1) breakStart = t;
        breakSlots++;
      }
    }
    if (breakStart === -1) continue;
    const actualMid = toMinutes(slots[breakStart]) + (breakSlots * SLOT_MINUTES) / 2;
    total += Math.abs(actualMid - idealMid);
  }
  return total;
}

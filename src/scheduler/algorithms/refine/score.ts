import type { Action } from "../../shared/action";
import { breakOffCenterCost, churnCount, deriveFairnessInputs, fairnessVariance } from "../../shared/objectives";
import type { RefineContext } from "./context";

// Coverage dominates by a wide margin (1000 per unstaffed slot vs. single
// or double digits for everything else), so annealing's occasional
// worse-move acceptance almost never regresses it in practice — the
// temperatures this mode runs at make exp(-1000/T) vanishingly small — while
// still leaving real room to explore fairness/churn/break-centering
// tradeoffs early in the run.
const UNSTAFFED_WEIGHT = 1000;
const FAIRNESS_WEIGHT = 10;
const CHURN_WEIGHT = 3;

export function unstaffedCount(decisions: Action[][], ctx: RefineContext): number {
  let count = 0;
  for (let t = 0; t < ctx.slots.length; t++) {
    const claimed = new Set<string>();
    for (let i = 0; i < ctx.staff.length; i++) {
      const a = decisions[t][i];
      if (a.kind === "WORK") claimed.add(a.positionId);
    }
    for (const p of ctx.openPositionsBySlot[t]) {
      if (!claimed.has(p.id)) count++;
    }
  }
  return count;
}

export function score(decisions: Action[][], ctx: RefineContext): number {
  const unstaffed = unstaffedCount(decisions, ctx);
  const variance = fairnessVariance(deriveFairnessInputs(decisions, ctx.staff.length));
  const churn = churnCount(decisions, ctx.staff.length);
  const offCenter = breakOffCenterCost(decisions, ctx.staff, ctx.slots, ctx.settings);
  return UNSTAFFED_WEIGHT * unstaffed + FAIRNESS_WEIGHT * variance + CHURN_WEIGHT * churn + offCenter;
}

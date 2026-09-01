import type { Action } from "../../shared/action";
import { breakOffCenterCost, churnCount, compareSecondary, fairnessVariance, type SecondaryCost } from "../../shared/objectives";
import { enumerateSlotOutcomes } from "./branch";
import type { SearchContext } from "./context";
import { stateSignature, type PersonState } from "./state";

// The one genuinely fiddly hard rule: a person can only be forced onto
// their break by *choosing* it at some slot inside their domain, and
// nothing else forces that choice. Without this check the search can reach
// a "0 unstaffed" leaf that simply never gave anyone a break — technically
// better on the primary objective, but not a valid schedule at all. Once a
// person's domain has no slot left at or after `nextT`, no continuation of
// this branch can ever satisfy their break, so it's a proven dead end and
// safe to prune outright rather than only discovering it at the leaf.
function hasDeadEnd(nextStates: PersonState[], nextT: number, ctx: SearchContext): boolean {
  for (let i = 0; i < nextStates.length; i++) {
    if (nextStates[i].hasHadBreak) continue;
    if (ctx.breakDomainByStaff[i].size === 0) continue;
    if (nextT > ctx.latestBreakDomainSlot[i]) return true;
  }
  return false;
}

// Redundant with hasDeadEnd (which, applied to every transition including
// the one into the final slot, already guarantees this can't fail) — kept
// as a cheap final check given how severe silently accepting an invalid
// schedule would be.
function allBreaksSatisfied(states: PersonState[], ctx: SearchContext): boolean {
  for (let i = 0; i < states.length; i++) {
    if (!states[i].hasHadBreak && ctx.breakDomainByStaff[i].size > 0) return false;
  }
  return true;
}

export interface Phase1Result {
  cost: number;
  // null means the search never beat the warm start (which may itself
  // already be proven optimal via the lower-bound fast path below) — the
  // caller should keep using the warm start's own decisions in that case.
  decisions: Action[][] | null;
}

// Minimizes total unstaffed slots via branch-and-bound. The fast path is
// the whole trick this mode is built on: a warm-started incumbent that
// already matches the lower bound is proof of optimality with zero search.
export function searchPhase1(ctx: SearchContext, initialStates: PersonState[], warmStartCost: number): Phase1Result {
  if (warmStartCost <= ctx.suffixLowerBound[0]) {
    return { cost: warmStartCost, decisions: null };
  }

  let bestCost = warmStartCost;
  let bestDecisions: Action[][] | null = null;
  const visited = new Map<string, number>();
  const budget = { nodes: 0, limit: ctx.nodeBudget, deadlineMs: ctx.deadlineMs };
  const decisions: Action[][] = new Array(ctx.slots.length);

  function recurse(t: number, states: PersonState[], costSoFar: number) {
    budget.nodes++;
    if (budget.nodes > budget.limit || Date.now() > budget.deadlineMs) return;
    if (costSoFar + ctx.suffixLowerBound[t] >= bestCost) return;

    const key = `${t}|${states.map(stateSignature).join(",")}`;
    const seen = visited.get(key);
    if (seen !== undefined && seen <= costSoFar) return;
    visited.set(key, costSoFar);

    if (t === ctx.slots.length) {
      if (costSoFar < bestCost && allBreaksSatisfied(states, ctx)) {
        bestCost = costSoFar;
        bestDecisions = decisions.slice(0, t);
      }
      return;
    }

    for (const outcome of enumerateSlotOutcomes(t, states, ctx, budget)) {
      if (hasDeadEnd(outcome.nextStates, t + 1, ctx)) continue;
      decisions[t] = outcome.actions;
      recurse(t + 1, outcome.nextStates, costSoFar + outcome.unstaffedThisSlot);
      if (budget.nodes > budget.limit || Date.now() > budget.deadlineMs) return;
    }
  }

  recurse(0, initialStates, 0);
  return { cost: bestCost, decisions: bestDecisions };
}

export interface Phase2Result {
  decisions: Action[][];
  secondaryCost: SecondaryCost;
}

// Exhaustively (within budget) explores every schedule that still hits the
// proven-optimal unstaffed count U*, keeping the lexicographically best by
// [fairness variance, churn, break-off-center cost]. Deliberately skips the
// dominance/memoization used in phase 1: PersonState alone doesn't capture
// enough history to compare two paths' churn so far, so treating equal
// PersonStates as interchangeable here could silently discard the
// lower-churn path — unsound for this phase even though it's sound for
// phase 1, where only the (fully-PersonState-determined) unstaffed count
// is ever compared.
export function searchPhase2(
  ctx: SearchContext,
  initialStates: PersonState[],
  targetUnstaffed: number,
  seedDecisions: Action[][],
  seedSecondaryCost: SecondaryCost
): Phase2Result {
  let bestSecondary = seedSecondaryCost;
  let bestDecisions = seedDecisions;
  const budget = { nodes: 0, limit: ctx.nodeBudget, deadlineMs: ctx.deadlineMs };
  const decisions: Action[][] = new Array(ctx.slots.length);

  function recurse(t: number, states: PersonState[], unstaffedSoFar: number) {
    budget.nodes++;
    if (budget.nodes > budget.limit || Date.now() > budget.deadlineMs) return;
    if (unstaffedSoFar + ctx.suffixLowerBound[t] > targetUnstaffed) return;

    if (t === ctx.slots.length) {
      if (unstaffedSoFar !== targetUnstaffed) return;
      if (!allBreaksSatisfied(states, ctx)) return;
      const full = decisions.slice(0, t);
      const secondary: SecondaryCost = [
        fairnessVariance(states),
        churnCount(full, ctx.staff.length),
        breakOffCenterCost(full, ctx.staff, ctx.slots, ctx.settings),
      ];
      if (compareSecondary(secondary, bestSecondary) < 0) {
        bestSecondary = secondary;
        bestDecisions = full;
      }
      return;
    }

    for (const outcome of enumerateSlotOutcomes(t, states, ctx, budget)) {
      if (hasDeadEnd(outcome.nextStates, t + 1, ctx)) continue;
      decisions[t] = outcome.actions;
      recurse(t + 1, outcome.nextStates, unstaffedSoFar + outcome.unstaffedThisSlot);
      if (budget.nodes > budget.limit || Date.now() > budget.deadlineMs) return;
    }
  }

  recurse(0, initialStates, 0);
  return { decisions: bestDecisions, secondaryCost: bestSecondary };
}

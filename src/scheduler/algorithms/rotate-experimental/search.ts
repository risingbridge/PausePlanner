import type { Action } from "../../shared/action";
import { breakOffCenterCost, churnCount, fairnessVariance } from "../../shared/objectives";
import { enumerateSlotOutcomes } from "./branch";
import type { SearchContext } from "./context";
import { positionImbalanceLowerBound, positionImbalanceScore } from "./positionBalance";
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

// Minimizes total unstaffed slots via branch-and-bound. Unchanged from
// Thorough (Experimental): rotation is a lower-priority objective and must
// never influence this phase's own decisions about what counts as better.
// The fast path is the whole trick this mode is built on: a warm-started
// incumbent that already matches the lower bound is proof of optimality
// with zero search.
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

// [position-imbalance, idle-fairness, churn, break-off-center], always
// compared in that order — the one addition to Thorough (Experimental)'s
// secondary objective, slotted in second (right after coverage) per
// Algorithm-RotateExperimental.md's "variety over calm" placement. Local to
// this fork rather than added to shared/objectives.ts's 3-element
// SecondaryCost: Thorough and Refine have no notion of position balance and
// must not be forced to carry a 4th slot they never fill in.
export type RotateSecondaryCost = [number, number, number, number];

export function compareRotateSecondary(a: RotateSecondaryCost, b: RotateSecondaryCost): number {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export interface Phase2Result {
  decisions: Action[][];
  secondaryCost: RotateSecondaryCost;
}

// Exhaustively (within budget) explores every schedule that still hits the
// proven-optimal unstaffed count U*, keeping the lexicographically best by
// [position imbalance, idle fairness, churn, break-off-center]. Deliberately
// skips the dominance/memoization used in phase 1, same as the parent:
// PersonState alone doesn't capture enough history to compare two paths'
// churn (or, now, their position matrices) so far, so treating equal
// PersonStates as interchangeable here could silently discard a better
// path.
//
// The one thing this fork adds beyond the parent's phase 2: a bound-cut
// against the position-imbalance term specifically, mirroring phase 1's own
// coverage cut. It's sound to compare against bestSecondary[0] alone (not
// the whole tuple) because [imbalance, ...] is compared lexicographically —
// a branch whose best *possible* imbalance already exceeds the best
// *achieved* imbalance so far can never win, regardless of how its idle
// fairness/churn/break-centering turn out. Strict '>' (not '>='), unlike
// phase 1's cut: a tie on imbalance can still be won on a later tuple
// element, so equal-bound branches must stay open.
export function searchPhase2(
  ctx: SearchContext,
  initialStates: PersonState[],
  targetUnstaffed: number,
  seedDecisions: Action[][],
  seedSecondaryCost: RotateSecondaryCost
): Phase2Result {
  let bestSecondary = seedSecondaryCost;
  let bestDecisions = seedDecisions;
  const budget = { nodes: 0, limit: ctx.nodeBudget, deadlineMs: ctx.deadlineMs };
  const decisions: Action[][] = new Array(ctx.slots.length);

  function recurse(t: number, states: PersonState[], unstaffedSoFar: number) {
    budget.nodes++;
    if (budget.nodes > budget.limit || Date.now() > budget.deadlineMs) return;
    if (unstaffedSoFar + ctx.suffixLowerBound[t] > targetUnstaffed) return;
    if (positionImbalanceLowerBound(states, t, ctx.positionIdeal, ctx.maxRemainingSuffix) > bestSecondary[0]) return;

    if (t === ctx.slots.length) {
      if (unstaffedSoFar !== targetUnstaffed) return;
      if (!allBreaksSatisfied(states, ctx)) return;
      const full = decisions.slice(0, t);
      const secondary: RotateSecondaryCost = [
        positionImbalanceScore(states, ctx.positionIdeal),
        fairnessVariance(states),
        churnCount(full, ctx.staff.length),
        breakOffCenterCost(full, ctx.staff, ctx.slots, ctx.settings),
      ];
      if (compareRotateSecondary(secondary, bestSecondary) < 0) {
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

import type { OpeningsGrid, Position, ScheduleResult, Staff } from "../../../types";
import { generateSlots } from "../../../utils/time";
import type { AlgorithmProgress, ScheduleSettings } from "../../types";
import { runBalanced } from "../balanced";
import { runQuick } from "../quick";
import { decodeSolution } from "./decode";
import { getHighs, type HighsOptions, type HighsSolution } from "./highsClient";
import type { LpTerm } from "./lpBuilder";
import { buildModel } from "./model";
import {
  breakQualityTerms,
  churnTerms,
  computeFairShare,
  coverageTerms,
  idleFairnessTerms,
  positionFairnessTerms,
} from "./objectives";

// Fixed so the same input always produces the same schedule (§7's
// determinism requirement) — a manager re-generating the same week twice
// should get the same answer, not a different equally-optimal one.
const RANDOM_SEED = 42;

// 10s + 10s + 15s + 5s + 5s = 45s worst case. Raised from an original 25s
// after diagnosing a real complaint on a real 5-staff instance: position
// fairness and idle fairness were both frequently timing out before
// finding *any* feasible incumbent (not just before proving optimality),
// and giving idle fairness alone 30s (vs. its original 5s) took it from a
// non-optimal 0.104 to a proven-optimal 0.021 — a ~5x tighter balance.
// coverage and churn keep their (already generous, never observed to be a
// bottleneck) budgets; position fairness and idle fairness get most of the
// increase, split unevenly in idle fairness's favor since it showed the
// clearer, more direct evidence of being time-starved and is the stage
// that most affects what a person actually experiences (how much idle
// time they get, not just which position their work lands on).
const STAGE_TIME_LIMITS = {
  coverage: 10,
  positionFairness: 10,
  idleFairness: 15,
  breakQuality: 5,
  churn: 5,
};

// The only granularity actually available — see AlgorithmProgress's own
// doc comment for why this can't be a smooth percentage.
const TOTAL_STAGES = 5;
const STAGE_LABELS = ["Coverage", "Position fairness", "Idle fairness", "Break quality", "Churn"];

const FAILURE_STATUSES = new Set([
  "Infeasible",
  "Primal infeasible or unbounded",
  "Unbounded",
  "Model error",
  "Load error",
  "Solve error",
  "Presolve error",
  "Postsolve error",
  "Empty",
  "Not Set",
]);

export async function runMip(
  positions: Position[],
  openings: OpeningsGrid,
  staff: Staff[],
  settings: ScheduleSettings,
  wasmUrl: string,
  onProgress?: (progress: AlgorithmProgress) => void
): Promise<ScheduleResult> {
  const slots = generateSlots(settings.dayStart, settings.dayEnd);
  const hasRequirements = staff.some((s) => s.requirements.length > 0);
  // Quick and Balanced know nothing about requirements, so their coverage
  // count can't be trusted as a valid comparison baseline once any exist —
  // same reasoning Thorough (Experimental) uses for the identical problem.
  // Computed regardless (cheap, synchronous) so there's always a safety
  // net available for the common, requirement-free case: stage 1's solve
  // is time-boxed and not guaranteed to prove optimality, so without this,
  // MIP (HiGHS) would be the only mode in this app that could, in
  // principle, do worse on coverage than the faster modes before it.
  const quickResult = runQuick(positions, openings, staff, settings);
  const balancedResult = runBalanced(positions, openings, staff, settings);
  const warmStart = balancedResult.unstaffed.length <= quickResult.unstaffed.length ? balancedResult : quickResult;

  // buildModel throws synchronously (before any solve) for the one case
  // that's a genuine data contradiction rather than a matter of degree —
  // see its own doc comment.
  const model = buildModel(positions, openings, staff, slots, settings);
  const highs = await getHighs(wasmUrl);
  const baseOptions: HighsOptions = { random_seed: RANDOM_SEED };

  function solveStage(stageIndex: number, terms: LpTerm[], timeLimitSeconds: number): HighsSolution {
    onProgress?.({ stage: stageIndex, totalStages: TOTAL_STAGES, label: STAGE_LABELS[stageIndex - 1] });
    model.lp.setObjective("Minimize", terms);
    const lpText = model.lp.build();
    const solution = highs.solve(lpText, { ...baseOptions, time_limit: timeLimitSeconds });
    if (FAILURE_STATUSES.has(solution.Status)) {
      throw new Error(
        `The solver could not find a valid schedule (status: "${solution.Status}"). This usually means the labor rules themselves are contradictory — e.g. minimum position length longer than the max-time-in-position cap — rather than a genuine coverage shortfall.`
      );
    }
    return solution;
  }

  // A stage can hit its time limit before finding *any* feasible integer
  // solution — not just before proving optimality — in which case
  // ObjectiveValue is Infinity. Freezing that as a "<= Infinity" bound
  // would either corrupt the LP text or leave the stage completely
  // unconstrained, either way silently discarding every guarantee every
  // later stage was supposed to inherit (this is exactly what caused a
  // real instance to regress from 0 to 3 unstaffed once idle fairness
  // landed — position fairness had timed out with no incumbent, and its
  // bogus frozen bound corrupted coverage for every stage after it, even
  // though coverage had already been correctly proven optimal at 0). When
  // that happens, this stage's objective is left unconstrained for later
  // stages instead — an honest "couldn't improve this dimension within
  // budget," never a silently wrong bound.
  function freezeIfFeasible(terms: LpTerm[], result: HighsSolution, epsilon = 1e-6): void {
    if (!Number.isFinite(result.ObjectiveValue)) return;
    model.lp.addConstraint(terms, "<=", result.ObjectiveValue + epsilon);
  }

  // Stage 1 — coverage. Frozen before stage 2 so fairness can never trade
  // away a covered position — §6's central discipline. Coverage timing out
  // with zero incumbent would mean this algorithm can't even establish
  // *some* valid schedule exists, which is different in kind from a later
  // stage failing to improve fairness — surfaced as a distinct, clear
  // error rather than silently proceeding with an unknown U*.
  const coverageResult = solveStage(1, coverageTerms(model), STAGE_TIME_LIMITS.coverage);
  if (!Number.isFinite(coverageResult.ObjectiveValue)) {
    throw new Error(
      "The solver couldn't establish a valid schedule at all within its time budget for this instance. Try a smaller or less constrained day, or a faster algorithm."
    );
  }
  const uStar = Math.round(coverageResult.ObjectiveValue);
  model.lp.addConstraint(coverageTerms(model), "<=", uStar);

  // Stage 2a — position fairness, net of requirement-forced minutes.
  const fairShare = computeFairShare(model);
  const posFairnessTerms = positionFairnessTerms(model, fairShare);
  const posFairnessResult = solveStage(2, posFairnessTerms, STAGE_TIME_LIMITS.positionFairness);
  freezeIfFeasible(posFairnessTerms, posFairnessResult);

  // Stage 2b — idle fairness (equal idle *ratio* across staff). Position
  // fairness alone doesn't guarantee this: someone available for more
  // position-windows than a colleague can hold an individually fair share
  // of every position while still ending up with substantially more total
  // work, and therefore less idle time, overall.
  const idleTerms = idleFairnessTerms(model, fairShare, uStar);
  const idleFairnessResult = solveStage(3, idleTerms, STAGE_TIME_LIMITS.idleFairness);
  freezeIfFeasible(idleTerms, idleFairnessResult);

  // Stage 2c — break quality, still ahead of churn per §6's ordering.
  const breakTerms = breakQualityTerms(model, settings);
  const breakQualityResult = solveStage(4, breakTerms, STAGE_TIME_LIMITS.breakQuality);
  freezeIfFeasible(breakTerms, breakQualityResult);

  // Stage 3 — churn, a pure tie-breaker among schedules already optimal on
  // everything above. If even *this* solve times out with no incumbent —
  // possible in principle after several rounds of added auxiliary
  // variables on a hard instance — fall back to whichever prior stage's
  // solution was last known-feasible rather than propagating Infinity into
  // decodeSolution.
  const churnResult = solveStage(5, churnTerms(model), STAGE_TIME_LIMITS.churn);
  // coverageResult is the ultimate fallback, not just the fourth choice —
  // its ObjectiveValue is already proven finite (checked right after it
  // was solved, above) — so this chain always ends on something decodable.
  const lastFeasible = [churnResult, breakQualityResult, idleFairnessResult, posFairnessResult, coverageResult].find(
    (r) => Number.isFinite(r.ObjectiveValue)
  )!;

  const finalResult = decodeSolution(model, lastFeasible, positions, openings);
  if (!hasRequirements && warmStart.unstaffed.length < finalResult.unstaffed.length) {
    return warmStart;
  }
  return finalResult;
}

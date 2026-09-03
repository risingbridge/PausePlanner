import type { OpeningsGrid, Position, ScheduleResult, Staff } from "../../../types";
import { generateSlots } from "../../../utils/time";
import type { AlgorithmProgress, ScheduleSettings } from "../../types";
import { runBalanced } from "../balanced";
import { runQuick } from "../quick";
import { decodeSolution } from "./decode";
import { getHighs, type HighsOptions, type HighsSolution } from "./highsClient";
import type { LpTerm } from "./lpBuilder";
import { buildModel } from "./model";
import { breakQualityTerms, churnTerms, computeFairShare, coverageTerms, positionFairnessTerms } from "./objectives";

// Fixed so the same input always produces the same schedule (§7's
// determinism requirement) — a manager re-generating the same week twice
// should get the same answer, not a different equally-optimal one.
const RANDOM_SEED = 42;

// 10s + 5s + 5s + 5s = 25s worst case, matching the design doc's suggested
// coverage/fairness/churn split — the doc's single "fairness" stage became
// two here (position balance, then break quality) because folding both
// into one weighted term would be exactly the "blend-by-weight" fragility
// §6 argues against; splitting the doc's 10s fairness budget across the
// two keeps the same total ceiling.
const STAGE_TIME_LIMITS = {
  coverage: 10,
  positionFairness: 5,
  breakQuality: 5,
  churn: 5,
};

// The only granularity actually available — see AlgorithmProgress's own
// doc comment for why this can't be a smooth percentage.
const TOTAL_STAGES = 4;
const STAGE_LABELS = ["Coverage", "Position fairness", "Break quality", "Churn"];

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

  // Stage 1 — coverage. Frozen before stage 2 so fairness can never trade
  // away a covered position — §6's central discipline.
  const coverageResult = solveStage(1, coverageTerms(model), STAGE_TIME_LIMITS.coverage);
  const uStar = Math.round(coverageResult.ObjectiveValue);
  model.lp.addConstraint(coverageTerms(model), "<=", uStar);

  // Stage 2a — position fairness, net of requirement-forced minutes.
  const fairShare = computeFairShare(model);
  const posFairnessTerms = positionFairnessTerms(model, fairShare);
  const posFairnessResult = solveStage(2, posFairnessTerms, STAGE_TIME_LIMITS.positionFairness);
  model.lp.addConstraint(posFairnessTerms, "<=", posFairnessResult.ObjectiveValue + 1e-6);

  // Stage 2b — break quality, still ahead of churn per §6's ordering.
  const breakTerms = breakQualityTerms(model, settings);
  const breakQualityResult = solveStage(3, breakTerms, STAGE_TIME_LIMITS.breakQuality);
  model.lp.addConstraint(breakTerms, "<=", breakQualityResult.ObjectiveValue + 1e-6);

  // Stage 3 — churn, a pure tie-breaker among schedules already optimal on
  // everything above.
  const churnResult = solveStage(4, churnTerms(model), STAGE_TIME_LIMITS.churn);

  const finalResult = decodeSolution(model, churnResult, positions, openings);
  if (!hasRequirements && warmStart.unstaffed.length < finalResult.unstaffed.length) {
    return warmStart;
  }
  return finalResult;
}

import type { AlgorithmId, OpeningsGrid, Position, ScheduleResult, Staff } from "../types";
import { ALGORITHM_LABELS } from "../types";
import { runBalanced } from "./algorithms/balanced";
import { runQuick } from "./algorithms/quick";
import { runRefineAsync } from "./algorithms/refine";
import { runThoroughAsync } from "./algorithms/thorough";
import { runThoroughExperimentalAsync } from "./algorithms/thorough-experimental";
import type { ScheduleSettings } from "./types";

export type { ScheduleSettings } from "./types";

export interface AlgorithmDefinition {
  id: AlgorithmId;
  label: string;
  // Thorough runs in a Web Worker and so is inherently async; Quick and
  // Balanced stay plain synchronous functions — a sync return still
  // satisfies this type, so neither needed to change for Thorough to slot
  // in here.
  run: (
    positions: Position[],
    openings: OpeningsGrid,
    staff: Staff[],
    settings: ScheduleSettings
  ) => ScheduleResult | Promise<ScheduleResult>;
}

export const ALGORITHMS: Record<AlgorithmId, AlgorithmDefinition> = {
  quick: { id: "quick", label: ALGORITHM_LABELS.quick, run: runQuick },
  balanced: { id: "balanced", label: ALGORITHM_LABELS.balanced, run: runBalanced },
  thorough: { id: "thorough", label: ALGORITHM_LABELS.thorough, run: runThoroughAsync },
  refine: { id: "refine", label: ALGORITHM_LABELS.refine, run: runRefineAsync },
  thoroughExperimental: {
    id: "thoroughExperimental",
    label: ALGORITHM_LABELS.thoroughExperimental,
    run: runThoroughExperimentalAsync,
  },
};

// Falls back to Quick for an unrecognized id — e.g. data exported by a
// future build referencing an algorithm this build doesn't know about.
export async function runScheduleAlgorithm(
  id: AlgorithmId,
  positions: Position[],
  openings: OpeningsGrid,
  staff: Staff[],
  settings: ScheduleSettings
): Promise<ScheduleResult> {
  return (ALGORITHMS[id] ?? ALGORITHMS.quick).run(positions, openings, staff, settings);
}

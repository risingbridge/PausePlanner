import type { AlgorithmId, OpeningsGrid, Position, ScheduleResult, Staff } from "../types";
import { ALGORITHM_LABELS } from "../types";
import { runBalanced } from "./algorithms/balanced";
import { runQuick } from "./algorithms/quick";
import type { ScheduleSettings } from "./types";

export type { ScheduleSettings } from "./types";

export interface AlgorithmDefinition {
  id: AlgorithmId;
  label: string;
  run: (positions: Position[], openings: OpeningsGrid, staff: Staff[], settings: ScheduleSettings) => ScheduleResult;
}

export const ALGORITHMS: Record<AlgorithmId, AlgorithmDefinition> = {
  quick: { id: "quick", label: ALGORITHM_LABELS.quick, run: runQuick },
  balanced: { id: "balanced", label: ALGORITHM_LABELS.balanced, run: runBalanced },
};

// Falls back to Quick for an unrecognized id — e.g. data exported by a
// future build referencing an algorithm this build doesn't know about.
export function runScheduleAlgorithm(
  id: AlgorithmId,
  positions: Position[],
  openings: OpeningsGrid,
  staff: Staff[],
  settings: ScheduleSettings
): ScheduleResult {
  return (ALGORITHMS[id] ?? ALGORITHMS.quick).run(positions, openings, staff, settings);
}

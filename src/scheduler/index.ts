import type { AlgorithmId, OpeningsGrid, Position, ScheduleResult, Staff } from "../types";
import { ALGORITHM_LABELS } from "../types";
import { runMipAsync } from "./algorithms/mip";
import type { AlgorithmProgress, ScheduleSettings } from "./types";

export type { AlgorithmProgress, ScheduleSettings } from "./types";

export interface AlgorithmDefinition {
  id: AlgorithmId;
  label: string;
  // The trailing onProgress callback exists only for MIP (HiGHS)'s own
  // per-stage reporting; kept in the shared signature (rather than folded
  // into a MIP-specific type) so a future non-MIP algorithm can slot back
  // into this registry without changing the type every caller depends on.
  run: (
    positions: Position[],
    openings: OpeningsGrid,
    staff: Staff[],
    settings: ScheduleSettings,
    onProgress?: (progress: AlgorithmProgress) => void
  ) => ScheduleResult | Promise<ScheduleResult>;
}

export const ALGORITHMS: Record<AlgorithmId, AlgorithmDefinition> = {
  mip: { id: "mip", label: ALGORITHM_LABELS.mip, run: runMipAsync },
};

// Falls back to MIP for an unrecognized id — e.g. data exported by an older
// build whose `algorithm` field named a mode this build no longer has.
export async function runScheduleAlgorithm(
  id: AlgorithmId,
  positions: Position[],
  openings: OpeningsGrid,
  staff: Staff[],
  settings: ScheduleSettings,
  onProgress?: (progress: AlgorithmProgress) => void
): Promise<ScheduleResult> {
  return (ALGORITHMS[id] ?? ALGORITHMS.mip).run(positions, openings, staff, settings, onProgress);
}

import type { OpeningsGrid, Position, ScheduleResult } from "../../../types";
import { findActiveBlock, isWithinShift } from "../../../utils/time";
import { decisionsToScheduleResult, type Action } from "../../shared/action";
import type { HighsSolution } from "./highsClient";
import type { MipModel } from "./model";

export function decodeSolution(
  model: MipModel,
  solution: HighsSolution,
  positions: Position[],
  openings: OpeningsGrid
): ScheduleResult {
  const { staff, slots, x, br, idle, req } = model;
  // The union's "Infeasible" branch has no Primal field, but core.ts
  // already throws before an infeasible solution ever reaches here — this
  // narrows what TypeScript can't infer across that call boundary.
  const columns = solution.Columns as Record<string, { Primal: number } | undefined>;
  const isOn = (name: string | undefined): boolean => {
    if (!name) return false;
    const col = columns[name];
    return !!col && col.Primal > 0.5;
  };

  const decisions: Action[][] = slots.map(() => new Array(staff.length) as Action[]);
  for (let t = 0; t < slots.length; t++) {
    const slot = slots[t];
    for (let s = 0; s < staff.length; s++) {
      if (!isWithinShift(slot, staff[s].start, staff[s].end)) {
        decisions[t][s] = { kind: "OFF" };
        continue;
      }
      const block = findActiveBlock(slot, staff[s].blocks);
      if (block) {
        decisions[t][s] = { kind: "BLOCKED", label: block.label };
        continue;
      }
      const requiredPositionId = req.requiredPositionAt[s].get(t);
      if (requiredPositionId !== undefined) {
        decisions[t][s] = { kind: "WORK", positionId: requiredPositionId };
        continue;
      }
      if (isOn(br.get(`${s}|${t}`))) {
        decisions[t][s] = { kind: "BREAK" };
        continue;
      }
      if (isOn(idle.get(`${s}|${t}`))) {
        decisions[t][s] = { kind: "IDLE" };
        continue;
      }
      let assigned: string | null = null;
      for (let p = 0; p < model.positions.length; p++) {
        if (isOn(x.get(`${s}|${p}|${t}`))) {
          assigned = model.positions[p].id;
          break;
        }
      }
      // Falls back to IDLE rather than throwing if none of x/br/idle came
      // back "on" — should be unreachable given the slot-partition
      // constraint (§5.1) always forces exactly one, but a solver
      // returning e.g. 0.4999 under numerical tolerance is not worth
      // crashing the whole generation over.
      decisions[t][s] = assigned ? { kind: "WORK", positionId: assigned } : { kind: "IDLE" };
    }
  }

  return decisionsToScheduleResult(decisions, positions, openings, staff, slots);
}

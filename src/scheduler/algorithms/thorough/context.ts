import type { Position, Staff } from "../../../types";
import type { ScheduleSettings } from "../../types";

export interface SearchContext {
  positions: Position[];
  staff: Staff[];
  settings: ScheduleSettings;
  slots: string[];
  openPositionsBySlot: Position[][];
  suffixLowerBound: number[];
  breakDomainByStaff: Set<number>[]; // legal break-start slot indices, per staff index
  latestBreakDomainSlot: number[]; // max(breakDomainByStaff[i]), or -1 if empty
  nodeBudget: number;
  deadlineMs: number;
}

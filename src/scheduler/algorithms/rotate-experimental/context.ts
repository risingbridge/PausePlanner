import type { Position, Staff } from "../../../types";
import type { ScheduleSettings } from "../../types";
import type { MaxRemainingByStaffPosition, PositionIdeal } from "./positionBalance";

export interface SearchContext {
  positions: Position[];
  staff: Staff[];
  settings: ScheduleSettings;
  slots: string[];
  openPositionsBySlot: Position[][];
  suffixLowerBound: number[];
  breakDomainByStaff: Set<number>[]; // legal break-start slot indices, per staff index
  latestBreakDomainSlot: number[]; // max(breakDomainByStaff[i]), or -1 if empty
  requiredPositionByStaffSlot: Array<Map<number, string>>; // staff index -> slot index -> required positionId
  requirementStartSlotByStaff: Array<Set<number>>; // slot indices where a requirement begins, per staff index
  positionIndexById: Map<string, number>; // for crediting positionMinutes without a linear scan
  positionIdeal: PositionIdeal; // static fair-share target, computed once up front
  maxRemainingSuffix: MaxRemainingByStaffPosition; // static suffix table backing the imbalance bound
  nodeBudget: number;
  deadlineMs: number;
}

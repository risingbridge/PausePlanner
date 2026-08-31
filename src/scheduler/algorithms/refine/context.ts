import type { Position, Staff } from "../../../types";
import type { ScheduleSettings } from "../../types";

export interface RefineContext {
  positions: Position[];
  staff: Staff[];
  settings: ScheduleSettings;
  slots: string[];
  openPositionsBySlot: Position[][];
  breakDomainByStaff: Set<number>[]; // legal break-start slot indices, per staff index
  breakSlotSpan: number; // how many 15-minute slots one break run occupies
}

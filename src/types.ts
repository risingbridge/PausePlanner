export interface Position {
  id: string;
  name: string;
}

export interface TimeBlock {
  id: string;
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  label?: string;
}

export interface Staff {
  id: string;
  name: string;
  start: string; // "HH:MM"; fallback/custom value, source of truth when shiftCodeId is unset
  end: string; // "HH:MM"
  shiftCodeId?: string; // when set, effective start/end come from the linked ShiftCode instead
  blocks: TimeBlock[];
}

// A named, reusable shift definition, global across all 7 weekdays. Staff
// link to one by id rather than copying its times, so an edit here is
// reflected everywhere that staff member's shift is used.
export interface ShiftCode {
  id: string;
  name: string;
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

// The six numeric scheduling rules; shared across every weekday.
export interface Settings {
  maxTimeInPosition: number; // minutes
  minPositionLength: number; // minutes; can't be interrupted before this
  minBreakLength: number; // minutes; length of the one break per shift
  minIdleTime: number; // minutes; minimum gap for every other stop
  earliestBreakPercent: number; // 0-100, % of shift; earliest the one break can start
  latestBreakPercent: number; // 0-100, % of shift; break is forced by this point if not yet taken
}

// openings[positionId][slotTime] = true if open
export type OpeningsGrid = Record<string, Record<string, boolean>>;

export type SlotStatus = "WORK" | "BREAK" | "IDLE" | "OFF" | "BLOCKED";

export interface TimelineEntry {
  status: SlotStatus;
  positionId?: string;
  label?: string;
}

export interface ScheduleResult {
  slots: string[];
  // assignments[slot][positionId] = staffId | null
  assignments: Record<string, Record<string, string | null>>;
  // staffTimeline[staffId][slot] = entry
  staffTimeline: Record<string, Record<string, TimelineEntry>>;
  unstaffed: Array<{ slot: string; positionId: string }>;
  generatedAt: string;
}

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

// One weekday's fully independent configuration — no relationship to any
// other weekday beyond the shared numeric rules in Settings.
export interface DaySchedule {
  dayStart: string; // "HH:MM"
  dayEnd: string; // "HH:MM", exclusive
  positions: Position[];
  openings: OpeningsGrid;
  staff: Staff[];
  schedule: ScheduleResult | null;
}

export interface AppState {
  days: Record<Weekday, DaySchedule>;
  settings: Settings;
  shiftCodes: ShiftCode[]; // global, shared across every weekday like Settings
  currentDay: Weekday;
  showMigrationNotice: boolean;
}

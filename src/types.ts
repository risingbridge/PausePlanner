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

// A positive constraint forcing a staff member into a specific position for
// a window of time, as opposed to a TimeBlock's negative one (unavailable).
// Day-scoped like positions themselves — positionId resolves against that
// same day's positions list, so there's no cross-day propagation to handle.
export interface PositionRequirement {
  id: string;
  positionId: string;
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  comment?: string;
}

export interface Staff {
  id: string;
  name: string;
  start: string; // "HH:MM"; fallback/custom value, source of truth when shiftCodeId is unset
  end: string; // "HH:MM"
  shiftCodeId?: string; // when set, effective start/end come from the linked ShiftCode instead
  blocks: TimeBlock[];
  requirements: PositionRequirement[];
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

// Extend this union (and ALGORITHM_LABELS below) to register a new
// scheduling algorithm — see src/scheduler/index.ts for the rest of the
// registration.
export type AlgorithmId = "quick" | "balanced" | "thorough" | "refine" | "thoroughExperimental" | "rotateExperimental";

export const ALGORITHM_LABELS: Record<AlgorithmId, string> = {
  quick: "Quick",
  balanced: "Balanced",
  thorough: "Thorough",
  refine: "Refine",
  thoroughExperimental: "Thorough (Experimental)",
  rotateExperimental: "Rotate (Experimental)",
};

// The scheduling algorithm and six numeric rules it runs with; shared
// across every weekday.
export interface Settings {
  algorithm: AlgorithmId;
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

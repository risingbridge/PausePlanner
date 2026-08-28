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
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  blocks: TimeBlock[];
}

export interface Settings {
  dayStart: string; // "HH:MM"
  dayEnd: string; // "HH:MM", exclusive
  maxTimeInPosition: number; // minutes
  minPositionLength: number; // minutes; can't be interrupted before this
  minBreakLength: number; // minutes; length of the one break per shift
  minIdleTime: number; // minutes; minimum gap for every other stop
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

export interface AppState {
  positions: Position[];
  staff: Staff[];
  settings: Settings;
  openings: OpeningsGrid;
  schedule: ScheduleResult | null;
}

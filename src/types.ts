export interface Position {
  id: string;
  name: string;
}

export interface Staff {
  id: string;
  name: string;
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

export interface Settings {
  dayStart: string; // "HH:MM"
  dayEnd: string; // "HH:MM", exclusive
  maxTimeInPosition: number; // minutes
  minPositionLength: number; // minutes; can't be interrupted before this
  minBreakLength: number; // minutes
}

// openings[positionId][slotTime] = true if open
export type OpeningsGrid = Record<string, Record<string, boolean>>;

export type SlotStatus = "WORK" | "BREAK" | "IDLE" | "OFF";

export interface TimelineEntry {
  status: SlotStatus;
  positionId?: string;
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

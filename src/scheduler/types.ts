import type { Settings } from "../types";

// dayStart/dayEnd live per-weekday in DaySchedule, not in the shared
// Settings; callers pass both in together here since every algorithm only
// ever schedules one day (and one shift range) at a time.
export type ScheduleSettings = Settings & { dayStart: string; dayEnd: string };

// Coarse, stage-level progress — the only granularity actually available:
// HiGHS's solve() is synchronous/blocking with no progress callback, so
// there's no way to report "40% through this stage," only "which of the 4
// stages is currently running." Only MIP (HiGHS) ever calls this; every
// other algorithm's `run` accepts it structurally (an extra optional
// parameter a function just doesn't use is fine in TS/JS) but ignores it.
export interface AlgorithmProgress {
  stage: number; // 1-based
  totalStages: number;
  label: string;
}

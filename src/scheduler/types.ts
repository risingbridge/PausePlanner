import type { Settings } from "../types";

// dayStart/dayEnd live per-weekday in DaySchedule, not in the shared
// Settings; callers pass both in together here since every algorithm only
// ever schedules one day (and one shift range) at a time.
export type ScheduleSettings = Settings & { dayStart: string; dayEnd: string };

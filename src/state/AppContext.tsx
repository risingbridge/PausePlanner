import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  AppState,
  DaySchedule,
  OpeningsGrid,
  Position,
  PositionRequirement,
  ScheduleResult,
  Settings,
  ShiftCode,
  Staff,
  TimeBlock,
  Weekday,
} from "../types";
import { WEEKDAYS } from "../types";
import { generateSlots } from "../utils/time";

const STORAGE_KEY = "pauseplanner_state_v2";
const OLD_STORAGE_KEY = "pauseplanner_state_v1";
const EXPORT_VERSION = 2;

const defaultSettings: Settings = {
  algorithm: "quick",
  maxTimeInPosition: 120,
  minPositionLength: 30,
  minBreakLength: 30,
  minIdleTime: 15,
  earliestBreakPercent: 25,
  latestBreakPercent: 75,
};

function defaultDaySchedule(): DaySchedule {
  return { dayStart: "08:00", dayEnd: "17:00", positions: [], openings: {}, staff: [], schedule: null };
}

function todaysWeekday(): Weekday {
  // getDay(): 0 = Sunday ... 6 = Saturday.
  return WEEKDAYS[(new Date().getDay() + 6) % 7];
}

function defaultState(): AppState {
  const days = Object.fromEntries(WEEKDAYS.map((d) => [d, defaultDaySchedule()])) as Record<
    Weekday,
    DaySchedule
  >;
  return {
    days,
    settings: defaultSettings,
    shiftCodes: [],
    currentDay: todaysWeekday(),
    showMigrationNotice: false,
  };
}

function normalizeStaffList(raw: unknown): Staff[] {
  return ((raw as Staff[]) ?? []).map((s) => ({ ...s, blocks: s.blocks ?? [], requirements: s.requirements ?? [] }));
}

function normalizeDay(raw: Record<string, unknown> | undefined): DaySchedule {
  const fallback = defaultDaySchedule();
  if (!raw) return fallback;
  return {
    dayStart: (raw.dayStart as string) ?? fallback.dayStart,
    dayEnd: (raw.dayEnd as string) ?? fallback.dayEnd,
    positions: (raw.positions as Position[]) ?? [],
    openings: (raw.openings as OpeningsGrid) ?? {},
    staff: normalizeStaffList(raw.staff),
    schedule: (raw.schedule as ScheduleResult) ?? null,
  };
}

function isOldShape(p: Record<string, unknown>): boolean {
  return Array.isArray(p.positions) && Array.isArray(p.staff) && typeof p.openings === "object" && !p.days;
}

function isNewShape(p: Record<string, unknown>): boolean {
  return typeof p.days === "object" && p.days !== null;
}

// A saved v1 (single-day) state migrates its one day of data into Monday,
// leaving the other six weekdays empty, rather than silently discarding it.
function migrateOldShape(p: Record<string, unknown>): AppState {
  const state = defaultState();
  const oldSettings = (p.settings as Record<string, unknown>) ?? {};
  state.days.mon = normalizeDay({
    dayStart: oldSettings.dayStart,
    dayEnd: oldSettings.dayEnd,
    positions: p.positions,
    openings: p.openings,
    staff: p.staff,
    schedule: p.schedule,
  } as Record<string, unknown>);
  const { dayStart: _ds, dayEnd: _de, ...oldRules } = oldSettings;
  state.settings = { ...defaultSettings, ...oldRules };
  state.showMigrationNotice = true;
  return state;
}

function normalizeNewShape(p: Record<string, unknown>): AppState {
  const rawDays = (p.days as Record<string, unknown>) ?? {};
  const days = Object.fromEntries(
    WEEKDAYS.map((d) => [d, normalizeDay(rawDays[d] as Record<string, unknown> | undefined)])
  ) as Record<Weekday, DaySchedule>;
  const currentDay = WEEKDAYS.includes(p.currentDay as Weekday) ? (p.currentDay as Weekday) : todaysWeekday();
  return {
    days,
    settings: { ...defaultSettings, ...(p.settings as Partial<Settings>) },
    shiftCodes: (p.shiftCodes as ShiftCode[]) ?? [],
    currentDay,
    showMigrationNotice: false,
  };
}

function normalizeState(parsed: Record<string, unknown>): AppState {
  if (isNewShape(parsed)) return normalizeNewShape(parsed);
  if (isOldShape(parsed)) return migrateOldShape(parsed);
  return defaultState();
}

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeState(JSON.parse(raw));
  } catch {
    return defaultState();
  }
  // No v2 data yet — fall back to a v1 save so existing users aren't reset.
  try {
    const oldRaw = localStorage.getItem(OLD_STORAGE_KEY);
    if (oldRaw) return migrateOldShape(JSON.parse(oldRaw));
  } catch {
    return defaultState();
  }
  return defaultState();
}

export class ImportValidationError extends Error {}

// Validates only the shape needed to normalize safely; normalizeState fills
// in any missing optional fields and accepts either the current per-weekday
// export or an older single-day one (migrating it the same way as loading
// old localStorage data does).
function validateImportShape(parsed: unknown): asserts parsed is Record<string, unknown> {
  if (!parsed || typeof parsed !== "object") {
    throw new ImportValidationError("This doesn't look like a PausePlanner export file.");
  }
  const p = parsed as Record<string, unknown>;
  if (!isNewShape(p) && !isOldShape(p)) {
    throw new ImportValidationError("This file is missing data PausePlanner expects.");
  }
}

function reconcileOpenings(openings: OpeningsGrid, positions: Position[], slots: string[]): OpeningsGrid {
  const next: OpeningsGrid = {};
  for (const p of positions) {
    const existing = openings[p.id] ?? {};
    const row: Record<string, boolean> = {};
    for (const slot of slots) {
      row[slot] = existing[slot] ?? false;
    }
    next[p.id] = row;
  }
  return next;
}

interface AppContextValue {
  state: AppState;
  slots: string[];
  currentDay: DaySchedule;
  setCurrentDay: (day: Weekday) => void;
  copyCurrentDayTo: (targets: Weekday[]) => void;
  dismissMigrationNotice: () => void;
  addPosition: (name: string) => void;
  renamePosition: (id: string, name: string) => void;
  removePosition: (id: string) => void;
  toggleOpening: (positionId: string, slot: string) => void;
  setOpeningRange: (positionId: string, slots: string[], open: boolean) => void;
  updateDayTimes: (patch: Partial<Pick<DaySchedule, "dayStart" | "dayEnd">>) => void;
  addStaff: (name: string, start: string, end: string, shiftCodeId?: string) => void;
  updateStaff: (id: string, patch: Partial<Omit<Staff, "id">>) => void;
  removeStaff: (id: string) => void;
  addBlock: (staffId: string, start: string, end: string, label: string) => void;
  removeBlock: (staffId: string, blockId: string) => void;
  addRequirement: (staffId: string, positionId: string, start: string, end: string, comment?: string) => void;
  removeRequirement: (staffId: string, requirementId: string) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  addShiftCode: (name: string, start: string, end: string) => void;
  updateShiftCode: (id: string, patch: Partial<Omit<ShiftCode, "id">>) => void;
  removeShiftCode: (id: string) => void;
  setSchedule: (schedule: ScheduleResult | null) => void;
  setManualAssignment: (slot: string, positionId: string, staffId: string | null) => void;
  setManualStatus: (slot: string, staffId: string, status: "IDLE" | "BREAK") => void;
  exportState: () => void;
  importState: (json: string) => void;
  clearAllData: () => void;
}

function addUnstaffed(schedule: ScheduleResult, slot: string, positionId: string) {
  const exists = schedule.unstaffed.some((u) => u.slot === slot && u.positionId === positionId);
  if (!exists) schedule.unstaffed.push({ slot, positionId });
}

function removeUnstaffed(schedule: ScheduleResult, slot: string, positionId: string) {
  schedule.unstaffed = schedule.unstaffed.filter((u) => !(u.slot === slot && u.positionId === positionId));
}

const AppContext = createContext<AppContextValue | null>(null);

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Every day-scoped action edits only state.days[state.currentDay]; this is
// what lets call sites keep addPosition(name)-style signatures instead of
// threading a weekday through everything.
function updateCurrentDay(prev: AppState, updater: (day: DaySchedule) => DaySchedule): AppState {
  return { ...prev, days: { ...prev.days, [prev.currentDay]: updater(prev.days[prev.currentDay]) } };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(loadState);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const currentDay = state.days[state.currentDay];

  const slots = useMemo(
    () => generateSlots(currentDay.dayStart, currentDay.dayEnd),
    [currentDay.dayStart, currentDay.dayEnd]
  );

  // Keep the current day's openings grid in sync with its own positions/slots.
  useEffect(() => {
    setState((prev) => {
      const day = prev.days[prev.currentDay];
      const reconciled = reconcileOpenings(day.openings, day.positions, slots);
      return updateCurrentDay(prev, (d) => ({ ...d, openings: reconciled }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, state.currentDay, currentDay.positions]);

  const value: AppContextValue = {
    state,
    slots,
    currentDay,
    setCurrentDay: (day) => setState((prev) => ({ ...prev, currentDay: day })),
    copyCurrentDayTo: (targets) =>
      setState((prev) => {
        const source = prev.days[prev.currentDay];
        const days = { ...prev.days };
        for (const target of targets) {
          if (target === prev.currentDay) continue;
          days[target] = {
            ...structuredClone({
              dayStart: source.dayStart,
              dayEnd: source.dayEnd,
              positions: source.positions,
              openings: source.openings,
              staff: source.staff,
            }),
            schedule: null,
          };
        }
        return { ...prev, days };
      }),
    dismissMigrationNotice: () => setState((prev) => ({ ...prev, showMigrationNotice: false })),
    addPosition: (name) =>
      setState((prev) =>
        updateCurrentDay(prev, (day) => ({ ...day, positions: [...day.positions, { id: uid(), name }] }))
      ),
    renamePosition: (id, name) =>
      setState((prev) =>
        updateCurrentDay(prev, (day) => ({
          ...day,
          positions: day.positions.map((p) => (p.id === id ? { ...p, name } : p)),
        }))
      ),
    removePosition: (id) =>
      setState((prev) =>
        updateCurrentDay(prev, (day) => {
          const { [id]: _removed, ...rest } = day.openings;
          return {
            ...day,
            positions: day.positions.filter((p) => p.id !== id),
            openings: rest,
            staff: day.staff.map((s) => ({
              ...s,
              requirements: s.requirements.filter((r) => r.positionId !== id),
            })),
          };
        })
      ),
    toggleOpening: (positionId, slot) =>
      setState((prev) =>
        updateCurrentDay(prev, (day) => ({
          ...day,
          openings: {
            ...day.openings,
            [positionId]: { ...day.openings[positionId], [slot]: !day.openings[positionId]?.[slot] },
          },
        }))
      ),
    setOpeningRange: (positionId, slotsToSet, open) =>
      setState((prev) =>
        updateCurrentDay(prev, (day) => {
          const row = { ...day.openings[positionId] };
          for (const slot of slotsToSet) row[slot] = open;
          return { ...day, openings: { ...day.openings, [positionId]: row } };
        })
      ),
    updateDayTimes: (patch) => setState((prev) => updateCurrentDay(prev, (day) => ({ ...day, ...patch }))),
    addStaff: (name, start, end, shiftCodeId) =>
      setState((prev) =>
        updateCurrentDay(prev, (day) => ({
          ...day,
          staff: [...day.staff, { id: uid(), name, start, end, shiftCodeId, blocks: [], requirements: [] }],
        }))
      ),
    updateStaff: (id, patch) =>
      setState((prev) =>
        updateCurrentDay(prev, (day) => ({
          ...day,
          staff: day.staff.map((s) => (s.id === id ? { ...s, ...patch } : s)),
        }))
      ),
    removeStaff: (id) =>
      setState((prev) =>
        updateCurrentDay(prev, (day) => ({ ...day, staff: day.staff.filter((s) => s.id !== id) }))
      ),
    addBlock: (staffId, start, end, label) =>
      setState((prev) =>
        updateCurrentDay(prev, (day) => ({
          ...day,
          staff: day.staff.map((s) => {
            if (s.id !== staffId) return s;
            const block: TimeBlock = { id: uid(), start, end, label: label.trim() || undefined };
            return { ...s, blocks: [...s.blocks, block] };
          }),
        }))
      ),
    removeBlock: (staffId, blockId) =>
      setState((prev) =>
        updateCurrentDay(prev, (day) => ({
          ...day,
          staff: day.staff.map((s) =>
            s.id === staffId ? { ...s, blocks: s.blocks.filter((b) => b.id !== blockId) } : s
          ),
        }))
      ),
    addRequirement: (staffId, positionId, start, end, comment) =>
      setState((prev) =>
        updateCurrentDay(prev, (day) => ({
          ...day,
          staff: day.staff.map((s) => {
            if (s.id !== staffId) return s;
            const requirement: PositionRequirement = {
              id: uid(),
              positionId,
              start,
              end,
              comment: comment?.trim() || undefined,
            };
            return { ...s, requirements: [...s.requirements, requirement] };
          }),
        }))
      ),
    removeRequirement: (staffId, requirementId) =>
      setState((prev) =>
        updateCurrentDay(prev, (day) => ({
          ...day,
          staff: day.staff.map((s) =>
            s.id === staffId ? { ...s, requirements: s.requirements.filter((r) => r.id !== requirementId) } : s
          ),
        }))
      ),
    updateSettings: (patch) => setState((prev) => ({ ...prev, settings: { ...prev.settings, ...patch } })),
    addShiftCode: (name, start, end) =>
      setState((prev) => ({ ...prev, shiftCodes: [...prev.shiftCodes, { id: uid(), name, start, end }] })),
    updateShiftCode: (id, patch) =>
      setState((prev) => ({
        ...prev,
        shiftCodes: prev.shiftCodes.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      })),
    removeShiftCode: (id) =>
      setState((prev) => {
        const code = prev.shiftCodes.find((c) => c.id === id);
        if (!code) return prev;
        const days = { ...prev.days };
        for (const day of WEEKDAYS) {
          days[day] = {
            ...days[day],
            staff: days[day].staff.map((s) =>
              s.shiftCodeId === id
                ? { ...s, start: code.start, end: code.end, shiftCodeId: undefined }
                : s
            ),
          };
        }
        return { ...prev, days, shiftCodes: prev.shiftCodes.filter((c) => c.id !== id) };
      }),
    setSchedule: (schedule) => setState((prev) => updateCurrentDay(prev, (day) => ({ ...day, schedule }))),
    setManualAssignment: (slot, positionId, staffId) =>
      setState((prev) =>
        updateCurrentDay(prev, (day) => {
          if (!day.schedule) return day;
          const schedule = structuredClone(day.schedule);
          const slotAssignments = (schedule.assignments[slot] ??= {});

          // Free the staffer from any other position they held this slot.
          if (staffId) {
            for (const pid of Object.keys(slotAssignments)) {
              if (pid !== positionId && slotAssignments[pid] === staffId) {
                slotAssignments[pid] = null;
                addUnstaffed(schedule, slot, pid);
              }
            }
          }

          // Free whoever previously held this exact position.
          const previousStaffId = slotAssignments[positionId] ?? null;
          if (previousStaffId && previousStaffId !== staffId) {
            schedule.staffTimeline[previousStaffId][slot] = { status: "IDLE" };
          }

          slotAssignments[positionId] = staffId;
          if (staffId) {
            removeUnstaffed(schedule, slot, positionId);
            schedule.staffTimeline[staffId][slot] = { status: "WORK", positionId };
          } else {
            addUnstaffed(schedule, slot, positionId);
          }

          return { ...day, schedule };
        })
      ),
    setManualStatus: (slot, staffId, status) =>
      setState((prev) =>
        updateCurrentDay(prev, (day) => {
          if (!day.schedule) return day;
          const schedule = structuredClone(day.schedule);
          const slotAssignments = (schedule.assignments[slot] ??= {});

          for (const pid of Object.keys(slotAssignments)) {
            if (slotAssignments[pid] === staffId) {
              slotAssignments[pid] = null;
              addUnstaffed(schedule, slot, pid);
            }
          }

          schedule.staffTimeline[staffId][slot] = { status };
          return { ...day, schedule };
        })
      ),
    exportState: () => {
      const payload = {
        exportVersion: EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        days: state.days,
        settings: state.settings,
        shiftCodes: state.shiftCodes,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const dateStamp = new Date().toISOString().slice(0, 10);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pauseplanner-export-${dateStamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    importState: (json) => {
      const parsed: unknown = JSON.parse(json);
      validateImportShape(parsed);
      setState(normalizeState(parsed));
    },
    clearAllData: () => setState(defaultState()),
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}

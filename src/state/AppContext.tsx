import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppState, OpeningsGrid, Position, ScheduleResult, Settings, Staff, TimeBlock } from "../types";
import { generateSlots } from "../utils/time";

const STORAGE_KEY = "pauseplanner_state_v1";

const defaultSettings: Settings = {
  dayStart: "08:00",
  dayEnd: "17:00",
  maxTimeInPosition: 120,
  minPositionLength: 30,
  minBreakLength: 30,
  minIdleTime: 15,
};

const defaultState: AppState = {
  positions: [],
  staff: [],
  settings: defaultSettings,
  openings: {},
  schedule: null,
};

function normalizeState(parsed: Record<string, unknown>): AppState {
  return {
    positions: (parsed.positions as Position[]) ?? [],
    staff: ((parsed.staff as Staff[]) ?? []).map((s) => ({ ...s, blocks: s.blocks ?? [] })),
    settings: { ...defaultSettings, ...(parsed.settings as Partial<Settings>) },
    openings: (parsed.openings as OpeningsGrid) ?? {},
    schedule: (parsed.schedule as ScheduleResult) ?? null,
  };
}

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState;
    return normalizeState(JSON.parse(raw));
  } catch {
    return defaultState;
  }
}

export class ImportValidationError extends Error {}

// Validates only the shape needed to normalize safely; normalizeState fills
// in any missing optional fields (e.g. an older export without minIdleTime).
function validateImportShape(parsed: unknown): asserts parsed is Record<string, unknown> {
  if (!parsed || typeof parsed !== "object") {
    throw new ImportValidationError("This doesn't look like a PausePlanner export file.");
  }
  const p = parsed as Record<string, unknown>;
  if (!Array.isArray(p.positions) || !Array.isArray(p.staff) || typeof p.openings !== "object") {
    throw new ImportValidationError("This file is missing data PausePlanner expects (positions, staff, openings).");
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
  addPosition: (name: string) => void;
  renamePosition: (id: string, name: string) => void;
  removePosition: (id: string) => void;
  toggleOpening: (positionId: string, slot: string) => void;
  setOpeningRange: (positionId: string, slots: string[], open: boolean) => void;
  addStaff: (name: string, start: string, end: string) => void;
  updateStaff: (id: string, patch: Partial<Omit<Staff, "id">>) => void;
  removeStaff: (id: string) => void;
  addBlock: (staffId: string, start: string, end: string, label: string) => void;
  removeBlock: (staffId: string, blockId: string) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  setSchedule: (schedule: ScheduleResult | null) => void;
  setManualAssignment: (slot: string, positionId: string, staffId: string | null) => void;
  setManualStatus: (slot: string, staffId: string, status: "IDLE" | "BREAK") => void;
  exportState: () => void;
  importState: (json: string) => void;
}

const EXPORT_VERSION = 1;

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

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(loadState);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const slots = useMemo(
    () => generateSlots(state.settings.dayStart, state.settings.dayEnd),
    [state.settings.dayStart, state.settings.dayEnd]
  );

  // Keep the openings grid in sync with current positions/slots.
  useEffect(() => {
    setState((prev) => {
      const reconciled = reconcileOpenings(prev.openings, prev.positions, slots);
      return { ...prev, openings: reconciled };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, state.positions]);

  const value: AppContextValue = {
    state,
    slots,
    addPosition: (name) =>
      setState((prev) => ({ ...prev, positions: [...prev.positions, { id: uid(), name }] })),
    renamePosition: (id, name) =>
      setState((prev) => ({
        ...prev,
        positions: prev.positions.map((p) => (p.id === id ? { ...p, name } : p)),
      })),
    removePosition: (id) =>
      setState((prev) => {
        const { [id]: _removed, ...rest } = prev.openings;
        return { ...prev, positions: prev.positions.filter((p) => p.id !== id), openings: rest };
      }),
    toggleOpening: (positionId, slot) =>
      setState((prev) => ({
        ...prev,
        openings: {
          ...prev.openings,
          [positionId]: {
            ...prev.openings[positionId],
            [slot]: !prev.openings[positionId]?.[slot],
          },
        },
      })),
    setOpeningRange: (positionId, slotsToSet, open) =>
      setState((prev) => {
        const row = { ...prev.openings[positionId] };
        for (const slot of slotsToSet) row[slot] = open;
        return { ...prev, openings: { ...prev.openings, [positionId]: row } };
      }),
    addStaff: (name, start, end) =>
      setState((prev) => ({
        ...prev,
        staff: [...prev.staff, { id: uid(), name, start, end, blocks: [] }],
      })),
    updateStaff: (id, patch) =>
      setState((prev) => ({
        ...prev,
        staff: prev.staff.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      })),
    removeStaff: (id) =>
      setState((prev) => ({ ...prev, staff: prev.staff.filter((s) => s.id !== id) })),
    addBlock: (staffId, start, end, label) =>
      setState((prev) => ({
        ...prev,
        staff: prev.staff.map((s) => {
          if (s.id !== staffId) return s;
          const block: TimeBlock = { id: uid(), start, end, label: label.trim() || undefined };
          return { ...s, blocks: [...s.blocks, block] };
        }),
      })),
    removeBlock: (staffId, blockId) =>
      setState((prev) => ({
        ...prev,
        staff: prev.staff.map((s) =>
          s.id === staffId ? { ...s, blocks: s.blocks.filter((b) => b.id !== blockId) } : s
        ),
      })),
    updateSettings: (patch) =>
      setState((prev) => ({ ...prev, settings: { ...prev.settings, ...patch } })),
    setSchedule: (schedule) => setState((prev) => ({ ...prev, schedule })),
    setManualAssignment: (slot, positionId, staffId) =>
      setState((prev) => {
        if (!prev.schedule) return prev;
        const schedule = structuredClone(prev.schedule);
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

        return { ...prev, schedule };
      }),
    setManualStatus: (slot, staffId, status) =>
      setState((prev) => {
        if (!prev.schedule) return prev;
        const schedule = structuredClone(prev.schedule);
        const slotAssignments = (schedule.assignments[slot] ??= {});

        for (const pid of Object.keys(slotAssignments)) {
          if (slotAssignments[pid] === staffId) {
            slotAssignments[pid] = null;
            addUnstaffed(schedule, slot, pid);
          }
        }

        schedule.staffTimeline[staffId][slot] = { status };
        return { ...prev, schedule };
      }),
    exportState: () => {
      const payload = {
        exportVersion: EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        ...state,
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
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}

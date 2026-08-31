import type { OpeningsGrid, Position, ScheduleResult, SlotStatus, Staff, TimelineEntry } from "../../types";

// The common per-(slot, staff) decision shape both search-based modes
// (Thorough, Refine) build their internal schedule representation from —
// deliberately the same shape a reconstructed ScheduleResult's
// staffTimeline entries carry, so converting in either direction is a
// straight mapping with no loss.
export type Action =
  | { kind: "OFF" }
  | { kind: "BLOCKED"; label?: string }
  | { kind: "WORK"; positionId: string }
  | { kind: "BREAK" }
  | { kind: "IDLE" };

export function actionToTimelineEntry(action: Action): TimelineEntry {
  switch (action.kind) {
    case "OFF":
      return { status: "OFF" as SlotStatus };
    case "BLOCKED":
      return { status: "BLOCKED" as SlotStatus, label: action.label };
    case "WORK":
      return { status: "WORK" as SlotStatus, positionId: action.positionId };
    case "BREAK":
      return { status: "BREAK" as SlotStatus };
    case "IDLE":
      return { status: "IDLE" as SlotStatus };
  }
}

export function decisionsFromScheduleResult(result: ScheduleResult, staff: Staff[], slots: string[]): Action[][] {
  return slots.map((slot) =>
    staff.map((s): Action => {
      const entry = result.staffTimeline[s.id]?.[slot];
      if (!entry) return { kind: "OFF" };
      switch (entry.status) {
        case "OFF":
          return { kind: "OFF" };
        case "BLOCKED":
          return { kind: "BLOCKED", label: entry.label };
        case "WORK":
          return { kind: "WORK", positionId: entry.positionId! };
        case "BREAK":
          return { kind: "BREAK" };
        case "IDLE":
          return { kind: "IDLE" };
      }
    })
  );
}

export function decisionsToScheduleResult(
  decisions: Action[][],
  positions: Position[],
  openings: OpeningsGrid,
  staff: Staff[],
  slots: string[]
): ScheduleResult {
  const assignments: Record<string, Record<string, string | null>> = {};
  const staffTimeline: Record<string, Record<string, TimelineEntry>> = {};
  const unstaffed: Array<{ slot: string; positionId: string }> = [];
  for (const s of staff) staffTimeline[s.id] = {};

  for (let t = 0; t < slots.length; t++) {
    const slot = slots[t];
    assignments[slot] = {};
    const claimed = new Set<string>();
    for (let i = 0; i < staff.length; i++) {
      const action = decisions[t][i];
      staffTimeline[staff[i].id][slot] = actionToTimelineEntry(action);
      if (action.kind === "WORK") {
        assignments[slot][action.positionId] = staff[i].id;
        claimed.add(action.positionId);
      }
    }
    for (const p of positions) {
      if (openings[p.id]?.[slot] === true && !claimed.has(p.id)) {
        assignments[slot][p.id] = null;
        unstaffed.push({ slot, positionId: p.id });
      }
    }
  }

  return { slots, assignments, staffTimeline, unstaffed, generatedAt: new Date().toISOString() };
}

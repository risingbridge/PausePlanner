import { useEffect, useState } from "react";
import { useApp } from "../state/AppContext";
import { runScheduleAlgorithm, type AlgorithmProgress, type ScheduleSettings } from "../scheduler";
import {
  findActiveBlock,
  formatDuration,
  generateSlots,
  isWithinShift,
  resolveStaffShift,
  SLOT_MINUTES,
} from "../utils/time";
import { WEEKDAYS, WEEKDAY_LABELS, type Position, type ShiftCode, type Staff, type Weekday } from "../types";

type ViewMode = "byPosition" | "byStaff";

// Shows a staff member's shift code by name (e.g. "F2") if they're linked
// to one, or their own custom times otherwise — lets the By Staff schedule
// disambiguate same-named staff and surface shift info without a lookup.
function staffHeaderLabel(s: Staff, shiftCodes: ShiftCode[]): string {
  const code = s.shiftCodeId ? shiftCodes.find((c) => c.id === s.shiftCodeId) : undefined;
  const suffix = code ? code.name : `${s.start}–${s.end}`;
  return `${s.name} (${suffix})`;
}

// A requirement's comment marks every slot its window actually covers, so
// the whole required stretch reads as required at a glance rather than
// just its first slot.
function requirementCommentAt(s: Staff, positionId: string, slot: string): string | undefined {
  for (const r of s.requirements) {
    if (r.positionId !== positionId || !r.comment) continue;
    if (slot >= r.start && slot < r.end) return r.comment;
  }
  return undefined;
}

function withComment(label: string, comment: string | undefined): string {
  return comment ? `${label} (${comment})` : label;
}

// Only worth showing once priorities actually differ — with every position at
// the default, a "P1" on each header would just be noise.
function PriorityBadge({ position, positions }: { position: Position; positions: Position[] }) {
  if (new Set(positions.map((p) => p.priority)).size < 2) return null;
  return (
    <span className="prio-badge" title={`Priority ${position.priority} (1 = most important)`}>
      P{position.priority}
    </span>
  );
}

export default function SchedulePage() {
  const { state, currentDay, slots, setSchedule, setScheduleForDay, setManualAssignment, setManualStatus } =
    useApp();
  const { positions, staff, openings, schedule } = currentDay;
  const { settings, shiftCodes } = state;
  const [view, setView] = useState<ViewMode>("byPosition");
  const [printingWeek, setPrintingWeek] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [mipProgress, setMipProgress] = useState<AlgorithmProgress | null>(null);
  const [isGeneratingWeek, setIsGeneratingWeek] = useState(false);
  const [weekProgress, setWeekProgress] = useState<{ day: Weekday; index: number; total: number } | null>(null);
  const [weekResult, setWeekResult] = useState<{ generated: string[]; skipped: string[]; errors: string[] } | null>(
    null
  );

  const anyGenerating = isGenerating || isGeneratingWeek;
  const canGenerate = positions.length > 0 && staff.length > 0 && slots.length > 0;
  const dayIsGeneratable = (day: Weekday) => {
    const d = state.days[day];
    return d.positions.length > 0 && d.staff.length > 0 && generateSlots(d.dayStart, d.dayEnd).length > 0;
  };
  const canGenerateWeek = WEEKDAYS.some(dayIsGeneratable);

  async function handleGenerate() {
    const scheduleSettings: ScheduleSettings = {
      ...settings,
      dayStart: currentDay.dayStart,
      dayEnd: currentDay.dayEnd,
    };
    const resolvedStaff = staff.map((s) => ({ ...s, ...resolveStaffShift(s, shiftCodes) }));
    setGenerateError(null);
    setMipProgress(null);
    setIsGenerating(true);
    try {
      const result = await runScheduleAlgorithm(
        settings.algorithm,
        positions,
        openings,
        resolvedStaff,
        scheduleSettings,
        setMipProgress
      );
      setSchedule(result);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Couldn't generate a schedule — please try again.");
    } finally {
      setIsGenerating(false);
      setMipProgress(null);
    }
  }

  // Runs one day at a time rather than in parallel — every mode (MIP most
  // of all, with its own dedicated WASM Worker) is written assuming it owns
  // the CPU/Worker for the duration of a solve, and 7 of them racing for
  // the same resources would only make each one slower and harder to show
  // progress for. A day with no positions or staff yet is skipped rather
  // than treated as an error — a week where only some days are set up is
  // the normal case, not a mistake. One day's solver error doesn't stop
  // the rest of the week from generating; every failure is collected and
  // reported together at the end.
  async function handleGenerateWeek() {
    setGenerateError(null);
    setWeekResult(null);
    setIsGeneratingWeek(true);
    const generated: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];
    try {
      for (let i = 0; i < WEEKDAYS.length; i++) {
        const day = WEEKDAYS[i];
        setWeekProgress({ day, index: i + 1, total: WEEKDAYS.length });
        if (!dayIsGeneratable(day)) {
          skipped.push(WEEKDAY_LABELS[day]);
          continue;
        }
        const d = state.days[day];
        const scheduleSettings: ScheduleSettings = { ...settings, dayStart: d.dayStart, dayEnd: d.dayEnd };
        const resolvedStaff = d.staff.map((s) => ({ ...s, ...resolveStaffShift(s, shiftCodes) }));
        setMipProgress(null);
        try {
          const result = await runScheduleAlgorithm(
            settings.algorithm,
            d.positions,
            d.openings,
            resolvedStaff,
            scheduleSettings,
            setMipProgress
          );
          setScheduleForDay(day, result);
          generated.push(WEEKDAY_LABELS[day]);
        } catch (err) {
          errors.push(`${WEEKDAY_LABELS[day]}: ${err instanceof Error ? err.message : "failed to generate"}`);
        }
      }
    } finally {
      setIsGeneratingWeek(false);
      setWeekProgress(null);
      setMipProgress(null);
      setWeekResult({ generated, skipped, errors });
    }
  }

  const staffById = new Map(staff.map((s) => [s.id, s]));
  const positionById = new Map(positions.map((p) => [p.id, p]));

  const generatedLabel = schedule ? new Date(schedule.generatedAt).toLocaleString() : "";
  const dayLabel = WEEKDAY_LABELS[state.currentDay];

  function availableStaffAt(slot: string) {
    return staff.filter((s) => {
      const { start, end } = resolveStaffShift(s, shiftCodes);
      return isWithinShift(slot, start, end) && !findActiveBlock(slot, s.blocks);
    });
  }

  // window.print() needs the DOM already showing the full-week content, so
  // this waits for React to commit printingWeek before printing, then waits
  // for the dialog to actually close (afterprint) before reverting — a
  // plain setState-then-print in one handler risks printing the old view.
  useEffect(() => {
    if (!printingWeek) return;
    const revert = () => setPrintingWeek(false);
    window.addEventListener("afterprint", revert);
    window.print();
    return () => window.removeEventListener("afterprint", revert);
  }, [printingWeek]);

  const summary = schedule
    ? staff.map((s) => {
        const timeline = schedule.staffTimeline[s.id] ?? {};
        let work = 0;
        let idle = 0;
        let brk = 0;
        for (const slot of schedule.slots) {
          const status = timeline[slot]?.status;
          if (status === "WORK") work += SLOT_MINUTES;
          else if (status === "IDLE") idle += SLOT_MINUTES;
          else if (status === "BREAK") brk += SLOT_MINUTES;
        }
        return { staff: s, work, idle, brk };
      })
    : [];

  function renderSummaryTable() {
    if (summary.length === 0) return null;
    return (
      <table className="simple-table summary-table">
        <thead>
          <tr>
            <th>Staff</th>
            <th>Time in position</th>
            <th>Idle</th>
            <th>Break</th>
          </tr>
        </thead>
        <tbody>
          {summary.map(({ staff: s, work, idle, brk }) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>{formatDuration(work)}</td>
              <td>{formatDuration(idle)}</td>
              <td>{formatDuration(brk)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  function renderWeekDayByPositionTable(day: Weekday) {
    const d = state.days[day];
    if (!d.schedule) {
      return <p className="hint">Not yet generated.</p>;
    }
    const staffById = new Map(d.staff.map((s) => [s.id, s]));
    return (
      <table className="grid-table">
        <thead>
          <tr>
            <th className="time-col">Time</th>
            {d.positions.map((p) => (
              <th key={p.id}>
                {p.name}
                <PriorityBadge position={p} positions={d.positions} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {d.schedule.slots.map((slot) => (
            <tr key={slot}>
              <td className="time-col">{slot}</td>
              {d.positions.map((p) => {
                const isOpen = d.openings[p.id]?.[slot] ?? false;
                if (!isOpen) {
                  return (
                    <td key={p.id} className="cell-closed">
                      &mdash;
                    </td>
                  );
                }
                const staffId = d.schedule!.assignments[slot]?.[p.id] ?? null;
                const assignedStaff = staffId ? staffById.get(staffId) : undefined;
                const label = assignedStaff?.name ?? (staffId ? "?" : "UNSTAFFED");
                const comment = assignedStaff
                  ? requirementCommentAt(assignedStaff, p.id, slot)
                  : undefined;
                return (
                  <td key={p.id} className={staffId ? "cell-assigned" : "cell-unstaffed"}>
                    {withComment(label, comment)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  function renderWeekDayByStaffTable(day: Weekday) {
    const d = state.days[day];
    if (!d.schedule) {
      return <p className="hint">Not yet generated.</p>;
    }
    const positionNameById = new Map(d.positions.map((p) => [p.id, p.name]));
    return (
      <table className="grid-table">
        <thead>
          <tr>
            <th className="time-col">Time</th>
            {d.staff.map((s) => (
              <th key={s.id}>{staffHeaderLabel(s, shiftCodes)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {d.schedule.slots.map((slot) => (
            <tr key={slot}>
              <td className="time-col">{slot}</td>
              {d.staff.map((s) => {
                const entry = d.schedule!.staffTimeline[s.id]?.[slot];
                if (!entry || entry.status === "OFF") {
                  return (
                    <td key={s.id} className="cell-closed">
                      &mdash;
                    </td>
                  );
                }
                if (entry.status === "BLOCKED") {
                  return (
                    <td key={s.id} className="cell-blocked">
                      {entry.label ? entry.label.toUpperCase() : "BLOCKED"}
                    </td>
                  );
                }
                const cellClass =
                  entry.status === "WORK" ? "cell-assigned" : entry.status === "BREAK" ? "cell-break" : "cell-idle";
                const label =
                  entry.status === "WORK" ? positionNameById.get(entry.positionId!) ?? "?" : entry.status;
                const comment =
                  entry.status === "WORK"
                    ? requirementCommentAt(s, entry.positionId!, slot)
                    : undefined;
                return (
                  <td key={s.id} className={cellClass}>
                    {withComment(label, comment)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <div className="page">
      <h2 className="no-print">Schedule</h2>

      <div className="add-row no-print">
        <button onClick={handleGenerate} disabled={!canGenerate || anyGenerating}>
          {isGenerating ? "Generating…" : "Generate day"}
        </button>
        <button onClick={handleGenerateWeek} disabled={!canGenerateWeek || anyGenerating}>
          {isGeneratingWeek ? "Generating…" : "Generate week"}
        </button>
        {isGeneratingWeek && weekProgress && (
          <span className="hint">
            {WEEKDAY_LABELS[weekProgress.day]} ({weekProgress.index}/{weekProgress.total})…
          </span>
        )}
        {anyGenerating && settings.algorithm === "mip" && mipProgress && (
          <div className="mip-progress">
            <div className="mip-progress-bar">
              {Array.from({ length: mipProgress.totalStages }, (_, i) => (
                <div
                  key={i}
                  className={
                    "mip-progress-segment" +
                    (i < mipProgress.stage - 1 ? " done" : i === mipProgress.stage - 1 ? " active" : "")
                  }
                />
              ))}
            </div>
            <span className="hint">
              Stage {mipProgress.stage}/{mipProgress.totalStages}: {mipProgress.label}
            </span>
          </div>
        )}
        {!canGenerate && (
          <span className="hint">Add at least one position and one staff member first.</span>
        )}
        {generateError && <span className="hint warning-text">{generateError}</span>}
        {weekResult && (
          <span className={`hint${weekResult.errors.length > 0 ? " warning-text" : ""}`}>
            {weekResult.generated.length > 0 && `Generated ${weekResult.generated.join(", ")}. `}
            {weekResult.skipped.length > 0 && `Skipped (no positions/staff): ${weekResult.skipped.join(", ")}. `}
            {weekResult.errors.length > 0 && weekResult.errors.join(" ")}
          </span>
        )}
        {schedule && (
          <div className="view-toggle">
            <button
              className={view === "byPosition" ? "active" : ""}
              onClick={() => setView("byPosition")}
            >
              By position
            </button>
            <button className={view === "byStaff" ? "active" : ""} onClick={() => setView("byStaff")}>
              By staff
            </button>
          </div>
        )}
        {schedule && <button onClick={() => window.print()}>Print / Save as PDF</button>}
        <button onClick={() => setPrintingWeek(true)}>Print full week</button>
      </div>

      {schedule && schedule.unstaffed.length > 0 && (
        <div className="warning-box">
          <strong>{schedule.unstaffed.length} open slot(s) could not be staffed.</strong> These are
          highlighted below.
        </div>
      )}

      {schedule && (
        <p className="hint no-print">
          Click any cell to change it manually. Regenerating the schedule discards manual edits.
        </p>
      )}

      {!printingWeek && schedule && <div className="no-print">{renderSummaryTable()}</div>}

      {!schedule && <p className="hint">No schedule generated yet.</p>}

      {!printingWeek && schedule && view === "byPosition" && (
        <div className="grid-scroll">
          <div className="print-header">
            <h2>{dayLabel}'s Position Schedule</h2>
            <p>Generated {generatedLabel}</p>
          </div>
          <table className="grid-table">
            <thead>
              <tr>
                <th className="time-col">Time</th>
                {positions.map((p) => (
                  <th key={p.id}>
                    {p.name}
                    <PriorityBadge position={p} positions={positions} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {schedule.slots.map((slot) => (
                <tr key={slot}>
                  <td className="time-col">{slot}</td>
                  {positions.map((p) => {
                    const staffId = schedule.assignments[slot]?.[p.id] ?? null;
                    const isOpen = openings[p.id]?.[slot] ?? false;
                    if (!isOpen) {
                      return (
                        <td key={p.id} className="cell-closed">
                          &mdash;
                        </td>
                      );
                    }
                    const options = availableStaffAt(slot);
                    const cellClass = staffId ? "cell-assigned" : "cell-unstaffed";
                    const assignedStaff = staffId ? staffById.get(staffId) : undefined;
                    const label = assignedStaff?.name ?? (staffId ? "?" : "UNSTAFFED");
                    const comment = assignedStaff
                      ? requirementCommentAt(assignedStaff, p.id, slot)
                      : undefined;
                    return (
                      <td key={p.id}>
                        <select
                          className={`cell-select ${cellClass} no-print`}
                          value={staffId ?? ""}
                          onChange={(e) => setManualAssignment(slot, p.id, e.target.value || null)}
                        >
                          <option value="">UNSTAFFED</option>
                          {options.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.id === staffId ? withComment(s.name, comment) : s.name}
                            </option>
                          ))}
                          {staffId && !options.some((s) => s.id === staffId) && (
                            <option value={staffId}>{withComment(label, comment)}</option>
                          )}
                        </select>
                        <span className={`print-only-text ${cellClass}`}>{withComment(label, comment)}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!printingWeek && schedule && view === "byStaff" && (
        <div className="grid-scroll">
          <div className="print-header">
            <h2>{dayLabel}'s Staff Schedule</h2>
            <p>Generated {generatedLabel}</p>
          </div>
          <table className="grid-table">
            <thead>
              <tr>
                <th className="time-col">Time</th>
                {staff.map((s) => (
                  <th key={s.id}>{staffHeaderLabel(s, shiftCodes)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {schedule.slots.map((slot) => (
                <tr key={slot}>
                  <td className="time-col">{slot}</td>
                  {staff.map((s) => {
                    const entry = schedule.staffTimeline[s.id]?.[slot];
                    if (!entry || entry.status === "OFF") {
                      return (
                        <td key={s.id} className="cell-closed">
                          &mdash;
                        </td>
                      );
                    }
                    if (entry.status === "BLOCKED") {
                      return (
                        <td key={s.id} className="cell-blocked">
                          {entry.label ? entry.label.toUpperCase() : "BLOCKED"}
                        </td>
                      );
                    }
                    const openPositionsHere = positions.filter((p) => openings[p.id]?.[slot]);
                    const currentValue = entry.status === "WORK" ? entry.positionId! : entry.status;
                    const cellClass =
                      entry.status === "WORK" ? "cell-assigned" : entry.status === "BREAK" ? "cell-break" : "cell-idle";
                    const currentLabel =
                      entry.status === "WORK" ? positionById.get(entry.positionId!)?.name ?? "?" : entry.status;
                    const comment =
                      entry.status === "WORK"
                        ? requirementCommentAt(s, entry.positionId!, slot)
                        : undefined;

                    function handleChange(value: string) {
                      if (value === "IDLE" || value === "BREAK") {
                        setManualStatus(slot, s.id, value);
                      } else {
                        setManualAssignment(slot, value, s.id);
                      }
                    }

                    return (
                      <td key={s.id}>
                        <select
                          className={`cell-select ${cellClass} no-print`}
                          value={currentValue}
                          onChange={(e) => handleChange(e.target.value)}
                        >
                          <option value="IDLE">IDLE</option>
                          <option value="BREAK">BREAK</option>
                          {openPositionsHere.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.id === entry.positionId ? withComment(p.name, comment) : p.name}
                            </option>
                          ))}
                          {entry.status === "WORK" && !openPositionsHere.some((p) => p.id === entry.positionId) && (
                            <option value={entry.positionId}>
                              {withComment(positionById.get(entry.positionId!)?.name ?? "?", comment)}
                            </option>
                          )}
                        </select>
                        <span className={`print-only-text ${cellClass}`}>{withComment(currentLabel, comment)}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!printingWeek && schedule && (
        <div className="print-only-block">
          <div className="print-header">
            <h2>{dayLabel}'s Summary</h2>
            <p>Generated {generatedLabel}</p>
          </div>
          {renderSummaryTable()}
        </div>
      )}

      {printingWeek && (
        <div className="print-only-block">
          {WEEKDAYS.map((day, i) => (
            <div key={day} className={i > 0 ? "week-print-page" : undefined}>
              <div className="print-header">
                <h2>{WEEKDAY_LABELS[day]} — {view === "byPosition" ? "Position Schedule" : "Staff Schedule"}</h2>
                {state.days[day].schedule && <p>Generated {new Date(state.days[day].schedule!.generatedAt).toLocaleString()}</p>}
              </div>
              {view === "byPosition" ? renderWeekDayByPositionTable(day) : renderWeekDayByStaffTable(day)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import { useApp } from "../state/AppContext";
import { generateSchedule } from "../scheduler/generateSchedule";
import { findActiveBlock, formatDuration, isWithinShift, SLOT_MINUTES } from "../utils/time";

type ViewMode = "byPosition" | "byStaff";

export default function SchedulePage() {
  const { state, slots, setSchedule, setManualAssignment, setManualStatus } = useApp();
  const { positions, staff, openings, settings, schedule } = state;
  const [view, setView] = useState<ViewMode>("byPosition");

  const canGenerate = positions.length > 0 && staff.length > 0 && slots.length > 0;

  function handleGenerate() {
    const result = generateSchedule(positions, openings, staff, settings);
    setSchedule(result);
  }

  const staffById = new Map(staff.map((s) => [s.id, s]));
  const positionById = new Map(positions.map((p) => [p.id, p]));

  function handlePrint() {
    window.print();
  }

  const generatedLabel = schedule ? new Date(schedule.generatedAt).toLocaleString() : "";

  function availableStaffAt(slot: string) {
    return staff.filter((s) => isWithinShift(slot, s.start, s.end) && !findActiveBlock(slot, s.blocks));
  }

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

  return (
    <div className="page">
      <h2 className="no-print">Schedule</h2>

      <div className="add-row no-print">
        <button onClick={handleGenerate} disabled={!canGenerate}>
          Generate schedule
        </button>
        {!canGenerate && (
          <span className="hint">Add at least one position and one staff member first.</span>
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
        {schedule && (
          <button onClick={handlePrint}>
            Print / Save as PDF
          </button>
        )}
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

      {schedule && <div className="no-print">{renderSummaryTable()}</div>}

      {!schedule && <p className="hint">No schedule generated yet.</p>}

      {schedule && view === "byPosition" && (
        <div className="grid-scroll">
          <div className="print-header">
            <h2>Position Schedule</h2>
            <p>Generated {generatedLabel}</p>
          </div>
          <table className="grid-table">
            <thead>
              <tr>
                <th className="time-col">Time</th>
                {positions.map((p) => (
                  <th key={p.id}>{p.name}</th>
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
                    const label = staffId ? staffById.get(staffId)?.name ?? "?" : "UNSTAFFED";
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
                              {s.name}
                            </option>
                          ))}
                          {staffId && !options.some((s) => s.id === staffId) && (
                            <option value={staffId}>{label}</option>
                          )}
                        </select>
                        <span className={`print-only-text ${cellClass}`}>{label}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {schedule && view === "byStaff" && (
        <div className="grid-scroll">
          <div className="print-header">
            <h2>Staff Schedule</h2>
            <p>Generated {generatedLabel}</p>
          </div>
          <table className="grid-table">
            <thead>
              <tr>
                <th className="time-col">Time</th>
                {staff.map((s) => (
                  <th key={s.id}>{s.name}</th>
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
                              {p.name}
                            </option>
                          ))}
                          {entry.status === "WORK" && !openPositionsHere.some((p) => p.id === entry.positionId) && (
                            <option value={entry.positionId}>{positionById.get(entry.positionId!)?.name ?? "?"}</option>
                          )}
                        </select>
                        <span className={`print-only-text ${cellClass}`}>{currentLabel}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {schedule && (
        <div className="print-only-block">
          <div className="print-header">
            <h2>Summary</h2>
            <p>Generated {generatedLabel}</p>
          </div>
          {renderSummaryTable()}
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import { useApp } from "../state/AppContext";
import { generateSchedule } from "../scheduler/generateSchedule";

type ViewMode = "byPosition" | "byStaff";

export default function SchedulePage() {
  const { state, slots, setSchedule } = useApp();
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
                    const staffId = schedule.assignments[slot]?.[p.id];
                    const isOpen = openings[p.id]?.[slot] ?? false;
                    if (!isOpen) {
                      return (
                        <td key={p.id} className="cell-closed">
                          &mdash;
                        </td>
                      );
                    }
                    if (staffId === null || staffId === undefined) {
                      return (
                        <td key={p.id} className="cell-unstaffed">
                          UNSTAFFED
                        </td>
                      );
                    }
                    return (
                      <td key={p.id} className="cell-assigned">
                        {staffById.get(staffId)?.name ?? "?"}
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
                    if (entry.status === "BREAK") {
                      return (
                        <td key={s.id} className="cell-break">
                          BREAK
                        </td>
                      );
                    }
                    if (entry.status === "IDLE") {
                      return (
                        <td key={s.id} className="cell-idle">
                          IDLE
                        </td>
                      );
                    }
                    return (
                      <td key={s.id} className="cell-assigned">
                        {positionById.get(entry.positionId!)?.name ?? "?"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

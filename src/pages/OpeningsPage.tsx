import { useState } from "react";
import { useApp } from "../state/AppContext";

export default function OpeningsPage() {
  const { state, slots, updateSettings, addPosition, renamePosition, removePosition, toggleOpening, setOpeningRange } =
    useApp();
  const { positions, openings, settings } = state;
  const [newPositionName, setNewPositionName] = useState("");

  function handleAddPosition() {
    const name = newPositionName.trim();
    if (!name) return;
    addPosition(name);
    setNewPositionName("");
  }

  const rangeInvalid = settings.dayStart >= settings.dayEnd;

  return (
    <div className="page">
      <h2>Positions &amp; Openings</h2>
      <p className="hint">Click a cell to toggle a position open or closed for that time. Times are shown in 15-minute intervals.</p>

      <div className="add-row">
        <label>
          Day start
          <input
            type="time"
            value={settings.dayStart}
            onChange={(e) => updateSettings({ dayStart: e.target.value })}
          />
        </label>
        <label>
          Day end
          <input
            type="time"
            value={settings.dayEnd}
            onChange={(e) => updateSettings({ dayEnd: e.target.value })}
          />
        </label>
      </div>

      {rangeInvalid && <p className="hint warning-text">Day start must be earlier than day end.</p>}

      <div className="add-row">
        <input
          type="text"
          placeholder="New position name"
          value={newPositionName}
          onChange={(e) => setNewPositionName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAddPosition()}
        />
        <button onClick={handleAddPosition}>Add position</button>
      </div>

      {positions.length === 0 ? (
        <p className="hint">Add at least one position to start building the openings grid.</p>
      ) : slots.length === 0 ? (
        <p className="hint">Set a valid day start/end above to build the openings grid.</p>
      ) : (
        <div className="grid-scroll">
          <table className="grid-table">
            <thead>
              <tr>
                <th className="time-col">Time</th>
                {positions.map((p) => (
                  <th key={p.id}>
                    <div className="pos-header">
                      <input
                        className="pos-name-input"
                        value={p.name}
                        onChange={(e) => renamePosition(p.id, e.target.value)}
                      />
                      <div className="pos-header-actions">
                        <button
                          className="small"
                          title="Mark all open"
                          onClick={() => setOpeningRange(p.id, slots, true)}
                        >
                          All open
                        </button>
                        <button
                          className="small"
                          title="Mark all closed"
                          onClick={() => setOpeningRange(p.id, slots, false)}
                        >
                          All closed
                        </button>
                        <button
                          className="small danger"
                          title="Remove position"
                          onClick={() => removePosition(p.id)}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slots.map((slot) => (
                <tr key={slot}>
                  <td className="time-col">{slot}</td>
                  {positions.map((p) => {
                    const open = openings[p.id]?.[slot] ?? false;
                    return (
                      <td key={p.id}>
                        <button
                          className={`cell-toggle ${open ? "open" : "closed"}`}
                          onClick={() => toggleOpening(p.id, slot)}
                        >
                          {open ? "OPEN" : "CLSD"}
                        </button>
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

import { useState } from "react";
import { useApp } from "../state/AppContext";

export default function StaffingPage() {
  const { state, addStaff, updateStaff, removeStaff } = useApp();
  const { staff, settings } = state;
  const [name, setName] = useState("");
  const [start, setStart] = useState(settings.dayStart);
  const [end, setEnd] = useState(settings.dayEnd);

  function handleAdd() {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (start >= end) {
      alert("Shift start must be before shift end.");
      return;
    }
    addStaff(trimmed, start, end);
    setName("");
  }

  return (
    <div className="page">
      <h2>Staffing</h2>
      <p className="hint">Add each staff member and the start/end time of their shift.</p>

      <div className="add-row">
        <input type="text" placeholder="Staff name" value={name} onChange={(e) => setName(e.target.value)} />
        <label>
          Start
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label>
          End
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <button onClick={handleAdd}>Add staff</button>
      </div>

      {staff.length === 0 ? (
        <p className="hint">No staff added yet.</p>
      ) : (
        <table className="simple-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Shift start</th>
              <th>Shift end</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.id}>
                <td>
                  <input value={s.name} onChange={(e) => updateStaff(s.id, { name: e.target.value })} />
                </td>
                <td>
                  <input
                    type="time"
                    value={s.start}
                    onChange={(e) => updateStaff(s.id, { start: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    type="time"
                    value={s.end}
                    onChange={(e) => updateStaff(s.id, { end: e.target.value })}
                  />
                </td>
                <td>
                  <button className="small danger" onClick={() => removeStaff(s.id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

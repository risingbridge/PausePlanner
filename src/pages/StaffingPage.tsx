import { useState } from "react";
import { useApp } from "../state/AppContext";

export default function StaffingPage() {
  const { state, addStaff, updateStaff, removeStaff, addBlock, removeBlock } = useApp();
  const { staff, settings } = state;
  const [name, setName] = useState("");
  const [start, setStart] = useState(settings.dayStart);
  const [end, setEnd] = useState(settings.dayEnd);
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
      <p className="hint">
        Add each staff member and the start/end time of their shift. Expand a row to block out time for
        meetings or other commitments — blocked staff are never scheduled into a position during that time.
      </p>

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
              <th>Blocked times</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <StaffRow
                key={s.id}
                name={s.name}
                start={s.start}
                end={s.end}
                blocks={s.blocks}
                expanded={expandedId === s.id}
                onToggleExpanded={() => setExpandedId(expandedId === s.id ? null : s.id)}
                onUpdate={(patch) => updateStaff(s.id, patch)}
                onRemove={() => removeStaff(s.id)}
                onAddBlock={(blockStart, blockEnd, label) => addBlock(s.id, blockStart, blockEnd, label)}
                onRemoveBlock={(blockId) => removeBlock(s.id, blockId)}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface StaffRowProps {
  name: string;
  start: string;
  end: string;
  blocks: Array<{ id: string; start: string; end: string; label?: string }>;
  expanded: boolean;
  onToggleExpanded: () => void;
  onUpdate: (patch: { name?: string; start?: string; end?: string }) => void;
  onRemove: () => void;
  onAddBlock: (start: string, end: string, label: string) => void;
  onRemoveBlock: (blockId: string) => void;
}

function StaffRow({
  name,
  start,
  end,
  blocks,
  expanded,
  onToggleExpanded,
  onUpdate,
  onRemove,
  onAddBlock,
  onRemoveBlock,
}: StaffRowProps) {
  const [blockStart, setBlockStart] = useState(start);
  const [blockEnd, setBlockEnd] = useState(end);
  const [blockLabel, setBlockLabel] = useState("");

  function handleAddBlock() {
    if (blockStart >= blockEnd) {
      alert("Block start must be before block end.");
      return;
    }
    onAddBlock(blockStart, blockEnd, blockLabel);
    setBlockLabel("");
  }

  return (
    <>
      <tr>
        <td>
          <input value={name} onChange={(e) => onUpdate({ name: e.target.value })} />
        </td>
        <td>
          <input type="time" value={start} onChange={(e) => onUpdate({ start: e.target.value })} />
        </td>
        <td>
          <input type="time" value={end} onChange={(e) => onUpdate({ end: e.target.value })} />
        </td>
        <td>
          <button className="small" onClick={onToggleExpanded}>
            {blocks.length === 0 ? "None" : `${blocks.length} block${blocks.length > 1 ? "s" : ""}`}
            {expanded ? " ▴" : " ▾"}
          </button>
        </td>
        <td>
          <button className="small danger" onClick={onRemove}>
            Remove
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5}>
            <div className="block-editor">
              {blocks.length > 0 && (
                <ul className="block-list">
                  {blocks.map((b) => (
                    <li key={b.id}>
                      <span>
                        {b.start}&ndash;{b.end}
                        {b.label ? ` — ${b.label}` : ""}
                      </span>
                      <button className="small danger" onClick={() => onRemoveBlock(b.id)}>
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="block-add-row">
                <label>
                  Start
                  <input type="time" value={blockStart} onChange={(e) => setBlockStart(e.target.value)} />
                </label>
                <label>
                  End
                  <input type="time" value={blockEnd} onChange={(e) => setBlockEnd(e.target.value)} />
                </label>
                <input
                  type="text"
                  placeholder="Label (optional, e.g. Meeting)"
                  value={blockLabel}
                  onChange={(e) => setBlockLabel(e.target.value)}
                />
                <button className="small" onClick={handleAddBlock}>
                  Add block
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

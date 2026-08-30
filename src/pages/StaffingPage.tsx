import { useState } from "react";
import { useApp } from "../state/AppContext";
import type { ShiftCode, Staff } from "../types";

export default function StaffingPage() {
  const { state, currentDay, addStaff, updateStaff, removeStaff, addBlock, removeBlock } = useApp();
  const { staff } = currentDay;
  const { shiftCodes } = state;
  const [name, setName] = useState("");
  const [start, setStart] = useState(currentDay.dayStart);
  const [end, setEnd] = useState(currentDay.dayEnd);
  const [shiftCodeId, setShiftCodeId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // The day switcher doesn't remount this page, so the add-staff form's
  // default times need to be re-synced whenever the selected day changes.
  // Adjusting during render (rather than in an effect) avoids an extra
  // render pass for what's otherwise a plain state update.
  const [syncedDay, setSyncedDay] = useState(state.currentDay);
  if (syncedDay !== state.currentDay) {
    setSyncedDay(state.currentDay);
    setStart(currentDay.dayStart);
    setEnd(currentDay.dayEnd);
    setShiftCodeId(null);
  }

  const selectedCode = shiftCodeId ? shiftCodes.find((c) => c.id === shiftCodeId) : undefined;
  const effectiveStart = selectedCode ? selectedCode.start : start;
  const effectiveEnd = selectedCode ? selectedCode.end : end;

  function handleShiftCodeSelect(value: string) {
    if (value === "") {
      setStart(effectiveStart);
      setEnd(effectiveEnd);
      setShiftCodeId(null);
    } else {
      setShiftCodeId(value);
    }
  }

  function handleAdd() {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (effectiveStart >= effectiveEnd) {
      alert("Shift start must be before shift end.");
      return;
    }
    addStaff(trimmed, effectiveStart, effectiveEnd, shiftCodeId ?? undefined);
    setName("");
  }

  return (
    <div className="page">
      <h2>Staffing</h2>
      <p className="hint">
        Add each staff member and the start/end time of their shift, either typed directly or picked from a
        shift code defined on the Settings page. Expand a row to block out time for meetings or other
        commitments — blocked staff are never scheduled into a position during that time.
      </p>

      <div className="add-row">
        <input type="text" placeholder="Staff name" value={name} onChange={(e) => setName(e.target.value)} />
        <label>
          Shift
          <select value={shiftCodeId ?? ""} onChange={(e) => handleShiftCodeSelect(e.target.value)}>
            <option value="">Custom</option>
            {shiftCodes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}: {c.start}&ndash;{c.end}
              </option>
            ))}
          </select>
        </label>
        <label>
          Start
          <input
            type="time"
            value={effectiveStart}
            disabled={!!selectedCode}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          End
          <input
            type="time"
            value={effectiveEnd}
            disabled={!!selectedCode}
            onChange={(e) => setEnd(e.target.value)}
          />
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
              <th>Shift code</th>
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
                shiftCodeId={s.shiftCodeId}
                shiftCodes={shiftCodes}
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
  shiftCodeId?: string;
  shiftCodes: ShiftCode[];
  blocks: Array<{ id: string; start: string; end: string; label?: string }>;
  expanded: boolean;
  onToggleExpanded: () => void;
  onUpdate: (patch: Partial<Omit<Staff, "id" | "blocks">>) => void;
  onRemove: () => void;
  onAddBlock: (start: string, end: string, label: string) => void;
  onRemoveBlock: (blockId: string) => void;
}

function StaffRow({
  name,
  start,
  end,
  shiftCodeId,
  shiftCodes,
  blocks,
  expanded,
  onToggleExpanded,
  onUpdate,
  onRemove,
  onAddBlock,
  onRemoveBlock,
}: StaffRowProps) {
  const linkedCode = shiftCodeId ? shiftCodes.find((c) => c.id === shiftCodeId) : undefined;
  const effectiveStart = linkedCode ? linkedCode.start : start;
  const effectiveEnd = linkedCode ? linkedCode.end : end;

  const [blockStart, setBlockStart] = useState(effectiveStart);
  const [blockEnd, setBlockEnd] = useState(effectiveEnd);
  const [blockLabel, setBlockLabel] = useState("");

  function handleShiftCodeChange(value: string) {
    if (value === "") {
      onUpdate({ shiftCodeId: undefined, start: effectiveStart, end: effectiveEnd });
    } else {
      onUpdate({ shiftCodeId: value });
    }
  }

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
          <select value={shiftCodeId ?? ""} onChange={(e) => handleShiftCodeChange(e.target.value)}>
            <option value="">Custom</option>
            {shiftCodes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}: {c.start}&ndash;{c.end}
              </option>
            ))}
          </select>
        </td>
        <td>
          <input
            type="time"
            value={effectiveStart}
            disabled={!!linkedCode}
            onChange={(e) => onUpdate({ start: e.target.value })}
          />
        </td>
        <td>
          <input
            type="time"
            value={effectiveEnd}
            disabled={!!linkedCode}
            onChange={(e) => onUpdate({ end: e.target.value })}
          />
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
          <td colSpan={6}>
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

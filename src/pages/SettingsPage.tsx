import { useRef, useState } from "react";
import { useApp } from "../state/AppContext";

export default function SettingsPage() {
  const {
    state,
    updateSettings,
    exportState,
    importState,
    addShiftCode,
    updateShiftCode,
    removeShiftCode,
    clearAllData,
  } = useApp();
  const { settings, shiftCodes } = state;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [codeName, setCodeName] = useState("");
  const [codeStart, setCodeStart] = useState("08:00");
  const [codeEnd, setCodeEnd] = useState("16:00");

  const minExceedsMax = settings.minPositionLength > settings.maxTimeInPosition;
  const idleExceedsBreak = settings.minIdleTime > settings.minBreakLength;
  const breakWindowInvalid = settings.earliestBreakPercent >= settings.latestBreakPercent;

  const trimmedCodeName = codeName.trim();
  const duplicateCodeName =
    trimmedCodeName !== "" &&
    shiftCodes.some((c) => c.name.trim().toLowerCase() === trimmedCodeName.toLowerCase());

  function handleAddShiftCode() {
    if (!trimmedCodeName) return;
    if (codeStart >= codeEnd) {
      alert("Shift code start must be before end.");
      return;
    }
    addShiftCode(trimmedCodeName, codeStart, codeEnd);
    setCodeName("");
  }

  function handleRemoveShiftCode(name: string, id: string) {
    const proceed = window.confirm(
      `Remove shift code "${name}"? Any staff currently linked to it will keep its current times as their own, on every weekday.`
    );
    if (!proceed) return;
    removeShiftCode(id);
  }

  function handleClearAllData() {
    const proceed = window.confirm(
      "Clear all data? This permanently deletes every weekday's positions, openings, staff, and generated schedule, plus shift codes and settings. This can't be undone — export a backup first if you want to keep it."
    );
    if (!proceed) return;
    clearAllData();
  }

  function handleImportClick() {
    setImportError(null);
    fileInputRef.current?.click();
  }

  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const proceed = window.confirm(
      "Importing will replace all current positions, staff, openings, settings, and the generated schedule. Continue?"
    );
    if (!proceed) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        importState(reader.result as string);
        setImportError(null);
      } catch {
        setImportError("Could not import this file — it doesn't look like a valid PausePlanner export.");
      }
    };
    reader.onerror = () => setImportError("Could not read the selected file.");
    reader.readAsText(file);
  }

  return (
    <div className="page">
      <h2>Settings</h2>
      <p className="hint">
        The scheduling day's start/end time is set on the Positions &amp; Openings page.
      </p>

      <div className="settings-grid">
        <fieldset>
          <legend>Scheduling rules</legend>
          <label className="field">
            Minimum position length (minutes)
            <input
              type="number"
              min={5}
              step={5}
              value={settings.minPositionLength}
              onChange={(e) => updateSettings({ minPositionLength: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            Max time in position (minutes)
            <input
              type="number"
              min={5}
              step={5}
              value={settings.maxTimeInPosition}
              onChange={(e) => updateSettings({ maxTimeInPosition: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            Minimum break length (minutes)
            <input
              type="number"
              min={5}
              step={5}
              value={settings.minBreakLength}
              onChange={(e) => updateSettings({ minBreakLength: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            Minimum idle time (minutes)
            <input
              type="number"
              min={5}
              step={5}
              value={settings.minIdleTime}
              onChange={(e) => updateSettings({ minIdleTime: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            Earliest break (% of shift)
            <input
              type="number"
              min={0}
              max={100}
              step={5}
              value={settings.earliestBreakPercent}
              onChange={(e) => updateSettings({ earliestBreakPercent: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            Latest break (% of shift)
            <input
              type="number"
              min={0}
              max={100}
              step={5}
              value={settings.latestBreakPercent}
              onChange={(e) => updateSettings({ latestBreakPercent: Number(e.target.value) })}
            />
          </label>
        </fieldset>
      </div>

      {minExceedsMax && (
        <p className="hint warning-text">
          Minimum position length can't be longer than max time in position.
        </p>
      )}
      {idleExceedsBreak && (
        <p className="hint warning-text">Minimum idle time is normally shorter than minimum break length.</p>
      )}
      {breakWindowInvalid && (
        <p className="hint warning-text">Earliest break must be before latest break.</p>
      )}

      <p className="hint">
        Once assigned, a staff member can't be moved to rebalance the schedule until they've worked{" "}
        <strong>{settings.minPositionLength} minutes</strong> in that position. After{" "}
        <strong>{settings.maxTimeInPosition} minutes</strong> continuously in a position, they're taken off
        regardless.
      </p>
      <p className="hint">
        Each person gets exactly one real break per shift, at least <strong>{settings.minBreakLength} minutes</strong>{" "}
        long, targeted at the window between <strong>{settings.earliestBreakPercent}%</strong> and{" "}
        <strong>{settings.latestBreakPercent}%</strong> of the way through their shift. A long idle gap already
        running when that window opens is converted into the break on the spot, rather than left idle with a
        separate break tacked on later. Widening the window (e.g. starting it earlier) gives the scheduler more
        room to use naturally idle time as the break instead of creating gaps elsewhere. Every other time
        they're moved off a position, they just go idle for at least{" "}
        <strong>{settings.minIdleTime} minutes</strong> before being scheduled again.
      </p>

      <div className="settings-grid">
        <fieldset>
          <legend>Shift codes</legend>
          <p className="hint">
            A shift code is a named, reusable start/end time (e.g. "F1: 08:00&ndash;15:00") that can be picked
            on the Staffing page instead of typing custom times. Shift codes are shared across every weekday —
            staff linked to one always reflect its current times, everywhere, until unlinked.
          </p>
          <div className="add-row">
            <input
              type="text"
              placeholder="Code name (e.g. F1)"
              value={codeName}
              onChange={(e) => setCodeName(e.target.value)}
            />
            <label>
              Start
              <input type="time" value={codeStart} onChange={(e) => setCodeStart(e.target.value)} />
            </label>
            <label>
              End
              <input type="time" value={codeEnd} onChange={(e) => setCodeEnd(e.target.value)} />
            </label>
            <button onClick={handleAddShiftCode}>Add shift code</button>
          </div>
          {duplicateCodeName && (
            <p className="hint warning-text">A shift code named "{trimmedCodeName}" already exists.</p>
          )}

          {shiftCodes.length === 0 ? (
            <p className="hint">No shift codes yet.</p>
          ) : (
            <table className="simple-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Start</th>
                  <th>End</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shiftCodes.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <input
                        value={c.name}
                        onChange={(e) => updateShiftCode(c.id, { name: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        type="time"
                        value={c.start}
                        onChange={(e) => updateShiftCode(c.id, { start: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        type="time"
                        value={c.end}
                        onChange={(e) => updateShiftCode(c.id, { end: e.target.value })}
                      />
                    </td>
                    <td>
                      <button className="small danger" onClick={() => handleRemoveShiftCode(c.name, c.id)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </fieldset>
      </div>

      <div className="settings-grid">
        <fieldset>
          <legend>Export / Import</legend>
          <p className="hint">
            Export everything — positions, openings, staff, blocked times, settings, and the generated
            schedule — as a JSON file. Import it later, or on another computer, to pick up exactly where you
            left off.
          </p>
          <div className="add-row">
            <button onClick={exportState}>Export data</button>
            <button onClick={handleImportClick}>Import data</button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json"
              className="visually-hidden"
              onChange={handleFileSelected}
            />
          </div>
          {importError && <p className="hint warning-text">{importError}</p>}
        </fieldset>
      </div>

      <div className="settings-grid">
        <fieldset>
          <legend>Danger zone</legend>
          <p className="hint">
            Permanently delete every weekday's positions, openings, staff, and generated schedule, plus shift
            codes and settings — resetting the app as if it were freshly installed. Export a backup first if
            you might want any of this later.
          </p>
          <button className="danger" onClick={handleClearAllData}>
            Clear all data
          </button>
        </fieldset>
      </div>
    </div>
  );
}

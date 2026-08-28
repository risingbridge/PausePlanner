import { useApp } from "../state/AppContext";

export default function SettingsPage() {
  const { state, updateSettings } = useApp();
  const { settings } = state;

  const minExceedsMax = settings.minPositionLength > settings.maxTimeInPosition;

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
        </fieldset>
      </div>

      {minExceedsMax && (
        <p className="hint warning-text">
          Minimum position length can't be longer than max time in position.
        </p>
      )}

      <p className="hint">
        Once assigned, a staff member can't be moved to rebalance the schedule until they've worked{" "}
        <strong>{settings.minPositionLength} minutes</strong> in that position. After{" "}
        <strong>{settings.maxTimeInPosition} minutes</strong> continuously in a position, they're taken off
        regardless, and must rest for at least <strong>{settings.minBreakLength} minutes</strong> before being
        scheduled anywhere again.
      </p>
    </div>
  );
}

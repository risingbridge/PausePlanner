import { useApp } from "../state/AppContext";

export default function SettingsPage() {
  const { state, updateSettings } = useApp();
  const { settings } = state;

  const minExceedsMax = settings.minPositionLength > settings.maxTimeInPosition;
  const idleExceedsBreak = settings.minIdleTime > settings.minBreakLength;

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

      <p className="hint">
        Once assigned, a staff member can't be moved to rebalance the schedule until they've worked{" "}
        <strong>{settings.minPositionLength} minutes</strong> in that position. After{" "}
        <strong>{settings.maxTimeInPosition} minutes</strong> continuously in a position, they're taken off
        regardless.
      </p>
      <p className="hint">
        Each person gets exactly one real break per shift, at least <strong>{settings.minBreakLength} minutes</strong>{" "}
        long — taken at the first opportunity at or after the middle of their shift, or forced near the end of
        their shift if nothing else triggered it sooner. Every other time they're moved off a position, they
        just go idle for at least <strong>{settings.minIdleTime} minutes</strong> before being scheduled again.
      </p>
    </div>
  );
}

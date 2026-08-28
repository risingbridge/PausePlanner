import { useApp } from "../state/AppContext";

export default function SettingsPage() {
  const { state, updateSettings } = useApp();
  const { settings } = state;

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

      <p className="hint">
        Once a staff member has worked <strong>{settings.maxTimeInPosition} minutes</strong> continuously in a
        position, they are taken off and must rest for at least{" "}
        <strong>{settings.minBreakLength} minutes</strong> before being scheduled into any position again.
      </p>
    </div>
  );
}

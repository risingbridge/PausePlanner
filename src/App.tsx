import { useState } from "react";
import { HashRouter, NavLink, Route, Routes, Navigate, useLocation } from "react-router-dom";
import { AppProvider, useApp, type CopyDayParts } from "./state/AppContext";
import OpeningsPage from "./pages/OpeningsPage";
import StaffingPage from "./pages/StaffingPage";
import SettingsPage from "./pages/SettingsPage";
import SchedulePage from "./pages/SchedulePage";
import HelpPage from "./pages/HelpPage";
import PrivacyPage from "./pages/PrivacyPage";
import { WEEKDAYS, WEEKDAY_LABELS, type Weekday } from "./types";
import "./App.css";

function App() {
  return (
    <AppProvider>
      <HashRouter>
        <AppShell />
      </HashRouter>
    </AppProvider>
  );
}

function AppShell() {
  const { state, setCurrentDay, copyCurrentDayTo, dismissMigrationNotice } = useApp();
  const [copyPanelOpen, setCopyPanelOpen] = useState(false);
  const [copyTargets, setCopyTargets] = useState<Set<Weekday>>(new Set());
  const [copyParts, setCopyParts] = useState<CopyDayParts>({ positions: true, staffing: true });
  const location = useLocation();
  // Settings, Help, and Privacy aren't day-scoped, so the day switcher (and
  // the "Copy to..." panel that hangs off it) has nothing to act on there.
  const showDaySwitcher =
    location.pathname !== "/settings" && location.pathname !== "/help" && location.pathname !== "/privacy";

  function toggleCopyTarget(day: Weekday) {
    setCopyTargets((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  }

  // Describes whichever of positions/openings/day-times and staff are
  // currently checked, for both the panel hint and the confirmation prompt —
  // kept in one place so the two can't drift out of sync with each other.
  function copyPartsDescription(): string {
    const parts: string[] = [];
    if (copyParts.positions) parts.push("positions, openings, and day times");
    if (copyParts.staffing) parts.push("staff");
    return parts.join(" and ");
  }

  function handleCopy() {
    const targets = [...copyTargets];
    if (targets.length === 0 || (!copyParts.positions && !copyParts.staffing)) return;
    const names = targets.map((d) => WEEKDAY_LABELS[d]).join(", ");
    const proceed = window.confirm(
      `This will replace ${names}'s ${copyPartsDescription()} with ${WEEKDAY_LABELS[state.currentDay]}'s. Continue?`
    );
    if (!proceed) return;
    copyCurrentDayTo(targets, copyParts);
    setCopyTargets(new Set());
    setCopyParts({ positions: true, staffing: true });
    setCopyPanelOpen(false);
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>
          PausePlanner <span className="app-version">v{__APP_VERSION__}</span>
        </h1>
        <nav>
          <NavLink to="/openings" className={({ isActive }) => (isActive ? "active" : "")}>
            Positions &amp; Openings
          </NavLink>
          <NavLink to="/staffing" className={({ isActive }) => (isActive ? "active" : "")}>
            Staffing
          </NavLink>
          <NavLink to="/schedule" className={({ isActive }) => (isActive ? "active" : "")}>
            Schedule
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? "active" : "")}>
            Settings
          </NavLink>
          <NavLink to="/help" className={({ isActive }) => (isActive ? "active" : "")}>
            Help
          </NavLink>
          <NavLink to="/privacy" className={({ isActive }) => (isActive ? "active" : "")}>
            Privacy &amp; Data
          </NavLink>
        </nav>
      </header>

      {showDaySwitcher && (
        <div className="day-switcher-row no-print">
          <div className="day-switcher">
            {WEEKDAYS.map((day) => (
              <button
                key={day}
                className={day === state.currentDay ? "active" : ""}
                onClick={() => setCurrentDay(day)}
              >
                {WEEKDAY_LABELS[day].slice(0, 3)}
              </button>
            ))}
          </div>
          <button className="small" onClick={() => setCopyPanelOpen((v) => !v)}>
            Copy {WEEKDAY_LABELS[state.currentDay]} to... {copyPanelOpen ? "▴" : "▾"}
          </button>
        </div>
      )}

      {showDaySwitcher && copyPanelOpen && (
        <div className="copy-day-panel no-print">
          <p className="hint">
            Copy {WEEKDAY_LABELS[state.currentDay]}'s {copyPartsDescription() || "—"} to:
          </p>
          <div className="copy-day-parts">
            <label>
              <input
                type="checkbox"
                checked={copyParts.positions}
                onChange={() => setCopyParts((prev) => ({ ...prev, positions: !prev.positions }))}
              />
              Positions &amp; Openings (incl. day start/end)
            </label>
            <label>
              <input
                type="checkbox"
                checked={copyParts.staffing}
                onChange={() => setCopyParts((prev) => ({ ...prev, staffing: !prev.staffing }))}
              />
              Staffing
            </label>
          </div>
          <div className="copy-day-targets">
            {WEEKDAYS.filter((d) => d !== state.currentDay).map((day) => (
              <label key={day}>
                <input
                  type="checkbox"
                  checked={copyTargets.has(day)}
                  onChange={() => toggleCopyTarget(day)}
                />
                {WEEKDAY_LABELS[day]}
              </label>
            ))}
          </div>
          <button
            onClick={handleCopy}
            disabled={copyTargets.size === 0 || (!copyParts.positions && !copyParts.staffing)}
          >
            Copy
          </button>
        </div>
      )}

      {state.showMigrationNotice && (
        <div className="warning-box no-print">
          Your existing data was moved to Monday when weekly scheduling was added. Switch to Monday and use
          "Copy Monday to..." above to fill in the other days.{" "}
          <button className="small" onClick={dismissMigrationNotice}>
            Dismiss
          </button>
        </div>
      )}

      <main className="app-main">
        <Routes>
          <Route path="/" element={<Navigate to="/openings" replace />} />
          <Route path="/openings" element={<OpeningsPage />} />
          <Route path="/staffing" element={<StaffingPage />} />
          <Route path="/schedule" element={<SchedulePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/help" element={<HelpPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;

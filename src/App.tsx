import { HashRouter, NavLink, Route, Routes, Navigate } from "react-router-dom";
import { AppProvider } from "./state/AppContext";
import OpeningsPage from "./pages/OpeningsPage";
import StaffingPage from "./pages/StaffingPage";
import SettingsPage from "./pages/SettingsPage";
import SchedulePage from "./pages/SchedulePage";
import "./App.css";

function App() {
  return (
    <AppProvider>
      <HashRouter>
        <div className="app-shell">
          <header className="app-header">
            <h1>PausePlanner</h1>
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
            </nav>
          </header>
          <main className="app-main">
            <Routes>
              <Route path="/" element={<Navigate to="/openings" replace />} />
              <Route path="/openings" element={<OpeningsPage />} />
              <Route path="/staffing" element={<StaffingPage />} />
              <Route path="/schedule" element={<SchedulePage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </main>
        </div>
      </HashRouter>
    </AppProvider>
  );
}

export default App;

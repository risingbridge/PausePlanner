interface Release {
  version: string;
  date: string;
  title: string;
  changes: string[];
}

// Newest first. 1.0.0 is the first version that was actually tagged; every
// entry below it was numbered in hindsight from the commit history, so
// those numbers describe the project's shape at the time rather than a
// release anyone could have installed by that name.
const RELEASES: Release[] = [
  {
    version: "1.0.1",
    date: "17 September 2026",
    title: "No more short sits",
    changes: [
      "Fixed the scheduler seating someone in a position for less than the minimum position length right before that position closed, then sending them idle. Only a person's own boundaries (shift end, blocked time, a required position) may now cut a stint short; a start that can't reach the minimum before the position closes is no longer allowed.",
      "Added the version number next to the title (it links here), and this changelog.",
    ],
  },
  {
    version: "1.0.0",
    date: "16 September 2026",
    title: "One scheduling engine",
    changes: [
      "MIP (HiGHS) is now the only scheduling algorithm. Quick, Balanced, Thorough, Refine, Thorough (Experimental), and Rotate (Experimental) were removed — MIP is the only one that proves optimality and honors required positions, so the rest added nothing but maintenance cost. Data exported by an earlier version that names one of them still imports fine and simply runs MIP.",
      "\"Copy to...\" can now copy positions & openings and staffing independently, instead of always overwriting both.",
      "MIP (HiGHS) became the default algorithm for new data (it had been Quick).",
      "Staffing page copy corrected: required positions were honored by more than just Thorough (Experimental).",
    ],
  },
  {
    version: "0.7.0",
    date: "9 September 2026",
    title: "Privacy & Data page",
    changes: [
      "New Privacy & Data page explaining where data lives (only in this browser's localStorage), what export/import does, and that the app sets no cookies and loads nothing from third parties.",
    ],
  },
  {
    version: "0.6.1",
    date: "4 September 2026",
    title: "MIP correctness fixes from real schedules",
    changes: [
      "Fixed MIP assigning two people to the same open position at the same time. The coverage constraint counted shortfalls correctly but never capped a position at one worker, and idle fairness had started exploiting that to pad someone's work minutes.",
      "Fixed MIP letting a continuous run exceed the max time in position when free work led straight into a required position on the same position. The cap was only enforced after a requirement ended, not before it started.",
    ],
  },
  {
    version: "0.6.0",
    date: "3 September 2026",
    title: "MIP (HiGHS) and Rotate (Experimental)",
    changes: [
      "Added MIP (HiGHS): the whole scheduling problem formulated as a mixed-integer program and solved by a real optimizer running in a Web Worker, with a per-stage progress bar next to the Generate button.",
      "Added idle fairness as its own MIP stage, so total workload — not just each position's share — is balanced across staff.",
      "Fixed a MIP stage that ran out of time without any solution silently corrupting the stages after it; raised the solve budget to 45 seconds worst case.",
      "Added Rotate (Experimental): Thorough (Experimental) with a fair position-rotation objective.",
    ],
  },
  {
    version: "0.5.1",
    date: "2 September 2026",
    title: "Small schedule-view improvements",
    changes: [
      "The By Staff view shows each person's shift code (or custom times) next to their name.",
      "Single-day print headings include the weekday.",
    ],
  },
  {
    version: "0.5.0",
    date: "1 September 2026",
    title: "Required positions",
    changes: [
      "Staff can be required to work a specific position for a window of time — the positive counterpart to blocked times — with an optional comment shown inline on every slot the requirement covers.",
      "Added Thorough (Experimental), the first algorithm to honor required positions.",
      "Fixed Thorough (Experimental) pushing every break to the end of the day.",
    ],
  },
  {
    version: "0.4.0",
    date: "31 August 2026",
    title: "Pluggable algorithms",
    changes: [
      "The scheduling algorithm is now selectable on the Settings page.",
      "Added Balanced, Thorough, and Refine alongside the original Quick algorithm.",
    ],
  },
  {
    version: "0.3.0",
    date: "30 August 2026",
    title: "Shift codes",
    changes: [
      "Added shift codes: named, reusable shift definitions shared across all weekdays. Staff link to one instead of copying its times, so editing the code updates everyone using it.",
      "Added a Clear all data button to Settings.",
      "The day switcher is hidden on Settings and Help, which aren't day-scoped.",
    ],
  },
  {
    version: "0.2.0",
    date: "29 August 2026",
    title: "A full week",
    changes: [
      "Replaced the single global day with seven independent weekday slots (Mon–Sun) and a day switcher in the header. Existing data migrates into Monday automatically.",
      "The break target window is configurable as a percentage of each shift, staggered across staff, and aware of coverage demand.",
    ],
  },
  {
    version: "0.1.0",
    date: "28 August 2026",
    title: "Initial release",
    changes: [
      "Positions and an openings grid in 15-minute slots, staff with shift times, and a Quick scheduling algorithm enforcing max time in position, minimum position length, one break per shift, and minimum idle time between positions.",
      "Per-staff blocked times (meetings and the like).",
      "Generated schedules are directly editable.",
      "Per-staff time summary, printed on its own page at the end.",
      "Export and import of all app data as JSON.",
      "Help page.",
      "Deployed to GitHub Pages.",
    ],
  },
];

export default function ChangelogPage() {
  return (
    <div className="page help-page">
      <h2>Changelog</h2>
      <p className="hint">
        You are running version <strong>{__APP_VERSION__}</strong>. Versions before 1.0.0 were numbered in
        hindsight from the project's history — 1.0.0 is the first one that was actually tagged.
      </p>

      {RELEASES.map((r) => (
        <section key={r.version}>
          <h3>
            {r.version} — {r.title}
          </h3>
          <p className="changelog-date">{r.date}</p>
          <ul>
            {r.changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

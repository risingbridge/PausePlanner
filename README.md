# PausePlanner

A workforce scheduling tool for planning which positions need to be staffed, when, and who covers them.

Define which positions are open at each time of day, add your staff and their shift hours, and generate a schedule that assigns staff to open positions — automatically enforcing a maximum continuous time in any one position and a minimum break length before returning to work.

The week is modeled as **7 persistent weekday slots** (Monday–Sunday) rather than calendar dates: there's no history and no "instances," just 7 always-present, independently-configured weekdays that repeat every week. Editing "Wednesday" always edits the same Wednesday slot. A day switcher in the header lets you jump between them; it defaults to today's actual weekday on first load and remembers your last choice after that.

Everything runs client-side; there is no backend or database. All data (positions, staffing, day start/end, and the generated schedule for each of the 7 weekdays, plus the shared scheduling-rule settings) is stored in the browser's `localStorage`, so it's private to whichever browser/device you use it on — use the export/import feature on the Settings page to move it elsewhere or keep a backup.

## Features

- **Day switcher** — 7 tabs (Mon–Sun) in the header. Switching days changes what Positions & Openings, Staffing, and Schedule all show; Settings and Help are unaffected, since scheduling rules are shared and Help is static. Positions, openings, staff, day start/end, and the generated schedule are all independent per weekday — staff are not shared across days, and a position named "Reception" on Monday has no relationship to one named "Reception" on Tuesday beyond the coincidence of sharing a name.
- **Copy to...** — next to the day switcher, copies the current day into one or more other weekdays you pick, after a confirmation (since it overwrites whatever was there). Choose which parts to copy: **Positions & Openings** (including day start/end), **Staffing**, or both — so you can reuse one day's position setup while leaving another day's staffing alone, or the reverse. The generated schedule is never copied — the destination day(s) generate fresh.
- **Positions & Openings** — a spreadsheet-style grid (time × position) where you toggle each position open or closed in 15-minute increments. Set that day's start/end time; the grid updates instantly. Each position has a **priority** (1 = most important, ties allowed): when not every open slot can be covered, the lowest-priority positions are left unstaffed first — strictly, so a more important position is never sacrificed to cover any number of less important ones.
- **Staffing** — add staff members with a name and shift start/end time, for the currently selected day. Instead of typing custom times, you can pick a shift code (managed on the Settings page) — a staff member linked to a code always reflects its current times, on every weekday, until unlinked. Expand a row to block out time for meetings or other commitments — blocked staff are never scheduled into a position during that window. Expand **Required positions** to force a staff member into a specific position for part of their shift, always honored when a schedule is generated. An optional comment on a requirement shows up inline on the Schedule page (e.g. "TWR (Currency check)") on every slot the requirement covers.
- **Settings** — choose the **scheduling algorithm** and tune the scheduling rules, shared across every weekday: minimum position length, max time in position, minimum break length, minimum idle time, and the earliest/latest points (as % of shift) the one real break can land. Also manage **shift codes** — named, reusable start/end times (e.g. "F1: 08:00–15:00") shared across all 7 weekdays, and export/import everything as a JSON file, to back up your work or move it to another computer.
- **Schedule** — generate a schedule for the currently selected day, view it either by position (who's where) or by staff (each person's timeline of positions/breaks/idle time), with any unstaffed gaps flagged. A per-person summary table (time in position, idle, break) sits above both views and updates live as you edit. Every cell is directly editable — click it to pick a different staff member, position, or status — for final manual touch-ups after generating. **Print / Save as PDF** prints the currently selected day; **Print full week** prints all 7 days' schedules in one document (using whichever view — by position or by staff — is currently selected), each on its own page, showing "Not yet generated" for any day without a generated schedule rather than blocking the print.

## Getting started

Requires Node.js.

```bash
npm install
npm run dev
```

Open the printed local URL in your browser.

## Building for production

```bash
npm run build
npm run preview
```

`npm run build` outputs static files to `dist/`. Don't open `dist/index.html` directly from disk — the build uses absolute asset paths that only resolve correctly when served over HTTP. Use `npm run preview` to sanity-check the build locally, or deploy `dist/` to any static host (Netlify, Vercel, GitHub Pages, etc.).

## How scheduling works

**MIP (HiGHS)** is the app's one scheduling engine (the Settings page's algorithm dropdown exists for future extensibility but currently lists only this). It formulates coverage, every labor rule, and a staged objective (coverage → position fairness → idle fairness → break quality → churn, each frozen in turn so a later stage can never trade away an earlier one's result) as a mixed-integer linear program and solves it with [HiGHS](https://highs.dev/), a real branch-and-cut solver compiled to WebAssembly and run in a dedicated Web Worker so the page stays responsive. Its ~3.4MB solver is loaded lazily on first use. It honors **required positions** (Staffing page) as hard constraints, and comes with a genuine optimality proof on each objective rather than a search budget silently running out — though a large, tightly-staffed instance can still leave a later stage unproven within its time budget (up to 45 seconds worst case).

See [Algorithm-Mip.md](Algorithm-Mip.md) for the full design, verification history, and every deviation from the original proposal.

## Tech stack

React, TypeScript, and Vite, with `react-router-dom` for page navigation. No UI framework — styling is plain CSS.

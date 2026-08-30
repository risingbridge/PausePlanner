# PausePlanner

A workforce scheduling tool for planning which positions need to be staffed, when, and who covers them.

Define which positions are open at each time of day, add your staff and their shift hours, and generate a schedule that assigns staff to open positions — automatically enforcing a maximum continuous time in any one position and a minimum break length before returning to work.

The week is modeled as **7 persistent weekday slots** (Monday–Sunday) rather than calendar dates: there's no history and no "instances," just 7 always-present, independently-configured weekdays that repeat every week. Editing "Wednesday" always edits the same Wednesday slot. A day switcher in the header lets you jump between them; it defaults to today's actual weekday on first load and remembers your last choice after that.

Everything runs client-side; there is no backend or database. All data (positions, staffing, day start/end, and the generated schedule for each of the 7 weekdays, plus the shared scheduling-rule settings) is stored in the browser's `localStorage`, so it's private to whichever browser/device you use it on — use the export/import feature on the Settings page to move it elsewhere or keep a backup.

## Features

- **Day switcher** — 7 tabs (Mon–Sun) in the header. Switching days changes what Positions & Openings, Staffing, and Schedule all show; Settings and Help are unaffected, since scheduling rules are shared and Help is static. Positions, openings, staff, day start/end, and the generated schedule are all independent per weekday — staff are not shared across days, and a position named "Reception" on Monday has no relationship to one named "Reception" on Tuesday beyond the coincidence of sharing a name.
- **Copy to...** — next to the day switcher, copies the current day's positions, openings, staff, and day start/end into one or more other weekdays you pick, after a confirmation (since it overwrites whatever was there). The generated schedule is never copied — the destination day(s) generate fresh.
- **Positions & Openings** — a spreadsheet-style grid (time × position) where you toggle each position open or closed in 15-minute increments. Set that day's start/end time; the grid updates instantly.
- **Staffing** — add staff members with a name and shift start/end time, for the currently selected day. Instead of typing custom times, you can pick a shift code (managed on the Settings page) — a staff member linked to a code always reflects its current times, on every weekday, until unlinked. Expand a row to block out time for meetings or other commitments — blocked staff are never scheduled into a position during that window.
- **Settings** — tune the scheduling rules, shared across every weekday: minimum position length, max time in position, minimum break length, minimum idle time, and the earliest/latest points (as % of shift) the one real break can land. Also manage **shift codes** — named, reusable start/end times (e.g. "F1: 08:00–15:00") shared across all 7 weekdays, and export/import everything as a JSON file, to back up your work or move it to another computer.
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

See [Algorithm.md](Algorithm.md) for a full, detailed walkthrough of the scheduling algorithm. Summary below.

The scheduler (`src/scheduler/generateSchedule.ts`) walks through the day one 15-minute slot at a time and, for each slot:

Each person gets exactly **one** real break per shift — at least **minimum break length** long, targeted at a window of their shift set by **earliest break** and **latest break** (as % of shift, default 25%–75%). Every other time someone is moved off a position — hitting max time in position again, a position closing, or a fairness rotation — they just go idle for at least **minimum idle time**, which can be much shorter than a full break, but has no maximum.

1. **Max time in position** is a hard cap: anyone who would exceed it by continuing is always pulled off. The first time this (or any other stop) happens inside the target window, it becomes their one real break; every other time, it's just a short idle gap.
2. A position **closing** also forces an immediate stop — nobody is ever bounced straight from one position into another in the same slot, even if a different position happens to be sitting vacant right then. Whether this becomes the real break or just idle follows the same one-break-per-shift rule above.
3. Because idle gaps have no maximum length, a long one can still be running when the target window opens. Rather than let it continue as plain idle and force an unrelated break later, it's converted into the real break from that point on — this is what keeps the break from ending up oddly tacked onto the end of the shift while an idle gap sits in the middle. Widening the window (e.g. lowering the earliest-break percentage) gives this more opportunities to fire before demand gets tight, which can resolve unstaffed gaps that a narrower window would otherwise force.
4. If a person still hasn't had their break by the end of the target window — or is running out of shift time entirely — the scheduler forces it right then, overriding an active stint, minimum position length, and fairness alike, since this guarantee is absolute.
5. How many people can newly start their break in the same slot is capped by real surplus, not a fixed number: staff on shift minus the *most* positions that will need covering at any point during the break's length (a momentary lull isn't treated as safe surplus if demand is about to spike back up while that break is still running), minus whoever's already mid-break. This lets a lightly-staffed slot send several people on break at once when that's genuinely safe, while staggering them a slot or two apart when it isn't — either way avoiding a wave of simultaneous breaks leaving positions unstaffed the moment they reopen. Once past the target window, at least one person is still allowed through each slot even with zero calculated surplus, so a fully-utilized team (no spare capacity at all) still makes progress toward everyone's break instead of deferring all the way to the absolute last resort below.
6. **Minimum position length** protects short stints from fairness-driven interruption: nobody can be pulled off a position they're still allowed to hold before they've worked it for at least this long. (It doesn't protect against a position closing or either guaranteed-break override above — those are hard stops.)
7. Everyone else eligible to work is ranked by how large a share of their shift-so-far they've spent idle (staff who haven't started their shift yet rank highest, so they're put to work right away). This is a running, per-person ratio, so it naturally accounts for staff having different shift lengths.
8. Positions that are genuinely vacant (nobody currently holding them) are handed out in that ranking order first. Only if no vacant position is available does the scheduler consider pulling someone off a position they're still actively working — and only the person who least deserves to keep it (based on the same idle ranking), and only when doing so actually improves the balance.
9. Any open position that still has no one available is marked **unstaffed**.

A staff member's blocked times (meetings, etc.) are treated as a hard constraint, checked before any of the above: during a block they're entirely unavailable — not eligible for a position, and the time doesn't count toward their idle ratio in either direction, the same as time outside their shift.

This is a greedy algorithm — it produces a valid, fairly-balanced schedule quickly, but it isn't guaranteed to find the mathematically optimal assignment across the whole day.

## Tech stack

React, TypeScript, and Vite, with `react-router-dom` for page navigation. No UI framework — styling is plain CSS.

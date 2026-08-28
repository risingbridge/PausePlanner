# PausePlanner

A workforce scheduling tool for planning which positions need to be staffed, when, and who covers them.

Define which positions are open at each time of day, add your staff and their shift hours, and generate a schedule that assigns staff to open positions — automatically enforcing a maximum continuous time in any one position and a minimum break length before returning to work.

Everything runs client-side; there is no backend or database. All data (positions, staffing, settings, and the generated schedule) is stored in the browser's `localStorage`, so it's private to whichever browser/device you use it on.

## Features

- **Positions & Openings** — a spreadsheet-style grid (time × position) where you toggle each position open or closed in 15-minute increments. Set a global day start/end time; the grid updates instantly.
- **Staffing** — add staff members with a name and shift start/end time. Expand a row to block out time for meetings or other commitments — blocked staff are never scheduled into a position during that window.
- **Settings** — tune the scheduling rules: minimum position length, max time in position, and minimum break length.
- **Schedule** — generate a schedule from the above, view it either by position (who's where) or by staff (each person's timeline of positions/breaks/idle time), with any unstaffed gaps flagged. Print or save the result as a PDF via the browser's print dialog.

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

The scheduler (`src/scheduler/generateSchedule.ts`) walks through the day one 15-minute slot at a time and, for each slot:

1. **Max time in position** is a hard cap: anyone who would exceed it by continuing is pulled off and must rest for at least the **minimum break length** before being assigned anywhere again. This rule ignores fairness and can't be overridden.
2. **Minimum position length** protects short stints: nobody can be pulled off a position for fairness reasons before they've worked it for at least this long. (They can still be pulled off sooner if the position itself closes.)
3. Everyone else is ranked by how large a share of their shift-so-far they've spent idle (staff who haven't started their shift yet rank highest, so they're put to work right away). This is a running, per-person ratio, so it naturally accounts for staff having different shift lengths.
4. Positions that are genuinely vacant (nobody currently holding them) are handed out in that ranking order first. Only if no vacant position is available does the scheduler consider pulling someone off a position they're still actively working — and only the person who least deserves to keep it (based on the same idle ranking), and only when doing so actually improves the balance. This is what keeps staff from being bounced directly from one position into another whenever it can be avoided.
5. Anyone displaced this way — or whose position simply closed with nowhere else to go — rests on a break (at least **minimum break length**) rather than idling. Idle is reserved for staff who haven't worked yet in their current stretch (e.g. the start of a shift, or genuine long-term surplus). Any open position that still has no one available is marked **unstaffed**.

A staff member's blocked times (meetings, etc.) are treated as a hard constraint, checked before any of the above: during a block they're entirely unavailable — not eligible for a position, and the time doesn't count toward their idle ratio in either direction, the same as time outside their shift. A block always takes effect immediately, regardless of minimum position length, since it isn't a fairness-driven interruption.

This is a greedy algorithm — it produces a valid, fairly-balanced schedule quickly, but it isn't guaranteed to find the mathematically optimal assignment across the whole day.

## Tech stack

React, TypeScript, and Vite, with `react-router-dom` for page navigation. No UI framework — styling is plain CSS.

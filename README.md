# PausePlanner

A workforce scheduling tool for planning which positions need to be staffed, when, and who covers them.

Define which positions are open at each time of day, add your staff and their shift hours, and generate a schedule that assigns staff to open positions — automatically enforcing a maximum continuous time in any one position and a minimum break length before returning to work.

Everything runs client-side; there is no backend or database. All data (positions, staffing, settings, and the generated schedule) is stored in the browser's `localStorage`, so it's private to whichever browser/device you use it on.

## Features

- **Positions & Openings** — a spreadsheet-style grid (time × position) where you toggle each position open or closed in 15-minute increments. Set a global day start/end time; the grid updates instantly.
- **Staffing** — add staff members with a name and shift start/end time.
- **Settings** — tune the two scheduling rules: max time in position and minimum break length.
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

1. Lets any staff member who is already working a position continue there, as long as that position is still open and they haven't hit the **max time in position** limit.
2. If a staff member hits that limit, they're taken off the position and must rest for at least the **minimum break length** before being assigned anywhere again.
3. If a staff member's position closes before they hit the limit, they're freed up immediately (no break required) and can be reassigned to another open position in the same slot.
4. Any remaining open positions are filled from staff who are on shift and currently available.
5. Any open position that still has no one available is marked **unstaffed**.

This is a greedy, first-fit algorithm — it produces a valid schedule quickly, but it isn't guaranteed to be the schedule that minimizes gaps or break time across the whole day.

## Tech stack

React, TypeScript, and Vite, with `react-router-dom` for page navigation. No UI framework — styling is plain CSS.

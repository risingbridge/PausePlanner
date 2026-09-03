# PausePlanner — agent notes

Workforce scheduling webapp: define which positions need staffing when, add staff, generate a
fair schedule. React + TypeScript + Vite, no backend — all data lives in the browser's
`localStorage`. Deployed to GitHub Pages via `.github/workflows/deploy.yml`.

Read **[README.md](README.md)** first for what the app does and its features. There are six
scheduling algorithms, each with its own full walkthrough: **[Algorithm.md](Algorithm.md)**
(Quick), **[Algorithm-Balanced.md](Algorithm-Balanced.md)**, **[Algorithm-Thorough.md](Algorithm-Thorough.md)**,
**[Algorithm-Refine.md](Algorithm-Refine.md)**,
**[Algorithm-ThoroughExperimental.md](Algorithm-ThoroughExperimental.md)**, and
**[Algorithm-RotateExperimental.md](Algorithm-RotateExperimental.md)**. This file covers
things a fresh agent needs that those don't: how the code is put together, conventions this
repo has settled on, and how prior work here got verified.

## Commands

```bash
npm install
npm run dev      # Vite dev server
npm run build    # tsc -b && vite build — treat any tsc/build error as a real bug, not noise
npm run lint     # oxlint
npm run preview  # serve the production build locally (dist/index.html can't be opened directly — see README)
```

There is no test suite. Verification is manual: run the dev server, drive it with the browser
tool, and/or write a throwaway script that calls a scheduler function directly (see below).

## Architecture

- **`src/types.ts`** — all shared types. `AppState = { days: Record<Weekday, DaySchedule>,
  settings: Settings, shiftCodes: ShiftCode[], currentDay: Weekday, showMigrationNotice: boolean }`.
  `DaySchedule` holds one weekday's fully independent `dayStart`/`dayEnd`/`positions`/`openings`/
  `staff`/`schedule`. `Settings` holds the chosen `algorithm: AlgorithmId` plus the six numeric
  rules shared across every weekday (`maxTimeInPosition`, `minPositionLength`, `minBreakLength`,
  `minIdleTime`, `earliestBreakPercent`, `latestBreakPercent`). `Staff.requirements: PositionRequirement[]`
  are positive constraints ("work position X from A to B", with an optional `comment`) — the
  opposite of `Staff.blocks: TimeBlock[]`, which are negative (unavailable).
- **`src/state/AppContext.tsx`** — all state and localStorage persistence (key
  `pauseplanner_state_v2`). Day-scoped actions (`addPosition`, `addStaff`, `toggleOpening`,
  `addRequirement`, etc.) keep simple signatures and resolve against `state.days[state.currentDay]`
  internally via the `updateCurrentDay` helper — callers never pass a weekday explicitly.
  `ShiftCode`s and `Settings` are the two pieces of state that are *not* day-scoped — shift codes
  are global and staff link to one by id (`addShiftCode`/`updateShiftCode`/`removeShiftCode`, with
  cross-day cleanup on delete: linked staff freeze to the code's last-known times rather than
  breaking). Also owns export/import (`exportState`/`importState`), `clearAllData`, and the
  one-time v1→v2 migration (`migrateOldShape`, triggered from `loadState`/`importState` alike,
  landing old data on Monday with the other six days empty).
- **`src/scheduler/`** — the scheduling engine, structured as a pluggable registry rather than one
  algorithm:
  - **`index.ts`** exports `ALGORITHMS: Record<AlgorithmId, AlgorithmDefinition>` and
    `runScheduleAlgorithm(id, ...)`. Every algorithm has the identical pure signature
    `(positions, openings, staff, settings: ScheduleSettings) => ScheduleResult | Promise<ScheduleResult>`
    — `ScheduleSettings` is `Settings` merged with that day's `dayStart`/`dayEnd`. Adding a new
    algorithm means registering it here; `SettingsPage`'s dropdown reads `ALGORITHMS` directly, so
    it needs zero changes.
  - **`algorithms/quick.ts`** — the original greedy, one-pass algorithm (`runQuick`), synchronous.
    Every other mode is judged against it.
  - **`algorithms/balanced/`** — CSP break placement (`breakPlacement.ts`) + Hungarian-matching
    coverage (`hungarian.ts`), synchronous, always returns the better of {its own result, Quick's}.
  - **`algorithms/thorough/`** — a hand-rolled branch-and-bound search proving minimum unstaffed
    slots, warm-started from Quick/Balanced. Runs in a dedicated Web Worker (`worker.ts` +
    `index.ts`'s `runThoroughAsync`) so the UI thread never blocks.
  - **`algorithms/refine/`** — simulated annealing seeded from Quick's schedule, also
    Worker-backed. Deterministic (seeded PRNG in `rng.ts`).
  - **`algorithms/thorough-experimental/`** — a **deliberate fork** of `thorough/` (not a shared
    abstraction) kept as a standing incubator for experimental features. Enforces
    `Staff.requirements`. **Read the fork-relationship note below before touching `thorough/`,
    `thorough-experimental/`, or `rotate-experimental/`.**
  - **`algorithms/rotate-experimental/`** — a **deliberate fork of the fork**: copied wholesale
    from `thorough-experimental/`, so it keeps requirements too, plus a fair-rotation objective
    (`positionBalance.ts`) that spreads each position's time evenly across staff. `PersonState`
    grows a `positionMinutes` matrix for this — which also has to feed `stateSignature`, or the
    existing symmetry-breaking (sound for coverage-only search) would silently discard branches
    that are genuinely different once rotation is scored. See
    [Algorithm-RotateExperimental.md](Algorithm-RotateExperimental.md).
  - **`shared/`** — logic genuinely identical between the search-based modes, extracted rather than
    duplicated: `action.ts` (the common per-slot `Action` decision shape both build their internal
    schedule from, plus conversions to/from `ScheduleResult`), `breakDomain.ts` (legal break-start
    slots, shared verbatim so Thorough/Refine/Thorough-Experimental stay behaviorally consistent
    on edge-case shifts), `objectives.ts` (fairness/churn/break-centering cost functions, compared
    as a lexicographic tuple by Thorough and folded into one weighted score by Refine).
  - Each Worker is typed structurally against a small `WorkerGlobal` interface rather than via the
    `"webworker"` lib — that lib conflicts with the `"DOM"` lib the rest of the app relies on, and a
    structural type avoids a project-wide tsconfig change for three files.
- **`src/pages/*.tsx`** — one file per route (`OpeningsPage`, `StaffingPage`, `SchedulePage`,
  `SettingsPage`, `HelpPage`). All read/write the current day via `useApp()`'s `currentDay`
  (resolved `DaySchedule`) rather than reaching into `state.days[...]` directly. `SettingsPage`
  holds the algorithm dropdown, the six scheduling-rule inputs, shift-code management,
  export/import, and a "Danger zone" with `clearAllData`. `StaffingPage`'s `StaffRow` has two
  independent expand/collapse editors per staff member — blocked times and required positions —
  built on the identical pattern (see Conventions below).
- **`src/App.tsx`** — routes, nav, the day switcher (Mon–Sun tabs), "Copy to..." panel, and the
  migration notice banner. All rendered inside `AppProvider` via an `AppShell` child component
  (needed because the switcher/copy panel call `useApp()`). The switcher is hidden on
  Settings/Help since neither is day-scoped.

## Conventions this repo has settled on

- **No WHAT comments.** Comments explain WHY only, and only where genuinely non-obvious (a
  hidden constraint, a subtle invariant, a workaround). If you'd write a comment restating what
  the next line does, don't.
- **Minimal dependencies.** Just React, react-router-dom, and Vite tooling. No UI framework, no
  state management library, no date library (weekdays are a fixed 7-key `Record`, not a
  calendar — there's no date math beyond `new Date().getDay()` for the default day).
- **Immutable state updates everywhere** in `AppContext.tsx` — every action does `{...prev,
  ...}` / `.map()` / `.filter()`, never in-place mutation, except inside `setManualAssignment`/
  `setManualStatus`/eviction logic where a `structuredClone` of just the schedule is taken
  first and then mutated locally before being placed back into the new state tree.
- **Optional free-text fields** (a block's `label`, a requirement's `comment`) are trimmed and
  stored as `undefined` rather than `""` when empty (`label.trim() || undefined`) — keeps
  "does this have one" a simple truthiness check everywhere it's read.
- **Expand/collapse per-row editors** (blocked times, required positions on `StaffingPage`)
  follow one pattern: a `"N item(s) ▾/▴"` toggle button in the row, an independent piece of
  `expandedXId` state in the parent so only one row's editor is open at a time, and an
  `add-row`-styled form below the list when expanded. Follow this shape for any new per-staff
  editor rather than inventing a new one.
- **Print output** uses a consistent pattern: `.no-print` hides interactive controls when
  printing; `.print-only-block` / `.print-header` (in `App.css`, gated by `@media print`) show
  static content that only exists for print. Follow this pattern for any new printable content
  rather than inventing a new mechanism.
- **Commit messages** explain why, not what, in 1–3 sentences, `Co-Authored-By: Claude Sonnet 5
  <noreply@anthropic.com>` trailer. Only commit/push when explicitly asked.

## The scheduler is genuinely delicate — read this before editing it

The algorithms went through several rounds of real bugs found via the user's own production
data, not synthetic tests. The short version, in case you're tempted to simplify something that
looks over-engineered:

- Quick's (`algorithms/quick.ts`) "one break per shift" window (`earliestBreakPercent`/
  `latestBreakPercent`) exists because a naive "first stop after the midpoint" rule let long idle
  stretches sit unconverted while an unrelated break got forced in at the very end of the shift.
- Quick's per-slot break-stagger cap (`maxNewBreaksThisSlot`) exists because letting everyone
  who's simultaneously idle take their break at once can empty out coverage the moment positions
  reopen. It's computed via **lookahead across the break's full duration**
  (`maxOpenPositionsDuringBreakFrom`), not just the current slot — a momentary lull right before a
  demand spike must not look like safe surplus.
- Quick's "at least one gets through" floor past the window exists because a team with zero spare
  capacity (e.g. a lone worker) would otherwise never clear the stagger cap and would defer
  everyone to the absolute last-resort deadline instead of near the window.
- Thorough/Refine/Thorough-Experimental's `hasDeadEnd`/`allBreaksSatisfied` checks exist because
  a search can otherwise reach a "0 unstaffed" leaf by simply never scheduling anyone's break
  (idle never removes future availability the way break does, so a search that only optimizes
  coverage will happily skip it). Don't remove this pruning without re-deriving a case that
  proves it's still caught.
- **Value ordering inside a branch-and-bound search matters more than it looks.** Thorough
  Experimental's `legalOptionsFor` tries `work`, then `break`, then `idle` for a free person. It
  used to try `idle` before `break`; on a real instance with an active requirement (which forces
  the search to seed its incumbent from `Infinity` — see `Algorithm-ThoroughExperimental.md`),
  that ordering made the search's first-found complete schedule defer every break as late as
  possible, burning the entire node budget on one bad answer (9 unstaffed slots) before any
  pruning could help. Swapping the order fixed it (proven-optimal in ~20,000 of the 100,000-node
  budget). If a search-based mode ever comes back with a suspiciously bad "unstaffed" count on a
  real instance, check the option ordering before assuming the budget needs raising.

If you change any of this, re-derive a real test case rather than trusting intuition — see below
for how prior sessions did it. Unstaffed slots are also not automatically a bug: with tight
staffing and a mandatory break, some scenarios are mathematically infeasible to cover perfectly,
and the algorithms are meant to surface that honestly rather than hide it by quietly breaking a
rule.

### `thorough/`, `thorough-experimental/`, and `rotate-experimental/` are a deliberate fork chain

`thorough-experimental/` started as a byte-for-byte copy of `thorough/`, kept as a standing
incubator for features that don't belong in the proven, permanent modes yet (today: required
position assignments). `rotate-experimental/` then forked *that* fork wholesale, adding a
fair-rotation objective on top. **They now diverge permanently** — a fix or improvement made to
one does not automatically apply to the others; check all three when you find a bug that plausibly
affects the shared ancestry (like the value-ordering fix above, which only landed in
`thorough-experimental/` and `rotate-experimental/`, not `thorough/`). This is an accepted cost of
using forks as incubators, not an oversight. See
[Algorithm-RotateExperimental.md](Algorithm-RotateExperimental.md)'s "note on the fork chain" for
the specific consequence of forking a fork: `thorough-experimental/` could prove its copy
introduced no behavioral drift before requirements landed; `rotate-experimental/` can't make that
same claim, since it changes behavior (the objective) on top of an already-modified base.

### How to test a scheduler change directly (no UI needed)

Every algorithm's entry point is a pure function with no DOM dependency (`runQuick`,
`runBalanced`, the sync core function inside `thorough`/`refine`/`thorough-experimental`/
`rotate-experimental`, or `runScheduleAlgorithm(id, ...)` for the full async/Worker-wrapped path),
so the fastest way to
check a change is a throwaway script, bundled with esbuild (plain `node --experimental-strip-types`
can't resolve the extension-less relative imports) and run with `node`:

```bash
npx esbuild /path/to/test.ts --bundle --platform=node --format=esm --outfile=/path/to/test.bundle.mjs
node /path/to/test.bundle.mjs
```

Write the script into the scratchpad directory, construct `positions`/`openings`/`staff`/
`settings` by hand (or paste in a real exported JSON's `days.mon` etc. and add that day's
`dayStart`/`dayEnd` to `settings`), call the algorithm function directly, and print
`result.staffTimeline`/`result.unstaffed` slot by slot. For a search-based mode, calling its
synchronous core function (e.g. `runThorough`, not `runThoroughAsync`) avoids needing a real
Worker in Node. Delete the script when done — none of these should be committed.

## How UI changes were verified

There's no automated UI test suite. Prior sessions used the Claude Browser tool
(`mcp__Claude_Browser__*`) against the Vite dev server, launched via `preview_start` with a
`.claude/launch.json` config (name `pauseplanner-dev`, already present in this repo). Useful
patterns already exercised:

- **`window.confirm`/`window.print` in automated testing**: this environment auto-rejects
  `confirm()` by default and no-ops `print()`. To test the "yes" path, override
  `window.confirm = () => true` via `javascript_tool` before clicking. To inspect what would
  print, stub `window.print` to a no-op first (so `printingWeek`-style state doesn't revert),
  then inject a `<style>` tag that forces the relevant `@media print` rules active outside of
  an actual print context, screenshot, then remove the injected style and reload.
- **File import testing**: a real file picker can't be driven programmatically; construct a
  `File` + `DataTransfer`, assign `input.files = dt.files`, and dispatch a `change` event on
  the hidden `<input type="file">` — this is how import/export round-tripping got verified. To
  feed a large real export into the browser without pasting it through the tool's own context,
  temporarily drop the JSON in `public/` (served by Vite at `/PausePlanner/<name>.json` in dev,
  matching the configured base path) and `fetch()` it from the page instead of embedding the
  content in a `javascript_tool` call — delete the file from `public/` again once done.
- Always check both the happy path and at least one edge case pulled from real usage data
  when the user reports one — several bugs in the scheduler were only caught this way, not by
  synthetic scenarios.

## Loose ends / things a fresh agent should know

- The weekly model (7 independent weekday slots, replacing an earlier single global day) touches
  almost every file. If something looks like it should reference a single
  `state.positions`/`state.staff`/etc. at the top level, that's stale — the correct shape is
  `state.days[state.currentDay].positions`, exposed as `currentDay.positions` via `useApp()`.
- LocalStorage migration: v1 (pre-weekly) data auto-migrates into the Monday slot the first
  time the new code loads it, with the old `pauseplanner_state_v1` key left untouched as an
  inert backup (never deleted). Don't add a second migration path without checking
  `migrateOldShape`/`normalizeState` in `AppContext.tsx` first — the logic already handles both
  fresh v2 data and legacy v1 data (from `localStorage` *or* an imported file) through the same
  functions.
- Required-position comments are display-only metadata read straight off `Staff.requirements` by
  `SchedulePage` (`requirementCommentAt`/`withComment`) — the scheduler itself never sees or
  stores them. Shown inline (`"TWR (Currency check)"`) on every slot the requirement's window
  covers (`slot >= r.start && slot < r.end`), so the whole required stretch reads as required.

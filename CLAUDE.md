# PausePlanner — agent notes

Workforce scheduling webapp: define which positions need staffing when, add staff, generate a
fair schedule. React + TypeScript + Vite, no backend — all data lives in the browser's
`localStorage`. Deployed to GitHub Pages via `.github/workflows/deploy.yml`.

Read **[README.md](README.md)** first for what the app does and its features. **[Algorithm-Mip.md](Algorithm-Mip.md)**
is the full design/verification walkthrough for **MIP (HiGHS)**, the app's one scheduling engine.
This file covers things that doc doesn't: how the code is put together, conventions this repo has
settled on, and how prior work here got verified.

Six earlier algorithms (Quick, Balanced, Thorough, Refine, Thorough (Experimental), Rotate
(Experimental)) were deliberately removed to consolidate on MIP — it's the only one that proves
optimality and the only one that honors `Staff.requirements`, so keeping the others around was
pure maintenance cost with no capability they offered that MIP didn't already cover better. Their
design docs (`Algorithm.md`, `Algorithm-Balanced.md`, `Algorithm-Thorough.md`, `Algorithm-Refine.md`,
`Algorithm-ThoroughExperimental.md`, `Algorithm-RotateExperimental.md`) are gone too — git history
has them if you need the old reasoning. `AlgorithmId` (`src/types.ts`) is kept as a one-member
union rather than a plain constant, and the `ALGORITHMS` registry (`src/scheduler/index.ts`) and
the Settings page's algorithm dropdown are both kept as-is (just with one entry) — a deliberate
choice to preserve the pluggable shape for if another algorithm is ever added back, rather than
collapsing the abstraction now and having to reintroduce it later.

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
  `minIdleTime`, `earliestBreakPercent`, `latestBreakPercent`). `Position.priority` (1 = most
  important, ties allowed; missing on pre-1.1 data and normalized to `DEFAULT_POSITION_PRIORITY` on
  load) drives strict lexicographic coverage — one frozen MIP coverage sub-stage per distinct
  level. `Staff.requirements: PositionRequirement[]`
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
- **`src/scheduler/`** — the scheduling engine, structured as a pluggable registry (currently
  holding one entry) rather than a single hardcoded algorithm:
  - **`index.ts`** exports `ALGORITHMS: Record<AlgorithmId, AlgorithmDefinition>` and
    `runScheduleAlgorithm(id, ...)`. Every algorithm has the identical pure signature
    `(positions, openings, staff, settings: ScheduleSettings, onProgress?) => ScheduleResult | Promise<ScheduleResult>`
    — `ScheduleSettings` is `Settings` merged with that day's `dayStart`/`dayEnd`. Adding a new
    algorithm means registering it here; `SettingsPage`'s dropdown reads `ALGORITHMS` directly, so
    it needs zero changes. Falls back to MIP for an unrecognized id (e.g. an old export naming a
    since-removed algorithm).
  - **`algorithms/mip/`** — builds its own CPLEX-LP-format problem text (`model.ts`,
    `lpBuilder.ts`) and hands it to [HiGHS](https://highs.dev/) (the `highs` npm package — note the
    package is named `highs`, not `highs-js`, which is the GitHub project's name) running in its
    own Worker, solved in frozen-and-lexicographic stages (`core.ts`): coverage (one sub-stage per
    distinct position priority, most important first), position fairness, idle fairness, break
    quality, churn — so the stage count reported to the progress bar is per-run, not a constant. The app's only runtime dependency (~3.4MB WASM,
    loaded lazily — see the "Minimal dependencies" note below). A stage timing out with zero
    feasible incumbent (`ObjectiveValue: Infinity`, not just "not proven optimal") must never be
    frozen as a constraint — this actually happened and silently corrupted coverage on a real
    schedule; every freeze is now conditional on `Number.isFinite`. See
    [Algorithm-Mip.md](Algorithm-Mip.md), including its "Deviations from the original design" and
    "Verification" sections, before assuming the original spec (preserved in project history)
    describes the current code. Also holds `action.ts` (`decisionsToScheduleResult`, used by
    `decode.ts` to produce the same `ScheduleResult` shape this app has always returned) and
    `breakDomain.ts` (`computeBreakDomain`, the legal break-start-slot set) — both moved in from a
    now-deleted `scheduler/shared/` when the DFS-based modes that used to share them were removed.
  - The Worker is typed structurally against a small `WorkerGlobal` interface rather than via the
    `"webworker"` lib — that lib conflicts with the `"DOM"` lib the rest of the app relies on, and a
    structural type avoids a project-wide tsconfig change for one file.
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
- **Minimal dependencies.** Just React, react-router-dom, and Vite tooling — with one deliberate
  exception: `algorithms/mip/` depends on `highs` (a real WASM MIP solver, ~3.4MB), loaded lazily
  inside that algorithm's own Worker so nobody pays the cost unless they select and run that mode.
  No UI framework, no state management library, no date library (weekdays are a fixed 7-key
  `Record`, not a calendar — there's no date math beyond `new Date().getDay()` for the default
  day).
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
- **Versioning.** `package.json`'s `version` is the single source of truth — `vite.config.ts`
  injects it as `__APP_VERSION__` (declared in `src/vite-env.d.ts`), shown next to the title in
  the header (linking to `/changelog`) so a deployed build can be matched to a tag at a glance.
  Releasing means: add an entry to the top of `RELEASES` in `src/pages/ChangelogPage.tsx`, run
  `npm version patch|minor|major` (bumps `package.json` and creates the `vX.Y.Z` tag), then
  `git push --follow-tags`. Semver: fixes are patch, new user-visible features are minor.

## The scheduler is genuinely delicate — read this before editing it

MIP went through several rounds of real bugs found via the user's own production data, not
synthetic tests — see [Algorithm-Mip.md](Algorithm-Mip.md)'s "Verification" section for the full
history (freeze-if-not-finite, the double-staffing gap, the requirement-boundary max-time gap,
and more). If you're tempted to simplify something in `algorithms/mip/` that looks
over-engineered, read that section first — most of what's there is a direct response to a real
bug on real data, not speculative robustness.

If you change any of it, re-derive a real test case rather than trusting intuition — see below
for how prior sessions did it. Unstaffed slots are also not automatically a bug: with tight
staffing and a mandatory break, some scenarios are mathematically infeasible to cover perfectly,
and the algorithm is meant to surface that honestly rather than hide it by quietly breaking a
rule.

### How to test a scheduler change directly (no UI needed)

`runMip` (the sync-looking-but-actually-`async` core function — loading the WASM solver has no
synchronous path) or `runScheduleAlgorithm("mip", ...)` for the full async/Worker-wrapped path are
both pure functions with no DOM dependency, so the fastest way to check a change is a throwaway
script, bundled with esbuild (plain `node --experimental-strip-types` can't resolve the
extension-less relative imports) and run with `node`:

```bash
npx esbuild /path/to/test.ts --bundle --platform=node --format=esm --outfile=/path/to/test.bundle.mjs
node /path/to/test.bundle.mjs
```

Write the script into the scratchpad directory, construct `positions`/`openings`/`staff`/
`settings` by hand (or paste in a real exported JSON's `days.mon` etc. and add that day's
`dayStart`/`dayEnd` to `settings`), call `runMip` directly, and print
`result.staffTimeline`/`result.unstaffed` slot by slot. Delete the script when done — none of
these should be committed.

Testing `runMip` needs two adjustments to that basic pattern: bundle with `--packages=external`
(so the real `highs` package resolves via Node's own module resolution instead of getting bundled
— it does its own environment detection between Node and browser internally) and copy the bundled
script into the project root before running `node` on it (so `node_modules/highs` resolves),
rather than running it from the scratchpad directory. Pass `require.resolve("highs/runtime")` (via
`createRequire`) as `runMip`'s `wasmUrl` argument — the Worker's own build-time `?url` import
doesn't apply outside Vite.

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

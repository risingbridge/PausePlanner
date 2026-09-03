# MIP (HiGHS)

**MIP (HiGHS)** (`src/scheduler/algorithms/mip/`) formulates the whole scheduling problem — coverage,
every labor rule, and a staged fairness objective — as a mixed-integer linear program, and hands
it to [HiGHS](https://highs.dev/) (a real simplex + branch-and-cut solver, compiled to WebAssembly
via the [`highs`](https://www.npmjs.com/package/highs) npm package) instead of running a hand-rolled
search. It is a genuinely different engine from every other mode here: Quick/Balanced/Thorough/
Refine/Thorough (Experimental)/Rotate (Experimental) all build on the same per-slot `PersonState`
DFS machinery in `scheduler/shared/`; this one shares none of it. It builds its own LP-format
problem text, solves it in up to four sequential stages, and decodes the result back into the same
`ScheduleResult` shape every other mode produces.

This document describes what was actually built and verified, not just designed — see "Deviations
from the original design" below for every place the implementation made a concrete choice the
original proposal left open or specified differently.

## Why a MIP here, and why HiGHS specifically

Coverage, break placement, and the run-length rules are genuinely globally coupled — a break that
looks fine in isolation can starve a position an hour later, and the min/max run-length rules are
contiguity constraints that don't compose cleanly with slot-by-slot decisions. That combination is
exactly what constraint/integer programming solvers exist for, and HiGHS is a real one: presolve,
cutting planes, a genuine optimality gap instead of "search budget exhausted." It has an official
WASM build, so it runs entirely client-side in a Web Worker — no backend, matching this app's one
hard constraint.

The tradeoff, paid honestly: `highs`'s WASM binary is **3.4MB** (gzipped ~1.2MB) — this app's first
real runtime dependency, where every other mode is hand-rolled TypeScript. It's loaded lazily,
inside this mode's own dedicated Worker (`import wasmUrl from "highs/runtime?url"`, resolved to its
own asset chunk by Vite), so nobody pays that cost unless they actually select **MIP (HiGHS)** and
generate a schedule — every other mode's bundle size is untouched.

## The model

Every staff/slot/position combination that's actually reachable gets a binary decision variable —
`x[s,p,t]` (working position `p`), `br[s,t]` (on break), `idle[s,t]` (idle) — built directly from
this app's existing `Position`/`Staff`/`OpeningsGrid`/`ScheduleSettings` types
(`model.ts`'s `buildModel`). Variables are only created where they could possibly be true: nothing
is created for a slot outside someone's shift, inside a blocked range, for a closed position, or
for a slot a requirement has already pinned — keeping the LP small rather than padding it with
variables permanently fixed to zero.

**Every hard rule becomes a linear constraint**, built once and shared unchanged across every
solve stage (only the objective — and one frozen bound per prior stage — differs stage to stage):

- **Slot partition** — for every present slot, exactly one of "working some open position," "on
  break," or "idle" is true.
- **Coverage** — `unstaffed[p,t]` is a shortfall variable, never a hard zero, because zero coverage
  is sometimes mathematically infeasible given the labor rules and the model has to say so
  honestly rather than pretend otherwise.
- **Exactly one break, sized and windowed** — reuses `shared/breakDomain.ts`'s
  `computeBreakDomain` verbatim for the legal start-slot set (same earliest/latest-percent window,
  same widen-to-full-shift fallback every other mode uses), then pins total break time to exactly
  `minBreakLength` and its contiguity via a `startBreak[s,t] ⟹ br[s,t..t+len)` implication.
- **Max time in position** — a sliding window forbidding any run of `maxTimeInPosition/15 + 1`
  consecutive slots on one position.
- **Min position length** — a `startWork[s,p,t]` indicator (`>= x[t] - x[t-1]`, one-directional —
  see "A note on one-directional indicators" below) whose forced-1 case implies the position holds
  for the (possibly shift-end-truncated) minimum window.
- **Min idle time between different positions** — for a genuine segment start on a different
  position, forbids any other position having been worked in the immediately preceding
  `minIdleTime`-slot lookback window.
- **Requirements and blocks** — a block simply omits that (staff, slot)'s variables entirely (the
  same "not present" treatment off-shift time already gets); a requirement fixes the position as a
  known constant rather than a decision variable, and removes it from what every *other* staff
  member sees as open at that slot — no separate eviction logic needed, exactly the trick Thorough
  (Experimental) uses for the same purpose.

### The two places a requirement boundary needed its own handling

These are the trickiest parts of the model, and the two places most likely to hide a bug if this
file is ever touched again:

1. **Max-time continuation across a requirement's end, on the same position.** Per Thorough
   (Experimental)'s documented behavior, only a requirement's own *start* resets the "continuous
   time in this position" counter — if free choice continues the same position right after the
   requirement ends, that's one continuous run for the cap's purposes. The model computes each
   requirement's `remainingBudget = maxTimeSlots - requiredLen` and adds one anchored window,
   right at the requirement's end, forbidding all `remainingBudget + 1` of the immediately
   following same-position slots from being 1 together.
2. **Min-idle time on both sides of a requirement boundary.** The ordinary lookback constraint
   above only fires off a real `startWork` variable — but a requirement's start/end has no
   variable to check against (it's a constant), so a free-choice switch *into* a requirement, or
   *out of* one, needs the same "no other position in the lookback window" rule applied explicitly
   using the requirement's known position and boundary slot.

Both were verified directly (see "Verification" below) with cases specifically designed to force
the boundary condition to actually trigger, not just cases where it happens not to matter.

### A note on one-directional indicators

`startWork[s,p,t] >= x[s,p,t] - x[s,p,t-1]` (and no upper-bound constraint pinning it back down) is
enough, and deliberately so: an over-triggered `startWork` can only add constraints, never relax
them, so at any solve's true optimum the solver has no reason to set it spuriously — doing so could
only hurt or not affect its own objective, given `startWork` doesn't appear in every stage's
objective. Stage 3 (churn), where it does appear and is being minimized, drives it to its true value
directly. This avoids needing the standard bidirectional big-M linearization.

## The staged objective

```
unstaffed → position fairness → idle fairness → break quality → churn
```

Each stage is solved to its own time-boxed optimum, its achieved value frozen as a `<=` constraint,
then the next stage re-solves the same model with that constraint added — coverage can never
regress to buy fairness, and fairness can never regress to buy tidiness.

- **Stage 1 (coverage)** — minimize `Σ unstaffed[p,t]`, uniform priority (no per-position weights
  configured — the original design's stated default).
- **Stage 2a (position fairness)** — minimize the worst-case deviation from each person's
  availability-weighted fair share of each position, computed **net of requirement-forced
  minutes** — the exact same `forced`/`remaining availability` split
  [Rotate (Experimental)](Algorithm-RotateExperimental.md) uses, not the original design's simpler
  flat-proportional formula (see "Deviations" below for why).
- **Stage 2b (idle fairness)** — minimize the worst-case deviation from an equal idle *ratio*
  across staff (`idleMinutes / elapsedMinutes`, matching `shared/objectives.ts`'s
  `fairnessVariance`, which every DFS-based mode already optimizes). **Not in the original
  design at all** — added after real-world testing showed position fairness alone leaves this
  open: a person available for more position-windows than a colleague can hold an individually
  fair share of every position while still doing substantially more total work, and therefore
  having substantially less idle time, overall. See "Deviations" below.
- **Stage 2c (break quality)** — minimize the worst-case deviation from each person's ideal break
  midpoint, reusing the exact "distance from window midpoint" formula
  `shared/objectives.ts`'s `breakOffCenterCost` already uses.
- **Stage 3 (churn)** — minimize total position-segment starts (a fresh segment beginning counts,
  including one resuming the same position after an idle/break gap — a different, and simpler,
  definition than `shared/objectives.ts`'s `churnCount`, which only counts genuine position
  *changes*; kept faithful to the original design's own formula rather than imported for
  consistency with the DFS modes).

Solve budget: 10s / 10s / 15s / 5s / 5s (45s worst case) — raised from an original 10s/4s/5s/3s/3s
(25s) after diagnosing a real complaint on a real 5-staff instance directly (see "Verification"
below): position fairness and idle fairness were both frequently timing out before finding *any*
feasible incumbent, not just before proving optimality, and giving idle fairness alone 30s (vs. its
original 5s) took it from a non-optimal 0.104 to a proven-optimal 0.021 — a ~5x tighter balance.
coverage and churn kept their already-generous, never-observed-to-bottleneck budgets; position
fairness and idle fairness got most of the increase, weighted toward idle fairness since it showed
clearer evidence of being time-starved and most directly affects what a person experiences (how
much idle time they get, not just which position their work lands on). `random_seed: 42` is fixed
on every solve for determinism, matching this codebase's existing convention (Refine's PRNG uses
the same seed) and the original design's own requirement that the same input always produce the
same schedule.

**Every stage past coverage can time out with zero feasible incumbent found at all** — not just
without proving optimality — in which case HiGHS reports `ObjectiveValue: Infinity`. Freezing that
as a constraint bound would corrupt the model for every later stage (this happened for real: on
one real schedule, position fairness timed out with no incumbent, and blindly freezing `<=
Infinity` silently regressed coverage from 0 to 3 unstaffed, even though coverage had already been
correctly proven optimal at 0 in stage 1). Each stage's freeze is now conditional on
`Number.isFinite(result.ObjectiveValue)` — an infeasible-within-budget stage is skipped (its
dimension just doesn't get optimized this round) rather than corrupting anything downstream, and
the final decode falls back through every prior stage's last known-feasible solution, with
stage 1's (guaranteed feasible, checked immediately) as the ultimate floor.

Stage 1's coverage solve is time-boxed and not guaranteed to prove optimality on a hard instance —
unlike a hand-rolled branch-and-bound with an admissible bound, "ran out of time" here just means
"best incumbent found so far," with no proof either way. So Quick and Balanced are always computed
too (cheap, synchronous, µs-scale next to the solver), and whenever no requirement exists — the one
case their coverage count can actually be trusted — the final result falls back to whichever of
{MIP, Quick, Balanced} has the fewest unstaffed slots. This gives MIP (HiGHS) the same "never worse
than the faster modes on coverage" guarantee every other mode in this app already has.

## Decoding back to `ScheduleResult`

`decode.ts` reads each variable's `Primal` value (`> 0.5` = true) and reconstructs the same
`Action[][]` shape the DFS modes build, reusing `shared/action.ts`'s `decisionsToScheduleResult`
unchanged — `ScheduleResult` was kept deliberately algorithm-agnostic from the start of this
project, and that paid off directly here: nothing downstream (Schedule/Staffing pages, print
output, manual editing) needed to change for a fundamentally different solving engine to slot in.

## Verification

No existing reference implementation to check this formulation against — it's genuinely new code,
verified the way this codebase verifies scheduler changes generally: real scenarios, checked
against independently-written validation logic, not just "it ran without crashing."

- **Single staff/position**: correct unavoidable-unstaffed-during-break behavior, break centered in
  the target window.
- **Three staff / two positions, no requirements**: 0 unstaffed; an independent validator (written
  separately from the model itself, replaying the decoded output against every hard rule from
  scratch) found zero violations.
- **Requirement + max-time boundary** (deliberately designed so free work would naturally continue
  the same position past the requirement): continuous run capped at exactly the combined budget,
  not a slot over.
- **Requirement + min-idle boundary** (deliberately designed so the solver has every incentive to
  switch positions immediately after the requirement ends): the switch is correctly delayed to
  exactly `minIdleTime` after the requirement's end, not before.
- **Real production data** (5 staff, 4 positions, one active requirement — the same Wednesday
  schedule used to verify Thorough (Experimental) and Rotate (Experimental)): 0 unstaffed, the
  requirement honored on every one of its slots, zero independent-validator violations, solved in
  ~16.6s in Node and well inside the budget in a real browser Worker end-to-end (WASM load, solve,
  decode, render — verified via the actual dev server, not just a script).
- **Infeasibility**: a requirement spanning nearly an entire shift, leaving no room anywhere for
  the mandatory break, throws a clear, specific `Error` before any solve is attempted (mirroring
  Thorough (Experimental)'s same guarantee) rather than hanging or silently returning a broken
  schedule.
- **A real user-reported regression, caught and fixed against the exact instance that surfaced
  it**: idle fairness was added and verified to genuinely narrow the spread (idle ratio range
  0.125–0.435 → 0.250–0.391 on a real 5-staff Friday schedule with no requirements), but adding it
  also exposed a latent bug — position fairness timing out with zero incumbent silently corrupted
  coverage downstream (0 → 3 unstaffed on that same real schedule). Fixed (see "The staged
  objective" above) and re-verified: 0 unstaffed restored, idle fairness still measurably improved,
  zero independent-validator violations, and the same real requirement-bearing Wednesday schedule
  re-checked to confirm the fix didn't disturb requirement handling (still 0 unstaffed, requirement
  honored on every slot, idle ratios tightened from a similar spread to 0.261–0.333).
- **A follow-up fairness complaint on the same real Friday instance, diagnosed and fixed by raising
  the time budget** (see "The staged objective" above): even after the fix above, idle ratios
  still ranged 0.250–0.391 — still a real gap, not a tuning-proof floor. Isolated stage-by-stage:
  position fairness and idle fairness were both frequently timing out before finding *any*
  feasible incumbent at their original few-second budgets, and freezing even a non-optimal
  position-fairness bound measurably narrowed what idle fairness could then find (in one isolated
  test, once that bound was frozen, idle fairness couldn't find *any* feasible point in 15s where
  it found near-optimal balance in the same time without it) — a genuine priority-order effect, not
  only a raw-time one. After raising the budget to 45s worst case, the same real instance now
  produces idle ratios of 0.333–0.350 (down from 0.250–0.391), with a solve time of ~37s — still
  well under the 45s ceiling — and zero real hard-rule violations (two short stints an
  independently-written validator initially flagged both turned out to be the validator not
  accounting for the position closing immediately after — a legitimate case the model's own
  min-position-length truncation logic already handles correctly, not a regression).

## Deviations from the original design

The original proposal (preserved in this project's history) was written as an implementation-ready
spec, not a description of working code. Building it surfaced several places worth being explicit
about:

- **`highs-js` isn't the actual package name.** The real, maintained npm package is `highs`
  (the project itself is named `highs-js` on GitHub, which is where the confusion comes from).
  Confirmed via the npm registry before writing any code against it.
- **Stage 2 split into three stages (2a, 2b, 2c), not one blended objective.** The original design
  says to "fold break quality into the same stage-2 objective, as a second term" — but doing that
  as a literal weighted sum would be exactly the "blend-by-weight is fragile" failure mode the
  design itself argues against for the *top-level* staging. Splitting it into genuinely sequential,
  frozen-and-lexicographic stages (all three still ahead of churn) resolves that ambiguity without
  introducing an arbitrary weight.
- **Idle fairness added as its own stage — not in the original design at all.** The original's
  "fairness" was specifically about position-minutes (spreading *work* time fairly across
  positions); it never addressed overall workload/idle-time balance as a separate concern. In
  practice these are genuinely different objectives — see "The staged objective" above for why
  satisfying one doesn't satisfy the other, discovered from a real report of unevenly-distributed
  idle time rather than anticipated up front.
- **Fair share computed net of requirement-forced minutes**, not the original's flat
  `availableTime[s] * (totalPositionTime[p] / totalAvailableTime)` formula — ported from
  Rotate (Experimental)'s already-verified reasoning: without netting out forced time, a person
  with a large requirement looks artificially over-served and gets penalized for time they didn't
  choose.
- **Headcount stays at 1.** The original design's model supports `req[p,t]` as an arbitrary
  integer "without change," but this app's actual data model (`OpeningsGrid`, `ScheduleResult`)
  is boolean open/closed with one assignee per position per slot everywhere else in the app —
  supporting headcount > 1 for real would mean changing `types.ts`, `OpeningsPage`, and
  `AppContext` well beyond this algorithm's own folder. Out of scope for "add a 7th algorithm."
- **No two-tier "instant greedy draft, then swap to the solved result" UX** — shipped instead with
  a lighter alternative: a 4-segment stage progress bar next to the Generate button, MIP-only
  (`SchedulePage.tsx` gates it on `settings.algorithm === "mip"`). The Worker posts a `{type:
  "progress", stage, totalStages, label}` message before each of the five stages starts, in
  addition to (not instead of) the single `{type: "done", ...}` message every other algorithm's
  worker sends exactly once — `runMipAsync`'s message handler in `index.ts` is the only one in
  this app that has to tell those apart rather than resolving on the first reply. This is coarse,
  stage-level progress only: HiGHS's `solve()` is synchronous with no progress callback, so there's
  no way to report *within*-stage progress, only which of the 5 stages is currently running. The
  original design's draft-then-swap idea remains a self-contained follow-up if the solve time ends
  up warranting it in practice.
- **No per-slot infeasibility classification.** The original design calls for classifying *why*
  each unstaffed slot exists (nobody on shift / everyone on mandatory break / everyone pinned
  elsewhere / genuine shortage) by inspecting which constraints are tight. Not built — the UI
  currently reports unstaffed slots exactly the way every other mode does (the count, and which
  slots, highlighted in the grid). A real gap relative to the original design, left for later
  rather than attempted under this session's time budget.
- **No solver-option tuning beyond `time_limit` and `random_seed`.** `mip_rel_gap`,
  `mip_heuristic_effort`, and the rest of HiGHS's large option surface are left at their defaults;
  worth revisiting only if a real instance is found where the defaults solve slower or worse than
  necessary.

## Everything else

`ScheduleResult`'s shape, the Schedule/Staffing pages, manual editing, print output, and the
requirements-warning banner logic are all unchanged and untouched by this mode's addition — see
the root [CLAUDE.md](CLAUDE.md) for how the algorithm registry (`src/scheduler/index.ts`) makes
that possible.

# MIP (HiGHS)

**MIP (HiGHS)** (`src/scheduler/algorithms/mip/`) formulates the whole scheduling problem — coverage,
every labor rule, and a staged fairness objective — as a mixed-integer linear program, and hands
it to [HiGHS](https://highs.dev/) (a real simplex + branch-and-cut solver, compiled to WebAssembly
via the [`highs`](https://www.npmjs.com/package/highs) npm package) instead of running a hand-rolled
search. It is the app's only scheduling engine — six earlier DFS-based modes (Quick, Balanced,
Thorough, Refine, Thorough (Experimental), Rotate (Experimental)) were removed once MIP covered
everything they did, better (see `CLAUDE.md` for why). It builds its own LP-format problem text,
solves it in five sequential stages, and decodes the result into the same `ScheduleResult` shape
this app has always used.

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

The tradeoff, paid honestly: `highs`'s WASM binary is **3.4MB** (gzipped ~1.2MB) — this app's only
runtime dependency; everything else is hand-rolled TypeScript. It's loaded lazily, inside this
algorithm's own dedicated Worker (`import wasmUrl from "highs/runtime?url"`, resolved to its own
asset chunk by Vite), so nobody pays that cost until they actually generate a schedule.

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
  honestly rather than pretend otherwise. This constraint is two-sided: `unstaffed + Σx ≥ 1` (a
  shortfall, if any, is counted correctly) **and** `Σx ≤ 1` (nobody can double up on an
  already-covered slot). The upper bound is not optional bookkeeping — see the real bug it fixed,
  below.
- **Exactly one break, sized and windowed** — reuses `breakDomain.ts`'s
  `computeBreakDomain` for the legal start-slot set (earliest/latest-percent window, with
  a widen-to-full-shift fallback), then pins total break time to exactly `minBreakLength` and its
  contiguity via a `startBreak[s,t] ⟹ br[s,t..t+len)` implication.
- **Max time in position** — a sliding window forbidding any run of `maxTimeInPosition/15 + 1`
  consecutive slots on one position.
- **Min position length** — a `startWork[s,p,t]` indicator (`>= x[t] - x[t-1]`, one-directional —
  see "A note on one-directional indicators" below) whose forced-1 case implies the position holds
  for the minimum window. That window is clipped only at the *person's* own hard boundaries (shift
  end, a block, an upcoming requirement) — never at the position closing. It used to clip there
  too, which let the solver seat someone for the last 15 minutes before a position closed and
  then send them idle: a visible "short sit" that reads as a min-position-length violation on the
  grid even though every constraint was technically satisfied. Now a start that can't reach the
  minimum before the position closes has `startWork` pinned to 0 — so that closing tail can only
  be covered by someone already sitting there, or goes honestly unstaffed. Relatedly, free work
  continuing the *same* position straight out of a requirement on it doesn't force `startWork`
  (it's one visible run, not a fresh segment), so a requirement can still run through a closing
  tail; max-time across that boundary is covered by the requirement-anchored windows.
- **Min idle time between different positions** — for a genuine segment start on a different
  position, forbids any other position having been worked in the immediately preceding
  `minIdleTime`-slot lookback window.
- **Requirements and blocks** — a block simply omits that (staff, slot)'s variables entirely (the
  same "not present" treatment off-shift time already gets); a requirement fixes the position as a
  known constant rather than a decision variable, and removes it from what every *other* staff
  member sees as open at that slot — no separate eviction logic needed.

### The two places a requirement boundary needed its own handling

These are the trickiest parts of the model, and the two places most likely to hide a bug if this
file is ever touched again:

1. **Max-time continuation across a requirement's boundary, on the same position — in *both*
   directions.** A per-slot state machine that only resets its "continuous time in this position"
   counter at a requirement's own *start* would let free choice continuing the same position right
   after the requirement ends run past the cap — not something a real-world cap should actually
   allow. A MIP has no such limitation: a backward-looking window is exactly as easy to express as a
   forward-looking one, so this model closes the gap in full rather than inheriting it. It computes
   each requirement's `remainingBudget = maxTimeSlots - requiredLen` and adds **two** anchored
   windows — one right at the requirement's end (forbidding the `remainingBudget + 1` immediately
   *following* same-position slots from summing past `remainingBudget`) and a mirror one right
   before the requirement's start (the same cap on the immediately *preceding* same-position slots).
   The second window shipped after the first — see "Verification" below for the real bug that
   exposed the gap and how it was confirmed fixed.
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
  minutes** — not the original design's simpler flat-proportional formula (see "Deviations"
  below for why).
- **Stage 2b (idle fairness)** — minimize the worst-case deviation from an equal idle *ratio*
  across staff (`idleMinutes / elapsedMinutes`). **Not in the original design at all** — added
  after real-world testing showed position fairness alone leaves this open: a person available
  for more position-windows than a colleague can hold an individually fair share of every
  position while still doing substantially more total work, and therefore having substantially
  less idle time, overall. See "Deviations" below.
- **Stage 2c (break quality)** — minimize the worst-case deviation from each person's ideal break
  midpoint ("distance from window midpoint").
- **Stage 3 (churn)** — minimize total position-segment starts (a fresh segment beginning counts,
  including one resuming the same position after an idle/break gap — kept faithful to the
  original design's own formula, which differs from the now-removed DFS modes' `churnCount`: that
  one only counted genuine position *changes*).

Solve budget: 10s / 10s / 15s / 5s / 5s (45s worst case) — raised from an original 10s/4s/5s/3s/3s
(25s) after diagnosing a real complaint on a real 5-staff instance directly (see "Verification"
below): position fairness and idle fairness were both frequently timing out before finding *any*
feasible incumbent, not just before proving optimality, and giving idle fairness alone 30s (vs. its
original 5s) took it from a non-optimal 0.104 to a proven-optimal 0.021 — a ~5x tighter balance.
coverage and churn kept their already-generous, never-observed-to-bottleneck budgets; position
fairness and idle fairness got most of the increase, weighted toward idle fairness since it showed
clearer evidence of being time-starved and most directly affects what a person experiences (how
much idle time they get, not just which position their work lands on). `random_seed: 42` is fixed
on every solve for determinism, matching the original design's own requirement that the same
input always produce the same schedule.

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
"ran out of time" here just means "best incumbent found so far," with no proof either way. Earlier
versions of this algorithm computed Quick and Balanced (two now-removed DFS-based modes) alongside
MIP purely as a coverage safety net, falling back to whichever had fewest unstaffed slots when MIP
didn't do better. That fallback was removed along with Quick and Balanced themselves (see
`CLAUDE.md`) — MIP's coverage on a hard, tightly-budgeted instance is now only as good as what
stage 1 finds within its own time limit, with no second opinion to fall back to. Worth knowing if
a future real instance ever shows a coverage result that looks worse than a naive greedy pass
would have done in the same situation.

## Decoding back to `ScheduleResult`

`decode.ts` reads each variable's `Primal` value (`> 0.5` = true) and reconstructs the same
`Action[][]` shape `action.ts`'s `decisionsToScheduleResult` expects — `ScheduleResult` was kept
deliberately algorithm-agnostic from the start of this project, and that paid off directly here:
nothing downstream (Schedule/Staffing pages, print output, manual editing) needed to change for a
fundamentally different solving engine to slot in.

## Verification

No existing reference implementation to check this formulation against — it's genuinely new code,
verified the way this codebase verifies scheduler changes generally: real scenarios, checked
against independently-written validation logic, not just "it ran without crashing." **A validator
for this engine specifically must check that no open position ever has more than one worker at
once, not only the per-staff hard rules (max-time, min-position-length, min-idle, break length)**
— the DFS-based modes can't structurally produce that (their joint-enumeration claims a position
per slot, so two people claiming it is mutually exclusive by construction), but this engine's
constraints are hand-written, and one real bug (below) proved the omission isn't theoretical.

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
  schedule used to verify the now-removed Thorough (Experimental) and Rotate (Experimental)
  modes): 0 unstaffed, the requirement honored on every one of its slots, zero
  independent-validator violations, solved in
  ~16.6s in Node and well inside the budget in a real browser Worker end-to-end (WASM load, solve,
  decode, render — verified via the actual dev server, not just a script).
- **Infeasibility**: a requirement spanning nearly an entire shift, leaving no room anywhere for
  the mandatory break, throws a clear, specific `Error` before any solve is attempted rather than
  hanging or silently returning a broken schedule.
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
  accounting for the position closing immediately after — at the time a legitimate case, since the
  min-position-length window was then also truncated at a position closing; that truncation has
  since been removed, see the entry below).
- **A genuine correctness bug, reported and reproduced from real data: two staff simultaneously
  assigned to the same open position.** §5.2's coverage constraint was one-sided —
  `unstaffed + Σx ≥ 1` correctly counts a shortfall, but nothing capped `Σx` from *above*. Once
  idle fairness started actively rewarding extra work-minutes, the solver had a real incentive to
  double-staff an already-covered slot purely to pad an under-served person's total, and nothing
  in the model forbade it. Confirmed directly against the exact real schedule that surfaced it
  (Håvard and Sigve both on TWR Coor, 09:00–09:30) before any fix, and confirmed absent after
  adding the missing `Σx ≤ 1` cap (net of any requirement already claiming the slot) — same
  instance re-solved: 0 unstaffed, zero double-staffed slot/position pairs, idle ratios still
  tightly balanced (0.304–0.350), zero real hard-rule violations (two more short stints an
  extended validator initially flagged both turned out to end exactly at the start of a *blocked*
  time — a third instance of the same class of validator gap as the position-closing case above,
  not a new one). Worth remembering: none of this fork's prior testing had ever explicitly checked
  for double-staffing — every earlier validator only checked per-staff rules (max-time,
  min-position-length, min-idle, break length), never "does any position ever have more than one
  worker." That's the reason a bug this fundamental survived as long as it did.
- **A genuine correctness bug, reported and reproduced from real data: a visible continuous run
  exceeding the max-time cap at a requirement's *start* boundary, not its end.** The original
  "requirement-then-free-continuation" window (see above) only anchored *after* a requirement's end
  — there was no mirror check for free choice continuing the same position right *up to* a
  requirement's start. On the real schedule that surfaced it, Mathias had a TWR requirement
  09:30–11:30 (120min — exactly the 120min `maxTimeInPosition` cap on its own) and the solver
  freely put him on TWR for the two slots immediately before it (09:00–09:30, 30min), producing a
  visible 09:00–11:30 continuous TWR run of 150min — 30min over the cap — even though the
  requirement's own duration and the free portion were each independently "legal" by every
  constraint written so far. Root-caused directly against the reported instance (reconstructed from
  the user's pasted export) before any fix. Fixed by adding the mirror "before" window described
  above. Re-verified against the exact same instance: the flagged 09:15 slot (the one slot whose
  inclusion would have made the joint run exceed the cap) is no longer assigned TWR, and — since a
  lone 09:00-only TWR stint would itself violate `minPositionLength` — the solver correctly avoids
  TWR there entirely rather than leaving a dangling too-short stint; zero max-time violations, zero
  min-position-length violations, zero min-idle-time violations, zero double-staffed slots on a full
  independent-validator pass. Coverage moved from 0 to 1 unstaffed slot (09:30, APP Coor) on this
  specific instance — not a regression, but the honest, unavoidable cost of closing the loophole:
  at 09:30 exactly four staff are present against four simultaneously-open positions with zero
  slack, and the freedom to silently pre-stage Mathias into TWR before his requirement (in violation
  of the cap) was propping up that 0-unstaffed result. Consistent with this project's standing
  position that unstaffed slots aren't automatically a bug — some tightly-staffed instances are
  mathematically infeasible to cover perfectly once every real safety rule is actually enforced.
- **A user-reported "short sit" — 15 minutes in a position, then idle or break, with
  `minPositionLength` set to 30.** Root cause was the min-position-length window's own truncation
  rule: it clipped at the first slot with no `x` variable, which included the *position closing*,
  so seating someone for just the final slot before a position closed was a legal fresh start.
  Reproduced with a synthetic instance built to make that sit free (a colleague hits the max-time
  cap exactly when the position has one slot left, and the newcomer's other position doesn't open
  until later): the solver took the 15-minute sit. Fixed by pinning `startWork` to 0 for any start
  that can't reach the minimum before the position closes (the person's own boundaries — shift
  end, block, requirement — still clip as before). Re-verified: the same instance now leaves that
  final slot unstaffed instead (the honest cost — nobody can legally sit it), a requirement on the
  same position still continues freely through a closing tail, a shift-end tail is still allowed
  (no pins generated), and an unrelated 3-staff/3-position instance kept identical coverage with
  zero validator violations.

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
  `availableTime[s] * (totalPositionTime[p] / totalAvailableTime)` formula — ported from the
  now-removed Rotate (Experimental) mode's already-verified reasoning: without netting out forced
  time, a person with a large requirement looks artificially over-served and gets penalized for
  time they didn't choose.
- **Headcount stays at 1.** The original design's model supports `req[p,t]` as an arbitrary
  integer "without change," but this app's actual data model (`OpeningsGrid`, `ScheduleResult`)
  is boolean open/closed with one assignee per position per slot everywhere else in the app —
  supporting headcount > 1 for real would mean changing `types.ts`, `OpeningsPage`, and
  `AppContext` well beyond this algorithm's own folder. Out of scope for this project.
- **No two-tier "instant greedy draft, then swap to the solved result" UX** — shipped instead with
  a lighter alternative: a 5-segment stage progress bar next to the Generate button, MIP-only
  (`SchedulePage.tsx` gates it on `settings.algorithm === "mip"`). The Worker posts a `{type:
  "progress", stage, totalStages, label}` message before each of the five stages starts, in
  addition to a final `{type: "done", ...}` message — `runMipAsync`'s message handler in
  `index.ts` has to tell those apart rather than resolving on the first reply. This is coarse,
  stage-level progress only: HiGHS's `solve()` is synchronous with no progress callback, so there's
  no way to report *within*-stage progress, only which of the 5 stages is currently running. The
  original design's draft-then-swap idea remains a self-contained follow-up if the solve time ends
  up warranting it in practice.
- **No per-slot infeasibility classification.** The original design calls for classifying *why*
  each unstaffed slot exists (nobody on shift / everyone on mandatory break / everyone pinned
  elsewhere / genuine shortage) by inspecting which constraints are tight. Not built — the UI
  reports only the count and which slots, highlighted in the grid, the same as every mode this
  app has ever had. A real gap relative to the original design, left for later rather than
  attempted under this session's time budget.
- **No solver-option tuning beyond `time_limit` and `random_seed`.** `mip_rel_gap`,
  `mip_heuristic_effort`, and the rest of HiGHS's large option surface are left at their defaults;
  worth revisiting only if a real instance is found where the defaults solve slower or worse than
  necessary.

## Everything else

`ScheduleResult`'s shape, the Schedule/Staffing pages, manual editing, print output, and the
requirements-warning banner logic are all unchanged and untouched by this mode's addition — see
the root [CLAUDE.md](CLAUDE.md) for how the algorithm registry (`src/scheduler/index.ts`) makes
that possible.

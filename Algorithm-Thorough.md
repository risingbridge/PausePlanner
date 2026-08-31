# The scheduling algorithm — Thorough mode

This document explains the **Thorough** scheduler (`src/scheduler/algorithms/thorough/`): the third and most powerful of PausePlanner's scheduling modes. It solves the same problem as the other two — assigning staff to open positions across a day while guaranteeing everyone their one real break — but it does so as a **single joint search solved to proven optimality**, in plain TypeScript, with no external dependencies.

It has the **same inputs, the same output, and honors the same hard rules** as the other modes (see [Algorithm.md](Algorithm.md) for Quick, [Algorithm-Balanced.md](Algorithm-Balanced.md) for Balanced). What changes is that it makes no compromises about the order in which decisions are taken: coverage, breaks, and idle time are all decided together at every slot, and — on the primary objective — the result comes with a guarantee that no schedule covers more positions, given the staff, the openings, and the rules.

For context, the three modes form a spectrum:

- **Quick** — greedy, single-pass. Takes the first good answer and never looks back. Sub-millisecond.
- **Balanced** — multi-pass. Places breaks with a backtracking search, then assigns coverage around them. Finds a very good answer.
- **Thorough** (this document) — one joint search, solved to proven optimality on coverage. Slowest, most capable.

## Why no external solver is needed

The instinctive way to reach "provable optimality" is a general constraint solver (OR-Tools CP-SAT and the like). That works, but it's the wrong tool here: a general solver is built for problems with thousands of variables and shapes it's never seen. This problem is tiny and fixed in shape — one day, a few dozen 15-minute slots, a handful of staff, a handful of positions. At that size, a purpose-built, hand-written **branch-and-bound** search is genuinely provably optimal on the primary objective, in plain TypeScript, with no dependency at all.

## The core idea: one joint search, no decomposition

Balanced fixes breaks first, then assigns coverage around them — tractable, but it can never trade a slightly-worse break placement for much-better coverage, because the breaks are already locked in by the time it looks at coverage. Thorough decides breaks and coverage **in the same breath**: it walks the day slot by slot, and at each slot branches over every valid joint assignment of people to {cover a position, take a break, sit idle}.

This reaches solutions the other two structurally cannot. If a demand spike can only be covered by moving someone's break earlier than their "ideal" center-of-window slot, Thorough finds it — verified directly: on a five-staff, three-position scenario used throughout this app's test scenarios, Quick and Balanced both land on 1 unstaffed slot; Thorough finds an arrangement with **0**, by shifting a break Balanced had already locked in.

## Inputs and output

Identical to the other two modes. `runThorough(positions, openings, staff, settings)` (`src/scheduler/algorithms/thorough/core.ts`) takes the same four arguments, schedules exactly one day, and knows nothing about the weekly model. Same status set (`OFF`/`BLOCKED`/`WORK`/`BREAK`/`IDLE`) and the same `unstaffed` record. Selecting Thorough on the Settings page is the only thing that changes — everything downstream (views, summary table, printing, manual edits) works unchanged.

One real difference from the other two: **Thorough is asynchronous.** It runs inside a Web Worker so a hard search never freezes the schedule grid, and `ALGORITHMS.thorough.run` returns a `Promise<ScheduleResult>` rather than a plain one. `AlgorithmDefinition.run`'s type was widened to `ScheduleResult | Promise<ScheduleResult>` to accommodate this — Quick and Balanced didn't need to change, since a synchronous return already satisfies that type — but `runScheduleAlgorithm` and the Schedule page's generate handler did need to become `async`, with a "Generating…" state on the button while a Thorough run is in flight. This is the one place this mode wasn't a fully silent drop-in, unlike Balanced.

## The free lower bound that makes it fast

At any slot, the fewest possible unstaffed positions is `max(0, demand − onShift)`: if more positions are open than bodies are present, no rule can conjure a person, and every inter-slot rule (max-time, min-length, no-bounce) can only ever force someone *off* a position, never add one. Summed as a suffix from each slot to the end of the day (`bound.ts`), this gives a valid lower bound on remaining unstaffed slots at every point in the search, computed once up front.

Combined with a **warm-start incumbent** — the better of Quick's and Balanced's results, both already computed in well under a millisecond — this yields the trick the whole mode is built on: **if the warm start's unstaffed count already equals the lower bound, coverage is provably optimal, and the search never runs at all.** On the overwhelming majority of days this is exactly what happens. Real searching only happens on genuinely tight days, and even then the same bound prunes most of the tree.

## The search

**State** per person, carried forward slot by slot: current position (or none), how many consecutive slots they've held it, whether they've had their break yet, remaining minutes if mid-break, remaining minutes if mid-mandatory-idle-run, and running idle/elapsed totals for fairness. A handful of small numbers — cheap to copy.

**Branching**, per slot: a person currently holding an open position they're still protected in (below `minPositionLength`) has exactly one legal choice — continue — so protection falls out naturally rather than needing separate bookkeeping. A person forced off (max-time exceeded, or their position just closed) has exactly {go idle, start break if eligible} — never a direct edge to a *different* position, which is what makes the no-bounce rule structural rather than checked. A person with no current position (fresh, or just finished an idle/break run) may take *any* open position, go idle anyway, or start a break — "go idle despite an open position being available" has to stay a real option, because locking someone into a position now can make them unavailable for a more critical one two slots later, and ruling that branch out would break the optimality guarantee.

Free people at a slot are assigned jointly (respecting position exclusivity) via a small recursive enumeration, not decided independently — this is where coverage and break timing are genuinely chosen together, not just carried in the same data structure.

**Pruning:**
- **Bound cut.** Any partial branch whose accumulated unstaffed count plus the remaining lower bound already meets or exceeds the best schedule found so far is dropped — it cannot win.
- **Symmetry breaking.** Among free people who currently share an identical state, only assignments in non-decreasing option rank are generated, discarding every permutation-duplicate without ever discarding a genuinely distinct outcome. This is the single biggest win on rosters with several people on matching shifts.
- **Dominance.** If two paths reach an identical combined state at the same slot, only the cheaper is kept — used for phase 1 (see below), where the tracked cost (unstaffed count) is fully determined by that state; deliberately *not* used for the phases after it, where it would be unsound (see below).
- **Dead-end feasibility.** The one genuinely fiddly part: a naive search can wander into a state where someone's break window has fully closed and they still haven't had their break — an unrecoverable dead end that, undetected, would otherwise only surface (as a rejected, invalid leaf) after wastefully searching the rest of the day. Every transition checks whether anyone still without a break has run out of legal slots left to start one, and prunes immediately if so — the same check applied to the very last transition also doubles as the hard guarantee that no complete schedule is ever accepted without everyone's break honored.

## The objective, in two phases

The four-objective lexicographic order the mode aims for — unstaffed, then fairness variance, then churn, then break-centering — is implemented as **two** search passes rather than four, for tractability:

1. **Phase 1** minimizes total unstaffed slots via the bound-and-prune search above, seeded by the warm start. Its answer, `U*`, is exact — either proven via the free lower-bound fast path, or via exhaustive (within budget) branch-and-bound.
2. **Phase 2** re-searches with unstaffed **pinned** at `U*` as a hard cut (any branch that can no longer possibly hit exactly `U*` is dropped), and — among everything that still achieves it — keeps the lexicographically best `[fairness variance, churn, break-off-center cost]`, compared as a plain tuple at each complete, valid leaf.

Phase 2 does **not** get its own per-sub-objective bound the way phase 1 does — variance isn't cheaply boundable mid-search the way an additive count is, so there's no equivalent free trick for it. It relies on the same symmetry breaking and the `U*` pin (which by itself eliminates every "leave something needlessly unstaffed" branch) plus the shared node/time budget, but explicitly skips dominance pruning: two different paths reaching an identical `PersonState` can have accumulated different churn to get there, and `PersonState` alone doesn't capture that, so treating them as interchangeable here could silently discard the lower-churn path. This is a real, disclosed reduction in rigor from the four-separate-phases design: unstaffed count is solved to a genuine proof; fairness, churn, and break-centering are solved as well as the shared budget allows, honestly, but without their own optimality certificate.

## Warm start and fallback

`runThorough` always computes both Quick's and Balanced's results first and uses the better (by unstaffed count) as the incumbent Phase 1 tries to beat, and as the fallback if the search never does — so a Thorough run is never worse than what Quick or Balanced already found, by construction, the same way Balanced guarantees it's never worse than Quick.

Each phase is bounded by both a node-count ceiling and a wall-clock deadline (1.5 seconds each in the current implementation); whichever is hit first stops that phase and it returns the best it found. Because the search runs inside a Web Worker, hitting a budget never freezes the page — it just means that phase's answer is "the best found," not a certified optimum.

## What Thorough uniquely buys you

**Joint tradeoffs.** Moving a break off-center to close a coverage gap hours later is reachable only by deciding breaks and coverage together — the defining capability of this mode, demonstrated directly by the 0-vs-1 result above.

**A real optimality proof on coverage.** When the lower-bound fast path fires, or the bounded search exhausts every branch that could beat the incumbent, the unstaffed count is genuinely proven minimal for that day, not just "the best we found." The other three objectives don't carry the same certificate (see above), so treat the unstaffed count specifically as the provable part of this mode's promise.

## The honest costs

- **Runtime is unbounded in principle**, and the search is worst-case exponential. At this app's scale it typically returns in tens to a few hundred milliseconds — often instantly via the fast path — verified up to 20 staff × 5 positions × a 17-hour day without exceeding a few hundred milliseconds. Genuinely adversarial inputs (many staff on mostly-distinct shifts, so symmetry breaking has little to grab onto, combined with tight constraints) can still consume the full budget; the budget-and-fallback design means that's a slower or less-optimal-on-secondary-objectives answer, never a frozen page or an invalid one.
- **It's the most code to maintain**, by a wide margin — the state encoding, branch enumeration, dead-end detection, and two-phase orchestration are all more intricate than a greedy pass, and every new scheduling rule means re-deriving the branch generator and re-checking the dead-end and bound logic stay valid.
- **It's the least explainable.** An optimal search result is correct but not narratable the way Quick's top-to-bottom pipeline is.
- **It adds real architectural surface** the other two modes didn't: a Web Worker, an async algorithm interface, and a loading state on the Schedule page. Contained to a handful of files, but it's the one place in this three-mode design that wasn't a fully invisible drop-in.

## Where it sits

Thorough is the mode to reach for when a schedule genuinely cannot afford a gap and you need the strongest available guarantee that it's covered as well as it possibly can be — or to find out that it provably can't be, so the fix is adding staff or relaxing a rule, not retrying. It's not the everyday default: Quick's answer is fine for most days, and Balanced's is already excellent without the extra machinery. But because this version costs nothing to ship — no dependency, no bundle weight for anyone who never selects it — it can sit in the menu as a genuine "prove it's as good as it gets" option that runs entirely in the browser.

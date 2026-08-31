# The scheduling algorithm — Balanced mode

This document explains the **Balanced** scheduler (`src/scheduler/algorithms/balanced/`): an alternative to the existing greedy scheduler (referred to here as **Quick** mode, see [Algorithm.md](Algorithm.md)) that solves the same problem — assigning staff to open positions across a day while guaranteeing everyone their one real break — but trades speed for better break placement and fewer unstaffed slots.

It has the **same inputs, the same output, and honors the same hard rules** as Quick mode. What changes is _how_ it decides, and the quality of the result in tightly-staffed periods.

## The core idea

Quick mode walks the day forward one 15-minute slot at a time and never looks back. That makes it fast and simple, but it forces it to place breaks _online_ — committing to a break before it can see what demand looks like later in the shift. Its one real failure mode follows directly from this: a mandatory break gets forced in late, sometimes straight into a demand spike, leaving a position unstaffed.

But this isn't actually an online problem. **All of the day's demand is known up front** — every position's open/closed state is fully specified for every slot before scheduling begins. Nothing is revealed as the day progresses. Balanced mode exploits that foresight.

It rests on one observation: **breaks are the globally scarce resource.** Deciding who stands where is comparatively soft and local — if someone rotates off a position, someone else can usually take it. Break placement is the hard global constraint, because a break removes a person from the entire pool for a fixed stretch, and badly-timed breaks are what create coverage gaps. So Balanced mode **separates the two concerns** and spends its effort on the one that matters.

## Inputs and output

Identical to Quick mode. `runBalanced(positions, openings, staff, settings)` (`src/scheduler/algorithms/balanced/index.ts`) takes the same four arguments every registered algorithm does, schedules exactly one day, and knows nothing about the weekly model. It produces the same per-slot, per-staff status set:

| Status | Meaning |
|---|---|
| `OFF` | Outside their shift hours. |
| `BLOCKED` | Inside a blocked time (a meeting, etc.). |
| `WORK` | Actively covering a specific position. |
| `BREAK` | Resting during their one guaranteed break of the day. |
| `IDLE` | On shift, available, but not currently needed for any position. |

and the same `unstaffed` record driving the warning banner. This is deliberate: the two modes are drop-in interchangeable via the `ALGORITHMS` registry (`src/scheduler/index.ts`), so the Schedule page offers them as a simple Settings-page choice and everything downstream — the views, the summary table, printing, manual edits — works unchanged.

## Pass 1 — Build the demand/supply profile

A single sweep over the day precomputes, for every slot `t`:

- `demand[t]` — how many positions are open (need covering).
- `onShift[t]` — how many staff are present and not blocked.
- `room[t]` — `max(0, onShift[t] − demand[t])`, i.e. how many people can be _simultaneously_ absent on break at `t` without creating a gap beyond whatever's already unstaffed at that instant. It's floored at zero rather than left negative — a slot that's already short before any breaks happen isn't "more infeasible" because of a break decision, so break placement isn't penalized for a shortfall it didn't cause.

This is the entire shape of the day, computed once (`computeSlotRoom` in `breakPlacement.ts`). Every later pass reads from it. Off-shift and blocked time is already excluded here, so those hard constraints never have to be rechecked downstream.

## Pass 2 — Place all breaks (the backtracking search)

This is the heart of Balanced mode and the pass that Quick mode structurally cannot do. Break placement is modeled as a **constraint-satisfaction problem** and solved with backtracking search.

- **Variables** — one per staff member: the slot `b_i` at which their break starts.
- **Domain** — the slots inside that person's target window (earliest%–latest% of their own shift, default 25%–75%) where an uninterrupted interval of `minBreakLength` actually fits, without colliding with their shift end or a blocked time. If the window itself is too narrow to fit a whole break anywhere, the domain widens to the full shift as a last resort — the same "absolute guarantee" spirit Quick mode's own backstop uses.
- **Constraint (cumulative)** — at every slot, the number of breaks covering it must not exceed `room[t]`. This is the standard "cumulative" resource constraint: overlapping intervals may never oversubscribe available room.

The search itself:

1. **Most-constrained-first ordering.** Assign the person with the smallest domain first. Someone whose window barely fits a break has the least freedom, so committing them early avoids wasted exploration.
2. **Constraint checking as it goes.** Before placing a break, its full interval is checked against the shared room state; anything that would push a covered slot's remaining room to (or below) zero is rejected immediately rather than discovered later.
3. **Backtrack** when a person has no legal slot left in their domain: undo the most recent placement and try its next candidate.
4. **Branch and bound for infeasible days.** If no arrangement satisfies every break with zero room violations — genuinely understaffed days — the search doesn't give up. It switches to minimizing total violation (how much room got oversubscribed, summed across every overdrawn slot) instead: it keeps the best arrangement found so far, and prunes any partial assignment whose running violation already meets or exceeds the best. This is a budgeted search (bounded by a node count, not wall-clock time, so it's deterministic across machines) — at this app's scale it comfortably finishes well inside budget, but if it ever didn't, it simply returns the best arrangement found so far rather than hanging. Violation here is a proxy for eventual unstaffed slots, not a guarantee of the literal minimum — Pass 3 is what actually determines final coverage.

This is precisely the capability Quick mode lacks. Because the search can see the whole day, it can slide someone's break _earlier_ within their window to dodge a demand spike three hours later. Quick mode's advice to "widen the earliest-break %" to resolve gaps becomes automatic here — the search finds a good placement itself.

## Pass 3 — Assign coverage, with breaks now fixed

With every break time locked in, what remains is placing available people into open positions each slot. Rather than a full time-expanded flow network, this is solved as a **per-slot minimum-cost bipartite matching** (the classic O(n³) Hungarian algorithm, `hungarian.ts`), with state — current position, continuous minutes held, idle rate — carried forward from slot to slot so the three inter-slot rules stay enforced without needing to encode time explicitly in the graph:

- **Claimants** (already holding an open position, past `minPositionLength` protection) get exactly one real edge back to their own position — no edge to any other position exists at all, so a direct position-to-position bounce is structurally impossible, not just discouraged. Their only alternative is a zero-cost "go idle" option.
- **Seekers** (no current position — freshly available, or resting off a prior stop) get an edge to every open position, weighted by fairness (see below).
- **Continuing past max time in position never reaches the matching at all** — anyone who'd exceed it is pulled off in a pass before the matching is built, so it can't be chosen by construction, not merely made expensive.
- A claimant's "stay" edge carries a small discount over what the same person would cost as a seeker, so near-ties favor stability over needless churn.
- **Fairness** enters as an edge-cost weight proportional to each person's idle rate (`idleMinutes / elapsedMinutes`) — lower cost for someone who's been idle a larger share of their shift — so the minimum-cost solution naturally favors giving work to whoever's most "owed" it, the same fairness notion Quick mode uses, but resolved as one optimal choice per slot instead of a rank-then-evict heuristic.
- **Leaving a position unfilled** is possible (via a dummy row) but carries a cost so far above any real assignment's that it's only ever chosen when no real assignment exists — coverage is always maximized first, and fairness/churn only break ties among ways of achieving that same maximum.

Minimizing total cost then yields an assignment that covers as much as possible, keeps people in place where sensible, and distributes work fairly — all at once, and all provably optimal for that single slot given the fixed breaks and the state carried in.

## Pass 4 — Repair

A final sweep looks at whatever's still unstaffed after Pass 3 and tries to close it with a genuinely spare person: someone marked `IDLE` at that exact slot who wasn't working the slot immediately before or after it either. That last condition is what keeps this pass safe to bolt on after the fact — since such a person wasn't adjacent to a `WORK` slot on either side, retroactively giving them this one slot can never create a same-slot bounce or a stint long enough to violate max-time-in-position. This is deliberately narrower than a full local search over swaps and break nudges — a bounded, always-safe gap-fill rather than general-purpose refinement — since Pass 3's own optimality already leaves comparatively little for a repair pass to find.

## How the hard constraints map to passes

| Constraint | Where it's enforced |
|---|---|
| One break, uninterrupted, inside the target window (or the widened fallback) | Pass 2 — it's the _definition_ of a variable's domain, so it cannot be violated |
| Break ≥ minimum length; breaks never oversubscribe room | Pass 2 — the cumulative constraint |
| Max continuous time in position | Pass 3 — filtered out before the matching is built, so no edge for it can exist |
| Minimum position length / no direct bounce | Pass 3 — protected stints are pinned before matching; claimants get no edge to any position but their own |
| Blocked / off-shift never assigned | Pass 1 — removed from supply before anything else runs |
| Minimum idle time floor | Pass 3 — any non-break gap that follows being pulled off a position is held to the floor before that person is eligible again |

## What you gain, and what you give up

**Gained**

- **Better break placement.** The single biggest source of Quick mode's unstaffed gaps — a break forced late into a spike — is significantly reduced, because breaks are chosen with full knowledge of the day.
- **Global fairness and low churn per slot.** Each slot's assignment is the single best trade-off available given the fixed breaks, rather than a greedy rank-then-evict decision.
- **A safety net, not just a best effort.** Balanced mode always runs Quick mode too and returns whichever result leaves fewer positions unstaffed (see below) — so even in a scenario its heuristics handle poorly, it can't do worse than Quick would have.

**Given up**

- **Speed and simplicity.** Backtracking is worst-case exponential in the number of staff. For this app's scale it's still fast (single-digit milliseconds even at 15 staff × 6 positions), but it is no longer trivially bounded, which is why the search itself is budgeted.
- **Incrementality.** Quick mode adapts instantly to a manual edit; Balanced mode really wants to re-solve. Manual edits on the Schedule page still bypass both algorithms entirely and are never re-run.

## Warm start and fallback

Quick mode and Balanced mode compose, just not by feeding one's internal search state into the other's. `runBalanced` always computes Quick's result as well as its own full pipeline (Passes 1–4), then returns whichever of the two **complete schedules** has fewer unstaffed slots — Balanced on a tie, since it also optimizes fairness and churn even when coverage comes out even. This is a simpler and more literal way to guarantee "you never get a worse result than Quick mode would have produced" than trying to structurally thread that guarantee through the search itself: it's just a straight comparison of two finished, valid schedules. The cost is running Quick an extra time per generate, which at this app's scale is well under a millisecond either way.

## Honest limitations

- **The decomposition assumes breaks dominate.** Fixing breaks _before_ coverage is a strong heuristic for feasibility and coverage, and only _approximate_ for fairness — rotation-driven idle gaps interact with fairness in ways Pass 2 doesn't model. Pass 4 only mops up leftover unstaffed gaps, not fairness or churn imbalance, so the result is a very good schedule, not a certified globally-optimal one across every objective at once.
- **Pass 2's branch-and-bound minimizes a proxy, not the literal final unstaffed count**, and is budget-bounded rather than exhaustive — on a genuinely infeasible day it finds a good break arrangement quickly, not a provably optimal one.
- **Not a full solver.** If you want provable optimality over a single combined objective, the honest move is to hand the whole thing to a CP-SAT / ILP solver (e.g. OR-Tools) as one model. Balanced mode is the pragmatic middle ground: markedly better than greedy in tight scenarios, still small and self-contained, no external solver dependency.
- **Greedy is still a fine default** for most days. Balanced mode earns its keep specifically when staffing is tight enough that break timing decides whether positions get covered — and even then, it's never worse than Quick would have been, only sometimes no better.

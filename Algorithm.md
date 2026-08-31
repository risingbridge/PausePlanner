# The Quick scheduling algorithm

PausePlanner supports more than one scheduling algorithm — see `src/scheduler/index.ts` for the pluggable registry (`AlgorithmId`/`ALGORITHMS`) and the "Scheduling algorithm" setting on the Settings page for how one is chosen. This document covers **Quick**, the fast greedy default; see [Algorithm-Balanced.md](Algorithm-Balanced.md) for **Balanced**, which trades speed for better break placement in tightly-staffed days.

This document explains, in detail, how `src/scheduler/algorithms/quick.ts` turns your positions, openings, staff, and settings into a schedule. It's a **greedy, single-pass simulation**: it walks through the day one 15-minute slot at a time, in order, making the best decision it can with the information available at that moment. It never looks back and revises an earlier slot, and it only looks *forward* in one specific, narrow way (explained in [The break window](#the-break-window)). It is not a constraint solver — it doesn't guarantee a mathematically optimal schedule, and in tightly-staffed scenarios it can leave a position **unstaffed** rather than violate a hard rule.

## Inputs

The algorithm itself schedules exactly one day at a time and knows nothing about the weekly model — `runQuick(positions, openings, staff, settings)` takes the same four plain arguments every registered algorithm does (see `AlgorithmDefinition` in `src/scheduler/index.ts`). What changed is where those arguments come from: PausePlanner now has 7 independent weekday slots (Monday–Sunday), each with its own positions, openings, staff, and day start/end, and the Schedule page calls `runScheduleAlgorithm` once for whichever weekday is currently selected, passing that day's data in.

- **Positions** — the list of things that need staffing (e.g. "TWR", "Reception"), specific to the selected weekday. The same name on two different days (e.g. "Reception" on Monday and "Reception" on Tuesday) are unrelated objects that just happen to share a label — there's no cross-day link.
- **Openings** — for every position, whether it's open at every 15-minute slot of the day, also specific to the selected weekday.
- **Staff** — each person's shift (`start`/`end`) and any blocked times (meetings, etc.). Staff are not shared across days either — each weekday's roster is entered independently (a "Copy to..." action exists in the UI to duplicate one day's positions/openings/staff/day-times into others, but that's a one-time copy, not an ongoing link). A staff member's shift may be defined by a linked shift code rather than typed directly, but that's resolved to a concrete `start`/`end` before this function ever sees it — the algorithm itself always receives plain, opaque values.
- **Settings** — the six numeric scheduling rules (`maxTimeInPosition`, `minPositionLength`, `minBreakLength`, `minIdleTime`, `earliestBreakPercent`, `latestBreakPercent`) described throughout this document, plus which algorithm to run (`algorithm`, chosen on the Settings page — see the intro above). These are shared across all 7 days — tune them once and every weekday's schedule uses the same rules. Day start/end, by contrast, lives per-weekday alongside positions/openings/staff, and gets merged into the `settings` argument at the call site (as `ScheduleSettings`, a superset of the shared `Settings` type) purely so `runQuick`'s signature doesn't need a fifth argument — the algorithm itself still just reads `settings.dayStart`/`settings.dayEnd` from whatever it's given.

## Output

For every 15-minute slot, the algorithm decides, for every staff member, exactly one of:

| Status | Meaning |
|---|---|
| `OFF` | Outside their shift hours. |
| `BLOCKED` | Inside a blocked time (a meeting, etc.). |
| `WORK` | Actively covering a specific position. |
| `BREAK` | Resting during their one guaranteed break of the day. |
| `IDLE` | On shift, available, but not currently needed for any position. |

It also tracks which positions couldn't be staffed at all (`unstaffed`), which drives the warning banner in the Schedule page.

## Per-staff running state

While simulating, the algorithm keeps a small state object per staff member, updated slot by slot:

- `currentPositionId` — the position they're currently working, or `null`.
- `continuousMinutes` — how long they've been in that position, uninterrupted.
- `restRemaining` — minutes left before they're available again, if resting.
- `restIsBreak` — whether the *current* rest is their one real break (`true`) or just a short idle gap (`false`).
- `hasHadBreak` — whether they've already used their one break for the day.
- `idleMinutes` / `elapsedMinutes` — running totals used to compute their **idle rate** (see [Fairness ranking](#4-fairness-ranking)), which is `idleMinutes / elapsedMinutes`. Break time is deliberately excluded from both — a proper rest doesn't count against or for someone's fairness score, the same way time outside their shift doesn't.

## The per-slot pipeline

For every slot, in this exact order:

### 0. Recompute the break "stagger budget"

Before anything else, the algorithm works out how many staff could safely start their one break *right now*, in this slot. This number gets used later (step 1) and is central to how the one-break system avoids creating staffing gaps — see [The break window](#the-break-window) for the full explanation. In short: it's the number of on-shift staff, minus the *most* positions that will need covering at any point during a break started now (not just this instant), minus however many people are already mid-break.

### 1. Availability pass

The algorithm goes through every staff member and decides, before anything else, whether they're even available this slot:

1. **Off shift** → `OFF`. Their position (if any) is dropped with no penalty.
2. **Blocked** (inside a meeting, etc.) → `BLOCKED`. Same as above — this is a hard constraint, checked before any scheduling logic.
3. **Still resting** from an earlier stop (`restRemaining > 0`) → continue resting. If this rest was plain idle time and the break window has just opened, it's upgraded into the real break right here (see below).
4. **Absolute last resort**: if they haven't had their break yet and there isn't enough shift time left to fit one in, they're forced onto it *right now*, no matter what — even if they're mid-stint in a position. This is the one rule in the whole algorithm that can never be skipped or deferred.
5. **Past the target break window** without a break yet → try to start it now (subject to the stagger budget from step 0, with a guaranteed minimum of one person let through even if the budget is otherwise zero).
6. Otherwise, they're **eligible** to be considered for work this slot.

Everyone who isn't eligible has already been fully decided for this slot; the remaining steps only apply to the eligible set.

### 2. Max time in position (hard cap)

Anyone eligible who's about to exceed **max time in position** by continuing is pulled off immediately — no exceptions, regardless of fairness or protection rules. This is what `applyStop` does: it decides whether this particular stop is significant enough to become the real break (see below) or just a short idle gap, then labels it accordingly.

### 3. Position closing

If a staff member's current position is no longer open, they're also stopped (`applyStop`) — this is what guarantees nobody is ever bounced directly from one position into a different one in the same slot without at least a rest in between.

### 4. Minimum position length protection

Everyone still standing who is mid-stint in a position they've held for *less* than **minimum position length** is protected: they keep working, unconditionally, regardless of how deserving anyone else might be. This is the only step that shields someone from being rotated out purely for fairness reasons.

### 5. Fairness ranking

Everyone remaining is ranked by **idle rate** — `idleMinutes / elapsedMinutes` — descending. Someone who has been idle a larger share of their shift so far ranks higher (more "deserving" of work). Staff who haven't started their shift yet at all get the highest possible priority (they're always put to work immediately, rather than defaulting to the back of the queue). Ties are broken by original staff order, for determinism.

### 6. Claimants vs. seekers

The ranked list splits into:
- **Claimants** — still holding a position that's open and available to reclaim.
- **Seekers** — need a new assignment this slot (either freshly available, or their old position just closed).

### 7. Fill vacant positions first

Positions that nobody currently holds ("genuinely vacant") are handed to seekers in rank order. This is deliberate: it means a seeker is only ever placed into a position someone else is actively working as an absolute last resort (step 8), which is what keeps people from being shuffled around unnecessarily.

### 8. Eviction (only when it actually helps)

If seekers remain after all vacant positions are filled, the algorithm considers pulling a position away from whichever claimant currently has the *lowest* idle rate (i.e., has been working the most, and so is least "owed" a break from work) — but **only if** doing so would improve the balance (the seeker's idle rate must be strictly higher than the claimant's) and only one eviction happens per otherwise-unresolved seeker. An evicted claimant is stopped via `applyStop`, same as steps 2–3.

### 9. Remaining claimants keep working

Anyone not evicted just continues in their position, uninterrupted.

### 10. Final seekers rest or idle

Anyone left with no position:
- If they were actively working immediately before this slot, they now rest. If the break window is open and the stagger budget allows it, this becomes their one real break; otherwise it's a short idle gap.
- If they weren't working before (genuinely surplus, nothing to lose), they're simply marked `IDLE` — no minimum duration is imposed, since there's nothing to protect them from.

### 11. Unstaffed bookkeeping

Any position still without an assigned staff member after all of the above is recorded as unstaffed for this slot.

## The break window

This is the most intricate part of the algorithm, and it exists to solve one specific problem: **everyone should get exactly one real, uninterrupted break during their shift — not several short ones, and not one dropped haphazardly wherever it happens to fit.**

### The target window

Each staff member has a target window, computed from their own shift length: **Earliest break %** to **Latest break %** (default 25%–75%). A stop that happens *inside* this window is eligible to become their one real break; a stop *before* it is always just a short idle gap (governed by **minimum idle time**, which has no maximum — it can run long if there's genuinely nothing to do).

### Why not just "the first stop after 50%"?

An earlier version of this algorithm used a fixed 50%–100% window and simply promoted whichever stop happened first after the midpoint. In practice this produced a bad pattern: a long, wasted idle stretch sitting well before the window, with the *actual* break getting forced in awkwardly at the very end of the shift once the guarantee kicked in. Two things fixed this:

1. **Any idle time still running when the window opens is converted into the break immediately** (rather than staying idle and having an unrelated break forced in separately later). This is checked continuously, not just once when a stint originally ends.
2. **The window itself became configurable and, by default, wider** (25%–75% instead of 50%–100%), giving the algorithm more genuinely idle time to draw on before demand tightens up. If your data still produces unstaffed gaps in tightly-staffed periods, widening the window further (lower "earliest break") is the intended lever to pull.

### Capacity-aware staggering

If several people become break-eligible in the same slot — say, several positions close at once — starting all of their breaks simultaneously could easily leave positions unstaffed the moment they reopen. So the number of *new* breaks allowed to start in any one slot is capped by real, forward-looking surplus:

```
surplus = (staff on shift right now) − (the MOST positions that will need
           covering at any point during a break started now) − (staff already mid-break)
```

The key detail is "the most positions that will need covering **during** the break" — not just the current instant. A momentary lull in demand right before a spike doesn't look like safe surplus, because the algorithm checks every slot across the break's full length (`minimum break length`) and uses the worst case. This is why the cap sometimes allows several people to break at once (when there's genuine, sustained surplus) and sometimes staggers them a slot or two apart (when there isn't).

### The absolute guarantee

Two hard backstops make sure nobody's break is ever actually skipped, no matter how tight things get:

1. **Past the window**, at least one person is still let through each slot even if the calculated surplus is zero — otherwise a fully-utilized team (no spare capacity at all, like a lone worker) would never make progress and everyone would pile up at the very last moment.
2. **When shift time is genuinely running out** (less than `minimum break length` remains), the break is forced immediately, completely ignoring the stagger cap. This is the one rule with no exceptions — better a brief, unavoidable gap than a broken promise.

## Blocked time and shift boundaries

A staff member's blocked times and shift boundaries are treated as facts, not preferences. They're resolved in the very first step of the availability pass, before any scheduling decision is made — a blocked or off-shift person is never assigned a position, never asked to keep working past `max time in position`, and their time doesn't count toward or against their idle rate. It's exactly as if that time doesn't exist for scheduling purposes.

## Settings reference

| Setting | Effect |
|---|---|
| **Max time in position** | Hard ceiling: nobody continues in one position past this many minutes. |
| **Minimum position length** | Nobody is rotated out for fairness before working a position this long (doesn't protect against a position closing or the one-break guarantee). |
| **Minimum break length** | How long the one real break must be. |
| **Minimum idle time** | The floor (not ceiling) for every *other* gap in someone's day. |
| **Earliest break %** / **Latest break %** | The target window, as a percentage of each person's own shift length, for where the one real break should land. |

## Known limitations

- **Greedy, not optimal.** The algorithm never backtracks. A decision made at 09:00 is never revisited even if a later slot reveals it was suboptimal.
- **Unstaffed slots are possible and honest.** If there genuinely isn't enough staff to cover demand while also honoring everyone's mandatory break, the algorithm will show you the resulting gap rather than silently break a rule to hide it. Widening the break window, lowering minimum break length, or adding staff during the tight period are the ways to resolve this.
- **Manual edits on the Schedule page bypass all of this.** They operate directly on the generated result and don't re-run any of these rules — see the Schedule page's own hint for details. Regenerating discards manual edits.

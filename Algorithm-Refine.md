# The scheduling algorithm — Refine mode

This document explains the **Refine** scheduler (`src/scheduler/algorithms/refine/`): a fourth scheduling mode based on **stochastic local search** (specifically **simulated annealing**). It solves the same problem as the other three — assigning staff to open positions across a day while guaranteeing everyone their one real break — but instead of reasoning about the problem's structure, it starts from a valid schedule and improves it by trial and error: make a random change, score the result, keep the changes that help, and occasionally accept ones that don't, until the time budget runs out.

It has the **same inputs, the same output, and honors the same hard rules** as the other modes. What changes is the strategy: it is the simplest of the four to implement, has no dependencies, scales to any instance size, and lands close to optimal in practice — but it is the one mode that can *never prove* it found the best answer.

For context, the four modes form a spectrum:

- **Quick** (`Algorithm.md`) — greedy, single-pass. One good answer, instantly.
- **Balanced** (`Algorithm-Balanced.md`) — multi-pass. A very good answer, no randomness, no proof.
- **Thorough** (`Algorithm-Thorough.md`) — branch-and-bound. The *proven* best answer, on coverage.
- **Refine** (this document) — simulated annealing. Polishes a good answer toward a great one by trial and error. No proof, but dead simple and scales forever.

## The core idea

Start from a schedule that is already valid, then repeatedly make small random changes. After each change, ask a single question — *is this schedule better or worse than the one I had?* — and use the answer to decide whether to keep the change. Over thousands of cheap iterations, the schedule drifts toward higher quality. No structural reasoning, just guided trial and error over valid schedules.

## The score measures quality, not distance to the optimum

The score is not "how far this is from optimal" — the optimum isn't known (finding it is the whole problem). It's an **absolute quality number** for any given schedule, letting two *neighboring* schedules be compared: is this new one better than the one currently held? The search only ever knows *better* and *worse*, never *best* — which is exactly why this mode can never produce an optimality certificate.

## The scoring function

Implemented in `score.ts`, exactly as specified — the weighted form, not the lexicographic-tuple form, since the annealing acceptance rule (`exp(−Δ/T)`) needs a single continuous number to compute a Δ from:

```
score = 1000·unstaffedSlots + 10·fairnessVariance + 3·churn + breakOffCenter
```

The large weight on unstaffed slots keeps coverage dominant — at the temperatures this run actually reaches, `exp(−1000/T)` is vanishingly small, so a move that regresses coverage is essentially never accepted even during the most exploratory early phase. The smaller weights order the rest: fairness, then churn, then break-centering. `fairnessVariance`, `churnCount`, and `breakOffCenterCost` are the same functions Thorough's phase 2 uses (`src/scheduler/shared/objectives.ts`) — both modes agree on exactly what "fairer," "calmer," and "better-centered" mean.

## Accepting some worse moves: simulated annealing

Pure hill-climbing (only ever accepting improvements) gets stuck at the nearest local peak. The fix: accept a worse move with probability `exp(−Δ/T)`, where `T` starts high and cools over the run. Early on the search wanders and can escape local optima; later, as `T` drops, it settles into greedy refinement.

**One deliberate deviation from the textbook pseudocode:** cooling is tied to *elapsed time*, not raw iteration count. The reference loop does `T = T × coolingFactor` once per iteration — but how many iterations fit in a fixed time budget varies a lot with instance size (more staff and positions means more expensive validation per candidate), so a cooling factor tuned for one instance's iteration count cools out almost immediately on a faster-iterating one. Measured on a 5-staff/3-position scenario, the textbook per-iteration schedule (`T *= 0.995`) reached near-zero after ~1,800 of the ~27,000 iterations the time budget actually allowed — meaning **over 90% of the run was spent in pure hill-climbing, not annealing at all.** Tying temperature to the fraction of the time budget elapsed (`T = T_start · e^(−rate · elapsedFraction)`) instead makes the full budget do real exploratory work regardless of how fast iteration happens to be on a given instance. `T_start = 50`, `rate = 5`, time budget `1200ms`.

## Inputs and output

Identical to the other three modes. `runRefine(positions, openings, staff, settings)` (`src/scheduler/algorithms/refine/core.ts`) takes the same four arguments, schedules exactly one day, and knows nothing about the weekly model. Same status set, same `unstaffed` record. Like Thorough, it runs in a Web Worker (`runRefineAsync`, dispatched the same way through the `ALGORITHMS` registry) so the schedule grid never freezes.

## Seeding: start from Quick

Assigning people at random until a valid schedule appears would be slow and unreliable — the one-break-in-window rule combined with coverage makes valid schedules rare in the space of random ones. Instead, Quick supplies the starting schedule: already valid, already decent, costs microseconds. Annealing only ever has to *improve* it, never has to first stumble into feasibility.

## Neighbor moves

Every move (`moves.ts`) proposes a plausible-looking candidate; nothing about move *generation* itself guarantees legality. Instead, every candidate is checked by a full-schedule validator (`validate.ts`) that replays each person's entire day against the same state machine every other mode's rules are built from — hard-cap, protection window, break contiguity/window/length, idle floor, no-bounce — before it's ever scored or considered for acceptance. This is a deliberate simplification from "construct only ever-valid moves by hand": a single-slot change can have effects that ripple forward through the rest of that person's day (e.g. reassigning them changes what "continuing" even means for every later slot), so surgically proving validity at the point of construction is real, structural reasoning — exactly the kind of complexity this mode exists to avoid. Generate-then-validate is simpler, unambiguously correct, and cheap enough at this app's scale (a handful of staff, a few dozen to ~90 slots) not to matter.

Three move types:

- **Reassign** — one person in one slot becomes a different open position, or idle.
- **Nudge** — an existing break slides one slot earlier or later within that person's domain (a K-slot break moving by one slot is exactly a 2-slot delta: the slot it vacates reverts to idle, the slot it gains becomes break).
- **Swap** — two people working the same slot trade positions.

About a quarter of proposed moves on a typical scenario turn out valid; the rest are simply discarded and the next iteration tries again — no repair, ever.

## The loop

```
current = Quick(...)          // valid warm start
best = current
repeat until the time budget is exhausted:
    T = T_start · e^(−rate · elapsedFraction)
    candidate = proposeMove(current)
    if candidate is valid:
        Δ = score(candidate) − score(current)
        if Δ < 0 or random() < exp(−Δ / T):
            current = candidate
            if score(current) < score(best): best = current
return best
```

## Determinism

A fixed seed (`rng.ts`, a small mulberry32 PRNG — `Math.random()` is never used) makes every run of the same inputs produce the exact same sequence of moves and therefore the exact same output. Worth doing for a tool people re-run and expect stable results from, per the source spec's own recommendation.

## Never worse than the cheaper modes

`runRefine` computes Quick's and Balanced's results too, and returns whichever of {the search's best-found, Quick, Balanced} scores lowest (unstaffed count first, then the same weighted score, as a tie-break) — the same "never regress" guarantee Balanced makes against Quick and Thorough makes against both. Annealing has no optimality proof to fall back on, so this comparison is the only thing standing between "usually great" and "occasionally worse than just running Quick alone."

## Verified behavior

Across the same test scenarios used for Balanced and Thorough: never worse than Quick or Balanced in any tested case; zero structural violations (no bounces, no missing/short/split breaks, no double-booking, max-time honored) across all of them; genuine annealing improvement confirmed directly (one scenario's score dropped from 1465 to 1375 over the course of a run, entirely from fairness/churn/break-centering gains — annealing was doing real work, it simply didn't happen to rediscover the specific coverage improvement Thorough's joint search found on that same scenario, which is the expected, honestly-documented shape of this algorithm class rather than a defect). Scales cleanly to 30 staff × 6 positions × a 17-hour day, completing within its time budget with no violations.

## The honest tradeoffs

**What it's great at**

- **Simplest to implement** of the four — no structural reasoning, no search tree, no constraint model.
- **Zero dependencies**, entirely client-side.
- **Anytime**: a valid best-so-far exists after every accepted move, so the run could be cut short at any point and still return something usable.
- **Scales indefinitely.** Where Thorough's branch-and-bound can spend its whole budget on a large, low-symmetry instance without proving much, Refine just keeps sampling and improving — it degrades gracefully instead of stalling.

**Its real limitations**

- **No optimality certificate — ever.** The mirror image of Thorough. An unstaffed slot in Refine's output could be genuinely unavoidable, or the search could simply never have stumbled onto the fix — there's no way to tell which from the result alone.
- **Non-deterministic in principle, deterministic in practice here.** Fixed-seeded specifically so re-running with the same inputs is reproducible.
- **Tuning-sensitive in theory, less so in practice at this scale.** Starting temperature, cooling rate, and move mix all affect quality — measured sweeps across a several-fold range of `T_start`/`rate` on the same scenario converged to the identical final result, suggesting the defaults aren't fragile at the instance sizes this app targets, though a very different scenario shape could still respond differently.

## Where it sits

Refine is the natural complement to Quick: Quick supplies the seed, Refine polishes it for as long as the time budget allows. If Thorough is "prove it's optimal," Refine is "get close to optimal cheaply, on any instance size, in a few hundred lines of code." All four modes run entirely client-side with zero external dependencies — Quick and Balanced synchronous and instant, Thorough and Refine backed by a Web Worker so their extra computation never costs the page its responsiveness.

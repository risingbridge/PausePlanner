# Rotate (Experimental)

**Rotate (Experimental)** is a fork of [Thorough (Experimental)](Algorithm-ThoroughExperimental.md)
(`src/scheduler/algorithms/thorough-experimental/`, copied wholesale into
`src/scheduler/algorithms/rotate-experimental/`). It keeps every feature Thorough (Experimental)
has — including required position assignments — and adds one thing on top: a fair-rotation
objective that spreads each position's time across the staff, so nobody gets typecast onto a
single station.

Like its parent, it is an incubator experiment, not a permanent mode. Quick, Balanced, Thorough,
and Refine are the fixed, documented algorithms; Rotate (Experimental) is where the rotation idea
is tried against a real, working branch-and-bound search before it either graduates somewhere
permanent or is discarded. Expect this document and the fork's contents to keep changing.

**Status:** built and verified, not just designed. Everything inherited from Thorough
(Experimental) — coverage, requirements, break handling — is unchanged from the already-tested
parent. The rotation objective itself has been verified two ways: a synthetic 3-staff/2-position
case where an unconstrained optimal-coverage schedule can typecast (one person parked on one
position all day) shows Thorough (Experimental) doing exactly that (per-position variance 200 and
800 across the two positions) while Rotate (Experimental) cuts both to 50, at identical 0-unstaffed
coverage; and a real 5-staff/4-position production schedule (with an active requirement) shows
total per-position variance roughly halved (7,902 → 4,122) versus Thorough (Experimental), again
at identical coverage and with the requirement honored on every one of its slots. A separate run
with the search's node/time budget raised 200x (100,000 nodes/1.5s → 20,000,000 nodes/8s) found no
better balance than the normal budget on the synthetic case — evidence, not proof, that the normal
budget already reaches (or comes very close to) the true optimum on realistic instance sizes.

## A note on the fork chain

Rotate (Experimental) forks a fork. Thorough (Experimental) already diverges permanently from
Thorough; Rotate (Experimental) now diverges permanently from both. A fix or improvement made to
any one of the three does not propagate to the others. That is the accepted cost of using forks as
incubators.

One honest consequence worth recording: Thorough (Experimental) took pride in a byte-identical
baseline — it proved the wholesale copy introduced no drift before required-positions landed.
Rotate (Experimental) cannot make the same clean claim, because it changes behavior (the
objective) on top of an already-modified base. If output looks wrong, the cause could be
requirements, rotation, or their interaction. This is the price of stacking two experiments in one
place, chosen deliberately because required positions and rotation are the same axis (see below)
and are most useful together.

## What's identical to Thorough (Experimental)

Everything Thorough (Experimental) carries, which is everything Thorough carries plus the full
required-positions feature. In particular, all of the following are inherited unchanged:

- Inputs, output shape, and every hard rule.
- The free per-slot lower bound, the two-phase lexicographic search, symmetry breaking, and
  dead-end pruning.
- The Quick/Balanced warm start, and the Web Worker wrapper (its own separate worker
  instance/module — never shared with Thorough's or Thorough (Experimental)'s).
- The entire required-positions experiment, verbatim: branching collapses to a single legal
  action inside a requirement window; a requirement-claimed position is removed from the open
  set for everyone else exactly as if it had closed, with holders forced off through the
  existing `forcedOff` path; an unavoidable same-slot bounce is checked as an explicit dead
  end; `continuousMinutes` resets at each requirement's start; break-vs-requirement
  infeasibility is surfaced as a thrown `Error` rather than a silently dropped break; the
  fast path is unconditionally skipped with the incumbent seeded from `Infinity` whenever any
  requirement exists; and the break-before-idle option ordering that makes that
  `Infinity`-seeded search converge.

See [Algorithm-ThoroughExperimental.md](Algorithm-ThoroughExperimental.md) for the full detail on
all of the above. This document only covers the rotation delta.

## What's different: fair position rotation

### It's a new objective, not a new constraint

The distinction matters and is the mirror image of the parent's feature. A requirement is a hard
positive constraint — "work this position for this window" — enforced structurally in the
branching. Rotation is a soft objective — a preference for which of the many valid schedules to
return. So rotation does not touch the branching rules or the hard-rule machinery
(`legalOptionsFor`, the required-position resolution, dead-end pruning are all untouched); it
enters through the lexicographic objective and the state it depends on. This is why rotation can
ride on top of requirements without fighting them: one decides what's legal, the other decides
what's best among the legal options.

### Fair share, not equal time

Positions have different demand — Reception may be open all day, backhouse only two hours — so
"everyone spends equal time in every position" is impossible. The target implemented
(`positionBalance.ts`'s `computePositionIdeal`) is a fair share of each position: split each
position's total staffed time as evenly as possible across the staff who could work it, weighted
by how much of that position's open time each person was actually present for (their availability
share). Person i's ideal for position p is computed as `forced[i][p] + remainingToDistribute[p] *
remainingAvail[i][p] / totalRemainingAvail[p]` — see the two correctness notes below for what
`forced`/`remaining` mean.

### The lexicographic slot-in

Rotation adds one level to Thorough (Experimental)'s lexicographic objective:

```
unstaffed → position-imbalance → idle-fairness → churn → break-centering
```

(`RotateSecondaryCost` in `search.ts`, compared as a 4-tuple.) Placed right after coverage, it
means "as balanced as possible without ever sacrificing a covered position." Its placement is the
design decision — the deliberate "variety over calm" values call, now expressed as one line in the
priority order. It sits above churn on purpose: rotating people around necessarily means more
switching (each rotation happening around a rest, per the no-bounce rule), so Rotate accepts more
churn as the price of variety. That trade is the entire reason the mode exists separately rather
than being folded into the default. The imbalance score itself is a sum of squared deviations from
the ideal across every (staff, position) cell — "column variance," summed rather than averaged
since only relative ordering between candidates matters for the comparison.

### The state carries the matrix

This is the substantive engine change. Thorough (Experimental)'s per-person state tracks current
position, `continuousMinutes`, break status, and idle run. `PersonState` here adds
`positionMinutes: number[]` — cumulative minutes in each position so far, indexed like
`ctx.positions`. It's credited in exactly two places in `branch.ts`: the required-position
resolution pass, and the free-choice "work" outcome — both feed the same `creditPosition` helper,
which is what makes point 1 below hold structurally rather than by convention.

`stateSignature` now serializes `positionMinutes` too, which matters in two places at once: phase
1's dominance-pruning `visited` map, and — more importantly — `enumerateJointAssignments`'s
symmetry breaking. Two people who are otherwise identical but have spent their day differently
across positions are *not* interchangeable for rotation purposes; without this, the existing
symmetry-breaking (sound for coverage-only Thorough) would silently discard genuinely different,
possibly better-balanced branches. The cost, as expected: a larger state weakens
memoization/dominance pruning, because two states are only "the same" now if their matrices match
too — fewer merges, a bigger tree. At ~5 staff and ~4 positions this stays cheap (the real-data
test above ran in under 120ms); it is a genuine change to the search's core, not a cosmetic
add-on.

### An admissible bound for imbalance

`positionImbalanceLowerBound` (`positionBalance.ts`) decomposes the bound per (staff, position)
cell rather than solving a global optimal-transport problem, using a precomputed suffix table
(`computeMaxRemainingSuffix`, one entry per slot/staff/position — the same "precompute once,
index for free" shape as the existing coverage suffix bound) of how many more minutes that cell
could possibly gain from the current slot onward:

- **Already past the ideal:** `positionMinutes` only ever grows, so the final deviation can only
  be greater than or equal to the current one — `(current - ideal)²` is a valid floor.
- **Short of the ideal:** the best that cell can possibly finish at is
  `min(ideal, current + remainingCapacity)`; if remaining capacity can't reach the ideal, that
  shortfall is locked in regardless of how the rest of the day plays out.

Each per-cell floor is independently valid, so the sum is a valid lower bound on the true sum even
though the per-cell "best cases" aren't necessarily simultaneously achievable — the same free slot
is credited toward *every* open position's remaining capacity at that slot (a person really could
dedicate it to any one of them, considered in isolation), which double-counts across cells but only
makes the bound looser, never wrong. `searchPhase2` uses it exactly like phase 1 uses the coverage
bound: prune a branch once its best-possible imbalance already exceeds the best imbalance
*achieved* so far, with a strict `>` rather than `>=` (a tie on imbalance can still be won on a
later tuple element, so equal-bound branches must stay open — unlike phase 1, which has nothing
after coverage to break a tie with).

### Two correctness interactions with requirements

These are the payoff for forking Thorough (Experimental) specifically rather than plain Thorough —
and they are correctness, not polish:

1. **Required minutes count toward the matrix.** When a requirement forces Alice into Reception
   9–11, `creditPosition` runs on that assignment exactly as it does for a freely-chosen one —
   Reception time she is accumulating increments `M[Alice][Reception]` regardless of how she got
   there.
2. **The fair-share ideal is computed net of forced assignments.** `computePositionIdeal` tracks
   `forced[i][p]` (minutes a requirement locks in) separately from `avail[i][p]` (total minutes
   that cell could possibly reach), and distributes only the *remaining* demand
   (`openMinutes[p] - totalForced[p]`) across *remaining* availability
   (`avail[i][p] - forced[i][p]`) — "given Alice must do 2h Reception, distribute the remaining
   Reception time so totals equalize," not "balance the free slots as if the forced ones didn't
   exist," which would double-count and over-penalize. Because forced future assignments are known
   in advance, they're folded into both the ideal and the bound's remaining-capacity table the same
   way — the one place the two experiments help each other rather than merely coexist.

### The pruning stress compounds — two things watched closely

- **`Infinity` seed + a looser bound.** Thorough (Experimental) already skips the warm-start fast
  path and seeds the incumbent from `Infinity` whenever requirements exist, so there is no
  bound-cut pruning until the first complete leaf. Rotate adds an objective term whose bound is
  inherently looser than coverage's. Verified directly (real production data, one active
  requirement): still converges in well under 120ms with 0 unstaffed, so the combination hasn't
  proven to be a practical problem at this instance size — but it's the first thing to check if a
  future instance times out.
- **`break`-before-`idle` ordering is untouched.** `legalOptionsFor` in this fork's `branch.ts` is
  byte-identical to the parent's on this point. Position balance influences which branch *scores*
  best at the leaf; it does not, and must not, reorder the options a free person is offered.

## `minPositionLength` is the rotation granularity

Rotation can only happen in chunks no smaller than `minPositionLength`. On a 7-hour day with a
60-minute floor, each person can do at most ~7 distinct stints — a hard ceiling on achievable
variety. Rotate cannot rotate faster than that floor allows; expect coarse rotation, not fine
mixing, whenever `minPositionLength` is large. This is a property of the inputs, not a limitation
of the search.

## Not implemented: position-history input for cross-day balance

The complaint Rotate targets — "one person always works Reception, another always backhouse" — is
usually a weekly pattern, but the engine is single-day and stateless; today's `positionIdeal` is
computed from scratch each generation, with no memory of yesterday. Within-day rotation alone
won't fully fix that. The intended remedy is an optional per-person position-history input
(accumulated minutes per position from previous days), folded into `computePositionIdeal` exactly
the way blocked times are fed in — "Alice did Reception all Monday" would make her the
least-exposed candidate for it on Tuesday, and balance would be computed across the week rather
than the day. This is a small change once `positionMinutes` already exists as a concept (it's just
a non-zero starting value for `forced`/`avail`'s counterparts), but it isn't built: there's no data
model field for it yet, and no UI to enter it. Left as a clearly-scoped next step rather than
attempted here.

## Everything else

Unchanged from Thorough (Experimental), and therefore from Thorough: the underlying search, the
lexicographic phases (now with the extra level above), the honest costs (runtime, code weight,
explainability), and the relationship to Quick/Balanced as warm starts. See
[Algorithm-ThoroughExperimental.md](Algorithm-ThoroughExperimental.md) and
[Algorithm-Thorough.md](Algorithm-Thorough.md) for all of that — this document only covers the
rotation delta on top of the fork.

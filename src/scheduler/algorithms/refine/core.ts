import type { OpeningsGrid, Position, ScheduleResult, Staff } from "../../../types";
import { generateSlots, SLOT_MINUTES } from "../../../utils/time";
import type { ScheduleSettings } from "../../types";
import { decisionsFromScheduleResult, decisionsToScheduleResult } from "../../shared/action";
import { computeBreakDomain } from "../../shared/breakDomain";
import { runBalanced } from "../balanced";
import { runQuick } from "../quick";
import type { RefineContext } from "./context";
import { attemptMove } from "./moves";
import { createRng } from "./rng";
import { score } from "./score";
import { isValidSchedule } from "./validate";

// A fixed seed rather than Math.random() — identical inputs should produce
// an identical run every time, which matters for a tool people re-run and
// expect stable output from.
const SEED = 42;
const T_START = 50;
// Cooling is tied to elapsed *time* rather than raw iteration count (unlike
// the textbook per-step multiplicative decay): how many iterations fit in
// the budget varies a lot with instance size, and a schedule tuned for a
// small instance's iteration count would cool out almost immediately on a
// faster-iterating one, wasting most of the run in pure hill-climbing
// instead of genuine annealing. Tying it to the fraction of the time
// budget elapsed keeps the full budget doing real exploratory work
// regardless of how many iterations that turns out to be.
const COOLING_RATE = 5;
const TIME_BUDGET_MS = 1200;
const MAX_ITERATIONS = 500000;

export function runRefine(
  positions: Position[],
  openings: OpeningsGrid,
  staff: Staff[],
  settings: ScheduleSettings
): ScheduleResult {
  const slots = generateSlots(settings.dayStart, settings.dayEnd);

  const quickResult = runQuick(positions, openings, staff, settings);
  const balancedResult = runBalanced(positions, openings, staff, settings);

  const openPositionsBySlot = slots.map((slot) => positions.filter((p) => openings[p.id]?.[slot] === true));
  const breakDomainByStaff = staff.map((s) => computeBreakDomain(s, settings, slots));
  const breakSlotSpan = Math.max(1, Math.ceil(settings.minBreakLength / SLOT_MINUTES));
  const ctx: RefineContext = { positions, staff, settings, slots, openPositionsBySlot, breakDomainByStaff, breakSlotSpan };

  const rng = createRng(SEED);
  // Quick, not Balanced, is the seed: it's already valid and near-instant,
  // and stumbling into a valid schedule via random assignment is
  // impractical here (the one-break-in-window rule makes valid schedules
  // rare in the space of random ones) — annealing only ever has to improve
  // a good start, never has to first find its way into feasible space.
  let current = decisionsFromScheduleResult(quickResult, staff, slots);
  let currentScore = score(current, ctx);
  let best = current;
  let bestScore = currentScore;

  const startTime = Date.now();
  const deadline = startTime + TIME_BUDGET_MS;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    const now = Date.now();
    if (now >= deadline) break;
    iterations++;
    const elapsedFraction = (now - startTime) / TIME_BUDGET_MS;
    const temperature = T_START * Math.exp(-COOLING_RATE * elapsedFraction);
    const candidate = attemptMove(current, ctx, rng);
    if (candidate && isValidSchedule(candidate, ctx)) {
      const candidateScore = score(candidate, ctx);
      const delta = candidateScore - currentScore;
      if (delta < 0 || rng() < Math.exp(-delta / temperature)) {
        current = candidate;
        currentScore = candidateScore;
        if (currentScore < bestScore) {
          best = current;
          bestScore = currentScore;
        }
      }
    }
  }

  const searchResult = decisionsToScheduleResult(best, positions, openings, staff, slots);

  // Never worse than either cheap baseline, the same guarantee Balanced and
  // Thorough both make — annealing has no proof to fall back on, so this is
  // the only thing standing between "usually great" and "occasionally
  // worse than just running Quick."
  const candidates = [
    { result: searchResult, decisions: best },
    { result: quickResult, decisions: decisionsFromScheduleResult(quickResult, staff, slots) },
    { result: balancedResult, decisions: decisionsFromScheduleResult(balancedResult, staff, slots) },
  ];
  candidates.sort((a, b) => {
    const byUnstaffed = a.result.unstaffed.length - b.result.unstaffed.length;
    if (byUnstaffed !== 0) return byUnstaffed;
    return score(a.decisions, ctx) - score(b.decisions, ctx);
  });
  return candidates[0].result;
}

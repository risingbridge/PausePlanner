import type { OpeningsGrid, Position, ScheduleResult, Staff } from "../../../types";
import { generateSlots } from "../../../utils/time";
import type { ScheduleSettings } from "../../types";
import { decisionsFromScheduleResult, decisionsToScheduleResult } from "../../shared/action";
import { computeBreakDomain } from "../../shared/breakDomain";
import { breakOffCenterCost, churnCount, deriveFairnessInputs, fairnessVariance, type SecondaryCost } from "../../shared/objectives";
import { runBalanced } from "../balanced";
import { runQuick } from "../quick";
import { computeSuffixLowerBound } from "./bound";
import type { SearchContext } from "./context";
import { searchPhase1, searchPhase2 } from "./search";
import { initialStates } from "./state";

const NODE_BUDGET = 100000;
const TIME_BUDGET_MS = 1500;

export function runThorough(
  positions: Position[],
  openings: OpeningsGrid,
  staff: Staff[],
  settings: ScheduleSettings
): ScheduleResult {
  const slots = generateSlots(settings.dayStart, settings.dayEnd);

  const quickResult = runQuick(positions, openings, staff, settings);
  const balancedResult = runBalanced(positions, openings, staff, settings);
  const warmStart = balancedResult.unstaffed.length <= quickResult.unstaffed.length ? balancedResult : quickResult;

  const openPositionsBySlot = slots.map((slot) => positions.filter((p) => openings[p.id]?.[slot] === true));
  const suffixLowerBound = computeSuffixLowerBound(positions, openings, staff, slots);
  const breakDomainByStaff = staff.map((s) => computeBreakDomain(s, settings, slots));
  const latestBreakDomainSlot = breakDomainByStaff.map((domain) => (domain.size === 0 ? -1 : Math.max(...domain)));

  const ctx: SearchContext = {
    positions,
    staff,
    settings,
    slots,
    openPositionsBySlot,
    suffixLowerBound,
    breakDomainByStaff,
    latestBreakDomainSlot,
    nodeBudget: NODE_BUDGET,
    deadlineMs: Date.now() + TIME_BUDGET_MS,
  };

  const phase1 = searchPhase1(ctx, initialStates(staff), warmStart.unstaffed.length);
  const phase1Decisions = phase1.decisions ?? decisionsFromScheduleResult(warmStart, staff, slots);
  const targetUnstaffed = phase1.cost;

  const seedFairnessInputs = deriveFairnessInputs(phase1Decisions, staff.length);
  const seedSecondary: SecondaryCost = [
    fairnessVariance(seedFairnessInputs),
    churnCount(phase1Decisions, staff.length),
    breakOffCenterCost(phase1Decisions, staff, slots, settings),
  ];

  ctx.deadlineMs = Date.now() + TIME_BUDGET_MS;
  const phase2 = searchPhase2(ctx, initialStates(staff), targetUnstaffed, phase1Decisions, seedSecondary);

  return decisionsToScheduleResult(phase2.decisions, positions, openings, staff, slots);
}

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

function buildRequirementIndex(
  staff: Staff[],
  slots: string[]
): { requiredPositionByStaffSlot: Array<Map<number, string>>; requirementStartSlotByStaff: Array<Set<number>> } {
  const requiredPositionByStaffSlot = staff.map(() => new Map<number, string>());
  const requirementStartSlotByStaff = staff.map(() => new Set<number>());
  staff.forEach((s, i) => {
    for (const r of s.requirements) {
      let isFirst = true;
      for (let t = 0; t < slots.length; t++) {
        if (slots[t] < r.start || slots[t] >= r.end) continue;
        requiredPositionByStaffSlot[i].set(t, r.positionId);
        if (isFirst) {
          requirementStartSlotByStaff[i].add(t);
          isFirst = false;
        }
      }
    }
  });
  return { requiredPositionByStaffSlot, requirementStartSlotByStaff };
}

export function runThoroughExperimental(
  positions: Position[],
  openings: OpeningsGrid,
  staff: Staff[],
  settings: ScheduleSettings
): ScheduleResult {
  const slots = generateSlots(settings.dayStart, settings.dayEnd);
  const hasRequirements = staff.some((s) => s.requirements.length > 0);

  const quickResult = runQuick(positions, openings, staff, settings);
  const balancedResult = runBalanced(positions, openings, staff, settings);
  const warmStart = balancedResult.unstaffed.length <= quickResult.unstaffed.length ? balancedResult : quickResult;

  const openPositionsBySlot = slots.map((slot) => positions.filter((p) => openings[p.id]?.[slot] === true));
  const suffixLowerBound = computeSuffixLowerBound(positions, openings, staff, slots);
  const breakDomainByStaff = staff.map((s) => computeBreakDomain(s, settings, slots));
  const latestBreakDomainSlot = breakDomainByStaff.map((domain) => (domain.size === 0 ? -1 : Math.max(...domain)));
  const { requiredPositionByStaffSlot, requirementStartSlotByStaff } = buildRequirementIndex(staff, slots);

  const ctx: SearchContext = {
    positions,
    staff,
    settings,
    slots,
    openPositionsBySlot,
    suffixLowerBound,
    breakDomainByStaff,
    latestBreakDomainSlot,
    requiredPositionByStaffSlot,
    requirementStartSlotByStaff,
    nodeBudget: NODE_BUDGET,
    deadlineMs: Date.now() + TIME_BUDGET_MS,
  };

  // Quick and Balanced know nothing about requirements, so "the warm start
  // already matches the lower bound" no longer implies "the warm start is a
  // valid answer" once any exist — it only speaks to coverage, not whether
  // the required person is actually standing in the required position. When
  // requirements are in play the search always runs for real, seeded from
  // Infinity so any complete, requirement-honoring schedule it finds counts
  // as an improvement; if it finds none at all, phase1.decisions stays null
  // and that's a genuine "no valid schedule exists," not a signal to fall
  // back to a warm start that was never checked against the requirements in
  // the first place.
  const phase1 = searchPhase1(ctx, initialStates(staff), hasRequirements ? Infinity : warmStart.unstaffed.length);
  if (hasRequirements && phase1.decisions === null) {
    throw new Error(
      "No schedule satisfies every required position together with everyone's guaranteed break. Try loosening a requirement, or the break window in Settings."
    );
  }
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

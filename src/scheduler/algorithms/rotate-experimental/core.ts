import type { OpeningsGrid, Position, ScheduleResult, Staff } from "../../../types";
import { generateSlots } from "../../../utils/time";
import type { ScheduleSettings } from "../../types";
import { decisionsFromScheduleResult, decisionsToScheduleResult } from "../../shared/action";
import { computeBreakDomain } from "../../shared/breakDomain";
import { breakOffCenterCost, churnCount, deriveFairnessInputs, fairnessVariance } from "../../shared/objectives";
import { runBalanced } from "../balanced";
import { runQuick } from "../quick";
import { computeSuffixLowerBound } from "./bound";
import type { SearchContext } from "./context";
import { computeMaxRemainingSuffix, computePositionIdeal, derivePositionMinutes, positionImbalanceScoreFromMatrix } from "./positionBalance";
import { searchPhase1, searchPhase2, type RotateSecondaryCost } from "./search";
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

export function runRotateExperimental(
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
  const positionIndexById = new Map(positions.map((p, idx) => [p.id, idx]));
  const positionIdeal = computePositionIdeal(positions, staff, openings, slots, requiredPositionByStaffSlot);
  const maxRemainingSuffix = computeMaxRemainingSuffix(positions, staff, openings, slots, requiredPositionByStaffSlot);

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
    positionIndexById,
    positionIdeal,
    maxRemainingSuffix,
    nodeBudget: NODE_BUDGET,
    deadlineMs: Date.now() + TIME_BUDGET_MS,
  };

  // Identical rationale to Thorough (Experimental): Quick and Balanced know
  // nothing about requirements, so their coverage count can't be trusted as
  // a valid answer once any requirement exists — the fast path is skipped
  // and the incumbent seeded from Infinity whenever one does.
  const phase1 = searchPhase1(ctx, initialStates(staff, positions.length), hasRequirements ? Infinity : warmStart.unstaffed.length);
  if (hasRequirements && phase1.decisions === null) {
    throw new Error(
      "No schedule satisfies every required position together with everyone's guaranteed break. Try loosening a requirement, or the break window in Settings."
    );
  }
  const phase1Decisions = phase1.decisions ?? decisionsFromScheduleResult(warmStart, staff, slots);
  const targetUnstaffed = phase1.cost;

  const seedFairnessInputs = deriveFairnessInputs(phase1Decisions, staff.length);
  const seedPositionMinutes = derivePositionMinutes(phase1Decisions, staff.length, positions.length, positionIndexById);
  const seedSecondary: RotateSecondaryCost = [
    positionImbalanceScoreFromMatrix(seedPositionMinutes, positionIdeal),
    fairnessVariance(seedFairnessInputs),
    churnCount(phase1Decisions, staff.length),
    breakOffCenterCost(phase1Decisions, staff, slots, settings),
  ];

  ctx.deadlineMs = Date.now() + TIME_BUDGET_MS;
  const phase2 = searchPhase2(ctx, initialStates(staff, positions.length), targetUnstaffed, phase1Decisions, seedSecondary);

  return decisionsToScheduleResult(phase2.decisions, positions, openings, staff, slots);
}

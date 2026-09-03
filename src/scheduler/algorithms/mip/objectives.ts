import { SLOT_MINUTES, toMinutes } from "../../../utils/time";
import type { ScheduleSettings } from "../../types";
import type { LpTerm } from "./lpBuilder";
import type { MipModel } from "./model";

export interface FairShare {
  ideal: number[][]; // ideal[staffIndex][positionIndex], in minutes
  forced: number[][]; // forced[staffIndex][positionIndex], in minutes
}

// Availability-weighted fair share, net of requirement-forced time — same
// formula and same rationale as Rotate (Experimental)'s
// computePositionIdeal (see Algorithm-RotateExperimental.md): required
// minutes are real time spent on that position and must count, but the
// *target* for the remaining, freely-assignable time has to be computed
// net of what's already forced, or a person with a big requirement gets
// double-penalized for having "too much" of that position.
export function computeFairShare(model: MipModel): FairShare {
  const { staff, positions, slots, present, openAt, req, positionIndexById } = model;
  const n = staff.length;
  const m = positions.length;
  const openMinutes = new Array(m).fill(0);
  const avail: number[][] = Array.from({ length: n }, () => new Array(m).fill(0));
  const forced: number[][] = Array.from({ length: n }, () => new Array(m).fill(0));

  for (let t = 0; t < slots.length; t++) {
    for (let p = 0; p < m; p++) if (openAt[p][t]) openMinutes[p] += SLOT_MINUTES;
    for (let s = 0; s < n; s++) {
      if (!present[s][t]) continue;
      const reqPid = req.requiredPositionAt[s].get(t);
      if (reqPid !== undefined) {
        const p = positionIndexById.get(reqPid);
        if (p !== undefined) {
          avail[s][p] += SLOT_MINUTES;
          forced[s][p] += SLOT_MINUTES;
        }
        continue;
      }
      for (let p = 0; p < m; p++) if (openAt[p][t]) avail[s][p] += SLOT_MINUTES;
    }
  }

  const ideal: number[][] = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let p = 0; p < m; p++) {
    let forcedTotal = 0;
    for (let s = 0; s < n; s++) forcedTotal += forced[s][p];
    const remaining = Math.max(0, openMinutes[p] - forcedTotal);

    let totalRemainingAvail = 0;
    for (let s = 0; s < n; s++) totalRemainingAvail += Math.max(0, avail[s][p] - forced[s][p]);

    for (let s = 0; s < n; s++) {
      const remainingAvail = Math.max(0, avail[s][p] - forced[s][p]);
      const share = totalRemainingAvail > 0 ? (remaining * remainingAvail) / totalRemainingAvail : 0;
      ideal[s][p] = forced[s][p] + share;
    }
  }
  return { ideal, forced };
}

// Same "distance from the target window's midpoint" idea as
// shared/objectives.ts's breakOffCenterCost, computed per candidate start
// slot instead of per chosen leaf — reused for consistency across every
// mode that scores break placement.
function breakDesirabilityCost(
  staff: MipModel["staff"][number],
  settings: ScheduleSettings,
  slotIndex: number,
  slots: string[],
  minBreakSlots: number
): number {
  const shiftStart = toMinutes(staff.start);
  const shiftEnd = toMinutes(staff.end);
  const idealMid = shiftStart + ((shiftEnd - shiftStart) * (settings.earliestBreakPercent + settings.latestBreakPercent)) / 200;
  const actualMid = toMinutes(slots[slotIndex]) + (minBreakSlots * SLOT_MINUTES) / 2;
  return Math.abs(actualMid - idealMid);
}

export function coverageTerms(model: MipModel): LpTerm[] {
  return [...model.unstaffed.values()].map((name): LpTerm => [1, name]);
}

// Adds the dev/maxDev variables and constraints for stage 2a, returns the
// objective terms (just [maxDev], but returned as a list for a uniform
// "terms you can freeze" interface across every stage).
export function positionFairnessTerms(model: MipModel, fairShare: FairShare): LpTerm[] {
  const { lp, staff, positions } = model;
  const maxDevVar = "maxDevPosition";
  lp.declareVar(maxDevVar, "continuous");
  for (let s = 0; s < staff.length; s++) {
    for (let p = 0; p < positions.length; p++) {
      const devVar = `dev_${s}_${p}`;
      lp.declareVar(devVar, "continuous");
      const xTerms: LpTerm[] = [];
      for (let t = 0; t < model.slots.length; t++) {
        const name = model.x.get(`${s}|${p}|${t}`);
        if (name) xTerms.push([SLOT_MINUTES, name]);
      }
      const forcedMinutes = fairShare.forced[s][p];
      const ideal = fairShare.ideal[s][p];
      // dev >= M - ideal  <=>  dev - SLOT_MINUTES*Σx >= forced - ideal
      lp.addConstraint(
        [[1, devVar], ...xTerms.map(([c, n]): LpTerm => [-c, n])],
        ">=",
        forcedMinutes - ideal
      );
      // dev >= ideal - M  <=>  dev + SLOT_MINUTES*Σx >= ideal - forced
      lp.addConstraint([[1, devVar], ...xTerms], ">=", ideal - forcedMinutes);
      lp.addConstraint(
        [
          [1, maxDevVar],
          [-1, devVar],
        ],
        ">=",
        0
      );
    }
  }
  return [[1, maxDevVar]];
}

export function breakQualityTerms(model: MipModel, settings: ScheduleSettings): LpTerm[] {
  const { lp, staff, slots, startBreak, minBreakSlots } = model;
  const maxBreakDevVar = "maxDevBreak";
  lp.declareVar(maxBreakDevVar, "continuous");
  for (let s = 0; s < staff.length; s++) {
    const terms: LpTerm[] = [];
    for (let t = 0; t < slots.length; t++) {
      const name = startBreak.get(`${s}|${t}`);
      if (!name) continue;
      const cost = breakDesirabilityCost(staff[s], settings, t, slots, minBreakSlots);
      terms.push([cost, name]);
    }
    lp.addConstraint(
      [
        [1, maxBreakDevVar],
        ...terms.map(([c, n]): LpTerm => [-c, n]),
      ],
      ">=",
      0
    );
  }
  return [[1, maxBreakDevVar]];
}

// switchCount[s] = (total position-segment starts) - 1, floored at 0 —
// §6's doc formula, implemented with an explicit variable (rather than
// just summing startWork and subtracting |staff|) so each person's own
// contribution is floored individually rather than the total.
export function churnTerms(model: MipModel): LpTerm[] {
  const { lp, staff, positions, slots, startWork } = model;
  const terms: LpTerm[] = [];
  for (let s = 0; s < staff.length; s++) {
    const switchVar = `switchCount_${s}`;
    lp.declareVar(switchVar, "general", { lower: 0 });
    const startTerms: LpTerm[] = [];
    for (let p = 0; p < positions.length; p++) {
      for (let t = 0; t < slots.length; t++) {
        const name = startWork.get(`${s}|${p}|${t}`);
        if (name) startTerms.push([1, name]);
      }
    }
    lp.addConstraint(
      [[1, switchVar], ...startTerms.map(([c, n]): LpTerm => [-c, n])],
      ">=",
      -1
    );
    terms.push([1, switchVar]);
  }
  return terms;
}

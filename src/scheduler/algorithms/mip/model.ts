import type { OpeningsGrid, Position, Staff } from "../../../types";
import { findActiveBlock, isWithinShift, SLOT_MINUTES } from "../../../utils/time";
import { computeBreakDomain } from "../../shared/breakDomain";
import type { ScheduleSettings } from "../../types";
import { LpBuilder } from "./lpBuilder";

function keyST(s: number, t: number): string {
  return `${s}|${t}`;
}
function keySPT(s: number, p: number, t: number): string {
  return `${s}|${p}|${t}`;
}
function keyPT(p: number, t: number): string {
  return `${p}|${t}`;
}

export interface RequirementIndex {
  requiredPositionAt: Array<Map<number, string>>; // staff index -> slot index -> required positionId
  requirementStartSlot: Array<Set<number>>; // staff index -> slot indices where a requirement begins
  requirementEndSlot: Array<Set<number>>; // staff index -> slot indices immediately AFTER a requirement ends
}

// Identical shape/semantics to thorough-experimental's buildRequirementIndex
// (see core.ts there), plus requirementEndSlot — needed here because the
// MIP has to explicitly re-derive the "no bounce, minimum idle gap" rule
// around a requirement boundary that the DFS engines get for free from
// their per-slot state machine (see §5.6/§5.7 handling below).
function buildRequirementIndex(staff: Staff[], slots: string[]): RequirementIndex {
  const requiredPositionAt = staff.map(() => new Map<number, string>());
  const requirementStartSlot = staff.map(() => new Set<number>());
  const requirementEndSlot = staff.map(() => new Set<number>());
  staff.forEach((s, i) => {
    for (const r of s.requirements) {
      let isFirst = true;
      let lastT = -1;
      for (let t = 0; t < slots.length; t++) {
        if (slots[t] < r.start || slots[t] >= r.end) continue;
        requiredPositionAt[i].set(t, r.positionId);
        if (isFirst) {
          requirementStartSlot[i].add(t);
          isFirst = false;
        }
        lastT = t;
      }
      if (lastT !== -1) requirementEndSlot[i].add(lastT + 1);
    }
  });
  return { requiredPositionAt, requirementStartSlot, requirementEndSlot };
}

export interface MipModel {
  lp: LpBuilder;
  slots: string[];
  positions: Position[];
  staff: Staff[];
  positionIndexById: Map<string, number>;
  present: boolean[][]; // present[s][t] — on shift, not blocked
  openAt: boolean[][]; // openAt[p][t]
  req: RequirementIndex;
  x: Map<string, string>; // key s|p|t
  br: Map<string, string>; // key s|t
  idle: Map<string, string>; // key s|t
  startWork: Map<string, string>; // key s|p|t
  startBreak: Map<string, string>; // key s|t
  unstaffed: Map<string, string>; // key p|t
  minPosSlots: number;
  maxTimeSlots: number;
  minIdleSlots: number;
  minBreakSlots: number;
}

// Builds every decision variable and every hard constraint (§5.1-§5.7 of
// Algorithm-Mip.md) as one LP model, shared unchanged across all solve
// stages — only the objective (and a frozen-bound constraint per prior
// stage) differs between stages. Throws synchronously, before any solve is
// attempted, for the one case that's a genuine data contradiction rather
// than a matter of degree: a staff member for whom no legal break-start
// slot survives at all (mirrors Thorough (Experimental)'s thrown Error for
// the same condition, given here instead of a generic "Infeasible" solver
// status so the message stays specific).
export function buildModel(positions: Position[], openings: OpeningsGrid, staff: Staff[], slots: string[], settings: ScheduleSettings): MipModel {
  const lp = new LpBuilder();
  const positionIndexById = new Map(positions.map((p, idx) => [p.id, idx]));
  const req = buildRequirementIndex(staff, slots);

  const present: boolean[][] = staff.map((s) =>
    slots.map((slot) => isWithinShift(slot, s.start, s.end) && !findActiveBlock(slot, s.blocks))
  );
  const openAt: boolean[][] = positions.map((p) => slots.map((slot) => openings[p.id]?.[slot] === true));

  const minPosSlots = Math.max(1, Math.round(settings.minPositionLength / SLOT_MINUTES));
  const maxTimeSlots = Math.max(1, Math.round(settings.maxTimeInPosition / SLOT_MINUTES));
  const minIdleSlots = Math.max(0, Math.round(settings.minIdleTime / SLOT_MINUTES));
  const minBreakSlots = Math.max(1, Math.round(settings.minBreakLength / SLOT_MINUTES));

  const x = new Map<string, string>();
  const br = new Map<string, string>();
  const idle = new Map<string, string>();
  const startWork = new Map<string, string>();
  const startBreak = new Map<string, string>();
  const unstaffed = new Map<string, string>();

  // --- variables: x[s,p,t], br[s,t], idle[s,t] ---
  for (let s = 0; s < staff.length; s++) {
    for (let t = 0; t < slots.length; t++) {
      if (!present[s][t]) continue;
      if (req.requiredPositionAt[s].has(t)) continue; // fixed, not a decision — see §5.7
      for (let p = 0; p < positions.length; p++) {
        if (!openAt[p][t]) continue;
        const name = `x_${keySPT(s, p, t)}`;
        x.set(keySPT(s, p, t), name);
        lp.declareVar(name, "binary");
      }
      const brName = `br_${keyST(s, t)}`;
      const idleName = `idle_${keyST(s, t)}`;
      br.set(keyST(s, t), brName);
      idle.set(keyST(s, t), idleName);
      lp.declareVar(brName, "binary");
      lp.declareVar(idleName, "binary");
    }
  }

  // --- §5.1 slot partition ---
  for (let s = 0; s < staff.length; s++) {
    for (let t = 0; t < slots.length; t++) {
      if (!present[s][t] || req.requiredPositionAt[s].has(t)) continue;
      const terms: Array<[number, string]> = [[1, br.get(keyST(s, t))!], [1, idle.get(keyST(s, t))!]];
      for (let p = 0; p < positions.length; p++) {
        const name = x.get(keySPT(s, p, t));
        if (name) terms.push([1, name]);
      }
      lp.addConstraint(terms, "=", 1);
    }
  }

  // --- §5.2 coverage & shortfall ---
  for (let p = 0; p < positions.length; p++) {
    for (let t = 0; t < slots.length; t++) {
      if (!openAt[p][t]) continue;
      const name = `unstaffed_${keyPT(p, t)}`;
      unstaffed.set(keyPT(p, t), name);
      lp.declareVar(name, "general", { lower: 0, upper: staff.length });
      const xTerms: Array<[number, string]> = [];
      let requiredCount = 0;
      for (let s = 0; s < staff.length; s++) {
        const xName = x.get(keySPT(s, p, t));
        if (xName) xTerms.push([1, xName]);
        if (req.requiredPositionAt[s].get(t) === positions[p].id) requiredCount++;
      }
      // Shortfall: unstaffed plus freely-assigned workers must reach the
      // one headcount this slot needs, net of anyone a requirement already
      // pinned here.
      lp.addConstraint([[1, name], ...xTerms], ">=", 1 - requiredCount);
      // Cap: at most that many freely-assigned workers. This app models
      // exactly one assignee per open position per slot everywhere else
      // (ScheduleResult.assignments holds a single staffId, never a list) —
      // without this cap the solver has no reason not to double-staff an
      // already-covered position purely to pad someone's work-minutes
      // total for the idle-fairness objective, since nothing before this
      // fix penalized doing so.
      lp.addConstraint(xTerms, "<=", 1 - requiredCount);
    }
  }

  // --- §5.3 exactly one break, sized, contiguous, windowed ---
  for (let s = 0; s < staff.length; s++) {
    const domain = computeBreakDomain(staff[s], settings, slots);
    const candidates: number[] = [];
    for (const t of domain) {
      if (t + minBreakSlots > slots.length) continue;
      let fits = true;
      for (let t2 = t; t2 < t + minBreakSlots; t2++) {
        if (!present[s][t2] || req.requiredPositionAt[s].has(t2)) {
          fits = false;
          break;
        }
      }
      if (fits) candidates.push(t);
    }
    if (candidates.length === 0) {
      throw new Error(
        `No legal break window exists for ${staff[s].name} once required positions and blocked time are accounted for. Try loosening a requirement, a blocked time, or the break window in Settings.`
      );
    }
    const startTerms: Array<[number, string]> = [];
    for (const t of candidates) {
      const name = `startBreak_${keyST(s, t)}`;
      startBreak.set(keyST(s, t), name);
      lp.declareVar(name, "binary");
      startTerms.push([1, name]);
      for (let t2 = t; t2 < t + minBreakSlots; t2++) {
        lp.addConstraint(
          [
            [1, br.get(keyST(s, t2))!],
            [-1, name],
          ],
          ">=",
          0
        );
      }
    }
    lp.addConstraint(startTerms, "=", 1);

    const totalBrTerms: Array<[number, string]> = [];
    for (let t = 0; t < slots.length; t++) {
      const name = br.get(keyST(s, t));
      if (name) totalBrTerms.push([1, name]);
    }
    lp.addConstraint(totalBrTerms, "=", minBreakSlots);
  }

  // --- §5.4 max continuous time in one position (sliding window) ---
  for (let s = 0; s < staff.length; s++) {
    for (let p = 0; p < positions.length; p++) {
      for (let t = 0; t + maxTimeSlots <= slots.length - 1; t++) {
        const terms: Array<[number, string]> = [];
        let complete = true;
        for (let t2 = t; t2 <= t + maxTimeSlots; t2++) {
          const name = x.get(keySPT(s, p, t2));
          if (!name) {
            complete = false;
            break;
          }
          terms.push([1, name]);
        }
        if (complete) lp.addConstraint(terms, "<=", maxTimeSlots);
      }
    }
  }
  // Requirement-then-free-continuation on the SAME position is one
  // continuous run for this cap's purposes (only the requirement's own
  // *start* resets the counter — see Algorithm-ThoroughExperimental.md).
  // The requirement's own duration is already validated at entry to fit
  // within the cap; what's checked here is any free extension past it.
  for (let s = 0; s < staff.length; s++) {
    for (const r of staff[s].requirements) {
      const p = positionIndexById.get(r.positionId);
      if (p === undefined) continue;
      let requiredLen = 0;
      for (let t = 0; t < slots.length; t++) if (req.requiredPositionAt[s].get(t) === r.positionId) requiredLen++;
      const reqEnd = [...req.requirementEndSlot[s]].find((end) => {
        const start = end - requiredLen;
        return start >= 0 && req.requiredPositionAt[s].get(start) === r.positionId;
      });
      if (reqEnd === undefined) continue;
      const remainingBudget = maxTimeSlots - requiredLen;
      if (remainingBudget < 0) continue; // already caught by entry validation
      const terms: Array<[number, string]> = [];
      let complete = true;
      for (let t2 = reqEnd; t2 <= reqEnd + remainingBudget; t2++) {
        const name = x.get(keySPT(s, p, t2));
        if (!name) {
          complete = false;
          break;
        }
        terms.push([1, name]);
      }
      if (complete && terms.length > 0) lp.addConstraint(terms, "<=", remainingBudget);
    }
  }
  // Free-choice-then-requirement continuation on the SAME position, mirroring
  // the case above in the other direction. Thorough (Experimental) only
  // resets its counter at a requirement's own *start* — a pragmatic
  // consequence of that engine's forward-only per-slot state machine, not a
  // real-world exemption. A MIP has no such limitation: it can express a
  // backward-looking window exactly as naturally as a forward one, so there's
  // no reason to inherit that same visible-cap-violation quirk here. Without
  // this, a person could freely work up to (maxTimeSlots - requiredLen) slots
  // on the SAME position immediately before a requirement claims it, and the
  // visible combined run would exceed the cap even though each piece is
  // independently "legal" by every constraint written so far.
  for (let s = 0; s < staff.length; s++) {
    for (const r of staff[s].requirements) {
      const p = positionIndexById.get(r.positionId);
      if (p === undefined) continue;
      let requiredLen = 0;
      for (let t = 0; t < slots.length; t++) if (req.requiredPositionAt[s].get(t) === r.positionId) requiredLen++;
      const reqStart = [...req.requirementStartSlot[s]].find(
        (start) => req.requiredPositionAt[s].get(start) === r.positionId
      );
      if (reqStart === undefined) continue;
      const remainingBudget = maxTimeSlots - requiredLen;
      if (remainingBudget < 0) continue; // already caught by entry validation
      const terms: Array<[number, string]> = [];
      let complete = true;
      for (let t2 = reqStart - 1; t2 >= reqStart - 1 - remainingBudget; t2--) {
        const name = x.get(keySPT(s, p, t2));
        if (!name) {
          complete = false;
          break;
        }
        terms.push([1, name]);
      }
      if (complete && terms.length > 0) lp.addConstraint(terms, "<=", remainingBudget);
    }
  }

  // --- §5.5 minimum position length (contiguity) + startWork bookkeeping ---
  for (let s = 0; s < staff.length; s++) {
    for (let p = 0; p < positions.length; p++) {
      for (let t = 0; t < slots.length; t++) {
        const name = x.get(keySPT(s, p, t));
        if (!name) continue;
        const startName = `startWork_${keySPT(s, p, t)}`;
        startWork.set(keySPT(s, p, t), startName);
        lp.declareVar(startName, "binary");
        const prev = x.get(keySPT(s, p, t - 1));
        if (prev) {
          lp.addConstraint(
            [
              [1, startName],
              [-1, name],
              [1, prev],
            ],
            ">=",
            0
          );
        } else {
          lp.addConstraint(
            [
              [1, startName],
              [-1, name],
            ],
            ">=",
            0
          );
        }
        // Effective window: minPosSlots, clipped to however many
        // consecutive slots this position actually stays assignable for
        // (shift end, position closing, or an upcoming requirement) —
        // never padded past that, per §5.5's own caveat.
        let windowLen = 0;
        for (let t2 = t; t2 < t + minPosSlots; t2++) {
          if (!x.get(keySPT(s, p, t2))) break;
          windowLen++;
        }
        for (let t2 = t; t2 < t + windowLen; t2++) {
          lp.addConstraint(
            [
              [1, x.get(keySPT(s, p, t2))!],
              [-1, startName],
            ],
            ">=",
            0
          );
        }
      }
    }
  }

  // --- §5.6 minimum idle time between different positions ---
  for (let s = 0; s < staff.length; s++) {
    for (let p2 = 0; p2 < positions.length; p2++) {
      for (let t = 0; t < slots.length; t++) {
        const startName = startWork.get(keySPT(s, p2, t));
        if (!startName || minIdleSlots === 0) continue;
        for (let p1 = 0; p1 < positions.length; p1++) {
          if (p1 === p2) continue;
          for (let t2 = Math.max(0, t - minIdleSlots); t2 < t; t2++) {
            const other = x.get(keySPT(s, p1, t2));
            if (other) {
              lp.addConstraint(
                [
                  [1, other],
                  [1, startName],
                ],
                "<=",
                1
              );
            }
          }
        }
      }
    }
  }
  // Same rule around a requirement boundary, on both sides — a requirement
  // is a fixed "start"/"end" that the lookback above can't see since fixed
  // slots carry no x variable to check against.
  if (minIdleSlots > 0) {
    for (let s = 0; s < staff.length; s++) {
      for (const t of req.requirementStartSlot[s]) {
        const reqPositionId = req.requiredPositionAt[s].get(t)!;
        for (let p1 = 0; p1 < positions.length; p1++) {
          if (positions[p1].id === reqPositionId) continue;
          for (let t2 = Math.max(0, t - minIdleSlots); t2 < t; t2++) {
            const other = x.get(keySPT(s, p1, t2));
            if (other) lp.addConstraint([[1, other]], "<=", 0);
          }
        }
      }
      for (const t of req.requirementEndSlot[s]) {
        // Identify which position this requirement (ending here) pinned,
        // by looking at the slot immediately before.
        const reqPositionId = req.requiredPositionAt[s].get(t - 1);
        if (reqPositionId === undefined) continue;
        for (let p1 = 0; p1 < positions.length; p1++) {
          if (positions[p1].id === reqPositionId) continue;
          for (let t2 = t; t2 < Math.min(slots.length, t + minIdleSlots); t2++) {
            const other = x.get(keySPT(s, p1, t2));
            if (other) lp.addConstraint([[1, other]], "<=", 0);
          }
        }
      }
    }
  }

  return {
    lp,
    slots,
    positions,
    staff,
    positionIndexById,
    present,
    openAt,
    req,
    x,
    br,
    idle,
    startWork,
    startBreak,
    unstaffed,
    minPosSlots,
    maxTimeSlots,
    minIdleSlots,
    minBreakSlots,
  };
}

import type { Action } from "../../shared/action";
import type { RefineContext } from "./context";

function cloneDecisions(decisions: Action[][]): Action[][] {
  return decisions.map((slotActions) => slotActions.slice());
}

function isSameAction(a: Action, b: Action): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "WORK" && b.kind === "WORK") return a.positionId === b.positionId;
  return true;
}

// Reassign one person in one slot to a different open position or to idle.
// Whether the result is actually legal (protection, max-time, no-bounce,
// exclusivity) is decided entirely by the caller's validity check — this
// only proposes a plausible-looking change, never tries to reason about
// whether it's allowed.
function tryReassign(decisions: Action[][], ctx: RefineContext, rng: () => number): Action[][] | null {
  const t = Math.floor(rng() * ctx.slots.length);
  const i = Math.floor(rng() * ctx.staff.length);
  const current = decisions[t][i];
  if (current.kind !== "WORK" && current.kind !== "IDLE") return null;

  const options: Action[] = [{ kind: "IDLE" }, ...ctx.openPositionsBySlot[t].map((p): Action => ({ kind: "WORK", positionId: p.id }))];
  const alternatives = options.filter((a) => !isSameAction(a, current));
  if (alternatives.length === 0) return null;

  const next = cloneDecisions(decisions);
  next[t][i] = alternatives[Math.floor(rng() * alternatives.length)];
  return next;
}

// Slides a person's existing break one slot earlier or later within their
// domain. A K-slot break sliding by one slot is exactly a 2-slot delta: the
// slot it vacates reverts to idle, the slot it gains becomes break.
function tryNudgeBreak(decisions: Action[][], ctx: RefineContext, rng: () => number): Action[][] | null {
  const i = Math.floor(rng() * ctx.staff.length);
  let breakStart = -1;
  for (let t = 0; t < ctx.slots.length; t++) {
    if (decisions[t][i].kind === "BREAK") {
      breakStart = t;
      break;
    }
  }
  if (breakStart === -1) return null;

  const direction = rng() < 0.5 ? -1 : 1;
  const newStart = breakStart + direction;
  if (newStart < 0 || newStart + ctx.breakSlotSpan > ctx.slots.length) return null;
  if (!ctx.breakDomainByStaff[i].has(newStart)) return null;

  const oldRange = new Set<number>();
  for (let k = 0; k < ctx.breakSlotSpan; k++) oldRange.add(breakStart + k);
  const newRange = new Set<number>();
  for (let k = 0; k < ctx.breakSlotSpan; k++) newRange.add(newStart + k);

  const next = cloneDecisions(decisions);
  for (const t of oldRange) {
    if (!newRange.has(t)) next[t][i] = { kind: "IDLE" };
  }
  for (const t of newRange) {
    if (!oldRange.has(t)) next[t][i] = { kind: "BREAK" };
  }
  return next;
}

// Swaps two people's position assignments within the same slot.
function trySwap(decisions: Action[][], ctx: RefineContext, rng: () => number): Action[][] | null {
  const t = Math.floor(rng() * ctx.slots.length);
  const workers: number[] = [];
  for (let i = 0; i < ctx.staff.length; i++) {
    if (decisions[t][i].kind === "WORK") workers.push(i);
  }
  if (workers.length < 2) return null;

  const a = workers[Math.floor(rng() * workers.length)];
  let b = a;
  for (let attempt = 0; attempt < 5 && b === a; attempt++) {
    b = workers[Math.floor(rng() * workers.length)];
  }
  if (b === a) return null;

  const next = cloneDecisions(decisions);
  const actionA = next[t][a];
  next[t][a] = next[t][b];
  next[t][b] = actionA;
  return next;
}

// Reassign is weighted more heavily since it applies almost everywhere;
// nudge/swap only fire when a break or a contested slot exists to act on.
const MOVE_GENERATORS = [tryReassign, tryReassign, tryNudgeBreak, trySwap];

export function attemptMove(decisions: Action[][], ctx: RefineContext, rng: () => number): Action[][] | null {
  const generator = MOVE_GENERATORS[Math.floor(rng() * MOVE_GENERATORS.length)];
  return generator(decisions, ctx, rng);
}

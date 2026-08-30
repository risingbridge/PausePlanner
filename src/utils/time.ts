import type { ShiftCode, Staff } from "../types";

export const SLOT_MINUTES = 15;

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function toHHMM(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function generateSlots(dayStart: string, dayEnd: string): string[] {
  const start = toMinutes(dayStart);
  const end = toMinutes(dayEnd);
  const slots: string[] = [];
  for (let t = start; t < end; t += SLOT_MINUTES) {
    slots.push(toHHMM(t));
  }
  return slots;
}

export function isWithinShift(slot: string, shiftStart: string, shiftEnd: string): boolean {
  const t = toMinutes(slot);
  return t >= toMinutes(shiftStart) && t < toMinutes(shiftEnd);
}

export function findActiveBlock<T extends { start: string; end: string }>(
  slot: string,
  blocks: T[]
): T | undefined {
  const t = toMinutes(slot);
  return blocks.find((b) => t >= toMinutes(b.start) && t < toMinutes(b.end));
}

export function resolveStaffShift(staff: Staff, shiftCodes: ShiftCode[]): { start: string; end: string } {
  const code = staff.shiftCodeId ? shiftCodes.find((c) => c.id === staff.shiftCodeId) : undefined;
  return code ? { start: code.start, end: code.end } : { start: staff.start, end: staff.end };
}

export function formatDuration(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

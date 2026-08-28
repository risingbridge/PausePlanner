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

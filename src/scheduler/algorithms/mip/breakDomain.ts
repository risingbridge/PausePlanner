import type { Staff } from "../../../types";
import { toMinutes } from "../../../utils/time";
import type { ScheduleSettings } from "../../types";

function breakFits(staff: Staff, startMinute: number, minBreakLength: number): boolean {
  const endMinute = startMinute + minBreakLength;
  return staff.blocks.every((b) => startMinute >= toMinutes(b.end) || endMinute <= toMinutes(b.start));
}

// Legal break-start slot indices for one person: primarily their target
// window (earliest%-latest% of shift), widened to the full shift only if
// the window itself can't fit a whole break anywhere on a pathological
// (very short shift, very narrow window) input.
export function computeBreakDomain(staff: Staff, settings: ScheduleSettings, slots: string[]): Set<number> {
  const shiftStart = toMinutes(staff.start);
  const shiftEnd = toMinutes(staff.end);
  const duration = shiftEnd - shiftStart;
  const windowStart = shiftStart + Math.round((duration * settings.earliestBreakPercent) / 100);
  const windowEnd = shiftStart + Math.round((duration * settings.latestBreakPercent) / 100);
  const latestPossibleStart = shiftEnd - settings.minBreakLength;

  const inWindow: number[] = [];
  for (let i = 0; i < slots.length; i++) {
    const t = toMinutes(slots[i]);
    if (t < windowStart || t > Math.min(windowEnd, latestPossibleStart)) continue;
    if (!breakFits(staff, t, settings.minBreakLength)) continue;
    inWindow.push(i);
  }
  if (inWindow.length > 0) return new Set(inWindow);

  const widened: number[] = [];
  for (let i = 0; i < slots.length; i++) {
    const t = toMinutes(slots[i]);
    if (t < shiftStart || t > latestPossibleStart) continue;
    if (!breakFits(staff, t, settings.minBreakLength)) continue;
    widened.push(i);
  }
  return new Set(widened);
}

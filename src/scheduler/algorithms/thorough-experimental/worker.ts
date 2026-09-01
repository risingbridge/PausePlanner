import type { OpeningsGrid, Position, ScheduleResult, Staff } from "../../../types";
import type { ScheduleSettings } from "../../types";
import { runThoroughExperimental } from "./core";

export interface ThoroughExperimentalWorkerRequest {
  positions: Position[];
  openings: OpeningsGrid;
  staff: Staff[];
  settings: ScheduleSettings;
}

export type ThoroughExperimentalWorkerResponse = { ok: true; result: ScheduleResult } | { ok: false; error: string };

// Typed structurally rather than via the "webworker" lib, so this file
// doesn't need a project-wide tsconfig change (which would conflict with
// the "DOM" lib the rest of the app already relies on).
interface WorkerGlobal {
  onmessage: ((ev: MessageEvent<ThoroughExperimentalWorkerRequest>) => void) | null;
  postMessage: (data: ThoroughExperimentalWorkerResponse) => void;
}

const ctx = self as unknown as WorkerGlobal;

ctx.onmessage = (event) => {
  try {
    const { positions, openings, staff, settings } = event.data;
    const result = runThoroughExperimental(positions, openings, staff, settings);
    ctx.postMessage({ ok: true, result });
  } catch (err) {
    ctx.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};

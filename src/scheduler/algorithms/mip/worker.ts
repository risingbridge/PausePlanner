import wasmUrl from "highs/runtime?url";
import type { OpeningsGrid, Position, ScheduleResult, Staff } from "../../../types";
import type { AlgorithmProgress, ScheduleSettings } from "../../types";
import { runMip } from "./core";

export interface MipWorkerRequest {
  positions: Position[];
  openings: OpeningsGrid;
  staff: Staff[];
  settings: ScheduleSettings;
}

// A stage-progress message can arrive any number of times (once per solve
// stage, always before "done"); "done" arrives exactly once and ends the
// exchange — the main-thread side (index.ts) keys off `type` to tell them
// apart rather than waiting for a single reply the way every other
// algorithm's worker does.
export type MipWorkerResponse =
  | ({ type: "progress" } & AlgorithmProgress)
  | { type: "done"; ok: true; result: ScheduleResult }
  | { type: "done"; ok: false; error: string };

// Typed structurally rather than via the "webworker" lib, so this file
// doesn't need a project-wide tsconfig change (which would conflict with
// the "DOM" lib the rest of the app already relies on) — same pattern as
// every other algorithm's worker.
interface WorkerGlobal {
  onmessage: ((ev: MessageEvent<MipWorkerRequest>) => void) | null;
  postMessage: (data: MipWorkerResponse) => void;
}

const ctx = self as unknown as WorkerGlobal;

// The only worker in this app whose handler is genuinely async all the way
// through — every other algorithm's core function is a synchronous
// computation the worker just offloads; this one's core function is
// async because loading the WASM solver is inherently async, with no
// synchronous alternative to fall back to.
ctx.onmessage = async (event) => {
  try {
    const { positions, openings, staff, settings } = event.data;
    const result = await runMip(positions, openings, staff, settings, wasmUrl, (progress) => {
      ctx.postMessage({ type: "progress", ...progress });
    });
    ctx.postMessage({ type: "done", ok: true, result });
  } catch (err) {
    ctx.postMessage({ type: "done", ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};

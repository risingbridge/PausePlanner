import type { OpeningsGrid, Position, ScheduleResult, Staff } from "../../../types";
import type { ScheduleSettings } from "../../types";
import { runRefine } from "./core";
import type { RefineWorkerRequest, RefineWorkerResponse } from "./worker";

let worker: Worker | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  }
  return worker;
}

// Runs the search off the main thread so the schedule grid never freezes
// while it thinks — falls back to running inline only if Workers genuinely
// aren't available in this environment.
export function runRefineAsync(
  positions: Position[],
  openings: OpeningsGrid,
  staff: Staff[],
  settings: ScheduleSettings
): Promise<ScheduleResult> {
  if (typeof Worker === "undefined") {
    return Promise.resolve(runRefine(positions, openings, staff, settings));
  }

  return new Promise((resolve, reject) => {
    const w = getWorker();

    function handleMessage(event: MessageEvent<RefineWorkerResponse>) {
      cleanup();
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.error));
    }
    function handleError(event: ErrorEvent) {
      cleanup();
      reject(event.error instanceof Error ? event.error : new Error(event.message));
    }
    function cleanup() {
      w.removeEventListener("message", handleMessage);
      w.removeEventListener("error", handleError);
    }

    w.addEventListener("message", handleMessage);
    w.addEventListener("error", handleError);
    const request: RefineWorkerRequest = { positions, openings, staff, settings };
    w.postMessage(request);
  });
}

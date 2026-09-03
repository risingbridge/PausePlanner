import type { OpeningsGrid, Position, ScheduleResult, Staff } from "../../../types";
import type { ScheduleSettings } from "../../types";
import { runRotateExperimental } from "./core";
import type { RotateExperimentalWorkerRequest, RotateExperimentalWorkerResponse } from "./worker";

let worker: Worker | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  }
  return worker;
}

// A separate Worker instance/module from Thorough's and Thorough
// (Experimental)'s own — this fork is meant to diverge freely, so it must
// never share runtime state (including an in-flight request) with either
// algorithm it descends from.
export function runRotateExperimentalAsync(
  positions: Position[],
  openings: OpeningsGrid,
  staff: Staff[],
  settings: ScheduleSettings
): Promise<ScheduleResult> {
  if (typeof Worker === "undefined") {
    return Promise.resolve(runRotateExperimental(positions, openings, staff, settings));
  }

  return new Promise((resolve, reject) => {
    const w = getWorker();

    function handleMessage(event: MessageEvent<RotateExperimentalWorkerResponse>) {
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
    const request: RotateExperimentalWorkerRequest = { positions, openings, staff, settings };
    w.postMessage(request);
  });
}

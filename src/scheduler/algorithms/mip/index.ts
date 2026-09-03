import type { OpeningsGrid, Position, ScheduleResult, Staff } from "../../../types";
import type { AlgorithmProgress, ScheduleSettings } from "../../types";
import type { MipWorkerRequest, MipWorkerResponse } from "./worker";

let worker: Worker | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  }
  return worker;
}

// Unlike every other algorithm here, this one has no synchronous fallback
// for a Worker-less environment — the WASM solver load is inherently
// async, so there's nothing to "just run inline" the way the DFS-based
// modes can. If Workers genuinely aren't available, this mode simply isn't
// — that's an acceptable gap given every browser this app targets supports
// them.
export function runMipAsync(
  positions: Position[],
  openings: OpeningsGrid,
  staff: Staff[],
  settings: ScheduleSettings,
  onProgress?: (progress: AlgorithmProgress) => void
): Promise<ScheduleResult> {
  if (typeof Worker === "undefined") {
    return Promise.reject(new Error("MIP (HiGHS) requires Web Workers, which aren't available in this environment."));
  }

  return new Promise((resolve, reject) => {
    const w = getWorker();

    // Unlike every other algorithm's worker exchange (exactly one reply),
    // this one can receive any number of "progress" messages before the
    // single "done" message that actually resolves/rejects — see
    // worker.ts's MipWorkerResponse for why.
    function handleMessage(event: MessageEvent<MipWorkerResponse>) {
      if (event.data.type === "progress") {
        onProgress?.(event.data);
        return;
      }
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
    const request: MipWorkerRequest = { positions, openings, staff, settings };
    w.postMessage(request);
  });
}

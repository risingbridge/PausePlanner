import highsLoader from "highs";

// The `highs` package's .d.ts declares its internal types (Highs,
// HighsSolution, HighsOptions...) without individual `export` keywords —
// only the default loader function is actually exported — so they're
// extracted here rather than imported by name.
type HighsFactory = typeof highsLoader;
export type Highs = Awaited<ReturnType<HighsFactory>>;
export type HighsSolution = ReturnType<Highs["solve"]>;
export type HighsOptions = NonNullable<Parameters<Highs["solve"]>[1]>;

let cached: Promise<Highs> | null = null;

// Loaded once per Worker (or per Node process, for test scripts) and
// reused across every stage's solve() call — the WASM instance itself is
// stateless between solves, so there's no reason to reload it per stage.
export function getHighs(wasmUrl: string): Promise<Highs> {
  if (!cached) {
    cached = highsLoader({ locateFile: () => wasmUrl });
  }
  return cached;
}

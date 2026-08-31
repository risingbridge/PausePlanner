// A small, fast, deterministic PRNG (mulberry32) rather than Math.random() —
// the same inputs should produce the same annealing run every time, which
// matters for a tool people re-run and expect stable output from.
export function createRng(seed: number): () => number {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

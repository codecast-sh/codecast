// mulberry32: a tiny deterministic PRNG, so anything drawn from a seed (a
// property run, a fixture world, a sampled p value) reads the same every time.
// Pure, no imports: it loads in the Convex runtime, bun and the browser alike.

export type Rng = () => number;

/** A uniform draw in [0, 1) per call, the same sequence for the same seed. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

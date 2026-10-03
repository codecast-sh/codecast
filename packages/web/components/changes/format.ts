// The page's small wording and motion helpers, one copy each.

/** "1 commit", "1,204 commits": a count with its noun, the plural `one + s` unless named. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** `--i` for the first paint's stagger (spec 5.4), capped at 10. */
export const rise = (i: number) => ({ ["--i" as any]: Math.min(i, 10) });

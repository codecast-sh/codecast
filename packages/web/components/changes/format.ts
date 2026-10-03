// The page's small wording and motion helpers, one copy each.

/** "1 commit", "1,204 commits": a count with its noun, the plural `one + s` unless named. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** `--i` for the first paint's stagger (spec 5.4), capped at 10. */
export const rise = (i: number) => ({ ["--i" as any]: Math.min(i, 10) });

/**
 * A number held to its unit with a no-break space ("40 ms", "2.1 MB",
 * "3 minutes"), so a line never ends on the number and starts the next on its
 * unit. `%` is a non-word character, so the unit's end is "no word character
 * follows", not a word boundary.
 */
export const glueUnits = (t: string) => t.replace(/(\d) (ms|s|MB|GB|KB|x|%|min|h|seconds|minutes)(?!\w)/g, "$1\u00a0$2");

/**
 * The head of a day or week where nothing landed: "Nothing landed on main on
 * Fri 2 Oct yet." `when` is "on Fri 2 Oct" or "this week". With every branch
 * shown the view is not of main, and "on main" goes.
 */
export const nothingLanded = (branches: string | undefined, when: string, yet: boolean) =>
  `Nothing landed ${branches === "all" ? "" : "on main "}${when}${yet ? " yet" : ""}.`;

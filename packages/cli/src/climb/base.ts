// The commit a climb starts from (flows.md FL10). A shared checkout lags its
// default branch routinely: another session lands on main every few minutes,
// and a climb based on the checkout's own HEAD ran its envs without fixes
// main already held, failing the same way three times (ct-97276). So the
// base is the default branch's upstream tip, fetched fresh, and the card
// records which tip it is and how far the checkout's HEAD stood from it.
import { tryGit } from "./protect.js";

export type ClimbBase = {
  sha: string;
  /** Where the sha came from: the upstream ref (origin/main), or "explicit" for --base, or "HEAD" when there is no upstream. */
  from: string;
  /** Whether the upstream was fetched just now; false when the fetch failed and the last fetched tip was used. */
  fetched: boolean;
  /** How many commits the checkout's HEAD lacks from the base, and has that the base does not. */
  head_behind: number;
  head_ahead: number;
  /** What a reader should know about the choice: a failed fetch, no upstream at all. */
  note?: string;
};

/** The default branch's upstream ref: the current branch's upstream, else the remote's HEAD, else origin/main or origin/master. */
function upstreamRef(root: string): string | null {
  const own = tryGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (own && own.includes("/")) return own;
  const head = tryGit(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head;
  for (const ref of ["origin/main", "origin/master"]) if (tryGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) return ref;
  return null;
}

/**
 * The climb's base: `explicit` when given, else the upstream tip after a
 * fetch. A failed fetch uses the last fetched tip and says so; a checkout
 * with no upstream at all bases on HEAD and says so.
 */
export function climbBase(root: string, explicit?: string, fetch = true): ClimbBase | null {
  const distance = (sha: string) => ({
    head_behind: Number(tryGit(root, ["rev-list", "--count", `HEAD..${sha}`]) ?? 0) || 0,
    head_ahead: Number(tryGit(root, ["rev-list", "--count", `${sha}..HEAD`]) ?? 0) || 0,
  });
  if (explicit) {
    const sha = tryGit(root, ["rev-parse", "--verify", "--quiet", `${explicit}^{commit}`]);
    return sha ? { sha, from: "explicit", fetched: false, ...distance(sha) } : null;
  }
  const ref = upstreamRef(root);
  if (!ref) {
    const sha = tryGit(root, ["rev-parse", "HEAD"]);
    return sha ? { sha, from: "HEAD", fetched: false, head_behind: 0, head_ahead: 0, note: "this checkout has no upstream to base on, so the climb bases on its HEAD" } : null;
  }
  const [remote, ...rest] = ref.split("/");
  const fetched = fetch && tryGit(root, ["fetch", "--quiet", remote, rest.join("/")]) !== null;
  const sha = tryGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!sha) return null;
  return { sha, from: ref, fetched, ...distance(sha), ...(fetch && !fetched ? { note: `fetching ${ref} failed, so the base is its last fetched tip` } : {}) };
}

/** The base in one line for the card and the record. */
export const baseWords = (b: ClimbBase) =>
  `${b.sha.slice(0, 10)}, ${b.from === "explicit" ? "named with --base" : b.from === "HEAD" ? "this checkout's HEAD" : `the tip of ${b.from}${b.fetched ? ", fetched now" : ""}`}${b.head_behind || b.head_ahead ? `; this checkout's HEAD was ${b.head_behind} behind${b.head_ahead ? ` and ${b.head_ahead} ahead` : ""}` : ""}${b.note ? ` (${b.note})` : ""}`;

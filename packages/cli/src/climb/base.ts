// The commit a climb starts from (flows.md FL10). A shared checkout lags its
// default branch routinely: another session lands on main every few minutes,
// and a climb based on the checkout's own HEAD ran its envs without fixes
// main already held, failing the same way three times (ct-97276). So the
// base is the default branch's upstream tip, fetched fresh, and the card
// records which tip it is and how far the checkout's HEAD stood from it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "../proc.js";
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
  /** A pending change the climb builds on, applied onto the upstream tip: the control candidates are measured beyond. */
  stack?: ClimbStack & { sha: string; onto: string };
};

/** A pending promoted change a climb stacks on: a branch or commit (`ref`) or a patch file, and the task that carries it. */
export type ClimbStack = { ref?: string; patch?: string; task?: string };

const GIT_ID = { GIT_AUTHOR_NAME: "codecast climb", GIT_AUTHOR_EMAIL: "climb@codecast.invalid", GIT_COMMITTER_NAME: "codecast climb", GIT_COMMITTER_EMAIL: "climb@codecast.invalid" };
const git = (root: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024, env: { ...process.env, ...GIT_ID, ...env } }).trim();

/**
 * The stacked base: a pending change applied onto `onto` (the upstream tip),
 * as a commit no branch points at, so the climb's control holds both main's
 * latest and the change it builds on. A ref that already contains `onto` is
 * taken as it is; another is merged onto it (a conflict refuses); a patch is
 * applied onto it. The commit is kept under refs/codecast/climb-stack/ so it
 * outlives garbage collection while the climb runs. Nothing in the checkout,
 * its branches or its index moves.
 */
export function stackBase(root: string, onto: string, stack: ClimbStack): { sha: string } | { error: string } {
  const keep = (sha: string) => { try { git(root, ["update-ref", `refs/codecast/climb-stack/${sha}`, sha]); } catch {} return { sha }; };
  try {
    if (stack.ref) {
      const ref = tryGit(root, ["rev-parse", "--verify", "--quiet", `${stack.ref}^{commit}`]) ?? tryGit(root, ["rev-parse", "--verify", "--quiet", `origin/${stack.ref}^{commit}`]);
      if (!ref) return { error: `the stack ${stack.ref} is not a branch or commit here (fetch it first)` };
      if (tryGit(root, ["merge-base", onto, ref]) === onto) return keep(ref);
      let tree: string;
      try { tree = git(root, ["merge-tree", "--write-tree", onto, ref]).split("\n")[0]; } catch { return { error: `the stack ${stack.ref} conflicts with ${onto.slice(0, 10)}; rebase it onto main first` }; }
      return keep(git(root, ["commit-tree", tree, "-p", onto, "-p", ref, "-m", `climb stack: ${stack.ref} onto ${onto.slice(0, 10)}`]));
    }
    if (stack.patch) {
      if (!fs.existsSync(stack.patch)) return { error: `the stack's patch ${stack.patch} does not exist` };
      const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "climb-stack-")), "index");
      try {
        git(root, ["read-tree", onto], { GIT_INDEX_FILE: index });
        try { git(root, ["apply", "--cached", path.resolve(stack.patch)], { GIT_INDEX_FILE: index }); } catch (err) { return { error: `the stack's patch does not apply onto ${onto.slice(0, 10)}: ${String((err as any)?.stderr ?? err).split("\n")[0]}` }; }
        const tree = git(root, ["write-tree"], { GIT_INDEX_FILE: index });
        return keep(git(root, ["commit-tree", tree, "-p", onto, "-m", `climb stack: ${path.basename(stack.patch)} onto ${onto.slice(0, 10)}`]));
      } finally { fs.rmSync(path.dirname(index), { recursive: true, force: true }); }
    }
    return { error: "the card's stack names neither a ref nor a patch" };
  } catch (err) {
    return { error: `the stack could not be built: ${String((err as any)?.stderr ?? (err as Error).message ?? err).split("\n")[0]}` };
  }
}

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
export const baseWords = (b: ClimbBase) => {
  const tip = b.stack ? b.stack.onto : b.sha;
  const head = `${tip.slice(0, 10)}, ${b.from === "explicit" ? "named with --base" : b.from === "HEAD" ? "this checkout's HEAD" : `the tip of ${b.from}${b.fetched ? ", fetched now" : ""}`}${b.head_behind || b.head_ahead ? `; this checkout's HEAD was ${b.head_behind} behind${b.head_ahead ? ` and ${b.head_ahead} ahead` : ""}` : ""}${b.note ? ` (${b.note})` : ""}`;
  if (!b.stack) return head;
  const what = b.stack.ref ?? (b.stack.patch ? path.basename(b.stack.patch) : "a pending change");
  return `${b.sha.slice(0, 10)}, stacked: ${what}${b.stack.task ? ` (${b.stack.task}, pending)` : ""} applied onto ${head}. Every candidate is measured beyond the stack, and Promote files only the increment`;
};

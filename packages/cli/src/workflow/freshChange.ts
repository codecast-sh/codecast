// A flow run works from the remote as it is now, never from a stale local copy
// (docs/architecture/flows.md FL4). A build box once ran a flow on a local
// branch made days earlier from an old main and never updated, while the real
// work sat on origin: Check passed on an empty change, and Land called it landed.
// So before a run reads its change it fetches the default branch and the named
// branch, takes the freshest tip of the branch, and stops when that tip holds
// nothing the default branch lacks.
import * as fs from "node:fs";
import { upstreamRef } from "../land/shipCheckout.js";
import { isAncestor } from "../land/replay.js";
import { git, gitTry } from "../wipSnapshot.js";

/** What git said went wrong: its first fatal or error line (a bad URL's last line is only "and the repository exists."), else its last. */
const said = (err: unknown) => {
  const lines = String((err as { stderr?: string })?.stderr || (err instanceof Error ? err.message : err)).trim().split("\n");
  return (lines.find((l) => /^(fatal|error): /.test(l))?.replace(/^(fatal|error): /, "") ?? lines.pop() ?? "").trim();
};

type Upstream = { remote: string; branch: string; ref: string; sha: string };

/**
 * Fetch the remote's default branch; throws when it cannot, since the run would otherwise build on a stale copy.
 * Null for a checkout with no origin: nothing is fresher than the local copy, so the change is read as it stands.
 */
export async function fetchDefault(root: string): Promise<Upstream | null> {
  if ((await gitTry(root, ["remote", "get-url", "origin"])) === null) return null;
  // An origin never fetched has no default branch to name yet: fetch it once and ask it which one it is.
  const ref = await upstreamRef(root).catch(async () => {
    await git(root, ["fetch", "--quiet", "origin"]).catch((err) => {
      throw new Error(`Could not fetch origin (${said(err)}), so the run would work from a stale copy. Check the remote with git fetch origin, then run this again`);
    });
    await gitTry(root, ["remote", "set-head", "origin", "--auto"]);
    return upstreamRef(root).catch(() => {
      throw new Error("origin's default branch cannot be named here. Run git remote set-head origin --auto (or git remote set-head origin <branch>), then run this again");
    });
  });
  const [remote, branch] = [ref.split("/")[0], ref.split("/").slice(1).join("/")];
  await git(root, ["fetch", "--quiet", remote, `+refs/heads/${branch}:refs/remotes/${ref}`]).catch(async (err) => {
    // A remote that answers but no longer has the branch renamed its default branch.
    const gone = (await gitTry(root, ["ls-remote", "--heads", remote, `refs/heads/${branch}`])) === "";
    throw new Error(gone
      ? `${remote} has no branch ${branch} any more, so its default branch was likely renamed. Run git remote set-head ${remote} --auto, then run this again`
      : `Could not fetch ${ref} (${said(err)}), so the run would work from a stale copy of it. Check the remote with git fetch ${remote} ${branch}, then run this again`);
  });
  return { remote, branch, ref, sha: await git(root, ["rev-parse", ref]) };
}

/** Which of these branches the remote holds (none without a remote). */
export async function remoteBranches(root: string, remote: string | null, names: string[]): Promise<Set<string>> {
  if (!remote) return new Set();
  const out = await git(root, ["ls-remote", "--heads", remote, ...names.map((n) => `refs/heads/${n}`)]).catch((err) => {
    throw new Error(`Could not read ${remote}'s branches (${said(err)}). Check the remote with git ls-remote ${remote}, then run this again`);
  });
  return new Set(out.split("\n").map((l) => l.split("\t")[1]?.replace(/^refs\/heads\//, "")).filter((n): n is string => !!n));
}

/**
 * The freshest tip of a named branch, decided without moving anything: the remote's when the local branch is behind
 * it or missing; the local one when it is ahead or the remote lacks the branch. Two that diverged stop the run, and
 * so does a behind branch checked out anywhere but `movable` (the run's own earlier worktree), which is never moved
 * under someone's work. `local` is where the branch is now, for `bringBranchTo`.
 */
export async function freshestBranch(root: string, remote: string | null, branch: string, movable: string | null): Promise<{ tip: string; remoteTip: string | null; local: string | null }> {
  const onRemote = (await remoteBranches(root, remote, [branch])).has(branch);
  if (onRemote && remote) await git(root, ["fetch", "--quiet", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]).catch((err) => {
    throw new Error(`Could not fetch ${remote}/${branch} (${said(err)}), so the run would work from a stale copy of it. Check it with git fetch ${remote} ${branch}, then run this again`);
  });
  const remoteTip = onRemote ? await git(root, ["rev-parse", `refs/remotes/${remote}/${branch}`]) : null;
  const local = await gitTry(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (!remoteTip) {
    if (!local) throw new Error(remote ? `No branch ${branch} here or on ${remote}. If the work is on another machine, push it from there first` : `No branch ${branch} here`);
    return { tip: local, remoteTip, local };
  }
  if (local === remoteTip || (local && (await isAncestor(root, remoteTip, local)))) return { tip: local, remoteTip, local };
  if (local && !(await isAncestor(root, local, remoteTip))) {
    throw new Error(`${branch} here (${local.slice(0, 10)}) and ${remote}/${branch} (${remoteTip.slice(0, 10)}) have diverged, so neither is the change. If ${remote}'s copy is the one to keep, run git branch -f ${branch} ${remote}/${branch} (or git reset --hard ${remote}/${branch} where ${branch} is checked out); if this one is, push it; then run this again`);
  }
  if (local) {
    const elsewhere = (await checkedOutAt(root, branch)).filter((p) => p !== movable);
    if (elsewhere.length) throw new Error(`${branch} here (${local.slice(0, 10)}) is behind ${remote}/${branch} (${remoteTip.slice(0, 10)}) and checked out at ${elsewhere.join(", ")}, so it is not moved under that work; update it there, then run this again`);
  }
  return { tip: remoteTip, remoteTip, local };
}

/**
 * Bring the local branch from `local` to `tip`, once the run is known to go ahead, and leave the run's earlier
 * worktree on that branch at the tip, so the stations' commits land on the branch. The worktree moves first, by git's
 * own commands that refuse rather than overwrite a file, ignored ones included: a fast-forward when it holds the
 * branch, else a detached checkout of the tip, then the ref, guarded by its old value, then the branch checked out
 * there. A refusal stops the run with nothing lost. A path that is not itself a worktree's root is never touched,
 * since git there would act on the checkout around it.
 */
export async function bringBranchTo(root: string, branch: string, local: string | null, tip: string, earlier: string | null): Promise<void> {
  const moveRef = async () => {
    if (local === tip) return;
    await git(root, ["update-ref", `refs/heads/${branch}`, tip, ...(local ? [local] : [])]).catch(async () => {
      const now = await gitTry(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
      throw new Error(`${branch} moved while the run was starting (now at ${now ? now.slice(0, 10) : "nothing"}); the run's worktree is at ${tip.slice(0, 10)} with nothing lost. Run this again`);
    });
  };
  // The worktree follows the tip even when the ref is already there: otherwise the reset after acquire moves it, unguarded.
  if (!earlier || !(await isWorktreeRoot(earlier))) return moveRef();
  const head = await git(earlier, ["rev-parse", "HEAD"]);
  const at = await gitTry(earlier, ["symbolic-ref", "--quiet", "HEAD"]);
  if (at === `refs/heads/${branch}`) {
    if (head !== tip) await git(earlier, ["merge", "--quiet", "--ff-only", "--no-overwrite-ignore", tip]).catch(refused(earlier, tip));
    return;
  }
  // Commits on a detached HEAD that no ref holds would be left behind by the checkout below.
  if (!at) {
    const stray = (await git(earlier, ["rev-list", "HEAD", "--not", "--branches", "--remotes"])).split("\n").filter(Boolean);
    if (stray.length) throw new Error(`The run's worktree ${earlier} holds ${stray.length} commit${stray.length === 1 ? "" : "s"} on no branch (${stray.slice(0, 3).map((c) => c.slice(0, 10)).join(", ")}${stray.length > 3 ? ", ..." : ""}); nothing has moved. Put ${stray.length === 1 ? "it" : "them"} on a branch there with git -C ${earlier} branch <name>, then run this again`);
  }
  if (head !== tip) await git(earlier, ["checkout", "--quiet", "--detach", "--no-overwrite-ignore", tip]).catch(refused(earlier, tip));
  await moveRef();
  await git(earlier, ["checkout", "--quiet", "--no-overwrite-ignore", branch]).catch((err) => {
    throw new Error(`Could not put the run's worktree ${earlier} on ${branch} (${gitWords(err)}); it is at ${tip.slice(0, 10)} with nothing lost. Free ${branch} where it is checked out (git worktree list names it), then run this again`);
  });
}

/** Git's whole message on one line: it names the files after its first line. */
const gitWords = (err: unknown) => String((err as { stderr?: string })?.stderr || (err instanceof Error ? err.message : err)).trim().split("\n").map((l) => l.trim()).filter(Boolean).join(" ");

/** The stop for a worktree move git refused. */
const refused = (worktree: string, tip: string) => (err: unknown): never => {
  throw new Error(`Could not bring the run's worktree ${worktree} to ${tip.slice(0, 10)} (${gitWords(err)}); nothing has moved. Move or remove the files git names there, then run this again`);
};

/** Whether `dir` is the root of a worktree: anywhere else git acts on the checkout that contains it. */
export async function isWorktreeRoot(dir: string): Promise<boolean> {
  const top = await gitTry(dir, ["rev-parse", "--show-toplevel"]);
  try {
    return !!top && fs.realpathSync(top) === fs.realpathSync(dir);
  } catch {
    return false;
  }
}

/** The worktrees that have this branch checked out. */
async function checkedOutAt(root: string, branch: string): Promise<string[]> {
  const out = await git(root, ["worktree", "list", "--porcelain"]);
  return out.split("\n\n").flatMap((block) => {
    const lines = block.split("\n");
    const at = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    return at && lines.includes(`branch refs/heads/${branch}`) ? [at] : [];
  });
}

/**
 * Stop a run whose named branch holds nothing the fetched default branch lacks: at run start that is a stale or
 * empty branch, never a change (one landed during a run is Land's to recognise, not this).
 */
export async function requireOwnCommits(root: string, branch: string, tip: string, upstream: Upstream): Promise<void> {
  if (await isAncestor(root, tip, upstream.sha)) {
    throw new Error(`${branch} holds no commit that ${upstream.ref} lacks (it is at ${tip.slice(0, 10)}): there is no change to run. If the work is on another machine, push it from there first`);
  }
}

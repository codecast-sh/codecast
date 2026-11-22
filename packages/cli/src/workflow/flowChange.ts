// How a session's change enters a flow (docs/architecture/flows.md FL4). A
// session in a shared checkout leaves its edits uncommitted beside everyone
// else's; the flow runs on a commit of exactly that session's files, made from
// the frozen tree the way `cast ship checkout` makes its commits, on a branch
// of its own, so nothing in the shared tree moves.
//
// Every file the session wrote goes in, including one another session also
// wrote after it (attribution is per file, so that file carries the other
// session's lines too, and the change says so). Dropping a file the session
// wrote would run the flow on part of its change, which is worse than carrying
// a neighbour's edit the change names.
import { buildCommits } from "../land/commitGroups.js";
import { defaultMessage, freezeAndAttribute, upstreamRef } from "../land/shipCheckout.js";
import type { SessionEdits } from "../land/attribute.js";
import { git } from "../wipSnapshot.js";
import type { FrozenChange } from "./flowChangeFile.js";
export { frozenChangeContext, writeFrozenChange, type FrozenChange } from "./flowChangeFile.js";

/** Whether `ref` (a codecast id, its 7-character short id, or the agent's own session id) names this session. */
export function sessionMatches(s: Pick<SessionEdits, "conversationId" | "sessionId">, ref: string): boolean {
  const r = ref.trim();
  if (!r) return false;
  if (s.sessionId === r) return true;
  const conv = s.conversationId ?? "";
  return !!conv && (conv === r || (r.length >= 7 && conv.startsWith(r)));
}

const idOf = (s: SessionEdits) => s.conversationId?.slice(0, 7) ?? s.sessionId.slice(0, 8);

/** Each path's last commit time on HEAD (ms); a path no commit holds is absent. */
async function lastCommitTimes(root: string, paths: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const p of paths) {
    const t = Number(await git(root, ["log", "-1", "--format=%ct", "HEAD", "--", p]).catch(() => ""));
    if (t) out.set(p, t * 1000);
  }
  return out;
}

/** What a session's change would hold, read from the frozen tree: its files, the ones another session also wrote, and the ones held out. */
export async function previewSessionChange(root: string, session: string, only?: ReadonlyArray<string> | null) {
  // Without an upstream, HEAD stands in: stale copies are still read from its history.
  const upstream = await upstreamRef(root).catch(() => "HEAD");
  const { frozen, attribution, credentials, stale } = await freezeAndAttribute(root, upstream);
  const heldWhy = (p: string) => credentials.get(p) ?? (stale.has(p) ? `a stale copy: ${stale.get(p)!.reason}` : undefined);
  const mine = attribution.sessions.find((s) => sessionMatches(s, session));
  if (!mine) throw new Error(`No uncommitted change in ${root} was written by session ${session}`);
  // A write is in a file's uncommitted diff only when it came after the file's last commit.
  const committedAt = await lastCommitTimes(root, frozen.changes.map((c) => c.path));
  const inDiff = (s: SessionEdits, p: string) => (s.edits.get(p) ?? 0) > (committedAt.get(p) ?? 0);
  // A session that changed more than this change names the files that belong to it (globs, repo-relative).
  const globs = (only ?? []).map((g) => new Bun.Glob(g));
  const wrote = frozen.changes.map((c) => c.path).filter((p) => inDiff(mine, p) && (!globs.length || globs.some((g) => g.match(p))));
  const held = wrote.filter((p) => heldWhy(p)).map((p) => ({ path: p, why: heldWhy(p)! }));
  const paths = wrote.filter((p) => !heldWhy(p)).sort();
  const shared = paths
    .map((p) => ({ path: p, also: attribution.sessions.filter((s) => s !== mine && inDiff(s, p)).map(idOf) }))
    .filter((s) => s.also.length);
  return { frozen, session: idOf(mine), conversation: mine.conversationId ?? null, agentSession: mine.sessionId, paths, shared, held };
}

/**
 * Commit the files `session` wrote, at their frozen content, on top of the
 * checkout's HEAD, and point `branch` at it. The shared tree, its index and
 * HEAD are untouched. Throws when the session wrote nothing that is changed.
 */
export async function freezeSessionChange(root: string, session: string, opts: { branch: string; worktree: string; title?: string | null; only?: ReadonlyArray<string> | null }): Promise<FrozenChange> {
  const { frozen, session: id, conversation, paths, shared, held } = await previewSessionChange(root, session, opts.only);
  if (!paths.length) throw new Error(`Session ${id} wrote nothing here that can go in a change${held.length ? ` (held: ${held.map((h) => `${h.path}, ${h.why}`).join("; ")})` : ""}`);
  const { tip } = await buildCommits(root, frozen, [{ message: defaultMessage(opts.title ?? null, paths), paths }]);
  await git(root, ["update-ref", `refs/heads/${opts.branch}`, tip]);
  return {
    source: "session", session: id, ...(conversation ? { conversation } : {}), base: frozen.base, tip, branch: opts.branch, worktree: opts.worktree, paths, shared, held,
    ...(opts.only?.length ? { only: [...opts.only] } : {}), ...(opts.title ? { title: opts.title } : {}),
  };
}

/** A branch here holds commits origin never had: moving it to origin's tip would drop them. */
export class UnpushedCommitsError extends Error {}

/**
 * Bring origin's `branch` into the local branch of that name. A plain `fetch origin +b:b` is refused while a worktree
 * has `b` checked out (the run's own worktree does), so the tip is fetched alone and the ref moved with update-ref.
 * Origin's copy may be rewritten (each refreeze of a session's change force-pushes it), so the local branch may move
 * anywhere origin has been; what it never does is drop commits that only exist here. Those are commits neither in
 * origin's tip now nor in the tip last fetched from it (kept in refs/remotes/origin/<branch>, as originTip keeps it),
 * and they refuse the move with UnpushedCommitsError.
 */
export async function fetchBranch(root: string, branch: string): Promise<string> {
  const ref = (name: string) => git(root, ["rev-parse", "--verify", "--quiet", name]).then((s) => s.trim()).catch(() => "");
  const within = (rev: string, of: string) => !!of && git(root, ["merge-base", "--is-ancestor", rev, of]).then(() => true, () => false);
  // Read before the fetch: a clone's default refspec makes `fetch origin <ref>` move refs/remotes/origin/<branch> too.
  const fetched = await ref(`refs/remotes/origin/${branch}`);
  await git(root, ["fetch", "--quiet", "origin", `refs/heads/${branch}`]);
  const tip = (await git(root, ["rev-parse", "FETCH_HEAD"])).trim();
  const local = await ref(`refs/heads/${branch}`);
  if (local && local !== tip && !(await within(local, tip)) && !(await within(local, fetched))) {
    throw new UnpushedCommitsError(`${branch} here has commits origin does not (its tip ${local.slice(0, 10)}): moving it to origin's ${tip.slice(0, 10)} would drop them. Push them (git push origin ${branch}) or set them aside on another branch, then run this again`);
  }
  await git(root, ["update-ref", `refs/heads/${branch}`, tip]);
  await git(root, ["update-ref", `refs/remotes/origin/${branch}`, tip]);
  return tip;
}

/** Origin's tip of `branch`, fetched now; empty when origin has no such branch or cannot be reached. */
export async function originTip(root: string, branch: string): Promise<string> {
  const remoteRef = `refs/remotes/origin/${branch}`;
  await git(root, ["fetch", "--quiet", "origin", `+${branch}:${remoteRef}`]).catch(() => "");
  return git(root, ["rev-parse", "--verify", "--quiet", remoteRef]).catch(() => "");
}

/**
 * Where a named branch stands now, against what the run last froze. The session fixing it may be on another machine
 * (a run started over ssh), where its commit reaches this checkout only through origin. The run's worktree holds no
 * work of its own, so the side that moved since the freeze holds the fix: this checkout's branch off the frozen tip
 * first, else origin's off the tip it had then (`remote_tip`), rebased or force-pushed included.
 */
async function branchTip(root: string, change: FrozenChange): Promise<{ tip: string; remote_tip?: string }> {
  const [local, remote] = await Promise.all([
    git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${change.branch}`]).catch(() => ""),
    originTip(root, change.branch),
  ]);
  const pushed = !!remote && remote !== (change.remote_tip ?? "") && remote !== change.tip;
  const tip = local && local !== change.tip ? local : pushed ? remote : local || change.tip;
  return { tip, ...(remote ? { remote_tip: remote } : {}) };
}

/**
 * Freeze a session's change again, after the session worked on what a stage
 * found (flows.md FL4): the same files cut the same way, on the same branch, so
 * the run's worktree follows the new tip and every later stage reads the change
 * as it stands now. Returns the new change and whether anything moved.
 */
export async function refreezeSessionChange(root: string, runDir: string, worktreePath: string | null): Promise<{ change: FrozenChange; moved: boolean }> {
  const { readFrozenChange, writeFrozenChange } = await import("./flowChangeFile.js");
  const before = readFrozenChange(runDir);
  if (!before?.session) throw new Error("The run's change did not come from a session, so there is no session's change to freeze again");
  // A named branch or pull request is the change: the session fixes it by committing there (a pull request's by pushing).
  const change: FrozenChange = before.source === "session" && !before.pushed
    ? await freezeSessionChange(root, before.conversation ?? before.session, { branch: before.branch, worktree: before.worktree, title: before.title ?? null, only: before.only ?? null })
    : { ...before, ...(await branchTip(root, before)) };
  const tree = (rev: string) => git(root, ["rev-parse", `${rev}^{tree}`]).then((s) => s.trim()).catch(() => rev);
  const moved = (await tree(before.tip)) !== (await tree(change.tip));
  // The run's worktree holds no work of its own: it is the change, so it follows the new tip.
  if (worktreePath) await git(worktreePath, ["reset", "--quiet", "--hard", change.tip]);
  writeFrozenChange(runDir, change);
  return { change, moved };
}

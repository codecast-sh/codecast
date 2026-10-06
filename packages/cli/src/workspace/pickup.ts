/**
 * `cast ws acquire <name> --from <session>`: pick up a teammate's working tree.
 *
 * The daemon on the session's machine publishes the checkout's real tree to a
 * hidden ref on the repo's remote (wipSnapshot.ts, sweepWipSnapshots). Picking
 * it up is three steps: resolve the session to its conversation and repository,
 * fetch its ref from this checkout's remote, and hand the snapshot to acquire as
 * a start point. Acquire already turns a snapshot start point into a branch at
 * the snapshot's parent with the snapshot's tree as uncommitted work, so this
 * module only resolves and checks; it never touches a worktree itself.
 *
 * Snapshot commits pin their dates to the base commit's (so siblings produce
 * one object), which means a snapshot cannot say when it was taken. What we can
 * say honestly is the base commit's date and when the session was last active.
 */

import { repositoryKeyOfRemote } from "@codecast/shared/contracts";
import { cliFetchRead } from "../cliHttp.js";
import { BRANCH_TRAILER, defaultRemote, git, parseSnapshotTrailer, wipRef } from "../wipSnapshot.js";

/** Past this much session idleness the pickup warns: the tree is as it stood then. */
export const PICKUP_STALE_HOURS = 24;

export interface PickupConversation {
  /** Full conversation id: the wip ref is named by it. */
  id: string;
  title?: string;
  /** The session's recorded origin, when its daemon stamped one. */
  remoteUrl: string | null;
  /** ISO time of the session's last activity. */
  updatedAt?: string;
}

export interface PickupSnapshot {
  /** Local ref the snapshot was fetched into: acquire's start point. */
  ref: string;
  sha: string;
  /** The session's HEAD when the snapshot was taken. */
  base: string;
  /** The session's branch ("HEAD" when it was detached). */
  branch: string;
  /** Files the snapshot changes against its base (edits, adds, deletes, untracked). */
  files: number;
  /** ISO commit date of the base commit. */
  baseDate: string;
  /** Warnings that do not stop the pickup. */
  warnings: string[];
}

/** A pickup that cannot proceed; the message is what the person reads. */
export class PickupError extends Error {}

function stderrOf(e: unknown): string {
  const err = e as { stderr?: string | Buffer; message?: string };
  return (err.stderr?.toString().trim().split("\n").pop() || err.message || String(e)).slice(0, 300);
}

/**
 * The conversation a session reference names (full id, short id, or session
 * id), through the same read the CLI's export uses: it resolves short ids and
 * applies the owner-or-team access rule server-side.
 */
export async function fetchPickupConversation(
  ref: string,
  auth: { convexUrl: string; authToken: string },
): Promise<PickupConversation> {
  const siteUrl = auth.convexUrl.replace(".cloud", ".site");
  const resp = await cliFetchRead(`${siteUrl}/cli/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: auth.authToken, conversation_id: ref, limit: 1 }),
  });
  const data = (await resp.json().catch(() => ({}))) as {
    error?: string;
    conversation?: { id: string; title?: string; git_remote_url?: string | null; updated_at?: string };
  };
  if (data.error === "Conversation not found") throw new PickupError(`no session ${ref} found`);
  if (data.error === "Access denied") throw new PickupError(`session ${ref} is not shared with you; ask its owner to share it or pass it to you`);
  if (data.error === "Unauthorized") throw new PickupError("not signed in; run: cast auth");
  if (data.error || !data.conversation) throw new PickupError(`could not read session ${ref}: ${data.error ?? `HTTP ${resp.status}`}`);
  const c = data.conversation;
  return { id: c.id, title: c.title, remoteUrl: c.git_remote_url ?? null, updatedAt: c.updated_at };
}

/**
 * Check the session belongs to this checkout's repository, fetch its snapshot
 * from the remote into a local ref, and describe it. Throws PickupError with
 * the reason when there is nothing to pick up.
 */
export async function preparePickup(
  repoRoot: string,
  conversation: PickupConversation,
  opts: { remote?: string; now?: number } = {},
): Promise<PickupSnapshot> {
  const remote = opts.remote ?? (await defaultRemote(repoRoot));
  if (!remote) throw new PickupError("this checkout has no remote to fetch the snapshot from");
  const localUrl = await git(repoRoot, ["remote", "get-url", remote]).catch(() => "");
  const warnings: string[] = [];

  const theirs = repositoryKeyOfRemote(conversation.remoteUrl);
  const ours = repositoryKeyOfRemote(localUrl);
  if (theirs && ours && theirs !== ours) {
    throw new PickupError(`session ${conversation.id.slice(0, 7)} ran in ${theirs}, but this checkout is ${ours}; run this from a checkout of ${theirs}`);
  }
  if (!theirs) warnings.push(`the session recorded no repository; trying ${remote} anyway`);

  const ref = wipRef(conversation.id);
  try {
    await git(repoRoot, ["fetch", "--quiet", "--force", "--no-tags", remote, `+${ref}:${ref}`]);
  } catch (e) {
    const listed = await git(repoRoot, ["ls-remote", remote, ref]).catch(() => null);
    if (listed === "") {
      throw new PickupError(
        `no snapshot of session ${conversation.id.slice(0, 7)} on ${remote}. The daemon on the session's machine publishes one every few minutes while it runs; ` +
          `check that machine is online and on a current cast, and that it can push to ${remote}`,
      );
    }
    throw new PickupError(`could not fetch ${ref} from ${remote}: ${stderrOf(e)}`);
  }

  const sha = await git(repoRoot, ["rev-parse", ref]);
  const message = await git(repoRoot, ["show", "-s", "--format=%B", sha]);
  const branch = parseSnapshotTrailer(message, BRANCH_TRAILER);
  const base = await git(repoRoot, ["rev-parse", `${sha}^`]).catch(() => "");
  if (!branch || !base) throw new PickupError(`${ref} on ${remote} is not a codecast snapshot`);
  const files = (await git(repoRoot, ["diff", "--name-only", "--no-renames", base, sha])).split("\n").filter(Boolean).length;
  const baseDate = await git(repoRoot, ["show", "-s", "--format=%cI", base]);

  if (conversation.updatedAt) {
    const idleHours = ((opts.now ?? Date.now()) - Date.parse(conversation.updatedAt)) / 3_600_000;
    if (idleHours > PICKUP_STALE_HOURS) {
      warnings.push(`the session has been idle ${Math.floor(idleHours)} hours; this is its tree as it stood then`);
    }
  }
  return { ref, sha, base, branch, files, baseDate, warnings };
}

/**
 * The branch to create for a pickup and the fallback when it is taken. The
 * session's own branch is the natural name, but it usually exists here already
 * (main, or a branch this person has too), and acquire never resets an existing
 * branch, so the fallback names the session.
 */
export function pickupBranches(snapshot: Pick<PickupSnapshot, "branch">, conversationId: string, override?: string): { branch: string; altBranch?: string } {
  const short = conversationId.slice(0, 7);
  if (override) return { branch: override };
  if (snapshot.branch === "HEAD") return { branch: `codecast/pickup-${short}` };
  return { branch: snapshot.branch, altBranch: `${snapshot.branch}-pickup-${short}` };
}

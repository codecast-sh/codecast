/**
 * `cast ws acquire <name> --rewind <session>[@<line>]`: a worktree holding the
 * files as they stood at a point in a session's conversation.
 *
 * Every turn end the daemon snapshots the checkout's tree (treeSnapshot.ts)
 * and records which snapshot closes which turn (treeSnapshots table). So the
 * tree "at message N" is the newest snapshot taken at or before that message
 * (turns.ts snapshotAtLine), and a worktree seeded from it is the session's
 * branch at that snapshot's base commit with the snapshot's files as
 * uncommitted work, which is exactly what acquire's start point does for a
 * snapshot commit. A fork from the same line then continues the conversation
 * from that tree: a rewind of both.
 *
 * Reuses the pickup resolver for the session lookup, repository check and the
 * fetch of the wip ref (the chain of snapshots travels with its tip).
 */

import { cliFetchRead } from "../cliHttp.js";
import { fetchTurnSnapshots } from "../turnsCommand.js";
import { snapshotAtLine, snapshotMoment, type TurnMessage, type TurnSnapshotRow } from "../turns.js";
import { gitTry, wipRef } from "../wipSnapshot.js";
import { fetchPickupConversation, PickupError, preparePickup, type PickupConversation } from "./pickup.js";

export interface ResolvedRewind {
  conversation: PickupConversation;
  snapshot: TurnSnapshotRow;
  /** 1-based transcript line the tree stood at, when one was named. */
  line?: number;
  /** The local ref or sha acquire starts from. */
  startPoint: string;
  branch: string;
  altBranch?: string;
  warnings: string[];
}

/** `<session>` or `<session>@<line>`. */
export function parseRewindRef(ref: string): { session: string; line?: number } {
  const m = ref.match(/^(.+?)@(\d+)$/);
  if (!m) return { session: ref };
  return { session: m[1], line: Number(m[2]) };
}

async function fetchMessages(conversationId: string, auth: { convexUrl: string; authToken: string }, upTo: number): Promise<TurnMessage[]> {
  const siteUrl = auth.convexUrl.replace(".cloud", ".site");
  const resp = await cliFetchRead(`${siteUrl}/cli/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: auth.authToken, conversation_id: conversationId, start_line: 1, end_line: upTo }),
  });
  const data = (await resp.json().catch(() => ({}))) as { error?: string; messages?: TurnMessage[] };
  if (data.error) throw new PickupError(`could not read the session's messages: ${data.error}`);
  return data.messages ?? [];
}

export async function resolveRewind(
  repoRoot: string,
  ref: string,
  auth: { convexUrl: string; authToken: string },
  branchOverride?: string,
): Promise<ResolvedRewind> {
  const { session, line } = parseRewindRef(ref);
  const conversation = await fetchPickupConversation(session, auth);
  const rows = await fetchTurnSnapshots(conversation.id);
  if (!rows.length) {
    throw new PickupError(
      `session ${conversation.id.slice(0, 7)} has no turn snapshots. The daemon on its machine records one at the end of every turn (cast 1.1.144 and later); an older session has only the tree its sweep last pushed, which --from picks up.`,
    );
  }
  let snapshot: TurnSnapshotRow | null;
  const warnings: string[] = [];
  if (line !== undefined) {
    const messages = await fetchMessages(conversation.id, auth, line);
    if (messages.length < line) throw new PickupError(`the session has ${messages.length} messages; there is no line ${line}`);
    snapshot = snapshotAtLine(rows, messages, line);
    if (!snapshot) {
      throw new PickupError(
        `no snapshot had been taken by message ${line} (the first is from ${new Date(snapshotMoment(rows[0])).toLocaleString()}); pick a later line, or --from for the session's current tree`,
      );
    }
  } else {
    snapshot = rows[rows.length - 1];
  }

  // Objects: here when this machine took them, else on the wip ref. The
  // pickup fetch brings the chain tip and everything behind it.
  if ((await gitTry(repoRoot, ["cat-file", "-e", `${snapshot.sha}^{commit}`])) === null) {
    const prepared = await preparePickup(repoRoot, conversation);
    warnings.push(...prepared.warnings);
    if ((await gitTry(repoRoot, ["cat-file", "-e", `${snapshot.sha}^{commit}`])) === null) {
      throw new PickupError(
        `snapshot ${snapshot.sha.slice(0, 10)} is not on ${wipRef(conversation.id)}: the session's daemon has pushed a newer chain that no longer reaches it, or has not pushed since. Its machine pushes every few minutes while the session runs.`,
      );
    }
  }
  const short = conversation.id.slice(0, 7);
  const base = snapshot.branch && snapshot.branch !== "HEAD" ? snapshot.branch : `codecast/rewind-${short}`;
  const suffix = line !== undefined ? `-at-${line}` : "";
  const branch = branchOverride ?? `${base}-rewind-${short}${suffix}`;
  return { conversation, snapshot, line, startPoint: snapshot.sha, branch, altBranch: branchOverride ? undefined : `${branch}-${Date.now().toString(36)}`, warnings };
}

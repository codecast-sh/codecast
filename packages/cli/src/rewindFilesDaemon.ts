/**
 * The daemon's side of the `rewind_files` command (contracts/rewindFiles.ts):
 * what it reads from the server for a rewind (the session's snapshot rows and
 * edit records), runs (rewindFilesCommand.ts) and reports back (the staged
 * mark on the conversation row, which every window's Put back chip reads).
 * The daemon hands in only what it alone knows: where the session's checkout
 * is, whether an agent is working there, and when the session's last turn ended.
 */

import { REWIND_ROWS_CAP, type RewindFilesArgs, type RewindFilesReply } from "@codecast/shared/contracts";
import { hashPath } from "./hash.js";
import { deviceId } from "./remote/device.js";
import { runRewindFilesCommand } from "./rewindFilesCommand.js";
import { readStaged } from "./rewindTree.js";
import { fetchTurnSnapshots } from "./turnsCommand.js";

export type RewindDaemonDeps = {
  /** The session's checkout and working folder; null when this machine does not have its folder. */
  checkout: { root: string; cwd: string } | null;
  /** An agent is mid-turn in this checkout (asked again right before files are written). */
  busy: () => Promise<boolean>;
  /** When the session's last turn ended (ms), from the daemon's own record. */
  lastTurnEnd?: number;
  snapshotsOff: boolean;
  /** Take and record the last turn's snapshot now, for one that never landed. */
  recordLastTurn?: () => Promise<void>;
  /** Snapshot the checkout without recording a row: advances the chain head after files moved. */
  advanceChain: () => Promise<void>;
  log: (line: string) => void;
};

async function server() {
  const { convexClient } = await import("./remote/convexClient.js");
  return convexClient({ timeoutMs: 20_000 });
}

/** Files the session's own tool calls changed after `after`; null on a backend without the query. */
async function editedPaths(conversationId: string, after: number) {
  const { client, token } = await server();
  try {
    return await client.query("treeSnapshots:editedPaths", { api_token: token, conversation_id: conversationId, after });
  } catch (e) {
    // Only a backend without the query is "cannot say"; any other failure is the rewind's to report.
    if (/Could not find public function/i.test(String((e as Error)?.message ?? e))) return null;
    throw e;
  }
}

type Mark = { id: string; files: number; staged_at: number; at: number } | null;

/** The staged mark on the conversation row. The device rides along: only the machine that holds a rewind may clear it. */
async function report(conversationId: string, staged: Mark, clearId?: string): Promise<boolean> {
  try {
    const { client, token } = await server();
    await client.mutation("treeSnapshots:reportRewindStaged", { api_token: token, device_id: deviceId(), conversation_id: conversationId, staged, ...(clearId ? { clear_id: clearId } : {}) });
    return true;
  } catch {
    return false;
  }
}

// Checkouts whose mark is being re-sent after a failed report.
const retrying = new Set<string>();

/** Report, and on failure keep trying in the background (one loop per checkout, reporting what is staged at each try). */
async function reportOrRetry(root: string, conversationId: string, staged: Mark, clearId: string | undefined, log: (l: string) => void) {
  if (await report(conversationId, staged, clearId)) return;
  if (retrying.has(root)) return;
  log(`[REWIND-FILES] could not report the staged rewind for ${conversationId.slice(0, 12)}; retrying in the background`);
  retrying.add(root);
  void (async () => {
    try {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 30_000));
        const now = await readStaged(root).catch(() => null);
        if (await report(now?.conversation_id ?? conversationId, now ? { id: now.id, files: now.files.length, staged_at: now.staged_at, at: now.at } : null, now ? undefined : clearId)) return;
      }
    } finally {
      retrying.delete(root);
    }
  })();
}

export async function runRewindFilesForDaemon(args: RewindFilesArgs, deps: RewindDaemonDeps): Promise<{ result?: string; error?: string }> {
  const conversationId = args.conversation_id;
  if (!deps.checkout) {
    // The folder is gone (a removed worktree): a rewind staged in it went with it. Settling it
    // clears the mark, or the Put back chip would stay with nothing to act on.
    if ((args.op === "put_back" || args.op === "keep") && args.staged_id) {
      await report(conversationId, null, args.staged_id);
      return { result: JSON.stringify({ op: args.op, refused: "the session's folder is gone from this machine, and its rewind with it", staged: null }) };
    }
    return { error: "This machine does not have the session's folder" };
  }
  const { root, cwd } = deps.checkout;
  let reply: RewindFilesReply;
  try {
    reply = await runRewindFilesCommand(args, {
      root,
      cwd,
      busy: await deps.busy(),
      busyNow: deps.busy,
      lastTurnEnd: deps.lastTurnEnd,
      snapshotsOff: deps.snapshotsOff,
      recordLastTurn: deps.recordLastTurn,
      rows: async () => {
        const all = await fetchTurnSnapshots(conversationId);
        // The server caps turn rows and prompt rows separately.
        const truncated = all.filter((r) => r.source !== "prompt").length >= REWIND_ROWS_CAP || all.filter((r) => r.source === "prompt").length >= REWIND_ROWS_CAP;
        // Only this checkout's rows: worktrees share an object store, so another worktree's snapshots would resolve here too.
        const key = hashPath(root);
        return { rows: all.filter((r) => !r.checkout_key || r.checkout_key === key), truncated };
      },
      edited: (after) => editedPaths(conversationId, after),
    });
  } catch (err) {
    return { error: `Rewind failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
  deps.log(`[REWIND-FILES] ${conversationId.slice(0, 12)} ${args.op}${reply.refused ? ` refused: ${reply.refused}` : reply.counts ? ` ${reply.counts.total} files` : ""}`);
  // The files moved under the snapshot chain: advance its head, so the next
  // turn's link (the fork's first) starts from the tree as it is now.
  if (args.op === "stage" || args.op === "put_back") await deps.advanceChain().catch(() => {});
  if (reply.staged !== undefined) {
    const s = reply.staged;
    const mark = s ? { id: s.id, files: s.count, staged_at: s.staged_at, at: s.at } : null;
    // A clear names the rewind it ended or found gone; a plan that merely found nothing staged here clears nothing.
    const clearId = mark ? undefined : reply.cleared_id;
    if (mark || clearId) await reportOrRetry(root, reply.staged_conversation_id ?? conversationId, mark, clearId, deps.log);
  }
  return { result: JSON.stringify(reply) };
}

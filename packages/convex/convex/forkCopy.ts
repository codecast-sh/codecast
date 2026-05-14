// Chained fork copy — the per-batch logic.
//
// Split out from conversations.ts so it can be unit-tested without dragging
// in Convex's generated module graph. The real mutation wires up a Convex
// MutationCtx and the scheduler; the test supplies an in-memory mock and
// runs the chain manually.
//
// Invariants enforced here:
//   - Cursor (`fork_copy_cursor`) is strictly monotonic. Each batch queries
//     `timestamp > cursor`, so a retried batch can never double-insert.
//   - `message_count` and `fork_copied` are patched in the same transaction
//     as the inserts they describe.
//   - The daemon command is emitted at most once per fork: emit clears
//     `fork_daemon_args`, and subsequent runs find it undefined.
//   - A batch never exceeds `FORK_BATCH_DOCS` documents OR
//     `FORK_BATCH_MAX_BYTES` of message body bytes (whichever hits first),
//     so it stays under Convex's per-transaction limits.

export const FORK_BATCH_DOCS = 500;
export const FORK_BATCH_MAX_BYTES = 8 * 1024 * 1024;

export type ForkMessage = {
  message_uuid?: string;
  role: string;
  content?: string;
  thinking?: string;
  tool_calls?: unknown;
  tool_results?: unknown;
  images?: unknown;
  subtype?: string;
  timestamp: number;
  tokens_used?: unknown;
  usage?: unknown;
};

export type ForkConvRow = {
  _id: string;
  user_id: string;
  forked_from?: string;
  parent_conversation_id?: string;
  fork_status?: "copying" | "complete" | "failed";
  fork_copy_cursor?: number;
  fork_copied?: number;
  fork_cutoff_timestamp?: number;
  fork_daemon_args?: string;
};

// Minimal ctx shape needed by advanceForkCopy. The real Convex MutationCtx
// is a superset; the test supplies an in-memory implementation.
export type ForkCopyCtx = {
  db: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get(id: any): Promise<any>;
    queryMessages(opts: {
      conversationId: string;
      cursorGt: number;
      cutoffLte?: number;
      limit: number;
    }): Promise<ForkMessage[]>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insertMessage(row: any): Promise<string>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insertDaemonCommand(row: any): Promise<string>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    patchConv(id: string, patch: Record<string, any>): Promise<void>;
  };
  scheduleContinue(forkId: string): Promise<void>;
};

export function estimateMsgBytes(m: {
  content?: string;
  thinking?: string;
  tool_calls?: unknown;
  tool_results?: unknown;
  images?: unknown;
}): number {
  return (
    (m.content?.length ?? 0) +
    (m.thinking?.length ?? 0) +
    (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0) +
    (m.tool_results ? JSON.stringify(m.tool_results).length : 0) +
    (m.images ? JSON.stringify(m.images).length : 0) +
    256
  );
}

async function emitForkDaemonCommand(ctx: ForkCopyCtx, fork: ForkConvRow): Promise<void> {
  if (!fork.fork_daemon_args) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fork.fork_daemon_args);
  } catch {
    return;
  }
  await ctx.db.insertDaemonCommand({
    user_id: fork.user_id,
    command: "resume_session",
    args: JSON.stringify(parsed),
    created_at: Date.now(),
  });
  await ctx.db.patchConv(fork._id, { fork_daemon_args: undefined });
}

export async function advanceForkCopy(
  ctx: ForkCopyCtx,
  forkId: string,
): Promise<{ done: boolean; copied: number }> {
  const fork = (await ctx.db.get(forkId)) as ForkConvRow | null;
  if (!fork || fork.fork_status !== "copying") {
    return { done: true, copied: 0 };
  }
  const sourceId = fork.forked_from ?? fork.parent_conversation_id;
  if (!sourceId) {
    await ctx.db.patchConv(forkId, { fork_status: "failed" });
    return { done: true, copied: 0 };
  }

  const cursor = fork.fork_copy_cursor ?? 0;
  const cutoff = fork.fork_cutoff_timestamp;

  const batch = await ctx.db.queryMessages({
    conversationId: sourceId,
    cursorGt: cursor,
    cutoffLte: cutoff,
    limit: FORK_BATCH_DOCS,
  });

  if (batch.length === 0) {
    await ctx.db.patchConv(forkId, {
      fork_status: "complete",
      message_count: fork.fork_copied ?? 0,
    });
    await emitForkDaemonCommand(ctx, fork);
    return { done: true, copied: 0 };
  }

  let copied = 0;
  let bytes = 0;
  let lastTs = cursor;
  for (const msg of batch) {
    const sz = estimateMsgBytes(msg);
    // First message always goes regardless of size, so we make progress even
    // if a single message body somehow exceeds the per-batch byte cap.
    if (copied > 0 && bytes + sz > FORK_BATCH_MAX_BYTES) break;
    await ctx.db.insertMessage({
      conversation_id: forkId,
      message_uuid: msg.message_uuid,
      role: msg.role,
      content: msg.content,
      thinking: msg.thinking,
      tool_calls: msg.tool_calls,
      tool_results: msg.tool_results,
      images: msg.images,
      subtype: msg.subtype,
      timestamp: msg.timestamp,
      tokens_used: msg.tokens_used,
      usage: msg.usage,
    });
    copied++;
    bytes += sz;
    lastTs = msg.timestamp;
  }

  const newCopied = (fork.fork_copied ?? 0) + copied;
  await ctx.db.patchConv(forkId, {
    fork_copy_cursor: lastTs,
    fork_copied: newCopied,
    message_count: newCopied,
  });

  const moreExpected = copied < batch.length || batch.length === FORK_BATCH_DOCS;
  if (moreExpected) {
    await ctx.scheduleContinue(forkId);
    return { done: false, copied };
  }

  await ctx.db.patchConv(forkId, { fork_status: "complete" });
  await emitForkDaemonCommand(ctx, { ...fork, fork_copied: newCopied });
  return { done: true, copied };
}

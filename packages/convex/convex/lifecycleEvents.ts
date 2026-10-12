// The durable trail of what happened to a session, and who did it.
//
// Convex function logs reach back minutes and the sync log keeps one coalesced
// row per conversation, so a session killed 24 seconds after creation
// (jx7970z, 2026-10-06) left no record of which mutation dismissed it. This
// layer wraps ctx.db for every mutation built from ./functions and writes one
// `conversation_events` row whenever a write CHANGES a lifecycle fact:
//   - a conversation's status, hide stamps, snooze or session_error,
//   - a conversation or managed session deleted,
//   - a pending message ending cancelled, failed or undeliverable.
// Re-asserting a value that is already set writes nothing.
//
// Who asked: a mutation names its surface with noteWriteCause(ctx, "...")
// (dispatch names `web:<action>`, the CLI routes `cli:<verb>`, crons
// `cron:<name>`). A write with no cause keeps the top of its stack instead,
// which names the writing function.

const LIFECYCLE_FIELDS = [
  "status",
  "inbox_dismissed_at",
  "inbox_killed_at",
  "inbox_stashed_at",
  "inbox_snoozed_until",
  "session_error",
] as const;
const TERMINAL_PENDING = new Set(["cancelled", "failed", "undeliverable"]);
const CAUSE = Symbol.for("codecast.writeCause");
const MAX_VALUE = 160;

/** Name who is writing, for every lifecycle event this mutation records from here on. */
export function noteWriteCause(ctx: { db: any }, cause: string): void {
  if (ctx?.db && typeof ctx.db === "object" && CAUSE in ctx.db) ctx.db[CAUSE] = cause;
}

function short(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
}

function writerStack(): string {
  return (new Error().stack ?? "")
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => !/(lifecycleEvents|changeLog|principalViewRevisions|functions)\.(ts|js)/.test(line))
    .slice(0, 4)
    .join(" | ");
}

export function makeLifecycleEventDb(db: any, rawDb: any): any {
  if (typeof rawDb?.normalizeId !== "function") return db;
  const tableOf = (id: any, table: string) => !!rawDb.normalizeId(table, String(id));

  const record = async (row: {
    conversation_id: string;
    kind: string;
    changes: Record<string, [string | null, string | null]>;
  }) => {
    const cause: string | undefined = wrapper[CAUSE];
    await rawDb.insert("conversation_events", {
      ...row,
      ts: Date.now(),
      ...(cause ? { cause } : { stack: writerStack() }),
    });
  };

  const conversationChanges = (pre: any, next: any, replace: boolean) => {
    const changes: Record<string, [string | null, string | null]> = {};
    for (const field of LIFECYCLE_FIELDS) {
      if (!replace && !(field in next)) continue;
      const before = short(pre?.[field]);
      const after = short(next[field]);
      if (before !== after) changes[field] = [before, after];
    }
    return changes;
  };

  const wrapper: any = {
    ...db,
    [CAUSE]: undefined as string | undefined,
    get: (...args: any[]) => db.get(...args),
    query: (...args: any[]) => db.query(...args),
    normalizeId: (...args: any[]) => db.normalizeId(...args),
    insert: (...args: any[]) => db.insert(...args),
    system: db.system,

    async patch(id: any, fields: any) {
      if (tableOf(id, "conversations") && LIFECYCLE_FIELDS.some((f) => f in fields)) {
        const pre = await db.get(id);
        const res = await db.patch(id, fields);
        const changes = conversationChanges(pre, fields, false);
        if (Object.keys(changes).length) await record({ conversation_id: String(id), kind: "lifecycle", changes });
        return res;
      }
      if (tableOf(id, "pending_messages") && TERMINAL_PENDING.has(fields?.status)) {
        const pre = await db.get(id);
        const res = await db.patch(id, fields);
        if (pre && pre.status !== fields.status && pre.conversation_id) {
          await record({
            conversation_id: String(pre.conversation_id),
            kind: `message_${fields.status}`,
            changes: { message: [String(id), short(pre.status)], status: [short(pre.status), fields.status] },
          });
        }
        return res;
      }
      return db.patch(id, fields);
    },

    async replace(id: any, doc: any) {
      if (!tableOf(id, "conversations")) return db.replace(id, doc);
      const pre = await db.get(id);
      const res = await db.replace(id, doc);
      const changes = conversationChanges(pre, doc ?? {}, true);
      if (Object.keys(changes).length) await record({ conversation_id: String(id), kind: "lifecycle", changes });
      return res;
    },

    async delete(id: any) {
      const conversation = tableOf(id, "conversations");
      const managed = !conversation && tableOf(id, "managed_sessions");
      if (!conversation && !managed) return db.delete(id);
      const pre = await db.get(id);
      const res = await db.delete(id);
      if (conversation) {
        await record({ conversation_id: String(id), kind: "deleted", changes: { status: [short(pre?.status), null] } });
      } else if (pre?.conversation_id) {
        await record({
          conversation_id: String(pre.conversation_id),
          kind: "managed_session_deleted",
          changes: { session_id: [short(pre.session_id), null] },
        });
      }
      return res;
    },
  };
  return wrapper;
}

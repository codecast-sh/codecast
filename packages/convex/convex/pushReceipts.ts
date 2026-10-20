// Expo push receipts. A push ticket only says Expo accepted the message; the
// outcome at Apple or Google arrives later as a receipt, and that is where a
// broken credential shows (InvalidCredentials when the APNs key Expo signs
// with is revoked). Codecast once ran for two weeks on a deleted APNs key with
// every ticket "ok", so every accepted ticket is kept here until a sweep reads
// its receipt: a dead token is cleared, and any other failure is reported to
// codecast's own external data as an error group, which promotes to the line
// the first time it appears and again whenever it regresses.
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256Hex } from "./lib/hash";

/** Expo keeps receipts for a day and suggests reading them after about 15 minutes. */
export const RECEIPT_READY_MS = 15 * 60_000;
export const RECEIPT_EXPIRES_MS = 24 * 3600_000;
/** Expo's limit on ids per getReceipts call. */
const RECEIPT_BATCH = 1000;

export type Ticket = { _id: Id<"push_tickets">; ticket_id: string; push_token: string; user_id?: Id<"users">; sent_at: number };
export type ExpoPushResult = { status: "ok" | "error"; message?: string; details?: { error?: string } };
export type PushFailure = { code: string; count: number; sample: string };

/**
 * What a sweep does with its tickets: which rows are settled, which tokens are
 * dead, and the failures by error code. A ticket with no receipt yet stays
 * unless Expo has already dropped it.
 */
export function settleReceipts(tickets: Ticket[], receipts: Record<string, ExpoPushResult>, now: number) {
  const settled: Id<"push_tickets">[] = [];
  const dead: { user_id: Id<"users">; push_token: string }[] = [];
  const failures = new Map<string, PushFailure>();
  for (const t of tickets) {
    const r = receipts[t.ticket_id];
    if (!r) {
      if (now - t.sent_at > RECEIPT_EXPIRES_MS) settled.push(t._id);
      continue;
    }
    settled.push(t._id);
    if (r.status !== "error") continue;
    const code = r.details?.error ?? "Unknown";
    if (code === "DeviceNotRegistered") {
      if (t.user_id) dead.push({ user_id: t.user_id, push_token: t.push_token });
      continue;
    }
    const f = failures.get(code) ?? { code, count: 0, sample: r.message ?? code };
    f.count++;
    failures.set(code, f);
  }
  return { settled, dead, failures: [...failures.values()] };
}

export const recordTicket = internalMutation({
  args: { ticket_id: v.string(), push_token: v.string(), user_id: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    await ctx.db.insert("push_tickets", { ...args, sent_at: Date.now() });
  },
});

export const readyTickets = internalQuery({
  args: { before: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("push_tickets")
      .withIndex("by_sent_at", (q) => q.lt("sent_at", args.before))
      .take(args.limit);
  },
});

export const settle = internalMutation({
  args: {
    ids: v.array(v.id("push_tickets")),
    dead: v.array(v.object({ user_id: v.id("users"), push_token: v.string() })),
  },
  handler: async (ctx, args) => {
    for (const id of args.ids) if (await ctx.db.get(id)) await ctx.db.delete(id);
    for (const d of args.dead) await clearPushTokenIfCurrent(ctx, d.user_id, d.push_token);
  },
});

/** Clears a dead token only if the user still carries it, so a re-registration that raced the ticket survives. */
export async function clearPushTokenIfCurrent(ctx: { db: any }, userId: Id<"users">, pushToken: string) {
  const user = await ctx.db.get(userId);
  if (user?.push_token === pushToken) await ctx.db.patch(userId, { push_token: undefined });
}

/**
 * Files push failures as error groups in codecast's own backend source, keyed
 * by error code. The source is the one whose ingest key sits in
 * CODECAST_BACKEND_INGEST_KEY; without it the failure only reaches the log.
 */
export async function reportPushFailures(ctx: { runQuery: any; runMutation: any }, failures: PushFailure[]) {
  if (!failures.length) return;
  for (const f of failures) console.error(`expo push failing: ${f.code} x${f.count}: ${f.sample}`);
  const key = process.env.CODECAST_BACKEND_INGEST_KEY;
  if (!key) return;
  const source = await ctx.runQuery(internal.ingest.sourceForKey, { key_hash: await sha256Hex(key) });
  if (!source || "retry_after_ms" in source) return;
  const at = Date.now();
  await ctx.runMutation(internal.ingest.applyBatch, {
    source_id: source._id,
    environment: "production",
    items_json: JSON.stringify(
      failures.map((f) => ({
        type: "error",
        level: "error",
        message: `Push notifications failing: ${f.code}`,
        fingerprint: `expo-push:${f.code}`,
        tags: { channel: "expo-push", code: f.code },
        context: { failed: f.count, sample: f.sample },
        at,
      }))
    ),
  });
}

/** At most this many batches a run, so a backlog drains over a few runs rather than one long action. */
const SWEEP_BATCHES = 10;

export const sweep = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const failures: PushFailure[] = [];
    let checked = 0;
    for (let batch = 0; batch < SWEEP_BATCHES; batch++) {
      const tickets: Ticket[] = await ctx.runQuery(internal.pushReceipts.readyTickets, { before: now - RECEIPT_READY_MS, limit: RECEIPT_BATCH });
      if (!tickets.length) break;
      const res = await fetch("https://exp.host/--/api/v2/push/getReceipts", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ ids: tickets.map((t) => t.ticket_id) }),
      });
      if (!res.ok) {
        console.error(`expo getReceipts ${res.status}: ${await res.text()}`);
        break;
      }
      const receipts = ((await res.json()) as { data?: Record<string, ExpoPushResult> }).data ?? {};
      const settled = settleReceipts(tickets, receipts, now);
      await ctx.runMutation(internal.pushReceipts.settle, { ids: settled.settled, dead: settled.dead });
      failures.push(...settled.failures);
      checked += tickets.length;
      // Tickets still waiting on a receipt stay in the index; stop rather than re-read them.
      if (tickets.length < RECEIPT_BATCH || settled.settled.length < tickets.length) break;
    }
    const byCode = new Map<string, PushFailure>();
    for (const f of failures) {
      const prev = byCode.get(f.code);
      byCode.set(f.code, prev ? { ...prev, count: prev.count + f.count } : f);
    }
    await reportPushFailures(ctx, [...byCode.values()]);
    return { checked, failures: [...byCode.values()] };
  },
});

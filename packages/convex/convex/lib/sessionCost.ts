import type { Doc } from "../_generated/dataModel";
import { turnCost } from "./usageDaily";
import { findConversationByAnyRef } from "../conversationSessionLookup";

// Sessions priced from their lifetime token totals (conversations.usage_totals)
// at API list price, the Spend chart's prices. One implementation for every
// surface that prices sessions: a line run (priceRun), a problem's runs
// (lineTrial.problemCost) and a task (taskCost.ts).

type Ctx = { db: any };
type Totals = { input: number; output: number; cache_read: number; cache_write: number };

export type KeyPrice = { sessions: number; tokens: number; usd: number };
export type SessionPrice = {
  /** Sessions that reported tokens. */
  sessions: number;
  usd: number;
  tokens: number;
  /** Tokens on a model the price table does not name: counted, never guessed at. */
  unpriced_tokens: number;
  /** The part on a metered provider key, which bills money. */
  key: KeyPrice;
  /** Subscription logins the sessions ran on, whether or not they reported tokens. */
  providers: string[];
  /** Sessions that reported no tokens at all (Codex and other backends without usage). */
  uncounted: number;
  device?: string;
};
export const newSessionPrice = (): SessionPrice => ({ sessions: 0, usd: 0, tokens: 0, unpriced_tokens: 0, key: { sessions: 0, tokens: 0, usd: 0 }, providers: [], uncounted: 0 });

/**
 * What a session's tokens were billed to. Claude Code and Codex sessions run
 * on the machine's subscription login (the launcher never hands them an API
 * key: cli providerKeyLaunch.ts), so they spend an account's quota and bill
 * nothing. Every other agent reads a provider key, which bills money.
 */
export function sessionBilling(agentType: string | undefined): { provider: "claude" | "codex" } | null {
  if (agentType === "claude_code") return { provider: "claude" };
  if (agentType === "codex") return { provider: "codex" };
  return null;
}

/**
 * The tokens a session spent itself. A fork the daemon created from a branch
 * whose transcript carries the shared history (no fork_status: the server
 * copy never ran) synced its origin's turns as its own, so its totals repeat
 * what the origin already counted; its own part is what it holds beyond the
 * origin. That is a floor, since the origin kept working after the fork. A
 * fork the server copied (fork_status set) inserts the copied rows without
 * rolling their usage up, so its totals are its own already.
 */
async function ownTotals(ctx: Ctx, conv: Doc<"conversations">): Promise<Totals | null> {
  const u = conv.usage_totals;
  if (!u) return null;
  if (!conv.forked_from || conv.fork_status) return u;
  const origin: Doc<"conversations"> | null = await ctx.db.get(conv.forked_from);
  const o = origin?.usage_totals;
  if (!o) return u;
  return {
    input: Math.max(0, u.input - o.input),
    output: Math.max(0, u.output - o.output),
    cache_read: Math.max(0, u.cache_read - o.cache_read),
    cache_write: Math.max(0, u.cache_write - o.cache_write),
  };
}

/** Adds one conversation's price into `into`, once: `seen` holds the conversations already counted. */
export async function priceSession(ctx: Ctx, conv: Doc<"conversations"> | null, seen: Set<string>, into: SessionPrice): Promise<void> {
  if (!conv || seen.has(`conv:${conv._id}`)) return;
  seen.add(`conv:${conv._id}`);
  // Its account carries the quota whether or not the session reported tokens (Codex sessions report none).
  const billing = sessionBilling(conv.agent_type);
  if (billing && !into.providers.includes(billing.provider)) into.providers.push(billing.provider);
  const u = await ownTotals(ctx, conv);
  if (!u) {
    into.uncounted++;
    return;
  }
  into.sessions++;
  const tokens = u.input + u.output + u.cache_read + u.cache_write;
  into.tokens += tokens;
  const usd = turnCost(conv.model, { input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cache_read, cache_creation_input_tokens: u.cache_write });
  if (usd > 0) into.usd += usd;
  else into.unpriced_tokens += tokens;
  if (!billing) {
    into.key.sessions++;
    into.key.tokens += tokens;
    into.key.usd += Math.max(0, usd);
  }
}

/** A conversation's direct children: subagents, and the station sessions nested under a run's primary conversation. */
export async function childConversations(ctx: Ctx, parentId: Doc<"conversations">["_id"]): Promise<Doc<"conversations">[]> {
  return await ctx.db.query("conversations").withIndex("by_parent_conversation_id", (q: any) => q.eq("parent_conversation_id", parentId)).collect();
}

/**
 * A workflow run's station sessions priced into `into`. A node may name its
 * session by any of its ids; a session already counted (`seen`) is skipped.
 */
export async function priceRun(ctx: Ctx, run: Doc<"workflow_runs">, seen: Set<string>, into: SessionPrice): Promise<SessionPrice> {
  if (run.runner_device) into.device ??= run.runner_device;
  const convs: (Doc<"conversations"> | null)[] = [];
  for (const node of run.node_statuses ?? []) {
    if (!node.session_id || seen.has(node.session_id)) continue;
    seen.add(node.session_id);
    convs.push(await findConversationByAnyRef(ctx as any, node.session_id, run.user_id));
  }
  // A station asked again (a re-ask at Present, a second build) leaves only its newest session on the node; every
  // visit's session is nested under the run's primary conversation, so the cost of a run never falls when it re-asks.
  if (run.primary_conversation_id) convs.push(...(await childConversations(ctx, run.primary_conversation_id)));
  for (const conv of convs) await priceSession(ctx, conv, seen, into);
  return into;
}

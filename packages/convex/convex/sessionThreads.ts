// Reads the durable ledger of session→session messages (every `cast send`) and
// reconstructs the graph of which agent talked to which. The data lives in
// `pending_messages`: that table is a delivery queue, but it KEEPS terminal
// `delivered` rows (only whole-conversation cleanup ever deletes them), so it
// doubles as a permanent record of inter-agent chatter. Each row's `content` is
// wrapped by formatSessionMessage as
//   <session-message from="jx7c6zk"> …body… </session-message>
// so even a self-send (where from_conversation_id is null) still names its sender
// via the `from` short_id — which is the join key we resolve back to a session.
import { query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

// Mirror of packages/web/components/sessionMessage.ts — kept tiny and dependency
// free so it runs on the Convex side. Pulls the sender short_id and the human body
// out of the wire wrapper, tolerating the injection noise the daemon can prepend.
const SESSION_MESSAGE_RE =
  /<session-message\s+from="([^"]*)"[^>]*>([\s\S]*?)<\/session-message>/;

function stripInjectionNoise(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, "")
    .replace(/^[\x00-\x1f\s]+/, "");
}

function parseSessionMessage(
  raw: string | null | undefined
): { from: string; body: string } | null {
  if (!raw) return null;
  const cleaned = stripInjectionNoise(raw);
  if (!cleaned.startsWith("<session-message")) return null;
  const m = cleaned.match(SESSION_MESSAGE_RE);
  if (!m) return null;
  return { from: (m[1] || "").trim(), body: (m[2] || "").trim() };
}

type NodeOut = {
  _id: string;
  short_id: string;
  title: string | null;
  project_path: string | null;
  agent_type: string | null;
  message_count: number;
  updated_at: number;
  status: string | null;
  user_id: string | null;
  is_subagent: boolean;
  resolved: boolean;
};

// The full inter-session message graph the signed-in user can see: messages they
// sent from one of their sessions, plus messages delivered to a session they own
// (including a teammate's cross-user send). Returns the message "links" plus a
// deduped node table for every session that appears as a sender or receiver.
export const listSessionThreads = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const me = await getAuthUserId(ctx as any);
    if (!me) return { links: [], nodes: [], generatedAt: Date.now() };

    const limit = Math.min(Math.max(args.limit ?? 600, 1), 1500);

    // Two prefix scans (status left unbound → every status) unioned: rows I sent,
    // and rows owned by a session of mine. Self-sends land in both; dedupe by _id.
    const [bySender, byOwner] = await Promise.all([
      ctx.db
        .query("pending_messages")
        .withIndex("by_user_status", (q: any) => q.eq("from_user_id", me))
        .collect(),
      ctx.db
        .query("pending_messages")
        .withIndex("by_owner_status", (q: any) => q.eq("owner_user_id", me))
        .collect(),
    ]);

    const seen = new Set<string>();
    const rows: any[] = [];
    for (const r of [...bySender, ...byOwner]) {
      const key = r._id.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      // Keep only true session→session traffic; web-compose / task dispatch land in
      // the same queue but lack the wrapper.
      if (typeof r.content !== "string") continue;
      if (!stripInjectionNoise(r.content).startsWith("<session-message")) continue;
      rows.push(r);
    }

    rows.sort((a, b) => b.created_at - a.created_at);
    const recent = rows.slice(0, limit);

    // Resolve every session we'll reference, with the fewest reads: gather the
    // explicit receiver / sender conversation ids, then resolve the remaining
    // sender short_ids (self-sends carry no from_conversation_id) one lookup each.
    const directIds = new Set<string>();
    for (const r of recent) {
      directIds.add(r.conversation_id.toString());
      if (r.from_conversation_id) directIds.add(r.from_conversation_id.toString());
    }

    const convCache = new Map<string, any>();
    await Promise.all(
      [...directIds].map(async (id) => {
        try {
          convCache.set(id, await ctx.db.get(id as any));
        } catch {
          convCache.set(id, null);
        }
      })
    );

    // short_id → conversation, preferring a candidate owned by the message sender
    // (short_id is only a 7-char prefix and can collide across users).
    const shortIdCache = new Map<string, any>();
    async function resolveShort(short: string, preferUser: string): Promise<any> {
      if (!short || short === "unknown") return null;
      const cacheKey = `${short}|${preferUser}`;
      if (shortIdCache.has(cacheKey)) return shortIdCache.get(cacheKey);
      const candidates = await ctx.db
        .query("conversations")
        .withIndex("by_short_id", (q: any) => q.eq("short_id", short))
        .take(16);
      const owned = candidates.find(
        (c: any) => c.user_id?.toString() === preferUser
      );
      const picked = owned ?? candidates[0] ?? null;
      shortIdCache.set(cacheKey, picked);
      return picked;
    }

    const nodes = new Map<string, NodeOut>();
    function addNode(conv: any): string | null {
      if (!conv) return null;
      const id = conv._id.toString();
      if (!nodes.has(id)) {
        nodes.set(id, {
          _id: id,
          short_id: conv.short_id ?? id.slice(0, 7),
          title: conv.title ?? null,
          project_path: conv.project_path ?? null,
          agent_type: conv.agent_type ?? null,
          message_count: conv.message_count ?? 0,
          updated_at: conv.updated_at ?? conv.started_at ?? 0,
          status: conv.status ?? null,
          user_id: conv.user_id?.toString() ?? null,
          is_subagent: !!conv.is_subagent,
          resolved: true,
        });
      }
      return id;
    }
    // A sender we couldn't resolve still gets a placeholder node so the edge renders.
    function addGhost(short: string): string {
      const id = `ghost:${short}`;
      if (!nodes.has(id)) {
        nodes.set(id, {
          _id: id,
          short_id: short,
          title: null,
          project_path: null,
          agent_type: null,
          message_count: 0,
          updated_at: 0,
          status: null,
          user_id: null,
          is_subagent: false,
          resolved: false,
        });
      }
      return id;
    }

    const links = [];
    for (const r of recent) {
      const parsed = parseSessionMessage(r.content);
      const toConv = convCache.get(r.conversation_id.toString());
      const toId = addNode(toConv) ?? addGhost(r.conversation_id.toString().slice(0, 7));

      const fromUserId = r.from_user_id?.toString() ?? "";
      let fromId: string | null = null;
      if (r.from_conversation_id) {
        fromId = addNode(convCache.get(r.from_conversation_id.toString()));
      }
      if (!fromId && parsed?.from) {
        const senderConv = await resolveShort(parsed.from, fromUserId);
        fromId = senderConv ? addNode(senderConv) : addGhost(parsed.from);
      }
      if (!fromId) fromId = addGhost(parsed?.from || "unknown");

      links.push({
        _id: r._id.toString(),
        created_at: r.created_at,
        delivered_at: r.delivered_at ?? null,
        status: r.status as string,
        retry_count: r.retry_count ?? 0,
        from_id: fromId,
        to_id: toId,
        from_short: parsed?.from ?? null,
        from_user_id: fromUserId,
        cross_user:
          !!r.owner_user_id && r.owner_user_id.toString() !== fromUserId,
        body: parsed?.body ?? "",
      });
    }

    return { links, nodes: [...nodes.values()], generatedAt: Date.now() };
  },
});

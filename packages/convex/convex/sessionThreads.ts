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
import { resolveConversationRef } from "./conversations";
import { checkConversationAccess } from "./privacy";

// Mirror of packages/web/components/sessionMessage.ts — kept tiny and dependency
// free so it runs on the Convex side. Pulls the sender short_id and the human body
// out of the wire wrapper, tolerating the injection noise the daemon can prepend.
const SESSION_MESSAGE_RE =
  /<session-message\s+from="([^"]*)"[^>]*>([\s\S]*)<\/session-message>/;

function removeLeadingFramingNewline(body: string): string {
  if (body.startsWith("\r\n")) return body.slice(2);
  if (body.startsWith("\n")) return body.slice(1);
  return body;
}

function removeTrailingFramingNewline(body: string): string {
  if (body.endsWith("\r\n")) return body.slice(0, -2);
  if (body.endsWith("\n")) return body.slice(0, -1);
  return body;
}

function stripInjectionNoise(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, "")
    .replace(/^[\x00-\x1f\s]+/, "");
}

export function parseSessionThreadMessage(
  raw: string | null | undefined
): { from: string; body: string } | null {
  if (!raw) return null;
  const cleaned = stripInjectionNoise(raw);
  if (!cleaned.startsWith("<session-message")) return null;
  const m = cleaned.match(SESSION_MESSAGE_RE);
  if (!m) return null;
  return {
    from: (m[1] || "").trim(),
    body: removeTrailingFramingNewline(removeLeadingFramingNewline(m[2] || "")),
  };
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
      const parsed = parseSessionThreadMessage(r.content);
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

// ── Where a received message was written ───────────────────────────────────
// A message that arrives from another session was composed at one point in
// THAT session's transcript: the assistant turn that ran the send. Landing a
// reader on the sender's session alone drops them at its tail, which is rarely
// where the message came from — so the card links to the turn itself.
//
// Every send leaves the text in a tool call: Claude Code's own SendMessage and
// Agent tools for an agent team, a Bash `cast send` or agent-send.sh for the
// rest. So an excerpt of the received body names the turn exactly, and
// timestamps only bound the search.
//
// Those bounds are loose on purpose. A send can wait — `cast send` queues until
// the recipient is idle — so the recipient's transcript timestamps the DELIVERY,
// not the writing, and the two can be hours apart. Cost stays flat regardless:
// the scan walks back from delivery and stops after SENDING_SCAN_LIMIT turns, so
// a busy sender is bounded by the limit and a quiet one by the window.
const SENDING_WINDOW_BEFORE_MS = 6 * 60 * 60 * 1000;
const SENDING_WINDOW_AFTER_MS = 5 * 60 * 1000;
const SENDING_SCAN_LIMIT = 150;
// How far back the time fallback may reach when no turn carries the text. Past
// this the nearest turn is a guess, and a link that opens the sender's session
// without claiming a spot in it is the more honest answer.
const SENDING_FALLBACK_MAX_GAP_MS = 5 * 60 * 1000;
const SENDING_EXCERPT_MIN = 12;
// Parsing a giant tool input to reach its string fields is not worth it: a
// paste that big is not the excerpt's source.
const SENDING_INPUT_PARSE_LIMIT = 200_000;

type SendingCandidate = {
  _id: any;
  timestamp: number;
  content?: string;
  tool_calls?: Array<{ input: string }>;
};

// Runs of whitespace collapse to one space so an excerpt survives re-wrapping
// and indentation. A tool input is JSON, so its newlines are the two characters
// `\` and `n` — normalizing alone cannot bridge that, which is why the haystack
// below carries the parsed string fields too.
function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function toolCallHaystack(message: SendingCandidate): string {
  const parts: string[] = [];
  for (const call of message.tool_calls ?? []) {
    parts.push(call.input);
    if (call.input.length > SENDING_INPUT_PARSE_LIMIT) continue;
    try {
      const parsed = JSON.parse(call.input);
      if (parsed && typeof parsed === "object") {
        for (const value of Object.values(parsed)) {
          if (typeof value === "string") parts.push(value);
        }
      }
    } catch {}
  }
  return normalizeForMatch(parts.join("\n"));
}

// The sender's turn that carries `excerpt`, searched outward from the delivery
// time: the turns at or before it first (newest first — the send is the last
// thing that happened before delivery), then the ones after, for clock skew.
// When no turn carries the text — an excerpt too short to be distinctive, a
// send whose tool call never synced — the last turn before delivery still puts
// the reader at the right moment, but only while it is close enough to have
// plausibly been the send.
export function pickSendingMessage(
  messages: SendingCandidate[],
  deliveredAt: number,
  excerpt: string,
): SendingCandidate | null {
  const needle = normalizeForMatch(excerpt);
  const before = messages
    .filter((m) => m.timestamp <= deliveredAt)
    .sort((a, b) => b.timestamp - a.timestamp);
  const after = messages
    .filter((m) => m.timestamp > deliveredAt)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (needle.length >= SENDING_EXCERPT_MIN) {
    const outward = [...before, ...after];
    // The send IS a tool call, so a call carrying the text beats a turn that
    // merely narrates it — an agent often repeats what it just sent.
    for (const message of outward) {
      if (toolCallHaystack(message).includes(needle)) return message;
    }
    for (const message of outward) {
      if (normalizeForMatch(message.content ?? "").includes(needle)) return message;
    }
  }
  const nearest = before[0];
  return nearest && deliveredAt - nearest.timestamp <= SENDING_FALLBACK_MAX_GAP_MS ? nearest : null;
}

export const findSendingMessage = query({
  args: {
    // A conversation id or a 7-char short id — whichever the card had.
    sender: v.string(),
    delivered_at: v.number(),
    excerpt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await getAuthUserId(ctx as any);
    if (!me) return null;
    const sender = await resolveConversationRef(ctx, args.sender, me);
    if (!sender) return null;
    if ((await checkConversationAccess(ctx, me, sender)) === "denied") return null;
    // Assistant turns only: an agent sends, so the tool call lives there, and
    // the reader is landing on a turn either way. A busy lead's window holds
    // hundreds of large tool-result rows, and reading them would make the click
    // wait seconds for an answer it cannot use.
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_conversation_role_timestamp", (q: any) =>
        q
          .eq("conversation_id", sender._id)
          .eq("role", "assistant")
          .gte("timestamp", args.delivered_at - SENDING_WINDOW_BEFORE_MS)
          .lte("timestamp", args.delivered_at + SENDING_WINDOW_AFTER_MS))
      .order("desc")
      .take(SENDING_SCAN_LIMIT);
    const hit = pickSendingMessage(rows as any, args.delivered_at, args.excerpt ?? "");
    // The conversation comes back either way: a card that could not name the
    // turn still opens the right session.
    return {
      conversation_id: sender._id.toString(),
      message_id: hit ? hit._id.toString() : null,
      timestamp: hit ? hit.timestamp : null,
    };
  },
});

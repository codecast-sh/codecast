import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import {
  useInboxStore,
  isConvexId,
  isSessionEffectivelyIdle,
  type InboxSession,
  type Message,
} from "../store/inboxStore";

// The fork family of a conversation, built LOCAL-FIRST: the inbox store already
// carries forked_from links for every cached session, and the conversation
// details payload carries enriched parent/children/sibling rows
// (forked_from_details / fork_children / fork_siblings). Together they cover
// the whole family in almost every case, so the branch map renders instantly
// with zero server round-trip. getConversationTree still runs when the panel is
// open and merges in any nodes the client has never seen (out of the 30-day
// store window, a teammate's branch, grandparents of an injected row) — they
// appear in place without a loading state.

export type BranchLive = "working" | "needs_input" | "idle";

export type ForkNode = {
  id: string;
  parentId: string | null;
  short_id?: string;
  title: string;
  message_count: number;
  // Messages inherited from the parent up to the fork point; message_count
  // minus this is the branch's own size (same semantics as BranchSelector).
  fork_copied?: number;
  parent_message_uuid?: string;
  started_at: number;
  updated_at?: number;
  agent_type?: string;
  username?: string;
  last_message_preview?: string;
  last_message_role?: string;
  git_branch?: string;
  // The prompt that started this branch (first user message after the fork),
  // from the server tree. Distinguishes same-titled siblings; falls back to
  // title until the server tree loads.
  branch_label?: string;
  // Messages on this branch after the fork point (server-computed; the client
  // also derives this instantly via branchOwnSize).
  branch_message_count?: number;
  // Liveness, only known for sessions present in the store.
  live?: BranchLive;
};

export type FlatForkNode = ForkNode & {
  depth: number;
  // Per ancestor level: does that ancestor have more siblings below us
  // (i.e. should a vertical rail be drawn through this row at that level)?
  guides: boolean[];
  isLast: boolean;
  childCount: number;
};

// Loose view of the conversation-details payload — only the fork fields.
export type ForkConversationLike = {
  _id: { toString(): string } | string;
  title?: string | null;
  message_count?: number;
  started_at?: number;
  updated_at?: number;
  agent_type?: string;
  forked_from?: { toString(): string } | string | null;
  parent_message_uuid?: string | null;
  forked_from_details?: {
    conversation_id?: { toString(): string } | string;
    title?: string | null;
    parent_message_uuid?: string;
  } | null;
  fork_children?: Array<Record<string, any>>;
  fork_siblings?: Array<Record<string, any>>;
} | null | undefined;

type RawRec = Partial<ForkNode> & { id: string; parentId?: string | null };

// The prompt that started a branch, computed locally from cached messages —
// the same thing the server's getConversationTree computes, but instant and
// deploy-independent for any conversation already in the store. Strips tags and
// collapses whitespace so slash-command wrappers read as their inner text.
function cleanPrompt(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function firstUserPromptOf(msgs: Message[]): string | undefined {
  for (const m of msgs) {
    if (m.role === "user" && typeof m.content === "string") {
      const c = cleanPrompt(m.content);
      if (c) return c.slice(0, 140);
    }
  }
  for (const m of msgs) {
    if (typeof m.content === "string") {
      const c = cleanPrompt(m.content);
      if (c) return c.slice(0, 140);
    }
  }
  return undefined;
}
function localBranchLabel(
  messages: Message[] | undefined,
  parentMessageUuid?: string | null,
): string | undefined {
  if (!messages || messages.length === 0) return undefined;
  // Root (or agent-switch sibling): the conversation's own opening prompt.
  if (!parentMessageUuid || parentMessageUuid === "agent-switch") {
    return firstUserPromptOf(messages);
  }
  // Fork: the first prompt after the fork point.
  const idx = messages.findIndex((m) => m.message_uuid === parentMessageUuid);
  return firstUserPromptOf(idx >= 0 ? messages.slice(idx + 1) : messages);
}

// Stricter than the inbox's needs-input bucketing on purpose: there a finished
// session counts as needs_input, but a map where every done branch glows amber
// says nothing. Amber here = the agent is actually blocked on you.
function liveOf(s: InboxSession): BranchLive {
  if (!isSessionEffectivelyIdle(s)) return "working";
  if (s.awaiting_input || s.agent_status === "permission_blocked" || s.pending_api_error) {
    return "needs_input";
  }
  return "idle";
}

function recFromSession(s: InboxSession): RawRec {
  return {
    id: s._id,
    parentId: s.forked_from ?? undefined,
    title: s.title || "Untitled",
    message_count: s.message_count ?? 0,
    // Inherited-history count, so the after-fork size is right even for a
    // branch known only from the store (not in the details payload).
    fork_copied: s.fork_copied,
    parent_message_uuid: s.parent_message_uuid ?? undefined,
    started_at: s.started_at,
    updated_at: s.updated_at,
    agent_type: s.agent_type,
    git_branch: s.git_branch ?? undefined,
    username: s.author_name ?? undefined,
    live: liveOf(s),
  };
}

function recFromDetails(f: Record<string, any>, parentId: string | undefined): RawRec {
  return {
    id: f._id?.toString?.() ?? f._id,
    parentId,
    title: f.title || "Untitled",
    short_id: f.short_id,
    message_count: f.message_count ?? 0,
    fork_copied: typeof f.fork_copied === "number" ? f.fork_copied : undefined,
    parent_message_uuid: f.parent_message_uuid,
    started_at: f.started_at,
    updated_at: f.updated_at,
    agent_type: f.agent_type,
    username: f.username,
    last_message_preview: f.last_message_preview,
    last_message_role: f.last_message_role,
    git_branch: f.git_branch,
  };
}

// Merge b into a, keeping a's defined fields (callers order sources from
// weakest to strongest by merging strongest last).
function mergeRec(a: RawRec | undefined, b: RawRec): RawRec {
  if (!a) return { ...b };
  const out: RawRec = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v !== undefined && v !== null && v !== "") (out as any)[k] = v;
  }
  // parentId: a known link always beats unknown.
  if (b.parentId !== undefined) out.parentId = b.parentId;
  return out;
}

type ServerTreeNode = {
  id: string;
  short_id?: string;
  title: string;
  message_count: number;
  parent_message_uuid?: string;
  started_at: number;
  status: string;
  agent_type?: string;
  branch_label?: string;
  branch_message_count?: number;
  children: ServerTreeNode[];
};

// Labels/counts the server has computed, remembered across renders and across
// the open/closed state of the map. Once you've opened the map for a family,
// the [ / ] hop HUD can show real branch labels even though hops read only from
// the store (which has no after-fork labels of its own).
const branchInfoCache = new Map<string, { label?: string; count?: number }>();

function collectServerRecs(node: ServerTreeNode, parentId: string | null, out: RawRec[]) {
  if (node.branch_label || typeof node.branch_message_count === "number") {
    branchInfoCache.set(node.id, { label: node.branch_label, count: node.branch_message_count });
  }
  out.push({
    id: node.id,
    parentId,
    title: node.title,
    short_id: node.short_id,
    message_count: node.message_count,
    parent_message_uuid: node.parent_message_uuid,
    started_at: node.started_at,
    agent_type: node.agent_type,
    branch_label: node.branch_label,
    branch_message_count: node.branch_message_count,
  });
  for (const c of node.children) collectServerRecs(c, node.id, out);
}

// Build the family's flat DFS order. Sources, weakest → strongest:
// server tree (when present) < conversation details rows < live store sessions.
// messagesByConv (cached message lists) feeds instant, deploy-independent
// branch labels for any conversation already loaded.
export function buildForkFamily(
  conversation: ForkConversationLike,
  sessions: Record<string, InboxSession>,
  serverTree?: ServerTreeNode | null,
  messagesByConv?: Record<string, Message[]>,
): FlatForkNode[] {
  if (!conversation?._id) return [];
  const currentId = conversation._id.toString();

  const recs = new Map<string, RawRec>();
  const put = (r: RawRec) => recs.set(r.id, mergeRec(recs.get(r.id), r));

  if (serverTree) {
    const flat: RawRec[] = [];
    collectServerRecs(serverTree, null, flat);
    for (const r of flat) put(r);
  }

  // Conversation-details rows (rich fields: username, previews, fork_copied).
  const parentId = conversation.forked_from?.toString();
  put({
    id: currentId,
    parentId: parentId ?? (serverTree ? undefined : null),
    title: conversation.title || "Untitled",
    message_count: conversation.message_count ?? 0,
    parent_message_uuid: conversation.parent_message_uuid ?? undefined,
    started_at: conversation.started_at ?? 0,
    updated_at: conversation.updated_at,
    agent_type: conversation.agent_type,
  });
  const ffd = conversation.forked_from_details;
  if (parentId && ffd?.conversation_id) {
    put({ id: parentId, title: ffd.title || "Untitled", parent_message_uuid: ffd.parent_message_uuid, message_count: 0, started_at: 0 });
  }
  for (const f of conversation.fork_children ?? []) put(recFromDetails(f, currentId));
  for (const f of conversation.fork_siblings ?? []) {
    if (parentId) put(recFromDetails(f, parentId));
  }

  // Ancestor chain from the store: the details payload only knows one level
  // up, but cached sessions carry their own forked_from links — walk upward
  // pulling each ancestor in so the family roots correctly even when viewed
  // from a deep child.
  let upId: string | undefined = currentId;
  const seenUp = new Set<string>();
  while (upId && !seenUp.has(upId)) {
    seenUp.add(upId);
    const next: string | undefined =
      sessions[upId]?.forked_from ?? recs.get(upId)?.parentId ?? undefined;
    if (next && sessions[next] && !recs.has(next)) put(recFromSession(sessions[next]));
    upId = next;
  }

  // Live store sessions: liveness + freshest counts, for any cached session
  // already in the family or fork-linked to it. The fixpoint loop attaches
  // chains of store-only forks (grandchildren the details payload doesn't
  // know) — repeat until no new ids join.
  let grew = true;
  const mergedStore = new Set<string>();
  while (grew) {
    grew = false;
    for (const s of Object.values(sessions)) {
      if (mergedStore.has(s._id)) continue;
      if (recs.has(s._id) || (s.forked_from && recs.has(s.forked_from))) {
        put(recFromSession(s));
        mergedStore.add(s._id);
        grew = true;
      }
    }
  }

  if (!recs.has(currentId)) return [];

  // Walk up to the highest known ancestor.
  let rootId = currentId;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(rootId)) break; // cycle guard
    seen.add(rootId);
    const p = recs.get(rootId)?.parentId;
    if (p && recs.has(p)) rootId = p;
    else break;
  }

  // Children index, chronological order.
  const childrenOf = new Map<string, RawRec[]>();
  for (const r of recs.values()) {
    if (!r.parentId || r.id === rootId || !recs.has(r.parentId)) continue;
    const list = childrenOf.get(r.parentId) ?? [];
    list.push(r);
    childrenOf.set(r.parentId, list);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
  }

  // DFS flatten with rail guides.
  const flat: FlatForkNode[] = [];
  const visit = (r: RawRec, depth: number, guides: boolean[], isLast: boolean) => {
    if (flat.length > 500) return; // runaway guard
    const kids = childrenOf.get(r.id) ?? [];
    const cached = branchInfoCache.get(r.id);
    const localLabel = messagesByConv
      ? localBranchLabel(messagesByConv[r.id], r.parent_message_uuid)
      : undefined;
    // Promote a freshly-computed local label into the cache so the [ / ] hop
    // HUD (which reads only the store) shows real labels for visited branches.
    if (localLabel && !cached?.label) {
      branchInfoCache.set(r.id, { label: localLabel, count: cached?.count });
    }
    flat.push({
      id: r.id,
      parentId: r.parentId ?? null,
      title: r.title || "Untitled",
      short_id: r.short_id,
      message_count: r.message_count ?? 0,
      fork_copied: r.fork_copied,
      parent_message_uuid: r.parent_message_uuid,
      started_at: r.started_at ?? 0,
      updated_at: r.updated_at,
      agent_type: r.agent_type,
      username: r.username,
      last_message_preview: r.last_message_preview,
      last_message_role: r.last_message_role,
      git_branch: r.git_branch,
      // Server label is authoritative (covers never-visited branches); the
      // local computation makes it instant for loaded ones; cache bridges hops.
      branch_label: r.branch_label ?? localLabel ?? cached?.label,
      branch_message_count: r.branch_message_count ?? cached?.count,
      live: r.live,
      depth,
      guides: [...guides],
      isLast,
      childCount: kids.length,
    });
    kids.forEach((k, i) => visit(k, depth + 1, [...guides, !isLastChild(i, kids)], isLastChild(i, kids)));
  };
  const isLastChild = (i: number, kids: RawRec[]) => i === kids.length - 1;
  const root = recs.get(rootId)!;
  visit(root, 0, [], true);
  return flat;
}

// Branch's own size: messages added after the fork point.
export function branchOwnSize(n: Pick<ForkNode, "message_count" | "fork_copied">): number {
  const total = n.message_count ?? 0;
  if (typeof n.fork_copied !== "number") return total;
  return Math.max(0, total - n.fork_copied);
}

// What the row shows. Count prefers the server's exact after-fork number, with
// the locally-derived size as the instant fallback before the tree loads.
export function branchDisplayCount(n: ForkNode): number {
  return typeof n.branch_message_count === "number" ? n.branch_message_count : branchOwnSize(n);
}

// Label prefers the first-message-after-fork (the prompt that started the
// branch) so same-titled siblings read differently; the root shows its opening
// prompt the same way. Falls back to the title until messages/tree are loaded.
export function branchDisplayLabel(n: ForkNode): string {
  return (n.branch_label || n.title || "Untitled").trim();
}

// Unread mirror of BranchSelector.unreadOf: baseline is your seen count or the
// inherited history, so never-opened branches read fully unread.
export function branchUnread(
  n: Pick<ForkNode, "message_count" | "fork_copied">,
  seenCount: number | undefined,
  isCurrent: boolean,
): number {
  if (isCurrent) return 0;
  const total = n.message_count ?? 0;
  const floor = typeof n.fork_copied === "number" ? n.fork_copied : 0;
  const baseline = Math.max(seenCount ?? floor, floor);
  return Math.max(0, total - baseline);
}

// Imperative variant for shortcut handlers ([ / ] branch hop): reads the store
// snapshot, no subscriptions, no render cost in ConversationView.
export function getForkFamilyOrder(conversation: ForkConversationLike): FlatForkNode[] {
  const s = useInboxStore.getState();
  return buildForkFamily(conversation, s.sessions, null, s.messages);
}

export function useForkTree(conversation: ForkConversationLike, open: boolean) {
  const conversationId = conversation?._id?.toString();
  const sessions = useInboxStore((s) => s.sessions);
  const messages = useInboxStore((s) => s.messages);
  const serverRes = useQuery(
    api.conversations.getConversationTree,
    open && conversationId && isConvexId(conversationId)
      ? { conversation_id: conversationId as any }
      : "skip",
  );
  const serverTree =
    serverRes && !("error" in serverRes) ? ((serverRes as any).tree as ServerTreeNode) : null;

  return useMemo(
    () => buildForkFamily(conversation, sessions, serverTree, messages),
    [conversation, sessions, serverTree, messages],
  );
}

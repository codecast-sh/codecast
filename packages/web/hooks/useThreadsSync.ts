// The Threads inbox's sync layer: threads.listMine and threads.unreadCount in,
// store collections out — the same feeder/reader split as useChatSync.
//
// Two feeders: the PAGE's (useThreadsInboxSync, mounted by /threads only) and
// the BADGE's (useThreadUnreadSync, mounted app-wide in DashboardLayout so the
// sidebar count is honest on every page). Neither is chat-gated: comment and
// task threads exist whether or not a team has chat on, and the personal
// workspace (no active team) has its own threads.
//
// Readers subscribe to a wake SIGNATURE of the fields they render, never the
// raw collection ref (store/wakeSig.ts).

import { useCallback, useMemo, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import {
  useInboxStore,
  useTrackedStore,
  type ChatMessageRow,
  type ChatRailChannel,
  type ThreadInboxRow,
} from "../store/inboxStore";
import { makeCollectionSig } from "../store/wakeSig";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { isConvexId } from "../lib/entityLinks";
import { ingestTaskDetail } from "./useSyncTasks";
import { questionCards } from "../lib/threadCards";
import { GLOBAL_THREAD_KEY, fileThreadKey, parseCommentThreadRootKey, webThreadKeyFromAnchor, type Comment } from "../lib/commentThread";
import { messagesSig, reactionsSig, useChatMembers, useChatRail, useMessageViews } from "./useChatSync";
import type { ChatMessageView } from "../components/chat/chatTypes";

const api = _api as any;

// ── Signatures ──────────────────────────────────────────────────────────────

/** What the Threads page renders from an entry. */
export const threadInboxSig = makeCollectionSig<ThreadInboxRow>(
  (e) =>
    `${e._id}|${e.kind}|${e.root_key}|${e.team_id ?? ""}|${e.channel_id ?? ""}` +
    `|${e.last_activity_at}|${e.last_read_at}|${e.unread}|${e.unread_capped ? 1 : 0}` +
    `|${e.last_reply?._id ?? ""}|${e.last_reply?.preview ?? ""}`,
);

/** The active workspace, as the server args want it: an explicit team id, or
 *  nothing at all for the personal workspace. Never a guessed team — the
 *  server must not pick one (personal is a value, not a missing pointer). */
function useThreadScope(): { teamId: string | undefined; args: { team_id?: string } } {
  const teamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as string | undefined;
  const scoped = !!teamId && isConvexId(teamId);
  return useMemo(
    () => ({ teamId: scoped ? teamId : undefined, args: scoped ? { team_id: teamId } : {} }),
    [teamId, scoped],
  );
}

/** A row belongs to the workspace on screen. Absence normalized on both sides:
 *  a personal row has no team_id and the personal workspace has no team.
 *  PAGE rows are the exception: a published page is personal property with no
 *  routing team, and its discussion follows the owner into every workspace
 *  (the server carries them into team-scoped reads the same way). */
export function threadRowInWorkspace(row: { team_id?: string; kind?: string }, teamId: string | undefined): boolean {
  if (row.kind === "page") return true;
  return String(row.team_id ?? "") === String(teamId ?? "");
}

// ── The page feeder ─────────────────────────────────────────────────────────

/** The newest page of the viewer's threads, live, plus backwards paging.
 *  Mounted by the Threads page only; the badge has its own feeder below.
 *  Entries sync as deltas; the payload fans out to the collections every
 *  other surface already reads — chat roots and rollups, comments, task
 *  detail rows — so the kind renderers paint from the store. */
export function useThreadsInboxSync(): {
  loading: boolean;
  error?: Error;
  /** Re-subscribe after an error (the page's "try again"). */
  retry: () => void;
  hasMore: boolean;
  isLoadingOlder: boolean;
  loadOlder: () => void;
} {
  const { teamId, args } = useThreadScope();
  const syncTable = useInboxStore((s) => s.syncTable);
  const convex = useConvex();
  const { data: result, error, retry } = useQueryNoThrow(api.threads.listMine, args);

  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [olderExhausted, setOlderExhausted] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const teamRef = useRef(teamId);
  if (teamRef.current !== teamId) {
    teamRef.current = teamId;
    if (olderCursor !== null) setOlderCursor(null);
    if (olderExhausted) setOlderExhausted(false);
    if (isLoadingOlder) setIsLoadingOlder(false);
  }

  const ingest = useCallback(
    (data: any, opts?: { firstPage?: boolean }) => {
      if (!data) return;
      syncTable("threadInbox", data.entries ?? []);
      // A fresh FIRST page is authoritative for its activity window: a local
      // row inside the window that the server no longer returns has been
      // revoked (left room, lost team) and must leave the client too.
      if (opts?.firstPage && Array.isArray(data.entries)) {
        const floor = data.has_more && data.entries.length > 0
          ? data.entries[data.entries.length - 1].last_activity_at
          : 0;
        const st = useInboxStore.getState();
        st.pruneThreadInbox(data.entries.map((e: any) => String(e._id)), teamRef.current, floor);
      }
      const chat = data.payload?.chat;
      if (chat?.roots?.length) syncTable("chatMessages", chat.roots);
      if (chat?.threads?.length) {
        syncTable(
          "chatThreadSummaries",
          chat.threads.map((t: any) => ({ ...t, _id: String(t.root_id) })),
        );
      }
      if (data.payload?.comments?.length) syncTable("comments", data.payload.comments);
      for (const task of data.payload?.tasks ?? []) ingestTaskDetail(task, { partialComments: true });
      if (data.payload?.pages?.length) {
        // Carry local optimistic reply stubs forward: a push racing the
        // server's write would otherwise clobber the reply for a beat. A stub
        // retires when the echoed row carries its client_id, or after a
        // minute (the send failed or the outbox is retrying).
        const local = useInboxStore.getState().pageThreads as Record<string, any>;
        const merged = data.payload.pages.map((p: any) => {
          const prev = local[String(p._id)];
          if (!prev) return p;
          const echoed = new Set((p.comments ?? []).map((c: any) => c.client_id).filter(Boolean));
          const stubs = (prev.comments ?? []).filter(
            (c: any) => c._id.startsWith("pagecmtstub-") && !echoed.has(c.client_id) && c.created_at > Date.now() - 60_000,
          );
          return stubs.length ? { ...p, comments: [...(p.comments ?? []), ...stubs] } : p;
        });
        syncTable("pageThreads", merged);
      }
    },
    [syncTable],
  );

  useConvexSync(
    result,
    useCallback(
      (data: any) => {
        ingest(data, { firstPage: true });
        if (data) setOlderCursor((prev) => (prev === null ? (data.next_cursor ?? null) : prev));
      },
      [ingest],
    ),
  );

  const loadOlder = useCallback(() => {
    if (!olderCursor || isLoadingOlder || olderExhausted) return;
    const forTeam = teamId;
    setIsLoadingOlder(true);
    void convex
      .query(api.threads.listMine, { ...args, cursor: olderCursor })
      .then((page: any) => {
        if (teamRef.current !== forTeam) return;
        ingest(page);
        setOlderCursor(page?.next_cursor ?? null);
        if (!page?.has_more) setOlderExhausted(true);
      })
      .catch(() => {
        // Leave the cursor: the affordance stays, the next click retries.
      })
      .finally(() => {
        if (teamRef.current === forTeam) setIsLoadingOlder(false);
      });
  }, [convex, teamId, args, olderCursor, isLoadingOlder, olderExhausted, ingest]);

  return {
    loading: result === undefined && !error,
    error,
    retry,
    hasMore: !!olderCursor && !olderExhausted,
    isLoadingOlder,
    loadOlder,
  };
}

// ── The badge feeder ────────────────────────────────────────────────────────

/** The server's count of the viewer's threads with unseen replies, for the
 *  workspace on screen. App-wide (DashboardLayout), so the sidebar badge is
 *  honest before the Threads page has ever mounted. */
export function useThreadUnreadSync(): void {
  const { args } = useThreadScope();
  const syncTable = useInboxStore((s) => s.syncTable);
  const { data } = useQueryNoThrow(api.threads.unreadCount, args);
  useConvexSync(
    data,
    useCallback((n: any) => syncTable("threadUnread", typeof n === "number" ? n : 0), [syncTable]),
  );
}

// ── Readers ─────────────────────────────────────────────────────────────────

/** The viewer's threads for the active workspace, newest activity first.
 *  Reads the STORE (the feeder only fills it), so a revisit paints from cache. */
export function useThreadInbox(): ThreadInboxRow[] {
  const s = useTrackedStore([
    (s: any) => threadInboxSig(s.threadInbox),
    (s: any) => s.clientState?.ui?.active_team_id,
  ]);
  const teamId = s.clientState?.ui?.active_team_id;
  const sig = threadInboxSig(s.threadInbox);
  return useMemo(() => {
    const out: ThreadInboxRow[] = [];
    for (const id in s.threadInbox) {
      const row = s.threadInbox[id] as ThreadInboxRow;
      if (!threadRowInWorkspace(row, teamId)) continue;
      out.push(row);
    }
    return out.sort((a, b) => b.last_activity_at - a.last_activity_at);
    // The signature is the real dep: the raw map ref flips on every push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, teamId]);
}

/** The sidebar badge: how many threads in this workspace have unseen replies.
 *  Server kinds come from the local rows once the page has synced them (they
 *  clear the instant a thread is read); the app-wide scalar stands in until
 *  then. Plus unread, unmuted DMs from the chat rail — the Threads page lists
 *  those as cards too, and the badge must equal its header count. Sessions
 *  never count: their number is the Inbox's. */
export function useThreadUnread(): number {
  const rail = useChatRail();
  const s = useTrackedStore([
    (s: any) => s.threadUnread,
    (s: any) => s.clientState?.ui?.active_team_id,
  ]);
  // The SCALAR is the server-kind number, never the local rows: the page
  // feeder mounts only on /threads, so after one visit the local rows would
  // freeze while new activity moves the scalar — a badge that ignores every
  // reply that lands while you sit on the Inbox. The scalar stays honest
  // app-wide (useThreadUnreadSync), and mark-read stays instant because the
  // mark actions decrement it on the draft.
  const scalar = (s as any).threadUnread ?? 0;
  return useMemo(() => {
    let dms = 0;
    for (const c of rail) if (c.kind === "dm" && (c.unreadCount ?? 0) > 0 && !c.muted) dms++;
    return scalar + dms;
  }, [rail, scalar]);
}

/** The web thread key of one comment row (which anchor it hangs on). */
function commentWebKey(c: Comment): string {
  return c.message_id ? String(c.message_id) : c.file_path ? fileThreadKey(c.file_path, c.line_number) : GLOBAL_THREAD_KEY;
}

/** Every comment thread the page's rows point at, assembled ONCE: a map of
 *  `${conversationId}:${webKey}` → comments oldest first. A per-card reader
 *  would rescan the whole comments map per card per push (the exact cost the
 *  chat cards avoid via useThreadInboxCards). */
export function useCommentThreadMap(rows: ThreadInboxRow[]): Map<string, Comment[]> {
  const anchors = useMemo(() => {
    const out = new Map<string, { conversationId: string; webKey: string }>();
    for (const r of rows) {
      if (r.kind !== "comment") continue;
      const parsed = parseCommentThreadRootKey(r.root_key);
      const conversationId = String(r.conversation_id ?? parsed.conversationId);
      out.set(r.root_key, { conversationId, webKey: webThreadKeyFromAnchor(parsed.anchorKey) });
    }
    return out;
  }, [rows]);
  const conversations = useMemo(() => new Set([...anchors.values()].map((a) => a.conversationId)), [anchors]);
  const s = useTrackedStore([
    (s: any) => {
      let sig = "";
      for (const id in s.comments) {
        const c = s.comments[id] as Comment;
        if (!conversations.has(String(c.conversation_id))) continue;
        sig += `${c._id}|${c.created_at}|${c.content.length}|${c.resolved_at ?? ""}|${c.agent_status ?? ""};`;
      }
      return sig;
    },
  ]);
  const all = (s as any).comments as Record<string, Comment>;
  const sig = (() => {
    let out = "";
    for (const id in all) {
      const c = all[id];
      if (!conversations.has(String(c.conversation_id))) continue;
      out += `${c._id}|${c.created_at}|${c.content.length}|${c.resolved_at ?? ""}|${c.agent_status ?? ""};`;
    }
    return out;
  })();
  return useMemo(() => {
    const map = new Map<string, Comment[]>();
    for (const [rootKey, a] of anchors) map.set(rootKey, []);
    const byConvKey = new Map<string, string>();
    for (const [rootKey, a] of anchors) byConvKey.set(`${a.conversationId}:${a.webKey}`, rootKey);
    for (const id in all) {
      const c = all[id];
      const rootKey = byConvKey.get(`${String(c.conversation_id)}:${commentWebKey(c)}`);
      if (rootKey) map.get(rootKey)!.push(c);
    }
    for (const list of map.values()) list.sort((a, b) => a.created_at - b.created_at);
    return map;
    // The signature is the real dep: the raw map ref flips on every push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchors, sig]);
}

/** Pending decisions as Threads cards. Woken only by the pending set. */
export function useQuestionThreadCards(): import("../lib/threadCards").ThreadCardModel[] {
  const s = useTrackedStore([
    (s: any) => {
      let sig = "";
      for (const id in s.sessionDecisions) {
        const d = s.sessionDecisions[id];
        if (d?.status === "pending") sig += `${d._id}|${d.created_at}|${d.updated_at ?? 0};`;
      }
      return sig;
    },
  ]);
  const sig = (() => {
    let out = "";
    for (const id in (s as any).sessionDecisions) {
      const d = (s as any).sessionDecisions[id];
      if (d?.status === "pending") out += `${d._id}|${d.created_at}|${d.updated_at ?? 0};`;
    }
    return out;
  })();
  return useMemo(
    () => questionCards(Object.values((s as any).sessionDecisions ?? {})),
    // The signature is the real dep: the raw map ref flips on every push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sig],
  );
}

export type ThreadInboxCard = {
  entry: ThreadInboxRow;
  /** The root, ready to render — null while the cache is genuinely cold. */
  root: ChatMessageView | null;
  /** The rail's view of the thread's room: display name, DM roster, team. */
  channel: ChatRailChannel | undefined;
};

/** The chat thread cards: entry + rendered root + room, assembled here so the
 *  view stays presentational. One store subscription for every card — a
 *  per-card reader would recompute a full-collection signature per push per
 *  card. Chat kind only; the other kinds have their own renderers. */
export function useThreadInboxCards(): ThreadInboxCard[] {
  const entries = useThreadInbox();
  const rail = useChatRail();
  const { byId, viewerId } = useChatMembers();
  const s = useTrackedStore([
    (s: any) => messagesSig(s.chatMessages),
    (s: any) => reactionsSig(s.chatReactions),
    (s: any) => s.chatThreadSummaries,
  ]);
  const chatEntries = useMemo(() => entries.filter((e) => e.kind === "chat"), [entries]);
  const rootRows = useMemo(
    () =>
      chatEntries
        .map((e) => (s.chatMessages as Record<string, ChatMessageRow>)[e.root_key])
        .filter(Boolean) as ChatMessageRow[],
    // The signature is the real dep: the raw map ref flips on every push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatEntries, messagesSig(s.chatMessages)],
  );
  const views = useMessageViews(rootRows, s.chatReactions, byId, viewerId, s.chatMessages, s.chatThreadSummaries);
  return useMemo(() => {
    const viewById = new Map(views.map((v) => [v.id, v]));
    const railById = new Map(rail.map((c) => [c.id, c]));
    return chatEntries.map((entry) => ({
      entry,
      root: viewById.get(entry.root_key) ?? null,
      channel: railById.get(String(entry.channel_id ?? "")),
    }));
  }, [chatEntries, views, rail]);
}

// Background prefetch for chat: the rows a notification will open are fetched
// before anyone clicks it, so the channel paints from the store instead of
// waiting on its first live page (hooks/useChatPrefetch mounts it on the sync
// host only).
//
// The one rule: fetch only what the cache is MISSING. A channel's page is
// wanted while its newest message is absent from the store, a thread while the
// reply or its root is absent. The store persists, so a reload whose rows are
// already on disk asks for nothing, and a channel that is open (its live page
// delivers the newest message itself) asks for nothing either.
//
// Every fetch is a one-shot query, never a subscription: a subscription is
// re-run on every write to the rows it read, and history a person has not
// opened is not worth that standing cost.

import type { ChatMessageRow, ChatRailRow } from "../store/chatSlice";

export type ChatPrefetchTarget = {
  kind: "channel" | "thread" | "message";
  id: string;
  channelId: string;
  messageId: string;
  at: number;
};

export type ChatPrefetchNotification = {
  entity_type?: string;
  entity_id?: string;
  chat_message_id?: string;
  read: boolean;
  created_at: number;
};

export const CHAT_PREFETCH_CHANNELS = 8;
export const CHAT_PREFETCH_NOTIFICATIONS = 12;
export const CHAT_PREFETCH_CONCURRENCY = 2;
/** The least time between two fetches of one target: a busy room costs at
 *  most one page a second, however fast its lines arrive. */
export const CHAT_PREFETCH_INTERVAL = 1_000;

type Known = { thread_root_id?: string };

const keyOf = (target: Pick<ChatPrefetchTarget, "kind" | "id">) => `${target.kind}:${target.id}`;

/** `arrived` names the channels whose newest line changed while the app was
 *  running: those are the ones an arrival toast can open, read or not (a line
 *  read on another device still toasts here). */
export function chatPrefetchTargets(
  rail: ChatRailRow[],
  notifications: ChatPrefetchNotification[],
  read: (id: string) => ChatMessageRow | undefined,
  arrived: ReadonlySet<string> = new Set(),
): ChatPrefetchTarget[] {
  const channels = new Map(rail.map(row => [row.channel_id, row]));
  const targets = new Map<string, ChatPrefetchTarget>();
  const add = (target: ChatPrefetchTarget) => {
    const prev = targets.get(keyOf(target));
    if (!prev || prev.at < target.at) targets.set(keyOf(target), target);
  };
  // The rows a click on this message lands on. `hint` is the rail's copy of
  // the newest line, which already says whether it is a reply.
  const lookup = (row: ChatRailRow, messageId: string, at: number, hint?: Known) => {
    const cached = read(messageId);
    const root = (cached ?? hint)?.thread_root_id;
    if (root) {
      if (!cached || !read(root)) add({ kind: "thread", id: root, channelId: row.channel_id, messageId, at });
    } else if (!cached && !hint && !targets.has(keyOf({ kind: "channel", id: row.channel_id }))) {
      // Unknown shape: ask for the one row. Never while the channel's page is
      // still coming, which usually carries it, and would otherwise leave a
      // lone new row above a gap in the cached room.
      add({ kind: "message", id: messageId, channelId: row.channel_id, messageId, at });
    }
  };
  const page = (row: ChatRailRow) => {
    const tip = row.last_message;
    if (!tip) return;
    if (!read(tip._id)) add({ kind: "channel", id: row.channel_id, channelId: row.channel_id, messageId: tip._id, at: row.sort_at });
    lookup(row, tip._id, tip.created_at, tip);
  };

  const fresh = rail
    .filter(row => row.notify_level !== "none" && (row.unread > 0 || row.unread_mentions > 0 || arrived.has(row.channel_id)))
    .sort((a, b) => b.sort_at - a.sort_at)
    .slice(0, CHAT_PREFETCH_CHANNELS);
  for (const row of fresh) page(row);

  // A notification names its channel and message. The channel must be one the
  // viewer's rail carries: a room they left keeps its old notifications.
  const pending = notifications
    .filter(n => !n.read && n.entity_type === "chat_channel" && n.chat_message_id && channels.has(n.entity_id ?? ""))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, CHAT_PREFETCH_NOTIFICATIONS);
  for (const n of pending) {
    const row = channels.get(n.entity_id!)!;
    page(row);
    const tip = row.last_message ?? undefined;
    lookup(row, n.chat_message_id!, n.created_at, tip?._id === n.chat_message_id ? tip : undefined);
  }
  return [...targets.values()].sort((a, b) => b.at - a.at);
}

export function createChatPrefetcher(options: {
  load: (target: ChatPrefetchTarget) => Promise<any>;
  ingest: (data: any) => void;
  read: (id: string) => ChatMessageRow | undefined;
  /** Asked again when an answer lands: a room the viewer lost meanwhile must
   *  not be written into the store. */
  allowed: (channelId: string) => boolean;
  onError: (error: unknown) => void;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let desired = new Map<string, ChatPrefetchTarget>();
  let rail: ChatRailRow[] = [];
  let notifications: ChatPrefetchNotification[] = [];
  const active = new Set<string>();
  // Each channel's newest line as first seen, and the channels whose newest
  // line has moved since: the arrivals.
  let tips: Map<string, string> | null = null;
  const arrived = new Set<string>();
  // Per target, the message it was last fetched for. A fetch that did not
  // bring its message (a reply the channel page never carries, a failure) is
  // not repeated until the target names a newer one.
  const fetchedFor = new Map<string, string>();
  const nextStart = new Map<string, number>();

  // Still the viewer's room: on the newest rail, and the caller agrees.
  const allowed = (channelId: string) => rail.some(row => row.channel_id === channelId) && options.allowed(channelId);
  const ready = (key: string, target: ChatPrefetchTarget) =>
    !active.has(key) && fetchedFor.get(key) !== target.messageId && allowed(target.channelId);

  const refresh = () => {
    desired = new Map(chatPrefetchTargets(rail, notifications, options.read, arrived).map(target => [keyOf(target), target]));
    for (const key of fetchedFor.keys()) if (!desired.has(key)) fetchedFor.delete(key);
    // A spacing timer outlives its target: a room whose page just landed drops
    // out of the wanted set, and its next line must still wait out the second.
    const now = Date.now();
    for (const [key, at] of nextStart) if (at <= now && !desired.has(key) && !active.has(key)) nextStart.delete(key);
  };

  const schedule = () => {
    if (stopped || timer !== undefined || active.size >= CHAT_PREFETCH_CONCURRENCY) return;
    let wait = Infinity;
    for (const [key, target] of desired) {
      if (ready(key, target)) wait = Math.min(wait, (nextStart.get(key) ?? 0) - Date.now());
    }
    if (wait !== Infinity) timer = setTimeout(pump, Math.max(0, wait));
  };

  const pump = () => {
    timer = undefined;
    if (stopped) return;
    for (const [key, target] of desired) {
      if (active.size >= CHAT_PREFETCH_CONCURRENCY) break;
      if (!ready(key, target) || (nextStart.get(key) ?? 0) > Date.now()) continue;
      active.add(key);
      fetchedFor.set(key, target.messageId);
      nextStart.set(key, Date.now() + CHAT_PREFETCH_INTERVAL);
      // An answer is kept even when its target has since moved on: it is still
      // true, and a thread answer that lands first must not throw away the
      // channel page still in flight beside it.
      void Promise.resolve()
        .then(() => options.load(target))
        .then(data => {
          if (!stopped && data && !data.unavailable && allowed(target.channelId)) options.ingest(data);
        })
        .catch(error => {
          if (!stopped) options.onError(error);
        })
        .finally(() => {
          active.delete(key);
          if (stopped) return;
          refresh();
          schedule();
        });
    }
    schedule();
  };

  return {
    update(nextRail: ChatRailRow[], nextNotifications: ChatPrefetchNotification[]) {
      if (stopped) return;
      rail = nextRail;
      notifications = nextNotifications;
      const seeding = tips === null;
      tips ??= new Map();
      for (const row of rail) {
        const tip = row.last_message?._id;
        if (!tip) continue;
        if (!seeding && tips.get(row.channel_id) !== tip) arrived.add(row.channel_id);
        tips.set(row.channel_id, tip);
      }
      refresh();
      schedule();
    },
    dispose() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      desired.clear();
      fetchedFor.clear();
      nextStart.clear();
    },
  };
}

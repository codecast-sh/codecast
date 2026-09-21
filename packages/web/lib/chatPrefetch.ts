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
export const CHAT_PREFETCH_INTERVAL = 1_000;

const keyOf = (target: ChatPrefetchTarget) => `${target.kind}:${target.id}`;

export function chatPrefetchTargets(
  rail: ChatRailRow[],
  notifications: ChatPrefetchNotification[],
  read: (id: string) => ChatMessageRow | undefined,
): ChatPrefetchTarget[] {
  const channels = new Map(rail.map(row => [row.channel_id, row]));
  const targets = new Map<string, ChatPrefetchTarget>();
  const add = (target: ChatPrefetchTarget) => {
    const key = keyOf(target);
    if (!targets.has(key) || targets.get(key)!.at < target.at) targets.set(key, target);
  };
  const channel = (row: ChatRailRow) => {
    if (!row.last_message) return;
    add({ kind: "channel", id: row.channel_id, channelId: row.channel_id, messageId: row.last_message._id, at: row.sort_at });
  };
  const message = (channelId: string, messageId: string, at: number, rootId?: string) => {
    const known = read(messageId);
    const root = rootId ?? known?.thread_root_id;
    if (root) add({ kind: "thread", id: root, channelId, messageId, at });
    else if (!known) add({ kind: "message", id: messageId, channelId, messageId, at });
  };
  for (const row of rail.filter(row => row.notify_level !== "none" && (row.unread > 0 || row.unread_mentions > 0))
    .sort((a, b) => b.sort_at - a.sort_at).slice(0, CHAT_PREFETCH_CHANNELS)) {
    channel(row);
    const tip = row.last_message;
    if (tip?.thread_root_id) message(row.channel_id, tip._id, tip.created_at, tip.thread_root_id);
  }
  for (const notification of notifications.filter(n => !n.read && n.entity_type === "chat_channel" && n.entity_id && n.chat_message_id && channels.has(n.entity_id))
    .sort((a, b) => b.created_at - a.created_at).slice(0, CHAT_PREFETCH_NOTIFICATIONS)) {
    const row = channels.get(notification.entity_id!)!;
    channel(row);
    const id = notification.chat_message_id!;
    message(row.channel_id, id, notification.created_at, row.last_message?._id === id ? row.last_message.thread_root_id : undefined);
  }
  return [...targets.values()].sort((a, b) => b.at - a.at);
}

export function createChatPrefetcher(options: {
  load: (target: ChatPrefetchTarget) => Promise<any>;
  ingest: (data: any) => void;
  read: (id: string) => ChatMessageRow | undefined;
  allowed: (channelId: string) => boolean;
  onError: (error: unknown) => void;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let desired = new Map<string, ChatPrefetchTarget>();
  let rail: ChatRailRow[] = [];
  let notifications: ChatPrefetchNotification[] = [];
  const active = new Map<string, string>();
  const completed = new Map<string, string>();
  const nextStart = new Map<string, number>();

  const refresh = () => {
    desired = new Map(chatPrefetchTargets(rail, notifications, options.read).map(target => [keyOf(target), target]));
    for (const key of completed.keys()) if (!desired.has(key)) completed.delete(key);
    for (const key of nextStart.keys()) if (!desired.has(key) && !active.has(key)) nextStart.delete(key);
  };

  const schedule = () => {
    if (stopped || timer !== undefined || active.size >= CHAT_PREFETCH_CONCURRENCY) return;
    const pending = [...desired].filter(([key, target]) => !active.has(key) && completed.get(key) !== target.messageId && options.allowed(target.channelId));
    if (!pending.length) return;
    const wait = Math.max(0, Math.min(...pending.map(([key]) => (nextStart.get(key) ?? 0) - Date.now())));
    timer = setTimeout(pump, wait);
  };

  const pump = () => {
    timer = undefined;
    if (stopped) return;
    for (const [key, target] of desired) {
      if (active.size >= CHAT_PREFETCH_CONCURRENCY) break;
      if (active.has(key) || completed.get(key) === target.messageId || (nextStart.get(key) ?? 0) > Date.now() || !options.allowed(target.channelId)) continue;
      active.set(key, target.messageId);
      nextStart.set(key, Date.now() + CHAT_PREFETCH_INTERVAL);
      void Promise.resolve().then(() => options.load(target)).then(data => {
        if (stopped || !options.allowed(target.channelId)) return;
        if (desired.get(key)?.messageId !== target.messageId) return;
        if (data && !data.unavailable) options.ingest(data);
        completed.set(key, target.messageId);
      }).catch(error => {
        if (stopped) return;
        completed.set(key, target.messageId);
        options.onError(error);
      }).finally(() => {
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
      refresh();
      schedule();
    },
    dispose() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      desired.clear();
      completed.clear();
      nextStart.clear();
    },
  };
}

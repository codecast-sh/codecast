import { afterEach, describe, expect, test } from "bun:test";
import { chatPrefetchTargets, createChatPrefetcher, CHAT_PREFETCH_INTERVAL, type ChatPrefetchNotification, type ChatPrefetchTarget } from "../chatPrefetch";
import type { ChatMessageRow, ChatRailRow } from "../../store/chatSlice";

const row = (channelId: string, tip = `${channelId}-tip`, at = 1, rootId?: string): ChatRailRow => ({
  channel_id: channelId, unread: 1, unread_mentions: 0, notify_level: "all", joined: true, sort_at: at,
  last_message: { _id: tip, user_id: "other", created_at: at, preview: "preview", thread_root_id: rootId },
});
const notification = (channelId: string, messageId: string, at = 1): ChatPrefetchNotification => ({
  entity_type: "chat_channel", entity_id: channelId, chat_message_id: messageId, read: false, created_at: at,
});
const message = (id: string, channelId: string, rootId?: string): ChatMessageRow => ({
  _id: id, channel_id: channelId, user_id: "other", content: "full message", created_at: 1, updated_at: 1, thread_root_id: rootId,
});
const none = () => undefined;
const pause = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const workers: ReturnType<typeof createChatPrefetcher>[] = [];
afterEach(() => { for (const worker of workers.splice(0)) worker.dispose(); });

// A worker over an in-memory cache. `load` defaults to a page holding just the
// target's message, the shape of a one-row channel.
function harness(load?: (target: ChatPrefetchTarget) => Promise<any>, cache: Record<string, ChatMessageRow> = {}) {
  const calls: ChatPrefetchTarget[] = [];
  const ingested: any[] = [];
  const errors: unknown[] = [];
  let allowed = true;
  const worker = createChatPrefetcher({
    read: id => cache[id], allowed: () => allowed,
    load: async target => { calls.push(target); return load ? load(target) : { messages: [message(target.messageId, target.channelId)] }; },
    ingest: data => {
      ingested.push(data);
      for (const value of data.messages ?? [data.message, data.root, ...(data.replies ?? [])].filter(Boolean)) cache[value._id] = value;
    },
    onError: error => errors.push(error),
  });
  workers.push(worker);
  return { worker, calls, cache, ingested, errors, revoke: () => { allowed = false; } };
}

describe("which rows the prefetch asks for", () => {
  test("a cold start is bounded, newest first, and skips read or muted channels", () => {
    const rail = Array.from({ length: 1_000 }, (_, i) => row(`c${i}`, undefined, i));
    rail.push({ ...row("muted", undefined, 2000), notify_level: "none" }, { ...row("read", undefined, 2000), unread: 0 });
    const targets = chatPrefetchTargets(rail, [], none);
    expect(targets.length).toBe(8);
    expect(targets[0].channelId).toBe("c999");
    expect(targets.at(-1)?.channelId).toBe("c992");
  });

  test("rows already in the cache cost nothing: a reload, or a channel open on screen", () => {
    const cache = { tip: message("tip", "c"), reply: message("reply", "t", "root"), root: message("root", "t") };
    const targets = chatPrefetchTargets([row("c", "tip"), row("t", "reply", 2, "root")], [notification("t", "reply", 2)], id => cache[id as keyof typeof cache]);
    expect(targets).toEqual([]);
  });

  test("notifications reach a muted channel, but never a room off the rail or a notification about something else", () => {
    const rail = [{ ...row("allowed"), notify_level: "none" as const }];
    const targets = chatPrefetchTargets(rail, [notification("allowed", "allowed-tip"), notification("revoked", "secret"), { ...notification("allowed", "old"), read: true }, { ...notification("allowed", "task"), entity_type: "task" }], none);
    expect(targets.map(t => `${t.kind}:${t.id}`)).toEqual(["channel:allowed"]);
  });

  test("a reply on the rail goes straight to its thread, with no lookup of the row first", () => {
    const targets = chatPrefetchTargets([row("c", "reply", 5, "root")], [notification("c", "reply", 5)], none);
    expect(targets.map(t => t.kind).sort()).toEqual(["channel", "thread"]);
  });

  test("an unknown notified row waits for its channel's page instead of a lone lookup", () => {
    const targets = chatPrefetchTargets([row("c", "tip", 10)], Array.from({ length: 500 }, (_, i) => notification("c", `older${i}`, i)), none);
    expect(targets.map(t => t.kind)).toEqual(["channel"]);
  });

  test("a cached reply whose root is missing asks for its thread once", () => {
    const cache = { tip: message("tip", "c"), reply: message("reply", "c", "root") };
    const targets = chatPrefetchTargets([row("c", "tip")], [notification("c", "reply"), notification("c", "reply", 2)], id => cache[id as keyof typeof cache]);
    expect(targets).toEqual([{ kind: "thread", id: "root", channelId: "c", messageId: "reply", at: 2 }]);
  });
});

describe("the prefetch worker", () => {
  test("fills the cache before a channel mounts, then stays idle on unchanged pushes", async () => {
    const h = harness();
    const rail = [row("c")];
    h.worker.update(rail, []);
    await pause();
    expect(h.cache["c-tip"]?.content).toBe("full message");
    for (let i = 0; i < 1_000; i++) h.worker.update(rail.map(r => ({ ...r })), []);
    await pause(CHAT_PREFETCH_INTERVAL + 20);
    expect(h.calls).toHaveLength(1);
  });

  test("runs two requests at most, and a disposed worker writes nothing late", async () => {
    const resolvers: Array<(data: any) => void> = [];
    const h = harness(() => new Promise(resolve => resolvers.push(resolve)));
    h.worker.update(Array.from({ length: 20 }, (_, i) => row(`c${i}`, undefined, i)), []);
    await pause();
    expect(h.calls).toHaveLength(2);
    resolvers[0]({ messages: [] });
    await pause();
    expect(h.calls).toHaveLength(3);
    h.worker.dispose();
    const before = h.ingested.length;
    for (const resolve of resolvers) resolve({ messages: [message("late", "c")] });
    await pause();
    expect(h.ingested).toHaveLength(before);
    expect(h.calls).toHaveLength(3);
  });

  test("a burst in one room costs one page a second, and lands on the newest line", async () => {
    const h = harness();
    h.worker.update([row("c", "first", 1)], []);
    await pause();
    for (let i = 2; i <= 100; i++) h.worker.update([row("c", `tip${i}`, i)], []);
    await pause(100);
    expect(h.calls).toHaveLength(1);
    await pause(CHAT_PREFETCH_INTERVAL);
    expect(h.calls.map(t => t.messageId)).toEqual(["first", "tip100"]);
    expect(h.cache.tip100).toBeDefined();
  });

  test("a notified reply is found and its thread fetched without opening chat", async () => {
    const h = harness(async target => target.kind === "message"
      ? { message: message(target.id, "c", "root") }
      : target.kind === "thread"
        ? { root: message("root", "c"), replies: [message("reply", "c", "root"), message("sibling", "c", "root")] }
        : { messages: [message("channel-tip", "c")] });
    h.worker.update([row("c", "channel-tip")], [notification("c", "reply")]);
    await pause(60);
    expect(h.calls.map(t => t.kind)).toEqual(["channel", "message", "thread"]);
    expect(h.cache.sibling).toBeDefined();
    h.worker.update([row("c", "channel-tip")], [notification("c", "reply")]);
    await pause(CHAT_PREFETCH_INTERVAL + 20);
    expect(h.calls).toHaveLength(3);
  });

  test("a thread answer that lands first does not throw away the channel page beside it", async () => {
    let page!: (value: any) => void;
    const h = harness(target => target.kind === "thread"
      ? Promise.resolve({ root: message("root", "c"), replies: [message("reply", "c", "root")] })
      : new Promise(done => { page = done; }));
    h.worker.update([row("c", "reply", 1, "root")], []);
    await pause();
    expect(h.cache.reply).toBeDefined();
    page({ messages: [message("root", "c"), message("newest-root", "c")] });
    await pause();
    expect(h.cache["newest-root"]).toBeDefined();
  });

  test("losing access drops the answer in flight and starts nothing more", async () => {
    let resolve!: (value: any) => void;
    const h = harness(() => new Promise(done => { resolve = done; }));
    h.worker.update([row("c")], []);
    await pause();
    h.worker.update([], []);
    resolve({ messages: [message("secret", "c")] });
    await pause();
    expect(h.ingested).toHaveLength(0);
    expect(h.calls).toHaveLength(1);
  });

  test("the caller's own gate is asked again when the answer lands", async () => {
    let resolve!: (value: any) => void;
    const h = harness(() => new Promise(done => { resolve = done; }));
    h.worker.update([row("c")], []);
    await pause();
    h.revoke();
    resolve({ messages: [message("secret", "c")] });
    await pause();
    expect(h.ingested).toHaveLength(0);
  });

  test("a failure is reported once, never retried in a loop, and blocks no other room", async () => {
    const h = harness(async target => {
      if (target.channelId === "bad") throw new Error("offline");
      return { messages: [message(target.messageId, target.channelId)] };
    });
    const rail = [row("bad", undefined, 2), row("good")];
    h.worker.update(rail, []);
    await pause();
    for (let i = 0; i < 10; i++) h.worker.update(rail, []);
    await pause(CHAT_PREFETCH_INTERVAL + 20);
    expect(h.errors).toHaveLength(1);
    expect(h.calls).toHaveLength(2);
    expect(h.cache["good-tip"]).toBeDefined();
  });
});

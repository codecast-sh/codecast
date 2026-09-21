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
const pause = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const workers: ReturnType<typeof createChatPrefetcher>[] = [];
afterEach(() => { for (const worker of workers.splice(0)) worker.dispose(); });

function harness(load?: (target: ChatPrefetchTarget) => Promise<any>) {
  const cache: Record<string, ChatMessageRow> = {};
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

describe("chat background prefetch", () => {
  test("cold catch-up is bounded, newest first, and skips read or muted channels", () => {
    const rail = Array.from({ length: 1_000 }, (_, i) => row(`c${i}`, undefined, i));
    rail.push({ ...row("muted", undefined, 2000), notify_level: "none" }, { ...row("read", undefined, 2000), unread: 0 });
    const targets = chatPrefetchTargets(rail, [], () => undefined);
    expect(targets.length).toBe(8);
    expect(targets[0].channelId).toBe("c999");
    expect(targets.at(-1)?.channelId).toBe("c992");
  });

  test("notifications warm muted channels, but never inaccessible rooms or non-chat notifications", () => {
    const rail = [{ ...row("allowed"), notify_level: "none" as const }];
    const targets = chatPrefetchTargets(rail, [notification("allowed", "reply"), notification("revoked", "secret"), { ...notification("allowed", "old"), read: true }, { ...notification("allowed", "task"), entity_type: "task" }], () => undefined);
    expect(targets.map(t => t.id).sort()).toEqual(["allowed", "reply"]);
  });

  test("many notifications for one known thread collapse to its latest reply", () => {
    const targets = chatPrefetchTargets([row("c", "newest", 50, "root")], Array.from({ length: 500 }, (_, i) => notification("c", `reply${i}`, i)), id => message(id, "c", "root"));
    expect(targets.filter(t => t.kind === "thread")).toEqual([{ kind: "thread", id: "root", channelId: "c", messageId: "reply499", at: 499 }]);
    expect(targets.filter(t => t.kind === "channel")).toHaveLength(1);
  });

  test("rail thread metadata bypasses the message lookup", () => {
    const targets = chatPrefetchTargets([row("c", "reply", 5, "root")], [notification("c", "reply", 5)], () => undefined);
    expect(targets.map(t => t.kind).sort()).toEqual(["channel", "thread"]);
  });

  test("prefetch populates the cache before a channel mounts and stays idle on unchanged pushes", async () => {
    const h = harness();
    const rail = [row("c")];
    h.worker.update(rail, []);
    await pause();
    expect(h.cache["c-tip"]?.content).toBe("full message");
    for (let i = 0; i < 1_000; i++) h.worker.update(rail.map(r => ({ ...r })), []);
    await pause(CHAT_PREFETCH_INTERVAL + 20);
    expect(h.calls).toHaveLength(1);
  });

  test("only two requests run together and disposal prevents late writes", async () => {
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

  test("a burst replaces queued work and spaces repeated channel fetches", async () => {
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

  test("notification lookup discovers and prefetches its thread without opening chat", async () => {
    const h = harness(async target => target.kind === "message"
      ? { message: message(target.id, "c", "root") }
      : target.kind === "thread"
        ? { root: message("root", "c"), replies: [message("reply", "c", "root"), message("sibling", "c", "root")] }
        : { messages: [message("channel-tip", "c")] });
    h.worker.update([row("c", "channel-tip")], [notification("c", "reply")]);
    await pause(50);
    expect(h.calls.map(t => t.kind).sort()).toEqual(["channel", "message", "thread"]);
    expect(h.cache.sibling).toBeDefined();
  });

  test("access revocation drops in-flight responses and pending requests", async () => {
    let resolve!: (value: any) => void;
    const h = harness(() => new Promise(done => { resolve = done; }));
    h.worker.update([row("c")], []);
    await pause();
    h.revoke();
    h.worker.update([], []);
    resolve({ messages: [message("secret", "c")] });
    await pause();
    expect(h.ingested).toHaveLength(0);
    expect(h.calls).toHaveLength(1);
  });

  test("failures are reported once, do not spin, and do not block other channels", async () => {
    const h = harness(async target => {
      if (target.channelId === "bad") throw new Error("offline");
      return { messages: [message(target.messageId, target.channelId)] };
    });
    const rail = [row("bad", undefined, 2), row("good")];
    h.worker.update(rail, []);
    await pause();
    for (let i = 0; i < 10; i++) h.worker.update(rail, []);
    await pause();
    expect(h.errors).toHaveLength(1);
    expect(h.calls).toHaveLength(2);
    expect(h.cache["good-tip"]).toBeDefined();
  });

  test("a superseded response cannot overwrite the newer target", async () => {
    let resolve!: (value: any) => void;
    const h = harness(() => new Promise(done => { resolve = done; }));
    h.worker.update([row("c", "old", 1)], []);
    await pause();
    h.worker.update([row("c", "new", 2)], []);
    resolve({ messages: [message("old", "c")] });
    await pause();
    expect(h.ingested).toHaveLength(0);
  });
});

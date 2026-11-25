// The feeder for the reply being written in one conversation (replyStreams.get)
// into the store's replyStreams collection: one row per conversation, keyed by
// the row's own conversation id, stamped with when THIS browser received it
// (replyStreamReceivedAt). Staleness is judged by that stamp, never by
// comparing the daemon's clock with ours.
//
// Bespoke rather than useSyncCollection: a coalesced apply runs after the view
// may have moved to another conversation, with that conversation's callback.
// So every answer is tagged, when it arrives, with the conversation it answers,
// and the apply reads only the tag: an answer for A writes or drops A's row,
// never B's.
//
// It also holds the lease that makes the server write pushes at all: while
// this feeder is live and the page is visible, it renews replyStreams.watch
// for the conversation (createReplyStreamWatcher).
import { useMemo } from "react";
import { useMutation } from "convex/react";
import { getFunctionName } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { REPLY_STREAM_WATCH_RENEW_MS, type ReplyStreamRow } from "@codecast/shared/contracts";
import { isConvexId, useInboxStore } from "../store/inboxStore";
import { replyStreamReceivedAt } from "../lib/replyStreamHandoff";
import { useConvexSync } from "./useConvexSync";
import { useFeederError } from "./useSyncCollection";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useServerAuthSettled } from "./useServerAuthSettled";
import { useWatchEffect } from "./useWatchEffect";

// Pushes come a line at a time; a short window folds a burst into one apply,
// and while the person types the apply waits for a pause (useConvexSync).
const COALESCE_MS = 100;

type TaggedAnswer = { conversationId: string; row: ReplyStreamRow | null };

/** Apply one answer to the store. A row that names another conversation than
 *  the one asked about is ignored. */
export function applyReplyStreamAnswer({ conversationId, row }: TaggedAnswer, now: number = Date.now()): void {
  const store = useInboxStore.getState();
  if (!row) {
    if (store.replyStreams[conversationId]) store.dropRows("replyStreams", [conversationId]);
    return;
  }
  if (row.conversation_id !== conversationId) return;
  const held = store.replyStreams[conversationId];
  store.syncTable("replyStreams", [{ ...row, _id: conversationId, received_at: replyStreamReceivedAt(held, row, now) }]);
}

export type ReplyStreamWatcherDeps = {
  now: () => number;
  /** One renewal (replyStreams.watch). Its failure is swallowed here. */
  send: () => Promise<unknown>;
  /** Whether the page is on screen; a hidden page renews nothing. */
  visible: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

/**
 * The lease that tells the server this conversation is on screen, so the
 * daemon's pushes are written (replyStreams.watch): renewed at once, then
 * every REPLY_STREAM_WATCH_RENEW_MS while the page is visible. Becoming
 * visible renews at once when the last renewal is that old. Each renewal
 * restarts the clock. A heartbeat, not a user action: no store write, and a
 * failed call (a backend without the function yet) is silent and the clock
 * carries on. Free of React and the DOM so its timing runs under bun.
 */
export function createReplyStreamWatcher(deps: ReplyStreamWatcherDeps) {
  let lastSent = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;
  let stopped = false;
  const schedule = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = deps.setTimer(() => {
      timer = null;
      if (stopped) return;
      if (deps.visible()) renew();
      else schedule();
    }, REPLY_STREAM_WATCH_RENEW_MS);
  };
  const renew = () => {
    lastSent = deps.now();
    try {
      deps.send().catch(() => {});
    } catch {
      // A synchronous throw is as silent as a rejection.
    }
    schedule();
  };
  return {
    start() {
      if (deps.visible()) renew();
      else schedule();
    },
    visibilityChanged() {
      if (stopped || !deps.visible()) return;
      if (deps.now() - lastSent >= REPLY_STREAM_WATCH_RENEW_MS) renew();
    },
    stop() {
      stopped = true;
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
    },
  };
}

export function useSyncReplyStream(conversationId: string, on: boolean): void {
  // Held at "skip" until the server has confirmed the caller (useSyncCollection).
  const authSettled = useServerAuthSettled();
  const args = on && authSettled && isConvexId(conversationId) ? { conversation_id: conversationId as Id<"conversations"> } : "skip";
  // The lease, under the same conditions as the subscription; a new
  // conversation starts its own at once, and the old one's stops.
  const watch = useMutation(api.replyStreams.watch);
  const watching = args === "skip" ? null : conversationId;
  useWatchEffect(() => {
    if (!watching || typeof document === "undefined") return;
    const watcher = createReplyStreamWatcher({
      now: () => Date.now(),
      send: () => watch({ conversation_id: watching as Id<"conversations"> }),
      visible: () => document.visibilityState === "visible",
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const onVisibility = () => watcher.visibilityChanged();
    document.addEventListener("visibilitychange", onVisibility);
    watcher.start();
    return () => {
      watcher.stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [watching, watch]);
  const { data, error } = useQueryNoThrow(api.replyStreams.get, args);
  useFeederError(getFunctionName(api.replyStreams.get), error);
  // `data` is always the answer for the args of this render, so the tag is
  // taken here, never at apply time.
  const tagged = useMemo<TaggedAnswer | undefined>(
    () => (data === undefined ? undefined : { conversationId, row: data }),
    [data, conversationId],
  );
  useConvexSync(tagged, applyReplyStreamAnswer, { coalesceMs: COALESCE_MS });
}

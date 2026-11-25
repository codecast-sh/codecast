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
// this feeder is live and its pane and the page are visible, it renews
// replyStreamLease.watch for the conversation (createReplyStreamWatcher).
import { useContext, useMemo } from "react";
import { useMutation } from "convex/react";
import { getFunctionName } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { REPLY_STREAM_WATCH_RENEW_MS, type ReplyStreamRow } from "@codecast/shared/contracts";
import { isConvexId, useInboxStore } from "../store/inboxStore";
import { replyStreamReceivedAt } from "../lib/replyStreamHandoff";
import { TabParamsCtx } from "../lib/tabParams";
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
  /** One renewal (replyStreamLease.watch). Its failure is swallowed here. */
  send: () => Promise<unknown>;
  /** Whether the page is on screen; a hidden page renews nothing. */
  visible: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

/** How long a conversation stays on screen before its first lease, so
 *  flicking through conversations (j/k) takes none for those passed. */
export const REPLY_STREAM_WATCH_DWELL_MS = 1_000;

/**
 * The lease that tells the server this conversation is on screen, so the
 * daemon's pushes are written (replyStreamLease.watch): taken after
 * REPLY_STREAM_WATCH_DWELL_MS, then renewed every REPLY_STREAM_WATCH_RENEW_MS
 * while the page is visible. `recheck` (the page shown again, or a wake from
 * sleep: focus, online, pageshow) renews at once when the last renewal is that
 * old by the wall clock, since timers stop while a laptop sleeps. Each renewal
 * restarts the clock. A heartbeat, not a user action: no store write, and a
 * failed call (a backend without the function yet) is silent and the clock
 * carries on. Free of React and the DOM so its timing runs under bun.
 */
export function createReplyStreamWatcher(deps: ReplyStreamWatcherDeps) {
  let lastSent = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;
  let stopped = false;
  let dwelling = false;
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
      dwelling = true;
      timer = deps.setTimer(() => {
        timer = null;
        dwelling = false;
        if (stopped) return;
        if (deps.visible()) renew();
        else schedule();
      }, REPLY_STREAM_WATCH_DWELL_MS);
    },
    recheck() {
      if (stopped || dwelling || !deps.visible()) return;
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
  // A visited in-app tab, or a folded pane of a split, stays mounted hidden.
  // It neither subscribes nor holds the lease: ten open tabs would otherwise
  // keep ten conversations' pushes flowing. When it shows again the row the
  // store kept is judged by when it was received, so a reply that went quiet
  // meanwhile reads as stale rather than drawn afresh.
  const tab = useContext(TabParamsCtx);
  const paneVisible = tab ? tab.isVisible ?? tab.isActive : true;
  const args = on && authSettled && paneVisible && isConvexId(conversationId) ? { conversation_id: conversationId as Id<"conversations"> } : "skip";
  // The lease, under the same conditions as the subscription, while the
  // document is visible too; a new conversation (or a pane shown again) starts
  // its own after the dwell, and the old one's stops.
  const watch = useMutation(api.replyStreamLease.watch);
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
    const recheck = () => watcher.recheck();
    document.addEventListener("visibilitychange", recheck);
    // A wake from sleep: timers were paused, the lease may have lapsed, and
    // no visibilitychange is promised.
    const WAKE = ["focus", "online", "pageshow"] as const;
    for (const e of WAKE) window.addEventListener(e, recheck);
    watcher.start();
    return () => {
      watcher.stop();
      document.removeEventListener("visibilitychange", recheck);
      for (const e of WAKE) window.removeEventListener(e, recheck);
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

import { useCallback, useMemo, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useTrackedStore } from "../store/inboxStore";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { isConvexId } from "../lib/entityLinks";
import type { ChatMember } from "../lib/chatViews";

import { useWatchEffect } from "./useWatchEffect";
// Typing presence, client half. Deliberately OUTSIDE the store: these rows
// live for seconds, nothing persists them, and their only reader is the
// composer strip of the channel on screen. Running them through syncTable/IDB
// would persist ghosts and wake subscribers app-wide for a signal two
// components care about.
//
// Freshness is the client's job. The server's list query only re-runs when a
// row CHANGES — a row abandoned by a closed tab never re-runs anything — so a
// local ticker ages rows out against the client clock. TTL is generous versus
// the reporter's refresh interval to ride out clock skew and slow networks.

/** Hide rows not refreshed within this window. */
const TYPING_TTL_MS = 8_000;
/** Reporters re-stamp at most this often while input events keep arriving. */
const REPORT_EVERY_MS = 2_500;
/** The ticker that ages rows out; only runs while somebody is typing. */
const TICK_MS = 1_000;

// ── Reporting (the composer's half) ─────────────────────────────────────────

/**
 * Report "the viewer is typing here" from input events, throttled, and clear
 * it on send/unmount/scope change. Fire-and-forget: typing presence must never
 * block the composer, so failures (offline, undeployed backend) are swallowed.
 */
export function useTypingReporter(
  channelId: string | undefined,
  threadRootId?: string,
): { onTyping: () => void; stop: () => void } {
  const convex = useConvex();
  const lastSentRef = useRef(0);
  // The scope the last report went to, so switching channels clears the old one.
  const scopeRef = useRef<{ channelId: string; threadRootId?: string } | null>(null);

  const stop = useCallback(() => {
    const scope = scopeRef.current;
    scopeRef.current = null;
    lastSentRef.current = 0;
    if (!scope) return;
    void convex
      .mutation(api.chatTyping.clear, { channel_id: scope.channelId as any })
      .catch(() => {});
  }, [convex]);

  const onTyping = useCallback(() => {
    if (!channelId || !isConvexId(channelId)) return;
    const now = Date.now();
    if (now - lastSentRef.current < REPORT_EVERY_MS) return;
    lastSentRef.current = now;
    scopeRef.current = { channelId, threadRootId };
    void convex
      .mutation(api.chatTyping.set, {
        channel_id: channelId as any,
        ...(threadRootId && isConvexId(threadRootId)
          ? { thread_root_id: threadRootId as any }
          : {}),
      })
      .catch(() => {});
  }, [convex, channelId, threadRootId]);

  // Leaving the box (channel switch, thread close, unmount) is a stop: the row
  // would age out anyway, but deleting it now is what makes the indicator drop
  // instantly for everyone else.
  useWatchEffect(() => stop, [stop, channelId, threadRootId]);

  return { onTyping, stop };
}

// ── Watching (the indicator's half) ─────────────────────────────────────────

const NO_MEMBERS: ChatMember[] = [];

/**
 * Who is typing in this scope (channel floor, or one thread), excluding the
 * viewer, resolved against the live roster. One server subscription per
 * channel — the floor and every thread panel share it via Convex's per-args
 * subscription dedupe.
 */
export function useTypingMembers(
  channelId: string | undefined,
  threadRootId?: string,
): ChatMember[] {
  const subscribable = !!channelId && isConvexId(channelId);
  const { data } = useQueryNoThrow(
    api.chatTyping.list,
    subscribable ? { channel_id: channelId as any } : "skip",
  );

  // Age rows out locally; the ticker only runs while rows exist.
  const [, setTick] = useState(0);
  const rowCount: number = data?.length ?? 0;
  useWatchEffect(() => {
    if (rowCount === 0) return;
    const t = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(t);
  }, [rowCount]);

  const s = useTrackedStore([
    (st: any) => st.teamMembers,
    (st: any) => st.currentUser?._id,
  ]);
  const viewerId = String(s.currentUser?._id ?? "");
  const members: ChatMember[] = s.teamMembers ?? [];

  const wantKey = threadRootId ?? "";
  const cutoff = Date.now() - TYPING_TTL_MS;
  const fresh = (data ?? []).filter(
    (r: any) =>
      r.thread_key === wantKey &&
      r.updated_at > cutoff &&
      String(r.user_id) !== viewerId,
  );

  // Stable identity while the SET of typists is unchanged, so the memo'd
  // composer strip doesn't re-render on every ticker beat.
  const ids = fresh
    .map((r: any) => String(r.user_id))
    .sort()
    .join(",");
  return useMemo(() => {
    if (!ids) return NO_MEMBERS;
    const byId = new Map(members.map((m) => [String(m._id), m]));
    return ids
      .split(",")
      .map((id) => byId.get(id) ?? ({ _id: id } as ChatMember));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, members]);
}

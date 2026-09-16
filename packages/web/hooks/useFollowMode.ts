"use client";

import { useRef } from "react";
import { useMutation } from "convex/react";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { FOLLOW_RENEW_MS } from "@codecast/convex/convex/follow";
import { useInboxStore } from "../store/inboxStore";
import { subscribeNavEvents } from "../store/viewNav";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";
import { useOpenSession } from "./useOpenSession";
import { viewedConversationId } from "./usePresenceReporter";
import { followersSig, planFollowApply, samePath, shouldEndFollow } from "../lib/follow";

// Follow mode, both sides, mounted once in the dashboard.
//
// Follower: while `followLeaderId` is set, hold the lease (renewed every
// FOLLOW_RENEW_MS, dropped on stop), subscribe to the leader's view, and apply
// each report as the person would have moved: a route push, the app's one
// session path, a scroll to the leader's message. An apply lands as a
// gesture navigation of this window's own, so the hook remembers the exact
// target it asked for: a gesture that lands anywhere else, a route the person
// took themselves, or any wheel, touch or paging key (a programmatic scroll
// fires none of those) is the person moving on their own, and ends the
// follow, as in Figma.
//
// Leader: while anyone holds a lease, report the view about four times a
// second at most: the real pathname, the conversation on screen (the same
// rule the presence reporter uses), and the transcript anchor the
// conversation view writes only while followed.

const PAGING_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);

function inEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.("input, textarea, [contenteditable=''], [contenteditable='true']");
}

export function useFollowMode(): void {
  const leaderId = useInboxStore((s) => s.followLeaderId);
  const followMut = useMutation(api.follow.follow);
  const unfollowMut = useMutation(api.follow.unfollow);
  const reportMut = useMutation(api.follow.reportView);
  const router = useRouter();
  const pathname = usePathname();
  const openSession = useOpenSession();

  // ── follower: the lease ──
  useWatchEffect(() => {
    if (!leaderId) return;
    const renew = () => followMut({ leader_id: leaderId as Id<"users"> }).catch(() => {});
    renew();
    const iv = setInterval(renew, FOLLOW_RENEW_MS);
    return () => {
      clearInterval(iv);
      unfollowMut({}).catch(() => {});
    };
  }, [leaderId, followMut, unfollowMut]);

  // ── follower: the leader's view, applied ──
  const view = useQueryNoThrow(api.follow.viewOf, leaderId ? { leader_id: leaderId as Id<"users"> } : "skip").data ?? null;
  const appliedRef = useRef("");
  // What the last apply asked for: the session, or the route. A move of this
  // window's own is one that lands somewhere else.
  const expectedConvRef = useRef<string | null>(null);
  const expectedPathRef = useRef<string | null>(null);
  const viewSig = view ? `${view.updated_at}|${view.withheld}|${view.path}|${view.conversation_id ?? ""}|${view.anchor?.message_id ?? ""}` : "";
  useWatchEffect(() => {
    if (!leaderId || !view) return;
    const st = useInboxStore.getState();
    const here = typeof window !== "undefined" ? window.location.pathname : pathname;
    const plan = planFollowApply(view, {
      pathname: here,
      conversationId: viewedConversationId(st as any, pathname),
      anchorMessageId: appliedRef.current.startsWith("session:") ? appliedRef.current.split(":")[2] || null : null,
    });
    st.setFollowBlocked(plan.kind === "blocked");
    if (plan.kind === "blocked" || plan.kind === "stay") return;
    const sig = plan.kind === "route" ? `route:${plan.path}` : `session:${plan.conversationId}:${plan.scrollTo ?? ""}`;
    if (sig === appliedRef.current) return;
    appliedRef.current = sig;
    if (plan.kind === "route") {
      expectedConvRef.current = null;
      expectedPathRef.current = plan.path;
      router.push(plan.path);
      return;
    }
    expectedConvRef.current = plan.conversationId;
    expectedPathRef.current = null;
    openSession(plan.conversationId);
    if (plan.scrollTo) st.requestNavigate(plan.conversationId, { scrollToMessageId: plan.scrollTo, source: "follow" });
  }, [leaderId, viewSig]);

  // ── follower: the person's own move ends it ──
  useWatchEffect(() => {
    if (!leaderId) {
      appliedRef.current = "";
      expectedConvRef.current = null;
      expectedPathRef.current = null;
      return;
    }
    const end = () => useInboxStore.getState().setFollowLeader(null);
    const unsubNav = subscribeNavEvents((e) => {
      if (!e.blocked && shouldEndFollow(e.source, e.to, expectedConvRef.current)) end();
    });
    const onScroll = () => end();
    const onKey = (e: KeyboardEvent) => {
      if (PAGING_KEYS.has(e.key) && !inEditable(e.target)) onScroll();
    };
    window.addEventListener("wheel", onScroll, { passive: true, capture: true });
    window.addEventListener("touchmove", onScroll, { passive: true, capture: true });
    window.addEventListener("keydown", onKey, true);
    return () => {
      unsubNav();
      window.removeEventListener("wheel", onScroll, { capture: true } as any);
      window.removeEventListener("touchmove", onScroll, { capture: true } as any);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [leaderId]);

  // A route the person took themselves (a rail click, a link) is a move too:
  // after an apply, this window is either on the applied route or has the
  // applied session on screen; a pathname that shows neither is the person.
  useWatchEffect(() => {
    if (!leaderId || !appliedRef.current || !pathname) return;
    if (expectedPathRef.current) {
      if (!samePath(pathname, expectedPathRef.current.split("?")[0] ?? "")) useInboxStore.getState().setFollowLeader(null);
      return;
    }
    if (expectedConvRef.current) {
      const st = useInboxStore.getState();
      if (viewedConversationId(st as any, pathname) !== expectedConvRef.current) useInboxStore.getState().setFollowLeader(null);
    }
  }, [pathname]);

  // ── leader: who follows me, and my place while they do ──
  const followers = useQueryNoThrow(api.follow.followersOf, {}).data;
  const followersKey = followersSig(followers as any);
  useWatchEffect(() => {
    useInboxStore.getState().setFollowedBy((followers ?? []).map((f: any) => ({ user_id: String(f.user_id), name: f.name, image: f.image })));
  }, [followersKey]);
  const followed = !!followers && followers.length > 0;
  const viewedId = useInboxStore((s) => (followed ? viewedConversationId(s as any, pathname) : null));
  const anchor = useInboxStore((s) => (followed ? s.viewAnchor : null));
  const anchorKey = anchor ? `${anchor.conversationId}|${anchor.messageId}|${anchor.offset}` : "";
  useWatchEffect(() => {
    if (!followed) return;
    const t = setTimeout(() => {
      const path = typeof window !== "undefined" ? window.location.pathname + window.location.search : pathname ?? "/";
      reportMut({
        path,
        conversation_id: (viewedId as Id<"conversations"> | null) ?? undefined,
        anchor: anchor && viewedId && anchor.conversationId === viewedId ? { message_id: anchor.messageId, offset: anchor.offset } : undefined,
      }).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [followed, pathname, viewedId, anchorKey, reportMut]);
}

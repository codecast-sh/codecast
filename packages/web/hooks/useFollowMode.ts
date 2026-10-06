"use client";

import { useRef } from "react";
import { useMutation } from "convex/react";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { FOLLOW_RENEW_MS } from "@codecast/shared/contracts/follow";
import { useInboxStore } from "../store/inboxStore";
import { subscribeNavEvents } from "../store/viewNav";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";
import { useOpenSession } from "./useOpenSession";
import { isCallPanelWindow } from "../lib/desktop";
import { viewedConversationId } from "./usePresenceReporter";
import { applyFollowView, followersSig, followViewSig, planFollowApply, planViewApply, samePath, shouldEndFollow, subscribeFollowSurfaces, type FollowView } from "../lib/follow";
import { useLeaderView } from "./useFollowSurface";

// Follow mode, both sides, mounted once in the dashboard.
//
// Follower: while `followLeaderId` is set, hold the lease (renewed every
// FOLLOW_RENEW_MS, dropped on stop), subscribe to the leader's view, and apply
// each report as the person would have moved: a route push, the app's one
// session path, a scroll to the leader's message, and then the place inside
// the page (the open panel, the diff file and line, a region's scroll), which
// the page's own surfaces take (lib/follow.ts, hooks/useFollowSurface.ts),
// waiting for them while the page mounts. An apply lands as a
// gesture navigation of this window's own, so the hook remembers the exact
// target it asked for: a gesture that lands anywhere else, a route the person
// took themselves, or any wheel, touch or paging key (a programmatic scroll
// fires none of those) is the person moving on their own, and ends the
// follow, as in Figma.
//
// Leader: while anyone holds a lease, report the view about four times a
// second at most and only when it changed: the real pathname, the
// conversation on screen (the same rule the presence reporter uses), the
// transcript anchor the conversation view writes only while followed, and the
// in-page view the mounted surfaces compose (useLeaderView).

const REPORT_MS = 250;
/** How long in-page parts wait for their surface to mount after a move. */
const PENDING_VIEW_MS = 10_000;

const PAGING_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);

function inEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.("input, textarea, [contenteditable=''], [contenteditable='true']");
}

/** The one window that follows: not the huddle window, not the palette. The
 *  others only mirror the state for their faces and pills. */
function isFollowHost(): boolean {
  if (typeof window === "undefined") return false;
  if (isCallPanelWindow()) return false;
  return !window.location?.pathname?.startsWith("/palette");
}

export function useFollowMode(): void {
  const host = isFollowHost();
  const leaderId = useInboxStore((s) => (host ? s.followLeaderId : null));
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
  // The in-page parts last handed to the surfaces on this page, and those no
  // surface has taken yet (the page is still mounting).
  const appliedViewRef = useRef<FollowView | null>(null);
  const pendingViewRef = useRef<{ view: FollowView; until: number; ready: () => boolean } | null>(null);
  const viewSig = view ? `${view.updated_at}|${view.withheld}|${view.path}|${view.conversation_id ?? ""}|${view.anchor?.message_id ?? ""}|${followViewSig(view.view)}` : "";
  useWatchEffect(() => {
    if (!leaderId || !view) return;
    const st = useInboxStore.getState();
    const here = typeof window !== "undefined" ? window.location.pathname : pathname;
    const plan = planFollowApply(view, {
      pathname: here,
      conversationId: viewedConversationId(st as any, pathname),
      anchorMessageId: appliedRef.current.startsWith("session:") ? appliedRef.current.split(":")[2] || null : null,
      appliedView: appliedViewRef.current,
    });
    st.setFollowBlocked(plan.kind === "blocked");
    if (plan.kind === "blocked") return;
    const sig = plan.kind === "route" ? `route:${plan.path}` : plan.kind === "session" ? `session:${plan.conversationId}:${plan.scrollTo ?? ""}` : appliedRef.current;
    let parts = plan.view;
    // After a move, the old page's surfaces are still mounted for a moment:
    // the parts wait until this window is on the page they belong to.
    let ready: () => boolean = () => true;
    // A move already made (a route whose query this pathname cannot show)
    // is the same page: only what changed in it applies.
    if (sig === appliedRef.current && plan.kind !== "stay") parts = planViewApply(view.view, appliedViewRef.current);
    else if (sig !== appliedRef.current) {
      const samePage = plan.kind === "session" && appliedRef.current.startsWith(`session:${plan.conversationId}:`);
      appliedRef.current = sig;
      if (!samePage) appliedViewRef.current = null;
      if (plan.kind === "route") {
        expectedConvRef.current = null;
        expectedPathRef.current = plan.path;
        router.push(plan.path);
        const target = plan.path.split(/[?#]/)[0] ?? plan.path;
        ready = () => samePath(window.location.pathname, target);
      } else if (plan.kind === "session") {
        expectedConvRef.current = plan.conversationId;
        expectedPathRef.current = null;
        openSession(plan.conversationId);
        if (plan.scrollTo) st.requestNavigate(plan.conversationId, { scrollToMessageId: plan.scrollTo, source: "follow" });
        const conversationId = plan.conversationId;
        if (!samePage) ready = () => viewedConversationId(useInboxStore.getState() as any, window.location.pathname) === conversationId;
      }
    }
    if (!parts) return;
    appliedViewRef.current = { ...appliedViewRef.current, ...parts };
    pendingViewRef.current = { view: parts, until: Date.now() + PENDING_VIEW_MS, ready };
    flushPendingView();
  }, [leaderId, viewSig]);

  // Parts no surface took yet go to each surface as it mounts, or on a short
  // poll for a page that reuses its surfaces across ids (one doc to the next).
  function flushPendingView() {
    const pending = pendingViewRef.current;
    if (!pending) return;
    if (Date.now() > pending.until) {
      pendingViewRef.current = null;
      return;
    }
    if (!pending.ready()) return;
    // Cleared before applying: an apply that scrolls notifies again.
    pendingViewRef.current = null;
    const left = applyFollowView(pending.view);
    if (left) pendingViewRef.current = { ...pending, view: left };
  }
  useWatchEffect(() => {
    if (!leaderId) {
      appliedViewRef.current = null;
      pendingViewRef.current = null;
      return;
    }
    const unsub = subscribeFollowSurfaces(flushPendingView);
    const iv = setInterval(flushPendingView, 200);
    return () => {
      unsub();
      clearInterval(iv);
    };
  }, [leaderId]);

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
  const followers = useQueryNoThrow(api.follow.followersOf, host ? {} : "skip").data;
  const followersKey = followersSig(followers as any);
  useWatchEffect(() => {
    useInboxStore.getState().setFollowedBy((followers ?? []).map((f: any) => ({ user_id: String(f.user_id), name: f.name, image: f.image })));
  }, [followersKey]);
  const followed = !!followers && followers.length > 0;
  const viewedId = useInboxStore((s) => (followed ? viewedConversationId(s as any, pathname) : null));
  const anchor = useInboxStore((s) => (followed ? s.viewAnchor : null));
  const anchorKey = anchor ? `${anchor.conversationId}|${anchor.messageId}|${anchor.offset}` : "";
  const leaderView = useLeaderView(followed);
  // Trailing throttle: a leader scrolling steadily streams a report every
  // REPORT_MS rather than one when they stop, and the report carries the
  // latest values when it fires. Nothing goes out when nothing changed.
  const latestRef = useRef<() => Parameters<typeof reportMut>[0]>(() => ({ path: "/" }));
  latestRef.current = () => ({
    path: typeof window !== "undefined" ? window.location.pathname + window.location.search : pathname ?? "/",
    conversation_id: (viewedId as Id<"conversations"> | null) ?? undefined,
    anchor: anchor && viewedId && anchor.conversationId === viewedId ? { message_id: anchor.messageId, offset: anchor.offset } : undefined,
    view: leaderView.view,
  });
  const reportRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; at: number; sent: string }>({ timer: null, at: 0, sent: "" });
  useWatchEffect(() => {
    const r = reportRef.current;
    if (!followed) {
      if (r.timer) clearTimeout(r.timer);
      reportRef.current = { timer: null, at: 0, sent: "" };
      return;
    }
    if (r.timer) return;
    r.timer = setTimeout(() => {
      r.timer = null;
      const args = latestRef.current();
      const sig = JSON.stringify(args);
      if (sig === r.sent) return;
      r.sent = sig;
      r.at = Date.now();
      reportMut(args).catch(() => {});
    }, Math.max(0, REPORT_MS - (Date.now() - r.at)));
  }, [followed, pathname, viewedId, anchorKey, leaderView.sig, reportMut]);
  useWatchEffect(() => () => {
    const r = reportRef.current;
    if (r.timer) clearTimeout(r.timer);
  }, []);
}

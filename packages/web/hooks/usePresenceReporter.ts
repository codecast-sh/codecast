import { useRef } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { usePathname } from "next/navigation";
import { api } from "@codecast/convex/convex/_generated/api";
import { INPUT_ACTIVE_MS } from "@codecast/convex/convex/presenceState";
import { getIdleMs, installDesktopInputTracker, isElectron } from "../lib/desktop";
import { isConvexId, mountedPathname, useInboxStore } from "../store/inboxStore";
import { sessionFocusKind } from "../lib/inboxRouting";

import { useWatchEffect } from "./useWatchEffect";
// Tell the server a human is at this desktop surface (pushRouter.reportPresence).
// The server uses it to keep mobile pushes quiet while you're actually here, so
// the fidelity bar is low: a coarse heartbeat with input recency. Electron
// reports OS-wide idle (correct even while Codecast is unfocused); a browser
// tab reports only in-page input and stops entirely while hidden, letting
// presence go stale on its own — same as when the machine sleeps.
//
// The same report names the conversation this window has open, so teammates
// see who is in a session (teams.getTeamMembers viewing_conversation_id). A
// change of that view goes out within VIEW_THROTTLE_MS instead of waiting for
// the heartbeat; a window blurred for longer than the presence idle threshold
// reports no view, and focus brings it back.
const HEARTBEAT_MS = 30_000;
const MIN_GAP_MS = 10_000;
export const VIEW_THROTTLE_MS = 2_000;
export const VIEW_BLUR_CLEAR_MS = INPUT_ACTIVE_MS;

export type PresenceReport = {
  focused: boolean;
  idle_ms: number;
  viewing_conversation_id?: string;
};

/**
 * The conversation on screen, as the store can see it, or null. Follows the
 * rail's own focus rule (sessionFocusKind): on the inbox it is the attended
 * conversation (a dismissed one being read, else the current one); on a
 * /conversation/<id> page it is the id in the path; everywhere else nothing
 * is open. Only a real Convex id is reported: an optimistic stub has no row
 * a teammate could open.
 */
export function viewedConversationId(
  state: {
    activeTabId: string | null;
    tabs: { id: string; path: string }[];
    currentSessionId: string | null;
    viewingDismissedId: string | null;
    sessions: Record<string, { _id?: string } | undefined>;
    currentConversation?: { source?: string };
  },
  fallbackPathname?: string | null,
): string | null {
  const pathname = state.activeTabId ? mountedPathname(state as any) : fallbackPathname ?? undefined;
  const kind = sessionFocusKind(pathname, state.currentConversation?.source);
  let id: string | undefined;
  if (kind === "current") {
    const key = state.viewingDismissedId ?? state.currentSessionId;
    id = key ? state.sessions[key]?._id ?? key : undefined;
  } else if (kind === "url") {
    id = pathname?.split("/conversation/")[1]?.split(/[/?#]/)[0];
  }
  return id && isConvexId(id) ? id : null;
}

export type PresenceReporterDeps = {
  now: () => number;
  send: (report: PresenceReport) => void;
  /** Time since the last input, given the floor set by the last window focus. */
  idleMs: (activityFloor: number) => Promise<number>;
  /** Whether a report may go out at all (a hidden browser tab stays silent). */
  canSend: () => boolean;
  focused: () => boolean;
  viewing: () => string | null;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

/**
 * The timing rules of one reporting window, free of React and the DOM so
 * they run under bun. `heartbeat` is the regular beat (MIN_GAP_MS between
 * sends). `viewChanged` sends promptly when the view it would report differs
 * from the last one sent, throttled to VIEW_THROTTLE_MS with a trailing send
 * so the final view always lands. `blur` starts the clock after which the
 * report stops naming a view; `focus` restores it.
 */
export function createPresenceReporter(deps: PresenceReporterDeps) {
  let activityFloor = deps.focused() ? deps.now() : 0;
  let lastSent = 0;
  let lastSentView: string | null | undefined;
  let blurredAt: number | null = deps.focused() ? null : deps.now();
  let stopped = false;
  let trailing: unknown = null;
  let blurTimer: unknown = null;

  const effectiveView = (): string | null => {
    if (blurredAt !== null && deps.now() - blurredAt >= VIEW_BLUR_CLEAR_MS) return null;
    return deps.viewing();
  };

  const dispatch = async () => {
    if (stopped || !deps.canSend()) return;
    lastSent = deps.now();
    const idleMs = await deps.idleMs(activityFloor);
    if (stopped) return;
    const view = effectiveView();
    lastSentView = view;
    deps.send({
      focused: deps.focused(),
      idle_ms: Math.min(Math.round(idleMs), Number.MAX_SAFE_INTEGER),
      ...(view ? { viewing_conversation_id: view } : {}),
    });
  };

  const heartbeat = () => {
    if (deps.now() - lastSent < MIN_GAP_MS) return;
    void dispatch();
  };

  const viewChanged = () => {
    if (stopped || !deps.canSend()) return;
    if (effectiveView() === lastSentView) return;
    const wait = VIEW_THROTTLE_MS - (deps.now() - lastSent);
    if (wait <= 0) {
      void dispatch();
      return;
    }
    if (trailing !== null) return;
    trailing = deps.setTimer(() => {
      trailing = null;
      viewChanged();
    }, wait);
  };

  const clearBlurTimer = () => {
    if (blurTimer !== null) deps.clearTimer(blurTimer);
    blurTimer = null;
  };

  return {
    heartbeat,
    viewChanged,
    focus() {
      activityFloor = deps.now();
      blurredAt = null;
      clearBlurTimer();
      viewChanged();
      heartbeat();
    },
    blur() {
      if (blurredAt !== null) return;
      blurredAt = deps.now();
      clearBlurTimer();
      blurTimer = deps.setTimer(() => {
        blurTimer = null;
        viewChanged();
      }, VIEW_BLUR_CLEAR_MS);
    },
    stop() {
      stopped = true;
      clearBlurTimer();
      if (trailing !== null) deps.clearTimer(trailing);
      trailing = null;
    },
  };
}

export function usePresenceReporter() {
  const report = useMutation(api.pushRouter.reportPresence);
  // Providers mounts this on every page, marketing included — only signed-in
  // users have presence worth reporting (the server no-ops anyway, but don't
  // send anonymous write traffic at all).
  const { isAuthenticated } = useConvexAuth();
  // Outside a tab shell the route is the real location, which no store write
  // announces; the pathname makes a plain navigation recompute the view.
  const pathname = usePathname();
  const viewing = useInboxStore((s) => viewedConversationId(s, pathname));
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;
  const reporterRef = useRef<ReturnType<typeof createPresenceReporter> | null>(null);

  useWatchEffect(() => {
    if (typeof window === "undefined" || !isAuthenticated) return;
    installDesktopInputTracker();

    const reporter = createPresenceReporter({
      now: Date.now,
      send: (r) => {
        report(r as any).catch(() => {});
      },
      idleMs: getIdleMs,
      canSend: () => isElectron() || document.visibilityState === "visible",
      // Focusing the app is activity the in-page input tracker can't see — the
      // click that focused the window can land on the dock or another screen.
      focused: () => document.hasFocus(),
      viewing: () => viewingRef.current,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (h) => window.clearTimeout(h as number),
    });
    reporterRef.current = reporter;

    const onFocus = () => reporter.focus();
    const onBlur = () => reporter.blur();
    const onVisibility = () => {
      if (document.visibilityState === "visible") reporter.focus();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    const interval = window.setInterval(() => reporter.heartbeat(), HEARTBEAT_MS);
    reporter.heartbeat();

    return () => {
      reporter.stop();
      reporterRef.current = null;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(interval);
    };
  }, [report, isAuthenticated]);

  useWatchEffect(() => {
    reporterRef.current?.viewChanged();
  }, [viewing]);
}

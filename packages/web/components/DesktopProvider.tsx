import { withInboxView } from "../lib/inboxViewHistory";
import { useEffect, useRef, useState } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useRouter } from "next/navigation";
import { useLocation } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import {
  isDesktop,
  updateBadge,
  onDeepLink,
  checkDesktopUpdate,
  onUpdateStatus,
  restartForUpdate,
  checkForUpdate,
  hasInProcessUpdater,
  notifyNative,
  requestNotificationPermission,
  hasBrowserNotificationPermission,
  parseDesktopDeepLinkPath,
  extractDeepLinkIntent,
  installDesktopInputTracker,
  shouldApplyAutoDeepLink,
  conversationIdFromPath,
  installWindowRoleTracker,
  reportDesktopWindowState,
  isDetachedTabWindow,
  onCallPanelHandback,
  onVoiceMirror,
} from "../lib/desktop";
import { cleanNotificationBody } from "../lib/notificationText";
import { notificationRoute } from "../lib/notificationTypes";
import { recordNotificationMiss } from "../lib/notificationNudge";
import { useOsPermission } from "../hooks/useOsPermissions";
import { soundChatMessage } from "../lib/sounds";
import { useInboxStore } from "../store/inboxStore";
import { useNeedsInputCount } from "../hooks/useNeedsInputCount";
import { usePresenceReporter } from "../hooks/usePresenceReporter";

// A native banner is for something that JUST happened. Rows older than this at
// the time we first see them (a sleep/offline gap replaying on reconnect) stay
// in the bell but don't banner — the phone already covered the away window,
// and a wake shouldn't replay a storm of stale banners on top.
const BANNER_FRESH_MS = 3 * 60_000;

// A seat the WALKIE holds — a burst being spoken or heard — is not a huddle.
// Reported as one, every other window would say "in a huddle in another
// window" for the length of a sentence somebody is speaking into a DM.
//
// The engine is loaded lazily, on the desktop only: this provider wraps every
// page, and the walkie pulls the media stack in with it.
let walkie: typeof import("../lib/calls/walkie") | null = null;
function inHuddle(st: any): boolean {
  if (st.call?.phase !== "connected") return false;
  if (!walkie) return true;
  return !walkie.walkieHoldsRoom(walkie.getWalkieStatus(), st.call.roomKey ?? null);
}

export function DesktopProvider() {
  const router = useRouter();
  const initRef = useRef(false);
  const [update, setUpdate] = useState<{ current: string; latest: string } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [stalled, setStalled] = useState(false);
  // Real download progress from Electron's own auto-updater (works when
  // Squirrel is alive). The daemon-driven "Update now" path can't report a
  // percentage, so it falls back to the indeterminate bar below.
  const [ipc, setIpc] = useState<{ status: string; version?: string; percent?: number } | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const requestDesktopUpdate = useMutation(api.users.requestDesktopUpdate);

  const startUpdate = () => {
    setStalled(false);
    setUpdating(true);
    setAttempt((a) => a + 1);
    // Newer desktop builds download in-process and report real progress over
    // IPC (the `ipc` state below), then swap + relaunch on "Restart". Older
    // builds lack that, so fall back to the daemon path (silent download +
    // forced restart) — which still ships via the working CLI auto-update
    // channel, so it can at least carry the user to a build that has the
    // in-process updater.
    if (hasInProcessUpdater()) {
      checkForUpdate({ manual: false });
    } else {
      requestDesktopUpdate({}).catch(() => setUpdating(false));
    }
  };

  // Dock badge = the sidebar's NEEDS INPUT count (same hook, so they can't
  // drift): sessions where the ball is in the user's court, mine-scoped, over
  // the authoritative inbox set. It used to count `has_pending || is_idle` over
  // the raw never-prune cache — i.e. every finished session ever synced — which
  // pinned the badge at 99+ forever.
  const needsInputCount = useNeedsInputCount(isDesktop());
  useWatchEffect(() => {
    if (!isDesktop()) return;
    updateBadge(needsInputCount);
  }, [needsInputCount]);

  // Report "a human is at this desktop" so the server holds mobile pushes
  // while you're here (pushRouter.ts). Runs on web and Electron alike.
  usePresenceReporter();

  const notifications = useQuery(api.notifications.list);
  const mountedAtRef = useRef<number>(Date.now());
  const seenIdsRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);

  const permissionRequestedRef = useRef(false);

  // Whether the OS can actually put a banner on screen (System Settings /
  // browser site permission). Read through a ref inside the notification loop
  // — the loop keys on arrivals, not on readiness changes.
  const { readiness } = useOsPermission("notifications");
  const readinessRef = useRef(readiness);
  readinessRef.current = readiness;

  useWatchEffect(() => {
    if (!notifications) return;
    const isPalette = typeof window !== "undefined" && window.location.pathname === "/palette";
    if (isPalette) return;
    const canNotify = isDesktop() || hasBrowserNotificationPermission();

    if (!initializedRef.current) {
      // Seed seen set with all notifications that already existed before mount.
      // We use created_at instead of ID-seeding so that an empty result (unauthenticated
      // query returning []) doesn't cause all subsequent notifications to appear "new".
      seenIdsRef.current = new Set(notifications.map((n) => n._id));
      initializedRef.current = true;
      if (!canNotify && !isDesktop() && !permissionRequestedRef.current) {
        permissionRequestedRef.current = true;
        requestNotificationPermission();
      }
      return;
    }

    for (const n of notifications) {
      if (
        !seenIdsRef.current.has(n._id) &&
        !n.read &&
        n.created_at >= mountedAtRef.current &&
        Date.now() - n.created_at < BANNER_FRESH_MS
      ) {
        const actor = n.actor?.name || n.actor?.github_username;
        const title = actor ? `${actor}` : "Codecast";
        const body = cleanNotificationBody(n.message) || n.message;
        // The same click target the bell computes: a chat banner lands on the
        // message, a task banner on the task — not just "the app, focused".
        const route = notificationRoute(n.entity_type, n.entity_id, n.chat_message_id) ?? undefined;
        // `key` lets the desktop shell collapse the same row reported by every
        // open window into one banner.
        notifyNative(title, body, { conversationId: n.conversation_id, route, key: String(n._id) });
        // A banner this row deserved could not be shown: the app is unfocused
        // (a focused app is announced by the toast/bell — nothing missed) and
        // the OS-level permission is not granted, so the notifyNative above
        // silently vanished. Feed the nudge banner — a miss overrides its
        // snooze (lib/notificationNudge.ts).
        if (readinessRef.current !== "granted" && !document.hasFocus()) {
          recordNotificationMiss({
            actor,
            fromPerson: typeof n.type === "string" && (n.type.startsWith("chat_") || n.type === "mention"),
          });
        }
        // Browser/Electron OS banners are silent by default; the page supplies
        // the same marimba the focused toast plays, so a chat message sounds
        // identical whether the window has focus or not. notifyNative already
        // no-ops when focused (the toast layer owns that case).
        if (typeof n.type === "string" && n.type.startsWith("chat_") && !document.hasFocus()) {
          // Keyed by the chat message, not by this notification row: the
          // in-page toast layer watches the same arrival through the chat rail
          // and sounds it too. One arrival, one sound.
          soundChatMessage(n.chat_message_id ? String(n.chat_message_id) : undefined);
        }
      }
    }
    seenIdsRef.current = new Set(notifications.map((n) => n._id));
  }, [notifications]);

  const updateDismissed = useInboxStore(s => s.updateClientDismissed);

  useWatchEffect(() => {
    if (!isDesktop() || initRef.current) return;
    initRef.current = true;

    updateDismissed("has_used_desktop", true);

    installDesktopInputTracker();
    installWindowRoleTracker();
    void import("../lib/calls/walkie").then((mod) => {
      walkie = mod;
      // Every other window draws the voice host's walkie and call facts off
      // its mirror: a talk key in this window lights for a burst the host is
      // speaking. Latest-only on the shell's side, so subscribing late starts
      // from the truth.
      onVoiceMirror((payload) => mod.applyVoiceMirror(payload));
    });
    // The shell offers to record a meeting it noticed starting. It picked this
    // window; the answer, and the microphone, are ours.
    void import("../lib/calls/meetingOffers").then(({ installMeetingOfferListener }) => {
      installMeetingOfferListener();
    });

    // The call panel closing hands its huddle back here.
    //
    // Taking it is an ordinary deliberate join — the seat in `call_members` is
    // already ours, so there is no ring and no permission to re-ask. It carries
    // the mic, camera and scribe state the panel was in, because a handback
    // that muted you would be a bug you could only discover by being talked
    // over. The panel is STILL CONNECTED as this arrives (the shell sends it on
    // the window's close, not after), so this join is what ends the panel's
    // participation, in that order, and the audio has no hole in it.
    onCallPanelHandback(async (payload) => {
      if (!payload?.room) return;
      // Closing the panel is a request to keep the call HERE. Without this
      // the auto-pop would reopen the panel on the same room forever.
      const [{ suppressAutoPopOut }, { takeOverCall }] = await Promise.all([
        import("../lib/calls/popOutCall"),
        import("../lib/calls/callManager"),
      ]);
      suppressAutoPopOut(payload.room);
      void takeOverCall({
        roomKey: payload.room,
        mic: !!payload.mic,
        camera: !!payload.camera,
        scribe: !!payload.scribe,
      });
    });

    // Single in-app navigation path, shared by codecast:// deep links (from the
    // native layer) and the codecast-navigate event (tray/menus/notifications).
    // `tabId` names an open tab of this window that already shows the target
    // (the shell's notification router found it): switch there first so the
    // navigation lands in that tab instead of retargeting the active one.
    const goTo = (path: string | undefined, tabId?: string | null) => {
      if (!path) return;
      if (tabId) useInboxStore.getState().switchTab(tabId);

      const convId = conversationIdFromPath(path);
      if (convId) {
        useInboxStore.getState().navigateToSession(convId, "deeplink");

        const cur = window.location.pathname;
        if (cur.startsWith("/inbox") || cur.startsWith("/conversation/")) {
          window.history.pushState(withInboxView({ inboxId: convId }), "", path);
          return;
        }
      }

      router.push(path);
    };

    onDeepLink((urls) => {
      for (const url of urls) {
        const raw = parseDesktopDeepLinkPath(url);
        if (!raw) continue;
        const { path, auto } = extractDeepLinkIntent(raw);
        // An auto handoff (the browser page redirecting itself, not a user
        // clicking an "Open in desktop" button) may not move the view while
        // the user is actively working in the desktop — agent-driven Chrome
        // tabs satisfy every browser-side gate and used to yank the app to
        // whatever the agent had open. Offer it instead, unless the user is
        // already looking at the target.
        if (auto && !shouldApplyAutoDeepLink()) {
          const convId = conversationIdFromPath(path);
          if (!convId || useInboxStore.getState().currentSessionId !== convId) {
            void import("./BrowserHandoffToast").then(({ showBrowserHandoffToast }) => {
              showBrowserHandoffToast(path, goTo);
            });
          }
          continue;
        }
        goTo(path);
      }
    });

    const handleNavigate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && typeof detail === "object") goTo(detail.path, detail.tabId);
      else goTo(detail);
    };
    window.addEventListener("codecast-navigate", handleNavigate);

    // Electron's built-in updater emits real download progress + a "ready"
    // signal over IPC. Surface it directly when it fires (it's dead on macOS
    // 26, where the daemon path takes over instead).
    onUpdateStatus((s) => setIpc(s));

  }, [router]);

  // Tell the desktop shell what this window shows, so a banner click can land
  // in the window (and tab) already on the target and so the shell knows which
  // window hosts a live call. Main window: its tabs, with the inbox tab named
  // by the conversation it shows; detached window: its own URL.
  const location = useLocation();
  const surfaceSig = useInboxStore((st) => {
    const tabs = st.tabs.map((t) => `${t.id}=${t.path}`).join("|");
    return `${tabs}#${st.activeTabId ?? ""}#${st.currentSessionId ?? ""}#${st.call?.phase ?? ""}`;
  });
  useWatchEffect(() => {
    if (!isDesktop()) return;
    const st = useInboxStore.getState();
    const live = `${location.pathname}${location.search}`;
    const inboxFamily = (p: string) => p === "/inbox" || p.startsWith("/inbox?") || p.startsWith("/conversation/");
    const withSession = (p: string) =>
      inboxFamily(p) && st.currentSessionId ? `/conversation/${st.currentSessionId}` : p;
    if (isDetachedTabWindow() || st.tabs.length === 0 || !st.activeTabId) {
      reportDesktopWindowState({ active: withSession(live), open: [], inCall: inHuddle(st) });
      return;
    }
    const open = st.tabs.map((t) => ({
      id: t.id,
      path: t.id === st.activeTabId ? withSession(t.path) : t.path,
    }));
    const activeTab = open.find((t) => t.id === st.activeTabId);
    reportDesktopWindowState({
      active: activeTab?.path ?? withSession(live),
      open,
      inCall: inHuddle(st),
    });
  }, [surfaceSig, location.pathname, location.search]);

  // Desktop update detection: compare the running app version against the latest
  // published version (same-origin /api/desktop/latest). Poll on mount, on window
  // focus, and hourly — Squirrel's own check is dead on macOS 26, so this is the
  // only reliable signal that an update is waiting.
  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    const check = () => {
      checkDesktopUpdate().then((u) => {
        if (cancelled) return;
        setUpdate(u);
      });
    };
    check();
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    const id = window.setInterval(check, 60 * 60 * 1000);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      window.clearInterval(id);
    };
  }, []);

  const ready = ipc?.status === "ready";
  const downloading = ipc?.status === "downloading";
  const errored = ipc?.status === "error";
  const latest = ipc?.version ?? update?.latest;
  const inProgress = updating || downloading;

  // "Stalled" means NO SIGN OF PROGRESS for 90s — not merely "slow". The timer
  // re-arms on every reported percent, so a big download over a cold CDN edge
  // that's genuinely moving (23%… 24%…) keeps its progress bar instead of being
  // branded "taking longer than usual" (which hid the bar and scared users
  // during the v1.1.84 rollout). The daemon fallback path reports no percent,
  // so for it this stays a plain 90s ceiling — past that, the update likely
  // failed (daemon down, download/verify error); surface that instead of a
  // frozen banner.
  useEffect(() => {
    if (!inProgress) {
      setStalled(false);
      return;
    }
    const id = window.setTimeout(() => setStalled(true), 90_000);
    return () => window.clearTimeout(id);
  }, [inProgress, ipc?.percent, attempt]);

  // A failed run (dead socket, sha mismatch, unreachable server) surfaces the
  // retry UI immediately — main.js aborts any wedged attempt on retry, so the
  // button always does real work now.
  const showStalled = stalled || (errored && (updating || update != null));

  // The banner sits over the composer, so it must never demand permanent
  // screen space: a download auto-collapses to a small pill after a few
  // seconds ("keep working" shouldn't cover where you work), while ready /
  // stalled re-expand once because they need a click. Manual expand during a
  // download sticks — the timer only arms on the download's state change.
  useEffect(() => {
    if (ready || showStalled) {
      setMinimized(false);
      return;
    }
    if (!inProgress) return;
    const id = window.setTimeout(() => setMinimized(true), 6_000);
    return () => window.clearTimeout(id);
  }, [inProgress, ready, showStalled]);

  // Nothing to surface: no known update (and not mid-update or failed), or
  // this version was dismissed while idle.
  if (!ready && !inProgress && !showStalled && (!update || update.latest === dismissedVersion)) return null;
  if (!latest) return null;

  if (minimized) {
    return (
      <div className="fixed bottom-4 left-4 z-[9998]">
        <button
          onClick={() => setMinimized(false)}
          aria-label="Show update status"
          className="relative flex items-center gap-2 overflow-hidden rounded-full border border-sol-cyan/30 bg-[color-mix(in_srgb,var(--sol-bg-alt)_95%,transparent)] px-3 py-1.5 shadow-lg shadow-sol-cyan/5 backdrop-blur-md transition-colors hover:border-sol-cyan/60"
        >
          {downloading && (
            <span
              className="absolute bottom-0 left-0 h-[2px] bg-sol-cyan transition-all duration-300"
              style={{ width: `${ipc?.percent ?? 0}%` }}
            />
          )}
          <span
            className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
              showStalled ? "bg-sol-orange" : "animate-pulse bg-sol-cyan"
            }`}
          />
          <span className="text-[11px] text-sol-text-dim">
            {ready
              ? `v${latest} ready`
              : downloading && ipc?.percent != null
                ? `${ipc.percent}%`
                : `v${latest}`}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="fixed bottom-4 left-4 z-[9998] w-80 max-w-[calc(100vw-2rem)]">
      <div className="relative overflow-hidden rounded-lg border border-sol-cyan/30 bg-[color-mix(in_srgb,var(--sol-bg-alt)_95%,transparent)] backdrop-blur-md shadow-lg shadow-sol-cyan/5">
        {/* Progress: real % when Electron's updater reports one, else an
            indeterminate sweep while the daemon works in the background. */}
        {downloading && (
          <div
            className="absolute bottom-0 left-0 h-[2px] bg-sol-cyan transition-all duration-300"
            style={{ width: `${ipc?.percent ?? 0}%` }}
          />
        )}
        {updating && !showStalled && (
          <div className="absolute bottom-0 left-0 h-[2px] w-1/4 bg-sol-cyan animate-[indeterminateBar_1.3s_ease-in-out_infinite]" />
        )}
        <div className="flex items-start gap-3 px-4 py-3">
          <div
            className={`mt-1 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              showStalled ? "bg-sol-orange" : "animate-pulse bg-sol-cyan"
            }`}
          />
          <div className="flex-1 min-w-0">
            {ready ? (
              <p className="text-xs text-sol-text">Codecast v{latest} is ready to install</p>
            ) : showStalled ? (
              <>
                <p className="text-xs text-sol-text">
                  {errored ? "Update failed" : "Update is taking longer than usual"}
                </p>
                <p className="mt-0.5 text-[11px] text-sol-text-dim">
                  {errored
                    ? "The download didn't complete — check your connection and try again."
                    : "If Codecast doesn’t restart shortly, quit and reopen it."}
                </p>
              </>
            ) : inProgress ? (
              <>
                <p className="text-xs text-sol-text">
                  {downloading ? `Downloading v${latest}` : `Updating to v${latest}`}
                  {downloading && ipc?.percent != null ? ` — ${ipc.percent}%` : "…"}
                </p>
                <p className="mt-0.5 text-[11px] text-sol-text-dim">
                  {downloading
                    ? "Keep working — we’ll prompt you to restart when it’s ready."
                    : "Downloading in the background — Codecast will restart on its own."}
                </p>
              </>
            ) : (
              <p className="text-xs text-sol-text">
                Codecast v{latest} is available
                {update?.current && (
                  <span className="text-sol-text-dim"> · you&rsquo;re on v{update.current}</span>
                )}
              </p>
            )}
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            {ready && (
              <button
                onClick={() => restartForUpdate()}
                className="rounded-md bg-sol-cyan px-3 py-1 text-[11px] font-medium text-sol-bg transition-opacity hover:opacity-90"
              >
                Restart now
              </button>
            )}
            {showStalled && (
              <button
                onClick={startUpdate}
                className="rounded-md bg-sol-cyan px-3 py-1 text-[11px] font-medium text-sol-bg transition-opacity hover:opacity-90"
              >
                Try again
              </button>
            )}
            {!inProgress && !ready && (
              <>
                <button
                  onClick={startUpdate}
                  className="rounded-md bg-sol-cyan px-3 py-1 text-[11px] font-medium text-sol-bg transition-opacity hover:opacity-90"
                >
                  Update now
                </button>
                <button
                  onClick={() => setDismissedVersion(latest)}
                  className="text-[11px] text-sol-text-dim transition-colors hover:text-sol-text"
                >
                  Later
                </button>
              </>
            )}
            {(inProgress || ready || showStalled) && (
              <button
                onClick={() => setMinimized(true)}
                aria-label="Minimize update status"
                title="Minimize"
                className="-mr-1 flex h-5 w-5 items-center justify-center rounded text-sol-text-dim transition-colors hover:bg-sol-bg hover:text-sol-text"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M2 5h6" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

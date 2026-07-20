import { useEffect, useRef, useState } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useRouter } from "next/navigation";
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
} from "../lib/desktop";
import { toast } from "sonner";
import { cleanNotificationBody } from "../lib/notificationText";
import { useInboxStore } from "../store/inboxStore";
import { useNeedsInputCount } from "../hooks/useNeedsInputCount";

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

  const notifications = useQuery(api.notifications.list);
  const mountedAtRef = useRef<number>(Date.now());
  const seenIdsRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);

  const permissionRequestedRef = useRef(false);

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
      if (!seenIdsRef.current.has(n._id) && !n.read && n.created_at >= mountedAtRef.current) {
        const actor = n.actor?.name || n.actor?.github_username;
        const title = actor ? `${actor}` : "Codecast";
        const body = cleanNotificationBody(n.message) || n.message;
        notifyNative(title, body, { conversationId: n.conversation_id });
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

    // Single in-app navigation path, shared by codecast:// deep links (from the
    // native layer) and the codecast-navigate event (tray/menus/notifications).
    const goTo = (path: string | undefined) => {
      if (!path) return;

      const convMatch = path.match(/^\/conversation\/([^/?#]+)/);
      if (convMatch) {
        const convId = convMatch[1];
        useInboxStore.getState().navigateToSession(convId, "deeplink");

        const cur = window.location.pathname;
        if (cur.startsWith("/inbox") || cur.startsWith("/conversation/")) {
          window.history.pushState({ inboxId: convId }, "", path);
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
        // whatever the agent had open. Offer it instead.
        if (auto && !shouldApplyAutoDeepLink()) {
          const convMatch = path.match(/^\/conversation\/([^/?#]+)/);
          const title = convMatch ? useInboxStore.getState().sessions[convMatch[1]]?.title : null;
          toast.info(`Browser handed off ${title ? `“${title}”` : "a page"}`, {
            action: { label: "Open", onClick: () => goTo(path) },
            duration: 10_000,
          });
          continue;
        }
        goTo(path);
      }
    });

    const handleNavigate = (e: Event) => goTo((e as CustomEvent).detail);
    window.addEventListener("codecast-navigate", handleNavigate);

    // Electron's built-in updater emits real download progress + a "ready"
    // signal over IPC. Surface it directly when it fires (it's dead on macOS
    // 26, where the daemon path takes over instead).
    onUpdateStatus((s) => setIpc(s));

  }, [router]);

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

  // Nothing to surface: no known update (and not mid-update or failed), or
  // this version was dismissed while idle.
  if (!ready && !inProgress && !showStalled && (!update || update.latest === dismissedVersion)) return null;
  if (!latest) return null;

  return (
    <div className="fixed bottom-4 left-4 z-[9998] w-80 max-w-[calc(100vw-2rem)]">
      <div className="relative overflow-hidden rounded-lg border border-sol-cyan/30 bg-sol-bg-alt/95 backdrop-blur-md shadow-lg shadow-sol-cyan/5">
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
          </div>
        </div>
      </div>
    </div>
  );
}

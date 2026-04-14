import { useRef, useState } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import {
  isDesktop,
  isElectron,
  updateBadge,
  onDeepLink,
  checkForUpdates,
  onUpdateStatus,
  restartForUpdate,
  notifyNative,
  requestNotificationPermission,
  hasBrowserNotificationPermission,
} from "../lib/desktop";
import { cleanNotificationBody } from "../lib/notificationText";
import { useInboxStore } from "../store/inboxStore";

export function DesktopProvider() {
  const router = useRouter();
  const sessions = useInboxStore((s) => s.sessions);
  const prevCountRef = useRef<number | null>(null);
  const initRef = useRef(false);
  const [updateStatus, setUpdateStatus] = useState<{ status: string; version?: string; percent?: number } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const dismissedStatusRef = useRef<string | null>(null);

  useWatchEffect(() => {
    if (!isDesktop()) return;
    const pending = Object.values(sessions).filter((s) => s.has_pending || s.is_idle).length;
    updateBadge(pending);
    prevCountRef.current = pending;
  }, [sessions]);

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

    onDeepLink((urls) => {
      for (const url of urls) {
        try {
          const parsed = new URL(url);
          if (parsed.pathname) {
            router.push(parsed.pathname + parsed.search);
          }
        } catch {}
      }
    });

    const handleNavigate = (e: Event) => {
      const path = (e as CustomEvent).detail;
      if (!path) return;

      const convMatch = path.match(/^\/conversation\/([^/?#]+)/);
      if (convMatch) {
        const convId = convMatch[1];
        useInboxStore.getState().navigateToSession(convId);

        const cur = window.location.pathname;
        if (cur.startsWith("/inbox") || cur.startsWith("/conversation/")) {
          window.history.pushState({ inboxId: convId }, "", path);
          return;
        }
      }

      router.push(path);
    };
    window.addEventListener("codecast-navigate", handleNavigate);

    checkForUpdates().catch(() => {});

    if (isElectron()) {
      onUpdateStatus((status) => {
        setUpdateStatus(status);
        if (status.status !== dismissedStatusRef.current) {
          setDismissed(false);
        }
      });
    }
  }, [router]);

  if (!updateStatus || dismissed) return null;

  const { status, version, percent } = updateStatus;
  if (status !== "available" && status !== "downloading" && status !== "ready") return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[9998] pointer-events-none">
      <div className="pointer-events-auto mx-auto max-w-xl mt-12 px-3">
        <div className="relative overflow-hidden rounded-lg border border-sol-cyan/30 bg-sol-bg-alt/95 backdrop-blur-md shadow-lg shadow-sol-cyan/5">
          {status === "downloading" && (
            <div
              className="absolute bottom-0 left-0 h-[2px] bg-sol-cyan/60 transition-all duration-300"
              style={{ width: `${percent ?? 0}%` }}
            />
          )}
          <div className="flex items-center gap-3 px-4 py-2.5">
            <div className="w-1.5 h-1.5 rounded-full flex-shrink-0 animate-pulse bg-sol-cyan" />
            <span className="text-xs text-sol-text flex-1">
              {status === "available" && `v${version} available — downloading`}
              {status === "downloading" && `Downloading v${version}${percent != null ? ` — ${percent}%` : ""}`}
              {status === "ready" && `v${version} ready to install`}
            </span>
            {status === "ready" && (
              <button
                onClick={() => restartForUpdate()}
                className="rounded-md bg-sol-cyan px-3 py-1 text-[11px] font-medium text-sol-bg hover:opacity-90 transition-opacity"
              >
                Restart
              </button>
            )}
            <button
              onClick={() => { setDismissed(true); dismissedStatusRef.current = status; }}
              className="text-sol-text-dim hover:text-sol-text transition-colors text-xs leading-none"
            >
              &times;
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

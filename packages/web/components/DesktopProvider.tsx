"use client";

import { useEffect, useRef, useState } from "react";
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
import { useInboxStore } from "../store/inboxStore";

export function DesktopProvider() {
  const router = useRouter();
  const sessions = useInboxStore((s) => s.sessions);
  const prevCountRef = useRef<number | null>(null);
  const initRef = useRef(false);
  const [updateReady, setUpdateReady] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isDesktop()) return;
    const pending = Object.values(sessions).filter((s) => s.has_pending || s.is_idle).length;
    updateBadge(pending);
    prevCountRef.current = pending;
  }, [sessions]);

  const notifications = useQuery(api.notifications.list);
  const seenIdsRef = useRef<Set<string> | null>(null);
  const pendingNotifsRef = useRef<Array<{ title: string; body: string; conversationId?: string }>>([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const permissionRequestedRef = useRef(false);

  useEffect(() => {
    if (!notifications) return;
    const canNotify = isDesktop() || hasBrowserNotificationPermission();

    if (seenIdsRef.current === null) {
      seenIdsRef.current = new Set(notifications.map((n) => n._id));
      if (!canNotify && !isDesktop() && !permissionRequestedRef.current) {
        permissionRequestedRef.current = true;
        requestNotificationPermission();
      }
      return;
    }

    for (const n of notifications) {
      if (!seenIdsRef.current.has(n._id) && !n.read) {
        const actor = n.actor?.name || n.actor?.github_username;
        const title = actor ? `${actor}` : "Codecast";
        pendingNotifsRef.current.push({ title, body: n.message, conversationId: n.conversation_id });
      }
    }
    seenIdsRef.current = new Set(notifications.map((n) => n._id));

    if (pendingNotifsRef.current.length > 0 && !debounceTimerRef.current) {
      debounceTimerRef.current = setTimeout(() => {
        const batch = pendingNotifsRef.current.splice(0);
        debounceTimerRef.current = null;
        if (batch.length === 0) return;
        if (batch.length === 1) {
          notifyNative(batch[0].title, batch[0].body, { conversationId: batch[0].conversationId });
        } else {
          notifyNative("Codecast", `${batch.length} sessions need attention`);
        }
      }, 10_000);
    }
  }, [notifications]);

  const updateDismissed = useInboxStore(s => s.updateClientDismissed);

  useEffect(() => {
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

    checkForUpdates().catch(() => {});

    if (isElectron()) {
      onUpdateStatus((status) => {
        if (status.status === "ready" && status.version) {
          setUpdateReady(status.version);
        }
      });
    }
  }, [router]);

  if (!updateReady || dismissed) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-4 py-3 shadow-lg">
      <span className="text-sm text-[var(--text-secondary)]">
        v{updateReady} available
      </span>
      <button
        onClick={() => restartForUpdate()}
        className="rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 transition-opacity"
      >
        Restart
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors text-xs"
      >
        Later
      </button>
    </div>
  );
}

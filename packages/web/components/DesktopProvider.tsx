"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import {
  isDesktop,
  updateBadge,
  onDeepLink,
  checkForUpdates,
  notifyNative,
} from "../lib/desktop";
import { useInboxStore } from "../store/inboxStore";

export function DesktopProvider() {
  const router = useRouter();
  const sessions = useInboxStore((s) => s.sessions);
  const prevCountRef = useRef<number | null>(null);
  const initRef = useRef(false);

  useEffect(() => {
    if (!isDesktop()) return;
    const pending = sessions.filter((s) => s.has_pending || s.is_idle).length;
    updateBadge(pending);
    prevCountRef.current = pending;
  }, [sessions]);

  const notifications = useQuery(api.notifications.list);
  const seenIdsRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!isDesktop() || !notifications) return;

    if (seenIdsRef.current === null) {
      seenIdsRef.current = new Set(notifications.map((n) => n._id));
      return;
    }

    for (const n of notifications) {
      if (!seenIdsRef.current.has(n._id) && !n.read) {
        const actor = n.actor?.name || n.actor?.github_username;
        const title = actor ? `${actor}` : "Codecast";
        notifyNative(title, n.message);
      }
    }
    seenIdsRef.current = new Set(notifications.map((n) => n._id));
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
  }, [router]);

  return null;
}

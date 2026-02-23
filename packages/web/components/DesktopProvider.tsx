"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
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

    if (prevCountRef.current !== null && pending > prevCountRef.current) {
      const newest = sessions.find((s) => s.is_idle);
      if (newest) {
        notifyNative(
          "Codecast",
          newest.title || newest.idle_summary || "Session needs attention"
        );
      }
    }
    prevCountRef.current = pending;
  }, [sessions]);

  useEffect(() => {
    if (!isDesktop() || initRef.current) return;
    initRef.current = true;

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

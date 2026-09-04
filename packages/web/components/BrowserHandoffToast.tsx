"use client";

/**
 * Browser → desktop handoff notice.
 *
 * When a browser page auto-hands-off to the desktop while the user is actively
 * working there, DesktopProvider must not yank the view (agent-driven Chrome
 * tabs satisfy every browser-side gate). Instead it raises this card: a
 * persistent toast — it never times out, only Open / dismiss / actually
 * arriving at the session clears it — that previews the session behind the
 * handoff (same card as a session reference hover) so the choice to switch is
 * an informed one.
 */

import { useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { MonitorDown, X } from "lucide-react";
import { isConvexId } from "../lib/entityLinks";
import { conversationIdFromPath } from "../lib/desktop";
import { SessionHoverContent } from "./EntityIdPill";
import { useInboxStore } from "../store/inboxStore";

import { useWatchEffect } from "../hooks/useWatchEffect";
// Keyed by path, so a background tab re-firing the same handoff refreshes the
// one card instead of stacking duplicates.
export function showBrowserHandoffToast(path: string, onOpen: (path: string) => void) {
  toast.custom(
    (toastId) => <BrowserHandoffToast toastId={toastId} path={path} onOpen={onOpen} />,
    { id: `browser-handoff:${path}`, duration: Infinity },
  );
}

// Dev console hook (same convention as __inboxStore): the real trigger needs
// the Electron deep-link bridge, so this is the only way to drive the card in
// a browser — __showBrowserHandoffToast("/conversation/<id>").
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined")
  (window as any).__showBrowserHandoffToast = (path: string) => showBrowserHandoffToast(path, () => {});

function BrowserHandoffToast({
  toastId,
  path,
  onOpen,
}: {
  toastId: string | number;
  path: string;
  onOpen: (path: string) => void;
}) {
  const convId = conversationIdFromPath(path);
  const session = useQuery(
    api.conversations.webGet,
    convId ? (isConvexId(convId) ? { id: convId } : { short_id: convId.slice(0, 7).toLowerCase() }) : "skip",
  );
  // The local row's title bridges the webGet round-trip so the skeleton isn't blank.
  const storeTitle = useInboxStore((s) => (convId ? s.sessions[convId]?.title : undefined));
  // Landing on the session by any route resolves the handoff — drop the card
  // rather than keep offering a page the user is already on.
  const arrived = useInboxStore((s) => convId != null && s.currentSessionId === convId);
  useWatchEffect(() => {
    if (arrived) toast.dismiss(toastId);
  }, [arrived, toastId]);

  const open = () => {
    toast.dismiss(toastId);
    onOpen(path);
  };

  // Sonner measures a custom toast only when its jsx prop changes, so a card
  // that grows internally (skeleton → loaded preview) leaves sonner's height
  // records stale. Hover then clamps the card to the stale --initial-height,
  // the pointer falls outside it, and the stack flickers open/closed. Re-issue
  // the same toast id on any size change — sonner treats that as an update and
  // re-measures.
  const rootRef = useRef<HTMLDivElement>(null);
  useWatchEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    let lastHeight = node.getBoundingClientRect().height;
    const ro = new ResizeObserver(() => {
      const height = node.getBoundingClientRect().height;
      if (Math.abs(height - lastHeight) < 1) return;
      lastHeight = height;
      showBrowserHandoffToast(path, onOpen);
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [path, onOpen]);

  return (
    <div ref={rootRef} className="w-[356px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-sol-cyan/40 bg-sol-bg-alt shadow-xl shadow-sol-cyan/10">
      <div className="flex items-center gap-2 border-b border-sol-border/60 bg-sol-cyan/5 px-3 py-2">
        <MonitorDown className="h-3.5 w-3.5 flex-shrink-0 text-sol-cyan" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-sol-text">
          Browser handed off {convId ? "a session" : "a page"}
        </span>
        <button
          onClick={open}
          className="rounded-md bg-sol-cyan px-2.5 py-0.5 text-[11px] font-medium text-sol-bg transition-opacity hover:opacity-90"
        >
          Open
        </button>
        <button
          onClick={() => toast.dismiss(toastId)}
          title="Dismiss"
          className="text-sol-text-dim transition-colors hover:text-sol-text"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {convId && session ? (
        <button onClick={open} className="block w-full p-3 text-left transition-colors hover:bg-sol-bg-highlight/40">
          <SessionHoverContent session={session} />
        </button>
      ) : convId && session === undefined ? (
        <div className="space-y-2 p-3">
          {storeTitle ? (
            <div className="text-xs font-medium leading-snug text-sol-text">{storeTitle}</div>
          ) : (
            <div className="h-3.5 w-2/3 animate-pulse rounded bg-sol-bg-highlight/60" />
          )}
          <div className="h-3 w-full animate-pulse rounded bg-sol-bg-highlight/40" />
        </div>
      ) : (
        <button onClick={open} className="block w-full p-3 text-left transition-colors hover:bg-sol-bg-highlight/40">
          <span className="font-mono text-[11px] text-sol-text-muted break-all">{path}</span>
        </button>
      )}
    </div>
  );
}

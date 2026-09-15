"use client";

/**
 * Browser → desktop handoff notice.
 *
 * When a browser page auto-hands-off to the desktop while the user is actively
 * working there, DesktopProvider must not yank the view. Instead it raises this
 * card: a persistent corner notice — it never times out, only Open / dismiss /
 * actually arriving at the session clears it. Not a modal: no backdrop, no
 * focus trap. Bigger than a hover popover so it can be read from across a
 * desk, and it shows the same facts an inbox card does (title, live state,
 * last user line) so the choice to switch is an informed one.
 */

import { useRef } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { MonitorDown, X } from "lucide-react";
import { isConvexId } from "../lib/entityLinks";
import { conversationIdFromPath } from "../lib/desktop";
import { sessionCardSummary } from "../lib/sessionSummary";
import { cleanTitle } from "../lib/conversationProcessor";
import { cleanUserMessage } from "./sessionMessage";
import { getLabelColor } from "../lib/labelColors";
import { abbrevModel, relativeTime } from "../lib/entityDisplay";
import { imageBytes } from "../lib/imageByteCache";
import { getProjectName, useInboxStore } from "../store/inboxStore";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { AgentTypeIcon, formatAgentType } from "./AgentTypeIcon";
import { AuthorAvatar } from "./entityDisplay";
import { FormattedSummary } from "./FormattedSummary";
import "./browserHandoffToast.css";

const TOAST_STYLE = {
  width: 460,
  padding: 0,
  background: "transparent",
  border: "none",
  boxShadow: "none",
} as const;

export function showBrowserHandoffToast(path: string, onOpen: (path: string) => void) {
  toast.custom(
    (toastId) => <BrowserHandoffToast toastId={toastId} path={path} onOpen={onOpen} />,
    { id: `browser-handoff:${path}`, duration: Infinity, unstyled: true, style: TOAST_STYLE },
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
  const { data: fetched, error } = useQueryNoThrow(
    api.conversations.webGet,
    convId ? (isConvexId(convId) ? { id: convId } : { short_id: convId.slice(0, 7).toLowerCase() }) : "skip",
  );
  const storeRow = useInboxStore((s) => (convId ? s.sessions[convId] : undefined));
  const session = (fetched ?? storeRow ?? null) as Record<string, unknown> | null;
  const loading = !!convId && fetched === undefined && !storeRow && !error;
  const thumbSrc = imageBytes.useSrc(
    typeof session?.image_preview_url === "string" ? session.image_preview_url : undefined,
  );

  const arrived = useInboxStore((s) => convId != null && s.currentSessionId === convId);
  useWatchEffect(() => {
    if (arrived) toast.dismiss(toastId);
  }, [arrived, toastId]);

  const open = () => {
    toast.dismiss(toastId);
    onOpen(path);
  };
  const dismiss = () => toast.dismiss(toastId);

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
    <div ref={rootRef}>
      <BrowserHandoffCard
        path={path}
        session={session}
        loading={loading}
        thumbSrc={thumbSrc}
        onOpen={open}
        onDismiss={dismiss}
      />
    </div>
  );
}

export function BrowserHandoffCard({
  path,
  session,
  loading = false,
  thumbSrc,
  onOpen,
  onDismiss,
}: {
  path: string;
  session: Record<string, any> | null;
  loading?: boolean;
  thumbSrc?: string;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const hasSession = !!session && (session.title || session.short_id);
  const title = hasSession ? cleanTitle(session.title || session.short_id || "Session") : null;
  const isLive = !!(session?.is_active || session?.status === "active");
  const summary = session ? sessionCardSummary(session) : "";
  const userLine = session ? cleanUserMessage(session.last_message_preview) : null;
  const project = session?.project_path ? getProjectName(undefined, session.project_path) : null;
  const projectColor = project ? getLabelColor(project) : null;
  const model = session ? abbrevModel(session.model) : null;
  const timeAgo = session ? relativeTime(session.updated_at) : null;
  const agent = session?.agent_type ? formatAgentType(session.agent_type) : null;
  const isForeign = !!(session?.author_name || session?.author_avatar);

  return (
    <div className="handoff-toast" role="status" aria-live="polite">
      <div className="handoff-toast-head">
        <span className="handoff-toast-glyph" aria-hidden="true">
          <MonitorDown className="h-4 w-4" />
        </span>
        <span className="handoff-toast-kicker">From the browser</span>
        <button type="button" className="handoff-toast-x" onClick={onDismiss} title="Dismiss">
          <X className="h-4 w-4" />
        </button>
      </div>

      {hasSession ? (
        <button type="button" className="handoff-toast-body" onClick={onOpen}>
          <div className="handoff-toast-row">
            <div className="handoff-toast-copy">
              <div className="handoff-toast-title">
                <AgentTypeIcon agentType={session.agent_type || "claude_code"} className="h-[18px] w-[18px]" />
                <span>{title}</span>
              </div>
              <div className="handoff-toast-status">
                {isLive && (
                  <span className="relative flex h-2 w-2 flex-shrink-0" title="Live">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sol-green opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-sol-green" />
                  </span>
                )}
                <span className={isLive ? "handoff-toast-live" : undefined}>
                  {isLive ? "Active" : session.status || "Stopped"}
                </span>
                {agent && <span>· {agent}</span>}
                {isForeign && session.author_name && (
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <AuthorAvatar name={session.author_name} avatar={session.author_avatar} size={14} />
                    <span className="truncate">{session.author_name}</span>
                  </span>
                )}
              </div>
              {summary && (
                <p className="handoff-toast-summary">
                  <FormattedSummary text={summary} />
                </p>
              )}
              {userLine && (
                <p className="handoff-toast-user">
                  <span>&gt;</span>
                  {userLine}
                </p>
              )}
            </div>
            {thumbSrc && <img src={thumbSrc} alt="" className="handoff-toast-thumb" />}
          </div>
          <div className="handoff-toast-meta">
            {project && projectColor && (
              <span className="handoff-toast-meta-project">
                <i className={projectColor.dot} />
                <span className={projectColor.text}>{project}</span>
              </span>
            )}
            <span className="handoff-toast-meta-rest">
              {session.message_count != null && session.message_count > 0 && (
                <span>{session.message_count} messages</span>
              )}
              {model && <span>{model}</span>}
              {timeAgo && <span>{timeAgo}</span>}
            </span>
          </div>
        </button>
      ) : loading ? (
        <div className="handoff-toast-body">
          <div className="handoff-toast-skel" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        </div>
      ) : (
        <button type="button" className="handoff-toast-body" onClick={onOpen}>
          <span className="handoff-toast-path">{path}</span>
        </button>
      )}

      <div className="handoff-toast-actions">
        <button type="button" className="handoff-toast-open" onClick={onOpen}>
          {hasSession ? "Open session" : "Open"}
        </button>
        <button type="button" className="handoff-toast-stay" onClick={onDismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}

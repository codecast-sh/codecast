// One notification row, and the waiting-burst group built on it.
//
// The bell and /notifications used to carry byte-similar copies of this markup,
// its avatar block and its clock, which is how the two drifted (the page's
// hand-rolled agent icon never learned muse, and only the bell wore the session
// glyph). One row now serves both, with a size the caller picks.
import { AvatarImg } from "../../lib/avatarCache";
import { ClaudeIcon, OpenAIIcon, CursorIcon, GeminiIcon, GrokIcon } from "../BrandIcons";
import { AgentTypeIcon } from "../AgentTypeIcon";
import { SessionGlyph } from "../identity";
import { ChevronRight } from "lucide-react";
import {
  agentNames,
  notificationActor,
  notificationRoute,
  sessionLabel,
  showsAgentIcon,
  typeColors,
  typeLabels,
} from "../../lib/notificationTypes";
import { summarizeIdleDigest, type IdleGrouped } from "@codecast/shared/contracts";

/** The URL a notification lands on — for opening it in a new tab, where the
 *  in-app store navigation can't reach. */
export function notificationHref(n: any): string {
  if (n.link) return n.link;
  return (
    notificationRoute(n.entity_type, n.entity_id, n.chat_message_id) ??
    (n.conversation_id ? `/conversation/${n.conversation_id}` : "/inbox")
  );
}

export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function AgentIcon({ agentType, className = "w-9 h-9" }: { agentType: string; className?: string }) {
  if (agentType === "codex" || agentType === "codex_cli") {
    return (
      <span className={`${className} rounded-full bg-[#0f0f0f] flex items-center justify-center shrink-0`}>
        <OpenAIIcon className="w-4 h-4 text-white" />
      </span>
    );
  } else if (agentType === "cursor") {
    return (
      <span className={`${className} rounded-full bg-[#1a1a2e] flex items-center justify-center shrink-0`}>
        <CursorIcon className="w-4 h-4 text-white" />
      </span>
    );
  } else if (agentType === "gemini") {
    return (
      <span className={`${className} rounded-full bg-[#1a73e8] flex items-center justify-center shrink-0`}>
        <GeminiIcon className="w-4 h-4 text-white" />
      </span>
    );
  } else if (agentType === "grok") {
    return (
      <span className={`${className} rounded-full bg-[#0a0a0a] flex items-center justify-center shrink-0`}>
        <GrokIcon className="w-4 h-4 text-white" />
      </span>
    );
  } else if (agentType === "opencode" || agentType === "pi" || agentType === "muse") {
    // No dedicated brand glyph — reuse the canonical AgentTypeIcon so these
    // never fall through to the Claude badge. (The bell's own copy knew only
    // muse and badged opencode and pi as Claude; the page's knew all three.)
    return (
      <span className={`${className} rounded-full bg-sol-bg-alt flex items-center justify-center shrink-0`}>
        <AgentTypeIcon agentType={agentType} className="w-4 h-4" />
      </span>
    );
  }
  return (
    <span className={`${className} rounded-full bg-sol-orange flex items-center justify-center shrink-0`}>
      <ClaudeIcon className="w-4 h-4 text-sol-bg" />
    </span>
  );
}

type RowProps = {
  notification: any;
  onOpen: (n: any) => void;
  onContextMenu?: (e: React.MouseEvent, n: any) => void;
  /** The bell is a dropdown and runs tighter than the full page. */
  size?: "bell" | "page";
  /** A row inside an open group: indented, quieter, no repeated border. */
  nested?: boolean;
};

export function NotificationRow({ notification, onOpen, onContextMenu, size = "bell", nested }: RowProps) {
  const label = sessionLabel(notification.conversation);
  const { name: actorName, avatar: actorAvatar } = notificationActor(notification);
  const agentType = notification.conversation?.agent_type || "claude_code";
  const agentIcon = showsAgentIcon(notification);
  const typeLabel = typeLabels[notification.type] || notification.type;
  const typeColor = typeColors[notification.type] || "text-sol-text-muted";
  const av = size === "page" ? "w-10 h-10" : "w-9 h-9";

  return (
    <button
      onClick={() => onOpen(notification)}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, notification) : undefined}
      className={`w-full text-left transition-colors hover:bg-sol-bg-alt ${
        nested ? "pl-12 pr-5 py-3 border-b border-sol-border/30" : "px-5 py-4 border-b border-sol-border/50"
      } ${!notification.read ? (nested ? "bg-sol-bg-alt/20" : "bg-sol-bg-alt/40") : size === "page" ? "bg-sol-bg" : ""}`}
    >
      <div className="flex items-start gap-3">
        {actorAvatar ? (
          <AvatarImg
            src={actorAvatar}
            alt={actorName || ""}
            className={`${av} rounded-full flex-shrink-0 mt-0.5`}
            fallback={
              <div className={`${av} rounded-full flex-shrink-0 mt-0.5 bg-sol-bg-alt border border-sol-border flex items-center justify-center`}>
                <span className="text-sm font-medium text-sol-text-muted">{(actorName || "?").charAt(0).toUpperCase()}</span>
              </div>
            }
          />
        ) : agentIcon ? (
          <div className="flex-shrink-0 mt-0.5">
            <AgentIcon agentType={agentType} className={av} />
          </div>
        ) : (
          <div className={`${av} rounded-full flex-shrink-0 mt-0.5 bg-sol-bg-alt border border-sol-border flex items-center justify-center`}>
            {actorName ? (
              <span className="text-sm font-medium text-sol-text-muted">{actorName.charAt(0).toUpperCase()}</span>
            ) : (
              <svg className="w-4 h-4 text-sol-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            )}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {actorName ? (
              <span className="text-sm font-medium text-sol-text">{actorName}</span>
            ) : agentIcon ? (
              <span className="text-sm font-medium text-sol-text">{agentNames[agentType] || agentType}</span>
            ) : null}
            <span className={`text-xs ${typeColor}`}>{typeLabel}</span>
            <span className="text-xs text-sol-text-muted ml-auto flex-shrink-0">{timeAgo(notification.created_at)}</span>
            {!notification.read && <div className="w-2 h-2 bg-sol-yellow rounded-full flex-shrink-0" />}
          </div>
          <p className="text-sm text-sol-text leading-relaxed line-clamp-2">{notification.message}</p>
          {label && (
            <div className="flex items-center gap-2 mt-1.5">
              <span className={`inline-flex items-center gap-1.5 text-xs text-sol-text-muted bg-sol-bg-alt px-2 py-0.5 rounded truncate ${size === "page" ? "max-w-[360px]" : "max-w-[280px]"}`}>
                {/* Which session this is about, by its face
                    (session-characters.md S3). */}
                <SessionGlyph row={notification.conversation} size={14} className="flex-shrink-0" />
                {label}
              </span>
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

/**
 * A waiting burst as one row that opens.
 *
 * The header says what the fold-up alert said, from the sessions the group
 * actually holds rather than the alert's frozen text: a session answered since
 * the alert went out is already gone from this list, and a header naming it
 * would send the reader to work that is finished. The faces come first, because
 * "which of mine are waiting" is the question being asked.
 */
export function NotificationGroupRow({
  group,
  open,
  onToggle,
  onOpen,
  onContextMenu,
  size = "bell",
}: {
  group: Extract<IdleGrouped<any>, { kind: "group" }>;
  open: boolean;
  onToggle: () => void;
  onOpen: (n: any) => void;
  onContextMenu?: (e: React.MouseEvent, n: any) => void;
  size?: "bell" | "page";
}) {
  const titles = group.rows.map((r) => sessionLabel(r.conversation) || "Session");
  const { message } = summarizeIdleDigest(titles);
  const faces = group.rows.slice(0, 4);

  return (
    <div className={!open && group.unread > 0 ? "bg-sol-bg-alt/40" : size === "page" ? "bg-sol-bg" : ""}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="w-full px-5 py-4 text-left border-b border-sol-border/50 hover:bg-sol-bg-alt transition-colors"
      >
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 mt-0.5 flex -space-x-2">
            {faces.map((r, i) => (
              <span
                key={r._id}
                className="w-7 h-7 rounded-full bg-sol-bg border border-sol-border flex items-center justify-center"
                style={{ zIndex: faces.length - i }}
              >
                <SessionGlyph row={r.conversation} size={14} />
              </span>
            ))}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-medium text-sol-text">{group.rows.length} sessions</span>
              <span className="text-xs text-sol-green">{typeLabels.sessions_need_input}</span>
              <span className="text-xs text-sol-text-muted ml-auto flex-shrink-0">{timeAgo(group.newestAt)}</span>
              {group.unread > 0 && <div className="w-2 h-2 bg-sol-yellow rounded-full flex-shrink-0" />}
            </div>
            <p className="text-sm text-sol-text leading-relaxed line-clamp-2">{message}</p>
          </div>
          <ChevronRight
            className={`w-4 h-4 text-sol-text-muted flex-shrink-0 mt-0.5 transition-transform ${open ? "rotate-90" : ""}`}
          />
        </div>
      </button>
      {open &&
        group.rows.map((r) => (
          <NotificationRow
            key={r._id}
            notification={r}
            onOpen={onOpen}
            onContextMenu={onContextMenu}
            size={size}
            nested
          />
        ))}
    </div>
  );
}

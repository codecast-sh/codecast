import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useState, useRef, useCallback, useMemo } from "react";
import { useEventListener } from "../hooks/useEventListener";
import { AvatarImg } from "../lib/avatarCache";
import { ClaudeIcon, OpenAIIcon, CursorIcon, GeminiIcon, GrokIcon } from "./BrandIcons";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useConvexSync } from "../hooks/useConvexSync";
import { useRouter } from "next/navigation";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../store/inboxStore";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { agentNames, notificationRoute, sessionLabel, sessionTypes, typeColors, typeLabels } from "../lib/notificationTypes";
import { ArrowUpRight, ExternalLink, Check, CheckCheck } from "lucide-react";
import { ContextMenu, useContextMenu, CtxItem, CtxSeparator } from "./ui/context-menu";

// The URL a notification lands on — for opening in a new tab, where the
// in-app store navigation of handleNotificationClick can't reach.
export function notificationHref(n: any): string {
  if (n.link) return n.link;
  return (
    notificationRoute(n.entity_type, n.entity_id, n.chat_message_id) ??
    (n.conversation_id ? `/conversation/${n.conversation_id}` : "/inbox")
  );
}

function timeAgo(timestamp: number): string {
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

function AgentIcon({ agentType, className = "w-9 h-9" }: { agentType: string; className?: string }) {
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
  }
  return (
    <span className={`${className} rounded-full bg-sol-orange flex items-center justify-center shrink-0`}>
      <ClaudeIcon className="w-4 h-4 text-sol-bg" />
    </span>
  );
}

export function NotificationBell() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const ctxMenu = useContextMenu<any>();

  // Local-first: sync the server list into the store, then read + mutate the
  // store so mark-read flips the bold state and badge instantly (the optimistic
  // `read` is field-protected against the next list sync).
  const notifsList = useQuery(api.notifications.list);
  useConvexSync(notifsList, useCallback((d: any) => useInboxStore.getState().syncTable("notifications", d), []));
  const notifications = useInboxStore((s) => s.notifications);
  const markAsRead = useInboxStore((s) => s.markNotificationRead);
  const markAllAsRead = useInboxStore((s) => s.markAllNotificationsRead);

  const sortedNotifications = useMemo(
    () => (Object.values(notifications) as any[]).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)),
    [notifications]
  );
  const unreadCount = useMemo(() => sortedNotifications.filter((n) => !n.read).length, [sortedNotifications]);

  useEventListener("mousedown", useCallback((event: MouseEvent) => {
    if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
      setIsOpen(false);
    }
  }, []), isOpen ? document : null);

  useWatchEffect(() => {
    if (isOpen && unreadCount > 0) {
      markAllAsRead();
    }
  }, [isOpen, markAllAsRead, unreadCount]);

  const handleNotificationClick = async (
    notificationId: Id<"notifications">,
    conversationId?: Id<"conversations">,
    entityType?: string,
    entityId?: string,
    link?: string,
    chatMessageId?: string
  ) => {
    markAsRead(notificationId);
    // A deep link wins (artifact comments: opens the published page with that
    // comment thread selected). New tab — the page lives outside the app.
    if (link) {
      window.open(link, "_blank", "noopener");
      setIsOpen(false);
      return;
    }
    const route = notificationRoute(entityType, entityId, chatMessageId);
    if (route) { router.push(route); setIsOpen(false); return; }
    if (conversationId) {
      useInboxStore.getState().requestNavigate(conversationId);
      router.push('/inbox');
    } else {
      router.push('/inbox');
    }
    setIsOpen(false);
  };

  const recentNotifications = sortedNotifications.slice(0, 20);

  return (
    <div className="relative" ref={dropdownRef}>
      <ShortcutTooltip label="Notifications">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 text-sol-text hover:text-sol-yellow transition-colors"
        aria-label="Notifications"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>
        {unreadCount !== undefined && unreadCount > 0 && (
          <span className="absolute -top-1 -right-2.5 inline-flex items-center justify-center px-1 sm:px-1.5 py-0.5 text-[10px] sm:text-xs font-bold leading-none text-white bg-sol-orange rounded-full min-w-[16px] sm:min-w-[18px]">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>
      </ShortcutTooltip>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-[calc(100vw-1rem)] sm:w-[520px] max-w-[520px] bg-sol-bg border border-sol-border rounded-lg shadow-lg overflow-hidden z-50">
          <div className="px-5 py-3 border-b border-sol-border flex items-center justify-between">
            <h3 className="text-sm font-semibold text-sol-text">Notifications</h3>
            {unreadCount !== undefined && unreadCount > 0 && (
              <span className="text-xs text-sol-text-muted">{unreadCount} unread</span>
            )}
          </div>

          <div className="max-h-[600px] overflow-y-auto">
            {recentNotifications.length === 0 ? (
              <div className="px-5 py-12 text-center text-sol-text-muted">
                No notifications yet
              </div>
            ) : (
              recentNotifications.map((notification: any) => {
                const label = sessionLabel(notification.conversation);
                // Actors without an account (anonymous page commenters) carry
                // their display identity on the row itself.
                const actorName = notification.actor?.name || notification.actor?.github_username || (notification as any).actor_name;
                const actorAvatar = notification.actor?.github_avatar_url || (notification as any).actor_avatar;
                const agentType = notification.conversation?.agent_type || "claude_code";
                const isSessionNotif = sessionTypes.has(notification.type);
                // An agent's face belongs to a row that names a session. The
                // daemon's machine alert has no conversation, so agentType
                // would fall back to Claude Code and put that logo on a report
                // about a frozen machine. Such a row takes the generic icon.
                const showsAgentIcon = isSessionNotif && !!notification.conversation;
                const typeLabel = typeLabels[notification.type] || notification.type;
                const typeColor = typeColors[notification.type] || "text-sol-text-muted";

                return (
                  <button
                    key={notification._id}
                    onClick={() => handleNotificationClick(notification._id, notification.conversation_id, (notification as any).entity_type, (notification as any).entity_id, (notification as any).link, (notification as any).chat_message_id)}
                    onContextMenu={(e) => ctxMenu.open(e, notification)}
                    className={`w-full px-5 py-4 text-left border-b border-sol-border/50 hover:bg-sol-bg-alt transition-colors ${
                      !notification.read ? 'bg-sol-bg-alt/40' : ''
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {actorAvatar ? (
                        <AvatarImg
                          src={actorAvatar}
                          alt={actorName || ''}
                          className="w-9 h-9 rounded-full flex-shrink-0 mt-0.5"
                          fallback={
                            <div className="w-9 h-9 rounded-full flex-shrink-0 mt-0.5 bg-sol-bg-alt border border-sol-border flex items-center justify-center">
                              <span className="text-sm font-medium text-sol-text-muted">{(actorName || "?").charAt(0).toUpperCase()}</span>
                            </div>
                          }
                        />
                      ) : showsAgentIcon ? (
                        <div className="flex-shrink-0 mt-0.5">
                          <AgentIcon agentType={agentType} />
                        </div>
                      ) : (
                        <div className="w-9 h-9 rounded-full flex-shrink-0 mt-0.5 bg-sol-bg-alt border border-sol-border flex items-center justify-center">
                          <svg className="w-4 h-4 text-sol-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                          </svg>
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {actorName ? (
                            <span className="text-sm font-medium text-sol-text">{actorName}</span>
                          ) : showsAgentIcon ? (
                            <span className="text-sm font-medium text-sol-text">{agentNames[agentType] || agentType}</span>
                          ) : null}
                          <span className={`text-xs ${typeColor}`}>{typeLabel}</span>
                          <span className="text-xs text-sol-text-muted ml-auto flex-shrink-0">{timeAgo(notification.created_at)}</span>
                          {!notification.read && (
                            <div className="w-2 h-2 bg-sol-yellow rounded-full flex-shrink-0" />
                          )}
                        </div>
                        <p className="text-sm text-sol-text leading-relaxed line-clamp-2">{notification.message}</p>
                        {label && (
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className="text-xs text-sol-text-muted bg-sol-bg-alt px-2 py-0.5 rounded truncate max-w-[280px]">
                              {label}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {recentNotifications.length > 0 && (
            <div className="px-5 py-3 border-t border-sol-border">
              <button
                onClick={() => {
                  router.push('/notifications');
                  setIsOpen(false);
                }}
                className="text-sm text-sol-yellow hover:text-sol-yellow-bright transition-colors w-full text-center"
              >
                View all
              </button>
            </div>
          )}
        </div>
      )}

      <ContextMenu state={ctxMenu}>
        {(n) => (
          <>
            <CtxItem
              icon={ArrowUpRight}
              onSelect={() => handleNotificationClick(n._id, n.conversation_id, n.entity_type, n.entity_id, n.link, n.chat_message_id)}
            >
              Open
            </CtxItem>
            <CtxItem
              icon={ExternalLink}
              onSelect={() => {
                markAsRead(n._id);
                window.open(notificationHref(n), "_blank", "noopener");
                setIsOpen(false);
              }}
            >
              Open in new tab
            </CtxItem>
            <CtxSeparator />
            {!n.read && (
              <CtxItem icon={Check} onSelect={() => markAsRead(n._id)}>
                Mark as read
              </CtxItem>
            )}
            <CtxItem icon={CheckCheck} onSelect={() => markAllAsRead()}>
              Mark all as read
            </CtxItem>
          </>
        )}
      </ContextMenu>
    </div>
  );
}

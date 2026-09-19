import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useState, useRef, useCallback, useMemo } from "react";
import { useEventListener } from "../hooks/useEventListener";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useConvexSync } from "../hooks/useConvexSync";
import { useRouter } from "next/navigation";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../store/inboxStore";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { TopbarButton } from "./TopbarButton";
import { notificationRoute } from "../lib/notificationTypes";
import { groupIdleNotifications } from "@codecast/shared/contracts";
import { NotificationGroupRow, NotificationRow, notificationHref } from "./notifications/NotificationRow";
import { ArrowUpRight, ExternalLink, Check, CheckCheck } from "lucide-react";
import { ContextMenu, useContextMenu, CtxItem, CtxSeparator } from "./ui/context-menu";

export { notificationHref };

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

  // Fold each waiting burst into one entry (the same fold-up the hourly alert
  // makes), then take 20 ENTRIES — so a fleet of twenty sessions no longer
  // pushes everything else out of the list.
  const entries = useMemo(
    () => groupIdleNotifications(sortedNotifications, (n: any) => String(n._id)).slice(0, 20),
    [sortedNotifications]
  );
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const toggleGroup = useCallback(
    (key: string) => setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] })),
    []
  );
  const openNotification = useCallback(
    (n: any) => handleNotificationClick(n._id, n.conversation_id, n.entity_type, n.entity_id, n.link, n.chat_message_id),
    // handleNotificationClick is stable enough for this dropdown's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return (
    <div className="relative" ref={dropdownRef}>
      <ShortcutTooltip label="Notifications">
      <TopbarButton
        onClick={() => setIsOpen(!isOpen)}
        active={isOpen}
        aria-label="Notifications"
      >
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>
        {unreadCount !== undefined && unreadCount > 0 && (
          <span className="absolute -top-1 -right-1.5 inline-flex items-center justify-center px-1 py-0.5 text-[10px] font-bold leading-none text-white bg-sol-orange rounded-full min-w-[16px] ring-2 ring-sol-bg">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </TopbarButton>
      </ShortcutTooltip>

      {isOpen && (
        <div className="cc-topbar-menu absolute right-0 mt-2 w-[calc(100vw-1rem)] sm:w-[520px] max-w-[520px] bg-sol-bg border border-sol-border rounded-lg shadow-lg overflow-hidden z-50">
          <div className="px-5 py-3 border-b border-sol-border flex items-center justify-between">
            <h3 className="text-sm font-semibold text-sol-text">Notifications</h3>
            {unreadCount !== undefined && unreadCount > 0 && (
              <span className="text-xs text-sol-text-muted">{unreadCount} unread</span>
            )}
          </div>

          <div className="max-h-[600px] overflow-y-auto">
            {entries.length === 0 ? (
              <div className="px-5 py-12 text-center text-sol-text-muted">
                No notifications yet
              </div>
            ) : (
              entries.map((entry: any) =>
                entry.kind === "group" ? (
                  <NotificationGroupRow
                    key={entry.key}
                    group={entry}
                    open={!!openGroups[entry.key]}
                    onToggle={() => toggleGroup(entry.key)}
                    onOpen={openNotification}
                    onContextMenu={(e, n) => ctxMenu.open(e, n)}
                  />
                ) : (
                  <NotificationRow
                    key={entry.key}
                    notification={entry.row}
                    onOpen={openNotification}
                    onContextMenu={(e, n) => ctxMenu.open(e, n)}
                  />
                )
              )
            )}
          </div>

          {entries.length > 0 && (
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

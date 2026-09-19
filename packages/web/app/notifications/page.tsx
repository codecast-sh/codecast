import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { useRouter } from "next/navigation";
import { useState, useCallback, useMemo } from "react";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../../store/inboxStore";
import { useConvexSync } from "../../hooks/useConvexSync";
import {
  NotificationGroupRow,
  NotificationRow,
  notificationHref,
} from "../../components/notifications/NotificationRow";
import { groupIdleNotifications } from "@codecast/shared/contracts";
import { ArrowUpRight, ExternalLink, Check, CheckCheck } from "lucide-react";
import { ContextMenu, useContextMenu, CtxItem, CtxSeparator } from "../../components/ui/context-menu";
import {
  notificationRoute,
  sessionTypes,
  socialTypes,
  taskTypes,
} from "../../lib/notificationTypes";

type FilterTab = "all" | "unread" | "sessions" | "social" | "tasks";

export default function NotificationsPage() {
  const router = useRouter();
  // Local-first: sync the server list into the store, read + mutate the store.
  const notifsList = useQuery(api.notifications.list);
  useConvexSync(notifsList, useCallback((d: any) => useInboxStore.getState().syncTable("notifications", d), []));
  const notificationsMap = useInboxStore((s) => s.notifications);
  const notifications = useMemo(
    () => (Object.values(notificationsMap) as any[]).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)),
    [notificationsMap]
  );
  const markAsRead = useInboxStore((s) => s.markNotificationRead);
  const markAllAsRead = useInboxStore((s) => s.markAllNotificationsRead);
  const [activeTab, setActiveTab] = useState<FilterTab>("all");
  const ctxMenu = useContextMenu<any>();

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
      return;
    }
    const route = notificationRoute(entityType, entityId, chatMessageId);
    if (route) { router.push(route); return; }
    if (conversationId) {
      router.push(`/conversation/${conversationId}`);
    } else {
      router.push("/inbox");
    }
  };

  const filteredNotifications = (notifications || []).filter((n: any) => {
    if (activeTab === "unread") return !n.read;
    if (activeTab === "sessions") return sessionTypes.has(n.type) || n.type === "team_session_start";
    if (activeTab === "social") return socialTypes.has(n.type);
    if (activeTab === "tasks") return taskTypes.has(n.type);
    return true;
  });

  const unreadCount = notifications?.filter((n: any) => !n.read).length || 0;

  // Same fold-up the bell and the hourly alert make: a waiting burst reads as
  // one entry that opens.
  const entries = useMemo(
    () => groupIdleNotifications(filteredNotifications, (n: any) => String(n._id)),
    [filteredNotifications]
  );
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const toggleGroup = useCallback(
    (key: string) => setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] })),
    []
  );
  const openNotification = useCallback(
    (n: any) => handleNotificationClick(n._id, n.conversation_id, n.entity_type, n.entity_id, n.link, n.chat_message_id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const tabs: { key: FilterTab; label: string }[] = [
    { key: "all", label: "All" },
    { key: "unread", label: `Unread${unreadCount > 0 ? ` (${unreadCount})` : ""}` },
    { key: "sessions", label: "Sessions" },
    { key: "tasks", label: "Tasks" },
    { key: "social", label: "Social" },
  ];

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center justify-between mb-5">
            <h1 className="text-xl font-semibold text-sol-text">Notifications</h1>
            {unreadCount > 0 && (
              <button
                onClick={() => markAllAsRead()}
                className="text-xs text-sol-text-muted hover:text-sol-yellow transition-colors px-3 py-1.5 border border-sol-border rounded-lg hover:border-sol-yellow/40"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="flex gap-1 mb-5 border-b border-sol-border">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-3 py-2 text-sm transition-colors border-b-2 -mb-px ${
                  activeTab === tab.key
                    ? "border-sol-yellow text-sol-yellow font-medium"
                    : "border-transparent text-sol-text-muted hover:text-sol-text"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {notifsList === undefined && notifications.length === 0 ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex items-start gap-3 p-4 rounded-lg bg-sol-bg-alt/30 animate-pulse">
                  <div className="w-10 h-10 rounded-full bg-sol-bg-alt" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-sol-bg-alt rounded w-3/4" />
                    <div className="h-3 bg-sol-bg-alt rounded w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : filteredNotifications.length === 0 ? (
            <div className="text-center py-16">
              <svg
                className="w-12 h-12 mx-auto text-sol-text-dim mb-3"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                />
              </svg>
              <p className="text-sol-text-muted text-sm">
                {activeTab === "all" ? "No notifications yet" : `No ${activeTab} notifications`}
              </p>
            </div>
          ) : (
            <div className="space-y-px rounded-lg border border-sol-border overflow-hidden">
              {entries.map((entry: any) =>
                entry.kind === "group" ? (
                  <NotificationGroupRow
                    key={entry.key}
                    group={entry}
                    open={!!openGroups[entry.key]}
                    onToggle={() => toggleGroup(entry.key)}
                    onOpen={openNotification}
                    onContextMenu={(e, n) => ctxMenu.open(e, n)}
                    size="page"
                  />
                ) : (
                  <NotificationRow
                    key={entry.key}
                    notification={entry.row}
                    onOpen={openNotification}
                    onContextMenu={(e, n) => ctxMenu.open(e, n)}
                    size="page"
                  />
                )
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
      </DashboardLayout>
    </AuthGuard>
  );
}

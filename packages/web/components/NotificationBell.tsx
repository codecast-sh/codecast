import { api } from "@codecast/convex/convex/_generated/api";
import { useState, useRef, useCallback, useMemo, forwardRef, type ButtonHTMLAttributes } from "react";
import { useEventListener } from "../hooks/useEventListener";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useConvexSync } from "../hooks/useConvexSync";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useRouter } from "next/navigation";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../store/inboxStore";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { TopbarButton } from "./TopbarButton";
import { notificationHref, notificationRoute } from "../lib/notificationTypes";
import { NotificationList } from "./notifications/NotificationList";
import { useAssistantScope, useSurfaceMode } from "../lib/surfaces";
import { bySessionAgent, withinScope } from "../lib/assistantScope";
import { ArrowUpRight, Bell, ExternalLink, Check, CheckCheck } from "lucide-react";
import { ContextMenu, useContextMenu, CtxItem, CtxSeparator } from "./ui/context-menu";

/** The bell in the top bar, with the unread count on its shoulder. */
export const NotificationBellButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean; unreadCount?: number; /** A quiet dot instead of the count (hosted mode). */ dot?: boolean }
>(function NotificationBellButton({ active, unreadCount, dot, ...props }, ref) {
  return (
      <TopbarButton
        ref={ref}
        {...props}
        active={active}
        aria-label="Notifications"
      >
        <Bell />
        {unreadCount !== undefined && unreadCount > 0 && dot && (
          <span aria-hidden className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-sol-cyan ring-2 ring-sol-bg" />
        )}
        {unreadCount !== undefined && unreadCount > 0 && !dot && (
          <span className="absolute -top-0.5 -right-1 inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-sol-cyan px-[3px] text-[9px] font-semibold leading-none tabular-nums text-white ring-2 ring-sol-bg">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </TopbarButton>
  );
});

export function NotificationBell() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const ctxMenu = useContextMenu<any>();

  // Local-first: sync the server list into the store, then read + mutate the
  // store so mark-read flips the bold state and badge instantly (the optimistic
  // `read` is field-protected against the next list sync).
  const notifsList = useQueryNoThrow(api.notifications.list, {}).data;
  useConvexSync(notifsList, useCallback((d: any) => useInboxStore.getState().syncTable("notifications", d), []));
  const notifications = useInboxStore((s) => s.notifications);
  const markAsRead = useInboxStore((s) => s.markNotificationRead);
  const markAllAsRead = useInboxStore((s) => s.markAllNotificationsRead);

  // Hosted mode's Assistant scope: only news about the assistant's
  // conversations (their replies, approvals and routines), the rest counted
  // at the foot. Team chat, huddles and other agents wait in Everything.
  const mode = useSurfaceMode();
  const scope = useAssistantScope();
  const allNotifications = useMemo(
    () => (Object.values(notifications) as any[]).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)),
    [notifications]
  );
  const sortedNotifications = useMemo(
    () => withinScope(allNotifications, scope.only, (n: any) => bySessionAgent(n.conversation ?? {})) as any[],
    [allNotifications, scope.only]
  );
  const hiddenByScope = allNotifications.length - sortedNotifications.length;
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
      <NotificationBellButton onClick={() => setIsOpen(!isOpen)} active={isOpen} unreadCount={unreadCount} dot={mode.hosted} />
      </ShortcutTooltip>

      {isOpen && (
        <NotificationList
          notifications={sortedNotifications}
          unreadCount={unreadCount}
          onOpen={openNotification}
          onContextMenu={(e, n) => ctxMenu.open(e, n)}
          openGroups={openGroups}
          onToggleGroup={toggleGroup}
          mode={mode}
          hiddenByScope={scope.only ? hiddenByScope : 0}
          onShowEverything={() => scope.setEverything(true)}
          onViewAll={() => {
            router.push('/notifications');
            setIsOpen(false);
          }}
        />
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

import { api } from "@codecast/convex/convex/_generated/api";
import { useState, useRef, useCallback, useMemo, forwardRef, type ButtonHTMLAttributes } from "react";
import { useEventListener } from "../hooks/useEventListener";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useConvexSync } from "../hooks/useConvexSync";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useRouter } from "next/navigation";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../store/inboxStore";
import { useCollectionRows } from "../hooks/useCollectionRows";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { TopbarButton } from "./TopbarButton";
import { notificationHref, notificationRoute } from "../lib/notificationTypes";
import { inAppPath } from "../lib/openIntent";
import { NotificationList } from "./notifications/NotificationList";
import { ArrowUpRight, Bell, ExternalLink, Check, CheckCheck } from "lucide-react";
import { ContextMenu, useContextMenu, CtxItem, CtxSeparator } from "./ui/context-menu";

// The rows the list shows, newest first, woken by a signature of what a row
// draws (whether it is read, when it came) rather than the collection's ref.
// Module level: the hook keys its signature on these functions.
const NOTIFICATION_ROWS = {
  sig: (n: any) => `${n.read ? 1 : 0}${n.created_at ?? 0}`,
  sort: (a: any, b: any) => (b.created_at ?? 0) - (a.created_at ?? 0),
};

/** The bell in the top bar, with the unread count on its shoulder. */
export const NotificationBellButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean; unreadCount?: number }
>(function NotificationBellButton({ active, unreadCount, ...props }, ref) {
  return (
      <TopbarButton
        ref={ref}
        {...props}
        active={active}
        aria-label="Notifications"
      >
        <Bell />
        {unreadCount !== undefined && unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-sol-cyan px-[3px] text-mark font-semibold leading-none tabular-nums text-white dark:text-sol-bg ring-2 ring-sol-bg">
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
  // A signature of what the rows show, not the collection: the bell is in
  // the top bar of every page, and the collection's ref turns over on any
  // write to any notification.
  const sortedNotifications = useCollectionRows<any>("notifications", NOTIFICATION_ROWS);
  const markAsRead = useInboxStore((s) => s.markNotificationRead);
  const markAllAsRead = useInboxStore((s) => s.markAllNotificationsRead);

  const unreadCount = useMemo(() => sortedNotifications.filter((n) => !n.read).length, [sortedNotifications]);

  useEventListener("mousedown", useCallback((event: MouseEvent) => {
    if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
      setIsOpen(false);
    }
  }, []), isOpen ? document : null);

  // What was unread when the panel opened is marked read when it closes, not
  // as it opens: the rows keep their unread look (and the header its count)
  // while the person reads them. A line that arrives with the panel open is
  // not in the snapshot, so it stays unread for the next look.
  const seenOnOpenRef = useRef<string[] | null>(null);
  useWatchEffect(() => {
    if (isOpen) {
      seenOnOpenRef.current = sortedNotifications.filter((n) => !n.read).map((n) => String(n._id));
      return;
    }
    const seen = seenOnOpenRef.current;
    seenOnOpenRef.current = null;
    if (!seen || seen.length === 0) return;
    const seenSet = new Set(seen);
    const unreadNow = (Object.values(useInboxStore.getState().notifications) as any[]).filter((n) => !n.read);
    // One write for the usual case; one per line only when something new
    // came in while the panel was open.
    if (unreadNow.every((n) => seenSet.has(String(n._id)))) markAllAsRead();
    else for (const id of seen) markAsRead(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the snapshot is taken at the open itself
  }, [isOpen]);

  const handleNotificationClick = async (
    notificationId: Id<"notifications">,
    conversationId?: Id<"conversations">,
    entityType?: string,
    entityId?: string,
    link?: string,
    chatMessageId?: string
  ) => {
    markAsRead(notificationId);
    // A deep link wins. An app route opens here; a page outside the app (a
    // published page with a comment thread selected) opens in a new tab.
    if (link) {
      const path = inAppPath(link);
      if (path) router.push(path);
      else window.open(link, "_blank", "noopener");
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
      <NotificationBellButton onClick={() => setIsOpen(!isOpen)} active={isOpen} unreadCount={unreadCount} />
      </ShortcutTooltip>

      {isOpen && (
        <NotificationList
          notifications={sortedNotifications}
          unreadCount={unreadCount}
          onOpen={openNotification}
          onContextMenu={(e, n) => ctxMenu.open(e, n)}
          openGroups={openGroups}
          onToggleGroup={toggleGroup}
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

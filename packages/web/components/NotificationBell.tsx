"use client";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Id } from "@codecast/convex/convex/_generated/dataModel";

export function NotificationBell() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const unreadCount = useQuery(api.notifications.getUnreadCount);
  const notifications = useQuery(api.notifications.list);
  const markAsRead = useMutation(api.notifications.markAsRead);
  const markAllAsRead = useMutation(api.notifications.markAllAsRead);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      if (unreadCount && unreadCount > 0) {
        markAllAsRead();
      }
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  const handleNotificationClick = async (notificationId: Id<"notifications">, conversationId?: Id<"conversations">) => {
    await markAsRead({ notificationId });
    if (conversationId) {
      router.push(`/conversation/${conversationId}`);
    }
    setIsOpen(false);
  };

  const recentNotifications = notifications?.slice(0, 5) || [];

  return (
    <div className="relative" ref={dropdownRef}>
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
          <span className="absolute top-0 right-0 inline-flex items-center justify-center px-1.5 py-0.5 text-xs font-bold leading-none text-white bg-red-600 rounded-full transform translate-x-1/2 -translate-y-1/2">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-80 bg-sol-bg border border-sol-border rounded-lg shadow-lg overflow-hidden z-50">
          <div className="px-4 py-3 border-b border-sol-border">
            <h3 className="text-sm font-semibold text-sol-text">Notifications</h3>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {recentNotifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-sol-text-muted">
                No notifications yet
              </div>
            ) : (
              recentNotifications.map((notification) => (
                <button
                  key={notification._id}
                  onClick={() => handleNotificationClick(notification._id, notification.conversation_id)}
                  className={`w-full px-4 py-3 text-left border-b border-sol-border hover:bg-sol-bg-alt transition-colors ${
                    !notification.read ? 'bg-sol-bg-alt/50' : ''
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {notification.actor?.github_avatar_url && (
                      <img
                        src={notification.actor.github_avatar_url}
                        alt={notification.actor.name || notification.actor.github_username || ''}
                        className="w-8 h-8 rounded-full flex-shrink-0"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-sol-text">{notification.message}</p>
                      <p className="text-xs text-sol-text-muted mt-1">
                        {new Date(notification.created_at).toLocaleString()}
                      </p>
                    </div>
                    {!notification.read && (
                      <div className="w-2 h-2 bg-sol-yellow rounded-full flex-shrink-0 mt-1.5" />
                    )}
                  </div>
                </button>
              ))
            )}
          </div>

          {recentNotifications.length > 0 && (
            <div className="px-4 py-3 border-t border-sol-border">
              <button
                onClick={() => {
                  router.push('/notifications');
                  setIsOpen(false);
                }}
                className="text-sm text-sol-yellow hover:text-sol-yellow-bright transition-colors w-full text-center"
              >
                View all notifications
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

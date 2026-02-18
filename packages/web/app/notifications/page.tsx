"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { useRouter } from "next/navigation";
import { Id } from "@codecast/convex/convex/_generated/dataModel";

export default function NotificationsPage() {
  const router = useRouter();
  const notifications = useQuery(api.notifications.list);
  const markAsRead = useMutation(api.notifications.markAsRead);
  const markAllAsRead = useMutation(api.notifications.markAllAsRead);

  const handleNotificationClick = async (notificationId: Id<"notifications">, conversationId?: Id<"conversations">) => {
    await markAsRead({ notificationId });
    if (conversationId) {
      router.push(`/inbox?s=${conversationId}`);
    } else {
      router.push('/inbox');
    }
  };

  const handleMarkAllAsRead = async () => {
    await markAllAsRead();
  };

  const unreadNotifications = notifications?.filter(n => !n.read) || [];

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-bold text-sol-text">Notifications</h1>
            {unreadNotifications.length > 0 && (
              <button
                onClick={handleMarkAllAsRead}
                className="text-sm text-sol-yellow hover:text-sol-yellow-bright transition-colors px-4 py-2 border border-sol-border rounded-lg hover:bg-sol-bg-alt"
              >
                Mark all as read
              </button>
            )}
          </div>

          {notifications === undefined ? (
            <div className="text-center py-12 text-sol-text-muted">
              Loading notifications...
            </div>
          ) : notifications.length === 0 ? (
            <div className="text-center py-12">
              <svg
                className="w-16 h-16 mx-auto text-sol-text-dim mb-4"
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
              <p className="text-sol-text-muted">No notifications yet</p>
            </div>
          ) : (
            <div className="space-y-2">
              {notifications.map((notification) => (
                <button
                  key={notification._id}
                  onClick={() => handleNotificationClick(notification._id, notification.conversation_id)}
                  className={`w-full p-4 text-left border border-sol-border rounded-lg hover:bg-sol-bg-alt transition-colors ${
                    !notification.read ? 'bg-sol-bg-alt/50 border-sol-yellow/30' : 'bg-sol-bg'
                  }`}
                >
                  <div className="flex items-start gap-4">
                    {notification.actor?.github_avatar_url && (
                      <img
                        src={notification.actor.github_avatar_url}
                        alt={notification.actor.name || notification.actor.github_username || ''}
                        className="w-10 h-10 rounded-full flex-shrink-0"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sol-text font-medium">{notification.message}</p>
                        {!notification.read && (
                          <div className="w-2 h-2 bg-sol-yellow rounded-full flex-shrink-0 mt-1.5" />
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-2 text-xs text-sol-text-muted">
                        <span className="capitalize">{notification.type.replace('_', ' ')}</span>
                        <span>·</span>
                        <span>{new Date(notification.created_at).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}

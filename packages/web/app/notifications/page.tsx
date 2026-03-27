import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Id } from "@codecast/convex/convex/_generated/dataModel";

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

function ClaudeIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.3041 3.541h-3.6718l6.696 16.918H24L17.3041 3.541Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409H6.696Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456H6.3247Z" />
    </svg>
  );
}

function OpenAIIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

function CursorIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 4l16 6-8 2-2 8z" />
    </svg>
  );
}

function GeminiIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C12 0 12 6.268 8.134 10.134C4.268 14 0 14 0 14C0 14 6.268 14 10.134 17.866C14 21.732 14 28 14 28C14 28 14 21.732 17.866 17.866C21.732 14 28 14 28 14C28 14 21.732 14 17.866 10.134C14 6.268 14 0 14 0" transform="scale(0.857) translate(1, -2)" />
    </svg>
  );
}

function AgentIcon({ agentType, className = "w-10 h-10" }: { agentType: string; className?: string }) {
  if (agentType === "codex" || agentType === "codex_cli") {
    return (
      <span className={`${className} rounded-full bg-[#0f0f0f] flex items-center justify-center shrink-0`}>
        <OpenAIIcon className="w-4.5 h-4.5 text-white" />
      </span>
    );
  } else if (agentType === "cursor") {
    return (
      <span className={`${className} rounded-full bg-[#1a1a2e] flex items-center justify-center shrink-0`}>
        <CursorIcon className="w-4.5 h-4.5 text-white" />
      </span>
    );
  } else if (agentType === "gemini") {
    return (
      <span className={`${className} rounded-full bg-[#1a73e8] flex items-center justify-center shrink-0`}>
        <GeminiIcon className="w-4.5 h-4.5 text-white" />
      </span>
    );
  }
  return (
    <span className={`${className} rounded-full bg-sol-orange flex items-center justify-center shrink-0`}>
      <ClaudeIcon className="w-4.5 h-4.5 text-sol-bg" />
    </span>
  );
}

const agentNames: Record<string, string> = {
  claude_code: "claude",
  codex: "codex",
  codex_cli: "codex",
  cursor: "cursor",
  gemini: "gemini",
};

const sessionTypes = new Set(["session_idle", "session_error", "permission_request"]);

const typeLabels: Record<string, string> = {
  team_session_start: "started coding",
  session_idle: "ready",
  session_error: "error",
  permission_request: "needs permission",
  mention: "mentioned you",
  comment_reply: "replied",
  conversation_comment: "commented",
  team_invite: "team invite",
  task_completed: "task done",
  task_failed: "task failed",
  task_assigned: "assigned to you",
  task_status_changed: "status changed",
  task_commented: "commented",
  doc_updated: "doc updated",
  doc_commented: "commented on doc",
  plan_status_changed: "plan updated",
  plan_task_completed: "plan task done",
};

const typeColors: Record<string, string> = {
  team_session_start: "text-sol-green",
  session_idle: "text-sol-green",
  session_error: "text-red-400",
  permission_request: "text-sol-orange",
  mention: "text-sol-blue",
  comment_reply: "text-sol-cyan",
  conversation_comment: "text-sol-cyan",
  team_invite: "text-sol-violet",
  task_completed: "text-sol-green",
  task_failed: "text-red-400",
  task_assigned: "text-sol-yellow",
  task_status_changed: "text-sol-yellow",
  task_commented: "text-sol-cyan",
  doc_updated: "text-sol-violet",
  doc_commented: "text-sol-cyan",
  plan_status_changed: "text-sol-green",
  plan_task_completed: "text-sol-green",
};

type FilterTab = "all" | "unread" | "sessions" | "social" | "tasks";

const socialTypes = new Set(["mention", "comment_reply", "conversation_comment", "team_invite"]);
const taskTypes = new Set(["task_assigned", "task_status_changed", "task_commented", "task_completed", "task_failed", "plan_status_changed", "plan_task_completed", "doc_updated", "doc_commented"]);

function sessionLabel(conversation: { title?: string; project_path?: string; agent_type?: string } | null): string | null {
  if (!conversation) return null;
  if (conversation.title) return conversation.title;
  if (conversation.project_path) {
    const parts = conversation.project_path.split("/");
    return parts[parts.length - 1] || parts[parts.length - 2] || conversation.project_path;
  }
  return null;
}

export default function NotificationsPage() {
  const router = useRouter();
  const notifications = useQuery(api.notifications.list);
  const markAsRead = useMutation(api.notifications.markAsRead);
  const markAllAsRead = useMutation(api.notifications.markAllAsRead);
  const [activeTab, setActiveTab] = useState<FilterTab>("all");

  const handleNotificationClick = async (
    notificationId: Id<"notifications">,
    conversationId?: Id<"conversations">,
    entityType?: string,
    entityId?: string
  ) => {
    await markAsRead({ notificationId });
    if (entityType && entityId) {
      const routes: Record<string, string> = { task: "/tasks/", doc: "/docs/", plan: "/plans/" };
      const base = routes[entityType];
      if (base) { router.push(`${base}${entityId}`); return; }
    }
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
        <div className="max-w-2xl mx-auto py-2">
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

          {notifications === undefined ? (
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
              {filteredNotifications.map((notification: any) => {
                const label = sessionLabel(notification.conversation);
                const actorName = notification.actor?.name || notification.actor?.github_username;
                const agentType = notification.conversation?.agent_type || "claude_code";
                const isSessionNotif = sessionTypes.has(notification.type);
                const typeLabel = typeLabels[notification.type] || notification.type;
                const typeColor = typeColors[notification.type] || "text-sol-text-muted";

                return (
                  <button
                    key={notification._id}
                    onClick={() => handleNotificationClick(notification._id, notification.conversation_id, (notification as any).entity_type, (notification as any).entity_id)}
                    className={`w-full px-5 py-4 text-left border-b border-sol-border/40 last:border-b-0 hover:bg-sol-bg-alt transition-colors ${
                      !notification.read ? "bg-sol-bg-alt/40" : "bg-sol-bg"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {notification.actor?.github_avatar_url ? (
                        <img
                          src={notification.actor.github_avatar_url}
                          alt={actorName || ""}
                          className="w-10 h-10 rounded-full flex-shrink-0 mt-0.5"
                        />
                      ) : isSessionNotif ? (
                        <div className="flex-shrink-0 mt-0.5">
                          <AgentIcon agentType={agentType} />
                        </div>
                      ) : (
                        <div className="w-10 h-10 rounded-full flex-shrink-0 mt-0.5 bg-sol-bg-alt border border-sol-border flex items-center justify-center">
                          <svg className="w-4 h-4 text-sol-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                          </svg>
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {actorName ? (
                            <span className="text-sm font-medium text-sol-text">{actorName}</span>
                          ) : isSessionNotif ? (
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
                            <span className="text-xs text-sol-text-muted bg-sol-bg-alt px-2 py-0.5 rounded truncate max-w-[360px]">
                              {label}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}

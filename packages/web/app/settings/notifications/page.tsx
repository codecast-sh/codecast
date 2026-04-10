import { useCallback } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Card } from "../../../components/ui/card";
import { Switch } from "../../../components/ui/switch";
import { toast } from "sonner";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  Bell, BellOff, Users, MessageSquare,
  CheckCircle, Terminal,
} from "lucide-react";

type NotifType = "team_session_start" | "mention" | "permission_request" | "session_idle" | "session_error" | "task_activity" | "doc_activity" | "plan_activity";

const NOTIF_SECTIONS = [
  {
    title: "Sessions",
    icon: Terminal,
    items: [
      { key: "team_session_start" as NotifType, label: "Team Sessions", desc: "When a team member starts a session" },
      { key: "session_idle" as NotifType, label: "Session Idle", desc: "When your session is waiting for input" },
      { key: "session_error" as NotifType, label: "Session Errors", desc: "When a session encounters an error" },
      { key: "permission_request" as NotifType, label: "Permission Requests", desc: "When a session needs your approval" },
    ],
  },
  {
    title: "Social",
    icon: MessageSquare,
    items: [
      { key: "mention" as NotifType, label: "Mentions", desc: "When someone @mentions you" },
    ],
  },
  {
    title: "Work Items",
    icon: CheckCircle,
    items: [
      { key: "task_activity" as NotifType, label: "Task Activity", desc: "Updates on tasks you're watching" },
      { key: "doc_activity" as NotifType, label: "Doc Activity", desc: "Updates on docs you're watching" },
      { key: "plan_activity" as NotifType, label: "Plan Activity", desc: "Updates on plans you're watching" },
    ],
  },
] as const;

const DEFAULT_PREFS = {
  team_session_start: true,
  mention: true,
  permission_request: true,
  session_idle: true,
  session_error: true,
  task_activity: true,
  doc_activity: true,
  plan_activity: true,
};

export default function NotificationsSettingsPage() {
  const user = useQuery(api.users.getCurrentUser);
  const updatePrefs = useMutation(api.users.updateNotificationPreferences);
  const activeTeamId = (user?.active_team_id || user?.team_id) as Id<"teams"> | undefined;
  const teamMembers = useQuery(
    api.teams.getTeamMembers,
    activeTeamId ? { team_id: activeTeamId } : "skip"
  );

  const prefs = user?.notification_preferences;
  const enabled = user?.notifications_enabled ?? false;
  const mutedMembers: Id<"users">[] = (user as any)?.muted_members ?? [];

  const getPref = useCallback((key: NotifType) => {
    return (prefs as any)?.[key] ?? true;
  }, [prefs]);

  const handleGlobalToggle = useCallback(async (value: boolean) => {
    try {
      await updatePrefs({ notifications_enabled: value });
    } catch {
      toast.error("Failed to update notification settings");
    }
  }, [updatePrefs]);

  const handleToggleType = useCallback(async (type: NotifType) => {
    const current = { ...DEFAULT_PREFS, ...prefs };
    try {
      await updatePrefs({
        notification_preferences: {
          ...current,
          [type]: !((current as any)[type] ?? true),
        },
      });
    } catch {
      toast.error("Failed to update preferences");
    }
  }, [prefs, updatePrefs]);

  const handleToggleMute = useCallback(async (memberId: Id<"users">) => {
    const isMuted = mutedMembers.includes(memberId);
    const next = isMuted
      ? mutedMembers.filter(id => id !== memberId)
      : [...mutedMembers, memberId];
    try {
      await updatePrefs({ muted_members: next });
    } catch {
      toast.error("Failed to update mute settings");
    }
  }, [mutedMembers, updatePrefs]);

  if (!user) return null;

  type TeamMember = { _id: Id<"users">; name?: string | null; email?: string | null; github_avatar_url?: string | null; title?: string | null };
  const otherMembers = (teamMembers ?? []).filter(
    (m: any) => m != null && m._id !== user._id
  ) as TeamMember[];

  return (
    <div className="space-y-6">
      {/* Global toggle */}
      <Card className="p-6 bg-sol-bg border-sol-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {enabled ? (
              <Bell className="w-5 h-5 text-sol-cyan" />
            ) : (
              <BellOff className="w-5 h-5 text-sol-base01" />
            )}
            <div>
              <h2 className="text-lg font-semibold text-sol-text">Notifications</h2>
              <p className="text-sm text-sol-base1">
                {enabled ? "Receiving push notifications" : "All notifications are off"}
              </p>
            </div>
          </div>
          <Switch checked={enabled} onCheckedChange={handleGlobalToggle} />
        </div>
      </Card>

      {/* Per-type toggles */}
      {enabled && (
        <>
          {NOTIF_SECTIONS.map((section) => {
            const Icon = section.icon;
            return (
              <Card key={section.title} className="p-6 bg-sol-bg border-sol-border">
                <div className="flex items-center gap-2 mb-4">
                  <Icon className="w-4 h-4 text-sol-base1" />
                  <h3 className="text-xs font-semibold text-sol-base1 uppercase tracking-wider">
                    {section.title}
                  </h3>
                </div>
                <div className="space-y-0 divide-y divide-sol-border/40">
                  {section.items.map((item) => (
                    <div key={item.key} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                      <div>
                        <span className="text-sm font-medium text-sol-text">{item.label}</span>
                        <p className="text-xs text-sol-base1 mt-0.5">{item.desc}</p>
                      </div>
                      <Switch
                        checked={getPref(item.key)}
                        onCheckedChange={() => handleToggleType(item.key)}
                      />
                    </div>
                  ))}
                </div>
              </Card>
            );
          })}

          {/* Per-member muting */}
          {otherMembers && otherMembers.length > 0 && (
            <Card className="p-6 bg-sol-bg border-sol-border">
              <div className="flex items-center gap-2 mb-1">
                <Users className="w-4 h-4 text-sol-base1" />
                <h3 className="text-xs font-semibold text-sol-base1 uppercase tracking-wider">
                  Team Members
                </h3>
              </div>
              <p className="text-xs text-sol-base01 mb-4">
                Mute notifications from specific team members
              </p>
              <div className="space-y-0 divide-y divide-sol-border/40">
                {otherMembers.map((member) => {
                  const isMuted = mutedMembers.includes(member._id);
                  return (
                    <div key={member._id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                      <div className="flex items-center gap-3">
                        {member.github_avatar_url ? (
                          <img
                            src={member.github_avatar_url}
                            alt=""
                            className="w-8 h-8 rounded-full"
                          />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-sol-base02 flex items-center justify-center">
                            <span className="text-sm font-medium text-sol-text">
                              {member.name?.[0]?.toUpperCase() || "?"}
                            </span>
                          </div>
                        )}
                        <div>
                          <span className="text-sm font-medium text-sol-text">
                            {member.name || member.email}
                          </span>
                          {member.title && (
                            <p className="text-xs text-sol-base01">{member.title}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {isMuted && (
                          <span className="text-xs text-sol-orange">Muted</span>
                        )}
                        <Switch
                          checked={!isMuted}
                          onCheckedChange={() => handleToggleMute(member._id)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

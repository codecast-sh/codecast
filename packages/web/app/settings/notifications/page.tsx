import { useSettingsData } from "../../../hooks/useSyncSettings";
import { useCurrentUser } from "../../../hooks/useCurrentUser";
import { useCallback } from "react";
import { useMutation } from "convex/react";
import { AvatarImg } from "../../../lib/avatarCache";
import { api } from "@codecast/convex/convex/_generated/api";
import { Switch } from "../../../components/ui/switch";
import { toast } from "sonner";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  Bell, BellOff, Users, MessageSquare, Laptop, CheckCircle, Terminal, Mail,
} from "lucide-react";
import { SettingsPanel, SettingsRow, SettingsSection } from "../../../components/settings/ui";
import { useOsPermission } from "../../../hooks/useOsPermissions";
import { PermissionRow } from "../../../components/permissions/PermissionRow";

/* This device's OS-level permission (System Settings / browser site
 * permission) — a separate axis from the in-app prefs below: with it off,
 * every banner silently vanishes no matter what the switches say. */
function DevicePermissionRow() {
  const { readiness, refresh } = useOsPermission("notifications");
  return <PermissionRow kind="notifications" readiness={readiness} onChange={refresh} />;
}

type NotifType = "team_session_start" | "mention" | "permission_request" | "session_idle" | "session_error" | "task_activity" | "doc_activity" | "plan_activity" | "artifact_activity" | "chat_activity" | "email_notifications";

const NOTIF_SECTIONS = [
  {
    title: "Sessions",
    icon: Terminal,
    items: [
      { key: "team_session_start" as NotifType, label: "Team sessions", desc: "When a team member starts a session" },
      { key: "session_idle" as NotifType, label: "Session idle", desc: "When your session is waiting for input" },
      { key: "session_error" as NotifType, label: "Session errors", desc: "When a session encounters an error" },
      { key: "permission_request" as NotifType, label: "Permission requests", desc: "When a session needs your approval" },
    ],
  },
  {
    title: "Social",
    icon: MessageSquare,
    items: [
      { key: "mention" as NotifType, label: "Mentions", desc: "When someone @mentions you" },
      { key: "artifact_activity" as NotifType, label: "Published pages", desc: "When someone comments on a page you published" },
      { key: "chat_activity" as NotifType, label: "Team chat", desc: "Thread replies, @here, and every post in channels you set to All new posts (a direct @you rides Mentions)" },
    ],
  },
  {
    title: "Work Items",
    icon: CheckCircle,
    items: [
      { key: "task_activity" as NotifType, label: "Task activity", desc: "Updates on tasks you're watching" },
      { key: "doc_activity" as NotifType, label: "Doc activity", desc: "Updates on docs you're watching" },
      { key: "plan_activity" as NotifType, label: "Plan activity", desc: "Updates on plans you're watching" },
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
  artifact_activity: true,
  chat_activity: true,
  email_notifications: true,
};

export default function NotificationsSettingsPage() {
  const { user } = useCurrentUser();
  const updatePrefs = useMutation(api.users.updateNotificationPreferences);
  const { data: teamMembers } = useSettingsData("teamMembers");

  const prefs = user?.notification_preferences;
  const enabled = user?.notifications_enabled ?? false;
  const mutedMembers: Id<"users">[] = (user as any)?.muted_members ?? [];
  const machineWidePresence = (user as any)?.machine_wide_presence ?? true;

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

  const handleToggleMachinePresence = useCallback(async (value: boolean) => {
    try {
      await updatePrefs({ machine_wide_presence: value });
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
    <SettingsPanel>
      <SettingsSection
        title="Delivery"
        icon={enabled ? Bell : BellOff}
        description={enabled ? "Push notifications are on." : "All push notifications are off. Email keeps its own switch below."}
        actions={<Switch checked={enabled} onCheckedChange={handleGlobalToggle} aria-label="Push notifications" />}
      >
        <DevicePermissionRow />
        {/* Email digest — its own channel, deliberately not gated behind the
            push toggle: the unsubscribe link in every digest lands here. */}
        <SettingsRow
          icon={Mail}
          label="Email me what I miss"
          description="When you're away, one email batches unseen mentions, comments, chat, and decisions your agents are waiting on. Never session idle/error noise, and never while you're at the keyboard."
          alignTop
        >
          <Switch
            checked={getPref("email_notifications")}
            onCheckedChange={() => handleToggleType("email_notifications")}
            aria-label="Email me what I miss"
          />
        </SettingsRow>
        {/* Presence source for phone-push routing */}
        {enabled && (
          <SettingsRow
            icon={Laptop}
            label="Wait until I'm away from my computer"
            description="Hold phone pushes while your computer sees any keyboard or mouse activity, not just activity in Codecast (machine-wide detection currently works on macOS only). Pushes arrive a few minutes after you step away, and always within an hour."
            alignTop
          >
            <Switch
              checked={machineWidePresence}
              onCheckedChange={handleToggleMachinePresence}
              aria-label="Wait until I'm away from my computer"
            />
          </SettingsRow>
        )}
      </SettingsSection>

      {enabled && (
        <>
          {NOTIF_SECTIONS.map((section) => (
            <SettingsSection key={section.title} title={section.title} icon={section.icon}>
              {section.items.map((item) => (
                <SettingsRow key={item.key} label={item.label} description={item.desc}>
                  <Switch
                    checked={getPref(item.key)}
                    onCheckedChange={() => handleToggleType(item.key)}
                    aria-label={item.label}
                  />
                </SettingsRow>
              ))}
            </SettingsSection>
          ))}

          {/* Per-member muting */}
          {otherMembers && otherMembers.length > 0 && (
            <SettingsSection
              title="Team Members"
              icon={Users}
              description="Mute notifications from specific team members."
            >
              {otherMembers.map((member) => {
                const isMuted = mutedMembers.includes(member._id);
                return (
                  <SettingsRow
                    key={member._id}
                    label={
                      <span className="flex items-center gap-3">
                        <AvatarImg
                          src={member.github_avatar_url}
                          alt=""
                          className="h-7 w-7 rounded-full"
                          fallback={
                            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-sol-bg-highlight">
                              <span className="text-xs font-medium text-sol-text">
                                {member.name?.[0]?.toUpperCase() || "?"}
                              </span>
                            </span>
                          }
                        />
                        <span className="min-w-0">
                          <span className="block truncate">{member.name || member.email}</span>
                          {member.title && <span className="block text-xs text-sol-text-muted">{member.title}</span>}
                        </span>
                      </span>
                    }
                  >
                    {isMuted && <span className="text-xs text-sol-orange">Muted</span>}
                    <Switch
                      checked={!isMuted}
                      onCheckedChange={() => handleToggleMute(member._id)}
                      aria-label={`Notifications from ${member.name || member.email}`}
                    />
                  </SettingsRow>
                );
              })}
            </SettingsSection>
          )}
        </>
      )}
    </SettingsPanel>
  );
}

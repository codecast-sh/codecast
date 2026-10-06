import { useState, useCallback, type ComponentType } from 'react';
import {
  StyleSheet,
  TouchableOpacity,
  Alert,
  View as RNView,
  Platform,
  Share,
  Image,
} from 'react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { api } from '@codecast/convex/convex/_generated/api';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useSettingsData } from '@codecast/web/hooks/useSyncSettings';
import { LANE_SWITCH, writeLane } from '@codecast/web/components/simple/lanePref';
import { useHostedMode } from '@codecast/web/lib/surfaces';
import { LANE_COPY } from '@codecast/web/components/simple/lane';
import { PlanPage } from '@/components/hosted/PlanPage';
import { MailPage } from '@/components/hosted/MailPage';
import { useTeamRosterIdentity } from '@codecast/web/hooks/useTeamRoster';
import { peopleOf } from '@codecast/shared/team/memberKind';
import { Text as RNText, TextInput } from '@/components/Themed';
import { Theme, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { copyToClipboard } from '@/lib/clipboard';
import { useAuth } from '@/lib/auth';
import { showActionSheet } from '@/lib/actionSheet';
import { DevicesSection } from '@/components/DevicesSection';
import { liveActivityNative } from '@/modules/codecast-live-activity';
import { SettingsScroll, SettingsGroup, ToggleRow, NavRow, SettingsSwitch, settingsStyles } from './SettingsUI';

export const THEME_OPTIONS = [
  { key: undefined, label: 'System', icon: 'mobile' as const },
  { key: 'light', label: 'Light', icon: 'sun-o' as const },
  { key: 'dark', label: 'Dark', icon: 'moon-o' as const },
] as const;

export const STATUS_OPTIONS = [
  { key: 'available', label: 'Available', icon: 'circle' as const, color: Theme.green },
  { key: 'busy', label: 'Busy', icon: 'minus-circle' as const, color: Theme.red },
  { key: 'away', label: 'Away', icon: 'clock-o' as const, color: Theme.accent },
] as const;

type NotificationType = 'team_session_start' | 'mention' | 'permission_request' | 'session_idle' | 'session_idle_digest' | 'session_error' | 'task_activity' | 'doc_activity' | 'plan_activity' | 'chat_activity' | 'live_activity';

const SESSION_NOTIFICATIONS: Array<{ type: NotificationType; label: string; description: string }> = [
  { type: 'team_session_start', label: 'Team Sessions', description: 'When a team member starts a session' },
  { type: 'mention', label: 'Mentions', description: 'When someone mentions you' },
  { type: 'permission_request', label: 'Permission Requests', description: 'When a session needs approval' },
  { type: 'session_idle', label: 'Session Idle', description: 'When a session is waiting for input' },
  { type: 'session_idle_digest', label: 'Hourly Digest', description: 'Fold waiting sessions into one alert an hour' },
  { type: 'session_error', label: 'Session Errors', description: 'When a session encounters an error' },
];

const WORK_NOTIFICATIONS: Array<{ type: NotificationType; label: string; description: string }> = [
  { type: 'task_activity', label: 'Task Activity', description: "Updates on tasks you're watching" },
  { type: 'doc_activity', label: 'Doc Activity', description: "Updates on docs you're watching" },
  { type: 'plan_activity', label: 'Plan Activity', description: "Updates on plans you're watching" },
];

// The store's user row, so every switch paints its own write in the same tick
// (currentUser is a localFirst singleton: a flip holds over pushes and rolls
// back if the server refuses).
export function useSettingsUser() {
  return useInboxStore((s) => s.currentUser) as any;
}

export function currentStatusOf(user: any) {
  return STATUS_OPTIONS.find((s) => s.key === user?.status) || STATUS_OPTIONS[0];
}

export function themeLabelOf(theme: string | undefined) {
  return (THEME_OPTIONS.find((t) => t.key === theme) ?? THEME_OPTIONS[0]);
}

// The workspace mirror (unset = personal). The team's row paints from the
// store's teams list; its invite code from the persisted settings cache.
export function useActiveTeamSettings() {
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id ?? undefined) as Id<"teams"> | undefined;
  const teamRow = useInboxStore((s) => (activeTeamId ? (s.teams as any[]).find((t) => t && String(t._id) === String(activeTeamId)) : undefined));
  const teamRecord = useSettingsData("team", activeTeamId ?? null).data as any;
  const activeTeam = teamRow || teamRecord ? { ...teamRow, ...teamRecord } : undefined;
  return { activeTeamId, activeTeam };
}

export function UserAvatar({ user, size = 50 }: { user: any; size?: number }) {
  useTheme();
  const initial = user?.name?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || '?';
  if (user?.github_avatar_url) {
    return <Image source={{ uri: user.github_avatar_url }} style={{ width: size, height: size, borderRadius: size / 2 }} />;
  }
  return (
    <RNView style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <RNText style={[styles.avatarText, { fontSize: size * 0.4 }]}>{initial}</RNText>
    </RNView>
  );
}

function ProfilePage() {
  const Theme = useTheme();
  const router = useRouter();
  const currentUser = useSettingsUser();
  const setMyStatus = useInboxStore((s) => s.setMyStatus);
  const updateMyProfile = useInboxStore((s) => s.updateMyProfile);
  const { signOut } = useAuth();
  const deleteAccountMutation = useMutation(api.users.deleteAccount);
  const [isDeleting, setIsDeleting] = useState(false);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const startEditing = useCallback((field: string, currentValue?: string | null) => {
    setEditingField(field);
    setEditValue(currentValue || '');
  }, []);

  const saveField = useCallback(() => {
    if (!editingField) return;
    // An emptied field is a real edit: send "" (updateProfile skips undefined).
    updateMyProfile({ [editingField]: editValue.trim() });
    setEditingField(null);
  }, [editingField, editValue, updateMyProfile]);

  const showStatusPicker = useCallback(() => {
    showActionSheet('Set Status', STATUS_OPTIONS.map((s) => ({
      label: s.label,
      selected: s.key === currentUser?.status,
      onPress: () => setMyStatus(s.key as any),
    })));
  }, [setMyStatus, currentUser?.status]);

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'This will permanently delete your account and all your data. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            Alert.prompt(
              'Confirm Deletion',
              'Type DELETE to confirm account deletion:',
              async (text) => {
                if (text?.toUpperCase() === 'DELETE') {
                  setIsDeleting(true);
                  try {
                    const result = await deleteAccountMutation({});
                    if (result.completed) {
                      await signOut();
                      router.replace('/auth/login');
                    } else {
                      Alert.alert('Partial Deletion', result.message, [
                        { text: 'OK', onPress: () => handleDeleteAccount() }
                      ]);
                    }
                  } catch (error) {
                    Alert.alert('Error', 'Failed to delete account. Please try again.');
                  } finally {
                    setIsDeleting(false);
                  }
                } else if (text) {
                  Alert.alert('Error', 'Please type DELETE to confirm');
                }
              },
              'plain-text'
            );
          },
        },
      ]
    );
  };

  const status = currentStatusOf(currentUser);
  const editProps = { editing: editingField, editValue, onEdit: startEditing, onChange: setEditValue, onSave: saveField };

  return (
    <SettingsScroll>
      <SettingsGroup>
        <RNView style={styles.userInfo}>
          <UserAvatar user={currentUser} />
          <RNView style={{ flex: 1, marginLeft: Spacing.md }}>
            <RNText style={styles.userName}>{currentUser?.name || 'User'}</RNText>
            <RNText style={styles.userEmail}>{currentUser?.email}</RNText>
          </RNView>
        </RNView>
        <EditableRow label="Name" value={currentUser?.name} field="name" {...editProps} />
        <EditableRow label="Title" value={currentUser?.title} field="title" placeholder="e.g. Software Engineer" {...editProps} />
        <EditableRow label="Bio" value={currentUser?.bio} field="bio" placeholder="Short bio" multiline {...editProps} />
        <NavRow
          label="Status"
          onPress={showStatusPicker}
          detail={
            <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <FontAwesome name={status.icon} size={12} color={status.color} />
              <RNText style={settingsStyles.detail}>{status.label}</RNText>
            </RNView>
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Danger Zone" footnote="Permanently delete your account and all data. This cannot be undone.">
        <NavRow
          icon="trash"
          tone="danger"
          label={isDeleting ? 'Deleting...' : 'Delete Account'}
          trailingIcon="exclamation-triangle"
          onPress={() => { if (!isDeleting) handleDeleteAccount(); }}
        />
      </SettingsGroup>
    </SettingsScroll>
  );
}

export function useNotificationToggles() {
  const currentUser = useSettingsUser();
  const updatePrefs = useInboxStore((s) => s.updateNotificationSettings);

  const toggleType = useCallback((type: NotificationType) => {
    const currentPrefs = currentUser?.notification_preferences || {
      team_session_start: true,
      mention: true,
      permission_request: true,
      session_idle: true,
      session_error: true,
      task_activity: true,
      doc_activity: true,
      plan_activity: true,
    };

    const currentVal = (currentPrefs as any)[type] ?? true;
    // The server ends an activity it started; one the app began on a phone
    // without push-to-start is only addressable from here.
    if (type === 'live_activity' && currentVal) liveActivityNative?.endAll().catch(() => {});
    updatePrefs({
      notification_preferences: {
        ...currentPrefs,
        session_idle: currentPrefs.session_idle ?? true,
        session_idle_digest: (currentPrefs as any).session_idle_digest ?? true,
        session_error: currentPrefs.session_error ?? true,
        task_activity: currentPrefs.task_activity ?? true,
        doc_activity: currentPrefs.doc_activity ?? true,
        plan_activity: currentPrefs.plan_activity ?? true,
        chat_activity: (currentPrefs as any).chat_activity ?? true,
        [type]: !currentVal,
      },
    });
  }, [currentUser, updatePrefs]);

  const isOn = (type: NotificationType) => (currentUser?.notification_preferences as any)?.[type] ?? true;
  return { currentUser, updatePrefs, toggleType, isOn };
}

function NotificationsPage() {
  const Theme = useTheme();
  const { currentUser, updatePrefs, toggleType, isOn } = useNotificationToggles();
  const { activeTeamId } = useActiveTeamSettings();
  // The roster, fed app-wide for the active team (useSyncWorkspaceData).
  // Identity projection: presence heartbeats on the roster re-render nothing.
  const roster = useTeamRosterIdentity();
  const teammates = activeTeamId
    ? peopleOf(roster as any[]).filter((m: any) => m._id !== currentUser?._id)
    : [];
  const enabled = currentUser?.notifications_enabled ?? false;
  const muted: Id<"users">[] = currentUser?.muted_members ?? [];

  const toggleMuteMember = (memberId: Id<"users">) => {
    updatePrefs({ muted_members: muted.includes(memberId) ? muted.filter((id) => id !== memberId) : [...muted, memberId] });
  };

  const toggleRow = (n: { type: NotificationType; label: string; description: string }) => (
    <ToggleRow key={n.type} label={n.label} description={n.description} value={isOn(n.type)} onValueChange={() => toggleType(n.type)} />
  );

  return (
    <SettingsScroll>
      <SettingsGroup>
        <ToggleRow
          label="Push Notifications"
          description="Receive notifications for team activity"
          value={enabled}
          onValueChange={() => updatePrefs({ notifications_enabled: !currentUser?.notifications_enabled })}
        />
      </SettingsGroup>

      {enabled && (
        <>
          <SettingsGroup title="Delivery">
            <ToggleRow
              label="Wait Until I'm Away From My Mac"
              description="Hold phone notifications while you're using your Mac at all, not just Codecast. They arrive a few minutes after you step away, or after an hour regardless. Needs an up-to-date Codecast daemon running on a Mac."
              value={currentUser?.machine_wide_presence ?? true}
              onValueChange={() => updatePrefs({ machine_wide_presence: !(currentUser?.machine_wide_presence ?? true) })}
            />
            {Platform.OS === 'ios' && toggleRow({ type: 'live_activity', label: 'Lock Screen', description: 'A Live Activity with every running agent, on the Lock Screen and in the Dynamic Island' })}
          </SettingsGroup>

          <SettingsGroup title="Sessions">{SESSION_NOTIFICATIONS.map(toggleRow)}</SettingsGroup>
          <SettingsGroup title="Tasks, docs and plans">{WORK_NOTIFICATIONS.map(toggleRow)}</SettingsGroup>

          {teammates.length > 0 && (
            <SettingsGroup title="Teammates" footnote="Turn someone off to stop notifications about their activity.">
              {teammates.map((member: any) => (
                <RNView key={member._id} style={settingsStyles.row}>
                  <UserAvatar user={member} size={32} />
                  <RNText style={[settingsStyles.label, { flex: 1, marginLeft: Spacing.sm, marginRight: Spacing.md }]} numberOfLines={1}>
                    {member.name || member.email}
                  </RNText>
                  <SettingsSwitch value={!muted.includes(member._id)} onValueChange={() => toggleMuteMember(member._id)} />
                </RNView>
              ))}
            </SettingsGroup>
          )}
        </>
      )}
    </SettingsScroll>
  );
}

export function useThemePicker() {
  const storeTheme = useInboxStore((s) => s.clientState?.ui?.theme);
  const updateClientUI = useInboxStore((s) => s.updateClientUI);
  const pick = useCallback(() => {
    showActionSheet('Appearance', THEME_OPTIONS.map((t) => ({
      label: t.label,
      selected: t.key === storeTheme,
      onPress: () => updateClientUI({ theme: t.key as any }),
    })));
  }, [storeTheme, updateClientUI]);
  return { theme: themeLabelOf(storeTheme), pick };
}

function AppearancePage() {
  const Theme = useTheme();
  const { theme, pick } = useThemePicker();
  const inboxImageThumbs = useInboxStore((s) => s.clientState?.ui?.inbox_image_thumbs === true);
  const hostedMode = useHostedMode();
  const updateClientUI = useInboxStore((s) => s.updateClientUI);
  return (
    <SettingsScroll>
      <SettingsGroup>
        <ToggleRow
          label={LANE_SWITCH.label}
          description={LANE_SWITCH.description}
          value={hostedMode}
          onValueChange={(on) => writeLane(on ? 'simple' : 'full')}
        />
        <NavRow
          label="Theme"
          description="Light, dark, or follow system"
          onPress={pick}
          detail={
            <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <FontAwesome name={theme.icon} size={14} color={Theme.textMuted} />
              <RNText style={settingsStyles.detail}>{theme.label}</RNText>
            </RNView>
          }
        />
        <ToggleRow
          label="Image Thumbnails"
          description="Show a small thumbnail on inbox rows when a session contains images"
          value={inboxImageThumbs}
          onValueChange={(v) => updateClientUI({ inbox_image_thumbs: v })}
        />
      </SettingsGroup>
    </SettingsScroll>
  );
}

function DevicesPage() {
  return (
    <SettingsScroll>
      <RNView style={{ marginTop: Spacing.xl }}>
        <DevicesSection showTitle={false} />
      </RNView>
    </SettingsScroll>
  );
}

function SecurityPage() {
  useTheme();
  const { isBiometricAvailable, isBiometricEnabled, enableBiometric, disableBiometric } = useAuth();
  const handleToggleBiometric = async () => {
    if (isBiometricEnabled) {
      await disableBiometric();
    } else {
      await enableBiometric();
      Alert.alert('Biometric Unlock Enabled', 'You can now use Face ID or Touch ID to unlock the app');
    }
  };
  return (
    <SettingsScroll>
      <SettingsGroup>
        {isBiometricAvailable ? (
          <ToggleRow label="Biometric Unlock" description="Use Face ID or Touch ID" value={isBiometricEnabled} onValueChange={handleToggleBiometric} />
        ) : (
          <RNView style={settingsStyles.row}>
            <RNText style={settingsStyles.muted}>Biometric authentication not available</RNText>
          </RNView>
        )}
      </SettingsGroup>
    </SettingsScroll>
  );
}

function TeamPage() {
  const Theme = useTheme();
  const currentUser = useSettingsUser();
  const { activeTeamId, activeTeam } = useActiveTeamSettings();
  const regenerateInvite = useMutation(api.teams.regenerateInviteCode);
  const inviteUrl = activeTeam?.invite_code ? `https://codecast.sh/join/${activeTeam.invite_code}` : null;

  const handleShareInvite = useCallback(async () => {
    if (!inviteUrl) return;
    await Share.share({ message: `Join my team on Codecast: ${inviteUrl}`, url: inviteUrl });
  }, [inviteUrl]);

  const handleCopyInvite = useCallback(async () => {
    if (!inviteUrl) return;
    await copyToClipboard(inviteUrl);
    Alert.alert('Copied', 'Invite link copied to clipboard');
  }, [inviteUrl]);

  const handleRegenerateInvite = useCallback(async () => {
    if (!activeTeamId || !currentUser?._id) return;
    Alert.alert('Regenerate Invite', 'This will invalidate the current invite link.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Regenerate',
        onPress: async () => {
          try {
            await regenerateInvite({ team_id: activeTeamId, requesting_user_id: currentUser._id as Id<"users"> });
            Alert.alert('Done', 'New invite code generated');
          } catch (_e) {
            Alert.alert('Error', 'Only admins can regenerate invite codes');
          }
        },
      },
    ]);
  }, [activeTeamId, currentUser, regenerateInvite]);

  if (!activeTeam) {
    return (
      <SettingsScroll>
        <SettingsGroup>
          <RNView style={settingsStyles.row}>
            <RNText style={settingsStyles.muted}>You're in your personal workspace. Switch to a team to invite people.</RNText>
          </RNView>
        </SettingsGroup>
      </SettingsScroll>
    );
  }

  return (
    <SettingsScroll>
      <SettingsGroup>
        <RNView style={settingsStyles.row}>
          <RNView style={settingsStyles.rowText}>
            <RNText style={settingsStyles.label}>{activeTeam.name}</RNText>
            <RNText style={settingsStyles.description}>
              {activeTeam.invite_code ? `Invite code: ${activeTeam.invite_code}` : 'No invite code'}
            </RNText>
          </RNView>
        </RNView>
      </SettingsGroup>
      <SettingsGroup title="Invite">
        <NavRow label="Share Invite Link" description="Invite someone to join your team" trailingIcon="share-square-o" onPress={handleShareInvite} />
        <NavRow label="Copy Invite Link" trailingIcon="clipboard" onPress={handleCopyInvite} />
        <NavRow label="Regenerate Invite Code" description="Invalidates the current code" trailingIcon="refresh" onPress={handleRegenerateInvite} />
      </SettingsGroup>
    </SettingsScroll>
  );
}

export function appVersionLabel() {
  const version = Constants.expoConfig?.version ?? '';
  const update = Updates.updateId ? Updates.updateId.slice(0, 8) : null;
  return { version, update };
}

function AboutPage() {
  useTheme();
  const { version, update } = appVersionLabel();
  return (
    <SettingsScroll>
      <SettingsGroup>
        <InfoRow label="Version" value={version || 'Unknown'} />
        <InfoRow label="Update" value={update ?? 'Built in'} />
        <InfoRow label="Channel" value={Updates.channel || (__DEV__ ? 'Development' : 'Default')} />
      </SettingsGroup>
    </SettingsScroll>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <RNView style={settingsStyles.row}>
      <RNText style={[settingsStyles.label, { flex: 1 }]}>{label}</RNText>
      <RNText style={settingsStyles.detail} selectable>{value}</RNText>
    </RNView>
  );
}

function EditableRow({ label, value, field, editing, editValue, onEdit, onChange, onSave, placeholder, multiline }: {
  label: string; value?: string | null; field: string; editing: string | null; editValue: string;
  onEdit: (field: string, value?: string | null) => void; onChange: (v: string) => void; onSave: () => void;
  placeholder?: string; multiline?: boolean;
}) {
  const Theme = useTheme();
  const isEditing = editing === field;
  return (
    <TouchableOpacity style={settingsStyles.row} onPress={() => !isEditing && onEdit(field, value)} activeOpacity={0.6} disabled={isEditing}>
      <RNText style={[settingsStyles.label, { width: 60 }]}>{label}</RNText>
      {isEditing ? (
        <RNView style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <TextInput
            style={[styles.editInput, multiline && { minHeight: 60, textAlignVertical: 'top' }]}
            value={editValue}
            onChangeText={onChange}
            placeholder={placeholder || label}
            placeholderTextColor={Theme.textMuted0}
            autoFocus
            multiline={multiline}
            returnKeyType={multiline ? 'default' : 'done'}
            onSubmitEditing={!multiline ? onSave : undefined}
            autoCorrect={false}
          />
          <TouchableOpacity onPress={onSave} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <FontAwesome name="check" size={16} color={Theme.green} />
          </TouchableOpacity>
        </RNView>
      ) : (
        <RNView style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
          <RNText style={{ fontSize: 15, color: value ? Theme.text : Theme.textMuted0, textAlign: 'right', flexShrink: 1 }} numberOfLines={1}>
            {value || placeholder || 'Not set'}
          </RNText>
          <FontAwesome name="pencil" size={12} color={Theme.textMuted0} />
        </RNView>
      )}
    </TouchableOpacity>
  );
}

/** Every settings sub-screen, keyed by the route segment that opens it
 *  (/settings/<key>). The top-level list and the route read this one table. */
export const SETTINGS_PAGES: Record<string, { title: string; Page: ComponentType }> = {
  profile: { title: 'Profile', Page: ProfilePage },
  notifications: { title: 'Notifications', Page: NotificationsPage },
  devices: { title: 'Devices', Page: DevicesPage },
  appearance: { title: 'Appearance', Page: AppearancePage },
  security: { title: 'Security', Page: SecurityPage },
  team: { title: 'Team', Page: TeamPage },
  about: { title: 'About', Page: AboutPage },
  plan: { title: 'Plan', Page: PlanPage },
  mail: { title: LANE_COPY.connections.mail, Page: MailPage },
};

const styles = themedStyles((Theme) => StyleSheet.create({
  userInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
  },
  avatar: {
    backgroundColor: Theme.bgHighlight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontWeight: '600',
    color: Theme.text,
  },
  userName: {
    fontSize: 17,
    fontWeight: '600',
    color: Theme.text,
    marginBottom: 2,
  },
  userEmail: {
    fontSize: 14,
    color: Theme.textMuted,
  },
  editInput: {
    flex: 1,
    fontSize: 15,
    color: Theme.text,
    backgroundColor: Theme.bgHighlight,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
}));

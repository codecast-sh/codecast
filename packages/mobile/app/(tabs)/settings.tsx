import { useState, useCallback } from 'react';
import { StyleSheet, TouchableOpacity, Switch, Alert, ScrollView, View as RNView, Text as RNText, TextInput, ActionSheetIOS, KeyboardAvoidingView, Platform, Share, Clipboard, Image } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/lib/auth';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, Spacing } from '@/constants/Theme';
import { useInboxStore } from '@codecast/web/store/inboxStore';

const THEME_OPTIONS = [
  { key: undefined, label: 'System', icon: 'mobile' as const },
  { key: 'light', label: 'Light', icon: 'sun-o' as const },
  { key: 'dark', label: 'Dark', icon: 'moon-o' as const },
] as const;

const STATUS_OPTIONS = [
  { key: 'available', label: 'Available', icon: 'circle' as const, color: Theme.green },
  { key: 'busy', label: 'Busy', icon: 'minus-circle' as const, color: Theme.red },
  { key: 'away', label: 'Away', icon: 'clock-o' as const, color: Theme.accent },
] as const;

export default function SettingsScreen() {
  const router = useRouter();
  const {
    signOut,
    isBiometricAvailable,
    isBiometricEnabled,
    enableBiometric,
    disableBiometric,
  } = useAuth();

  const currentUser = useQuery(api.users.getCurrentUser);
  const updateNotificationPreferences = useMutation(api.users.updateNotificationPreferences);
  const updateProfile = useMutation(api.users.updateProfile);
  const deleteAccountMutation = useMutation(api.users.deleteAccount);
  const [isDeleting, setIsDeleting] = useState(false);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const storeTheme = useInboxStore((s) => s.clientState?.ui?.theme);
  const updateClientUI = useInboxStore((s) => s.updateClientUI);

  const activeTeamId = (currentUser?.active_team_id || currentUser?.team_id) as Id<"teams"> | undefined;
  const activeTeam = useQuery(api.teams.getTeam, activeTeamId ? { team_id: activeTeamId } : "skip");
  const regenerateInvite = useMutation(api.teams.regenerateInviteCode);

  const handleShareInvite = useCallback(async () => {
    if (!activeTeam?.invite_code) return;
    const url = `https://codecast.sh/join/${activeTeam.invite_code}`;
    await Share.share({ message: `Join my team on Codecast: ${url}`, url });
  }, [activeTeam]);

  const handleCopyInvite = useCallback(() => {
    if (!activeTeam?.invite_code) return;
    const url = `https://codecast.sh/join/${activeTeam.invite_code}`;
    Clipboard.setString(url);
    Alert.alert('Copied', 'Invite link copied to clipboard');
  }, [activeTeam]);

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

  const startEditing = useCallback((field: string, currentValue?: string | null) => {
    setEditingField(field);
    setEditValue(currentValue || '');
  }, []);

  const saveField = useCallback(async () => {
    if (!editingField) return;
    try {
      await updateProfile({ [editingField]: editValue.trim() || undefined });
    } catch (_e) {
      Alert.alert('Error', 'Failed to update profile');
    }
    setEditingField(null);
  }, [editingField, editValue, updateProfile]);

  const showStatusPicker = useCallback(() => {
    const options = [...STATUS_OPTIONS.map(s => s.label), 'Cancel'];
    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: options.length - 1, title: 'Set Status' },
      async (idx) => {
        if (idx < STATUS_OPTIONS.length) {
          try {
            await updateProfile({ status: STATUS_OPTIONS[idx].key });
          } catch (_e) {
            Alert.alert('Error', 'Failed to update status');
          }
        }
      },
    );
  }, [updateProfile]);

  const showThemePicker = useCallback(() => {
    const options = [...THEME_OPTIONS.map(t => t.label), 'Cancel'];
    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: options.length - 1, title: 'Appearance' },
      (idx) => {
        if (idx < THEME_OPTIONS.length) {
          updateClientUI({ theme: THEME_OPTIONS[idx].key as any });
        }
      },
    );
  }, [updateClientUI]);

  const handleToggleBiometric = async () => {
    if (isBiometricEnabled) {
      await disableBiometric();
    } else {
      await enableBiometric();
      Alert.alert(
        'Biometric Unlock Enabled',
        'You can now use Face ID or Touch ID to unlock the app'
      );
    }
  };

  const handleToggleNotifications = async () => {
    const newValue = !currentUser?.notifications_enabled;
    try {
      await updateNotificationPreferences({
        notifications_enabled: newValue,
      });
    } catch (error) {
      Alert.alert('Error', 'Failed to update notification settings');
    }
  };

  const teamMembers = useQuery(api.teams.getTeamMembers, activeTeamId ? { team_id: activeTeamId } : "skip");

  const handleToggleNotificationType = async (type: 'team_session_start' | 'mention' | 'permission_request' | 'session_idle' | 'session_error' | 'task_activity' | 'doc_activity' | 'plan_activity') => {
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

    try {
      const currentVal = (currentPrefs as any)[type] ?? true;
      await updateNotificationPreferences({
        notification_preferences: {
          ...currentPrefs,
          session_idle: currentPrefs.session_idle ?? true,
          session_error: currentPrefs.session_error ?? true,
          task_activity: currentPrefs.task_activity ?? true,
          doc_activity: currentPrefs.doc_activity ?? true,
          plan_activity: currentPrefs.plan_activity ?? true,
          [type]: !currentVal,
        },
      });
    } catch (error) {
      Alert.alert('Error', 'Failed to update notification preferences');
    }
  };

  const handleToggleMuteMember = async (memberId: Id<"users">) => {
    const currentMuted = currentUser?.muted_members ?? [];
    const isMuted = currentMuted.includes(memberId);
    const newMuted = isMuted
      ? currentMuted.filter((id: Id<"users">) => id !== memberId)
      : [...currentMuted, memberId];
    try {
      await updateNotificationPreferences({ muted_members: newMuted });
    } catch (error) {
      Alert.alert('Error', 'Failed to update mute settings');
    }
  };

  const handleSignOut = () => {
    Alert.alert(
      'Sign Out',
      'Are you sure you want to sign out?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: signOut,
        },
      ]
    );
  };

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

  const currentStatus = STATUS_OPTIONS.find(s => s.key === currentUser?.status) || STATUS_OPTIONS[0];

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      <RNView style={styles.section}>
        <RNText style={styles.sectionTitle}>Profile</RNText>
        <RNView style={styles.card}>
          <RNView style={styles.userInfo}>
            <RNView style={styles.avatar}>
              <RNText style={styles.avatarText}>
                {currentUser?.name?.[0]?.toUpperCase() || currentUser?.email?.[0]?.toUpperCase() || "?"}
              </RNText>
            </RNView>
            <RNView style={styles.userDetails}>
              <RNText style={styles.userName}>{currentUser?.name || "User"}</RNText>
              <RNText style={styles.userEmail}>{currentUser?.email}</RNText>
            </RNView>
          </RNView>

          <RNView style={styles.settingDivider} />
          <EditableRow label="Name" value={currentUser?.name} field="name" editing={editingField} editValue={editValue} onEdit={startEditing} onChange={setEditValue} onSave={saveField} />
          <RNView style={styles.settingDivider} />
          <EditableRow label="Title" value={currentUser?.title} field="title" editing={editingField} editValue={editValue} onEdit={startEditing} onChange={setEditValue} onSave={saveField} placeholder="e.g. Software Engineer" />
          <RNView style={styles.settingDivider} />
          <EditableRow label="Bio" value={currentUser?.bio} field="bio" editing={editingField} editValue={editValue} onEdit={startEditing} onChange={setEditValue} onSave={saveField} placeholder="Short bio" multiline />
          <RNView style={styles.settingDivider} />
          <TouchableOpacity style={styles.setting} onPress={showStatusPicker} activeOpacity={0.6}>
            <RNView style={styles.settingText}>
              <RNText style={styles.settingLabel}>Status</RNText>
            </RNView>
            <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <FontAwesome name={currentStatus.icon} size={12} color={currentStatus.color} />
              <RNText style={{ fontSize: 15, color: Theme.textMuted }}>{currentStatus.label}</RNText>
              <FontAwesome name="chevron-right" size={10} color={Theme.textMuted0} />
            </RNView>
          </TouchableOpacity>
        </RNView>
      </RNView>

      <RNView style={styles.section}>
        <RNText style={styles.sectionTitle}>Appearance</RNText>
        <RNView style={styles.card}>
          <TouchableOpacity style={styles.setting} onPress={showThemePicker} activeOpacity={0.6}>
            <RNView style={styles.settingText}>
              <RNText style={styles.settingLabel}>Theme</RNText>
              <RNText style={styles.settingDescription}>Light, dark, or follow system</RNText>
            </RNView>
            <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <FontAwesome name={storeTheme === 'dark' ? 'moon-o' : storeTheme === 'light' ? 'sun-o' : 'mobile'} size={14} color={Theme.textMuted} />
              <RNText style={{ fontSize: 15, color: Theme.textMuted }}>{storeTheme === 'dark' ? 'Dark' : storeTheme === 'light' ? 'Light' : 'System'}</RNText>
              <FontAwesome name="chevron-right" size={10} color={Theme.textMuted0} />
            </RNView>
          </TouchableOpacity>
        </RNView>
      </RNView>

      {activeTeam && (
        <RNView style={styles.section}>
          <RNText style={styles.sectionTitle}>Team</RNText>
          <RNView style={styles.card}>
            <RNView style={styles.setting}>
              <RNView style={styles.settingText}>
                <RNText style={styles.settingLabel}>{activeTeam.name}</RNText>
                <RNText style={styles.settingDescription}>
                  {activeTeam.invite_code ? `Invite code: ${activeTeam.invite_code}` : 'No invite code'}
                </RNText>
              </RNView>
            </RNView>
            <RNView style={styles.settingDivider} />
            <TouchableOpacity style={styles.setting} onPress={handleShareInvite} activeOpacity={0.6}>
              <RNView style={styles.settingText}>
                <RNText style={styles.settingLabel}>Share Invite Link</RNText>
                <RNText style={styles.settingDescription}>Invite someone to join your team</RNText>
              </RNView>
              <FontAwesome name="share-square-o" size={16} color={Theme.accent} />
            </TouchableOpacity>
            <RNView style={styles.settingDivider} />
            <TouchableOpacity style={styles.setting} onPress={handleCopyInvite} activeOpacity={0.6}>
              <RNView style={styles.settingText}>
                <RNText style={styles.settingLabel}>Copy Invite Link</RNText>
              </RNView>
              <FontAwesome name="clipboard" size={16} color={Theme.textMuted} />
            </TouchableOpacity>
            <RNView style={styles.settingDivider} />
            <TouchableOpacity style={styles.setting} onPress={handleRegenerateInvite} activeOpacity={0.6}>
              <RNView style={styles.settingText}>
                <RNText style={styles.settingLabel}>Regenerate Invite Code</RNText>
                <RNText style={styles.settingDescription}>Invalidates the current code</RNText>
              </RNView>
              <FontAwesome name="refresh" size={14} color={Theme.textMuted0} />
            </TouchableOpacity>
          </RNView>
        </RNView>
      )}

      <RNView style={styles.section}>
        <RNText style={styles.sectionTitle}>Notifications</RNText>
        <RNView style={styles.card}>
          <RNView style={styles.setting}>
            <RNView style={styles.settingText}>
              <RNText style={styles.settingLabel}>Push Notifications</RNText>
              <RNText style={styles.settingDescription}>
                Receive notifications for team activity
              </RNText>
            </RNView>
            <Switch
              value={currentUser?.notifications_enabled ?? false}
              onValueChange={handleToggleNotifications}
              trackColor={{ false: Theme.bgHighlight, true: Theme.accent }}
              thumbColor="#fff"
              ios_backgroundColor={Theme.bgHighlight}
            />
          </RNView>

          {currentUser?.notifications_enabled && (
            <>
              <RNView style={styles.settingDivider} />
              <RNView style={styles.setting}>
                <RNView style={styles.settingText}>
                  <RNText style={styles.settingLabel}>Team Sessions</RNText>
                  <RNText style={styles.settingDescription}>
                    When a team member starts a session
                  </RNText>
                </RNView>
                <Switch
                  value={currentUser?.notification_preferences?.team_session_start ?? true}
                  onValueChange={() => handleToggleNotificationType('team_session_start')}
                  trackColor={{ false: Theme.bgHighlight, true: Theme.accent }}
                  thumbColor="#fff"
                  ios_backgroundColor={Theme.bgHighlight}
                />
              </RNView>

              <RNView style={styles.settingDivider} />
              <RNView style={styles.setting}>
                <RNView style={styles.settingText}>
                  <RNText style={styles.settingLabel}>Mentions</RNText>
                  <RNText style={styles.settingDescription}>
                    When someone mentions you
                  </RNText>
                </RNView>
                <Switch
                  value={currentUser?.notification_preferences?.mention ?? true}
                  onValueChange={() => handleToggleNotificationType('mention')}
                  trackColor={{ false: Theme.bgHighlight, true: Theme.accent }}
                  thumbColor="#fff"
                  ios_backgroundColor={Theme.bgHighlight}
                />
              </RNView>

              <RNView style={styles.settingDivider} />
              <RNView style={styles.setting}>
                <RNView style={styles.settingText}>
                  <RNText style={styles.settingLabel}>Permission Requests</RNText>
                  <RNText style={styles.settingDescription}>
                    When a session needs approval
                  </RNText>
                </RNView>
                <Switch
                  value={currentUser?.notification_preferences?.permission_request ?? true}
                  onValueChange={() => handleToggleNotificationType('permission_request')}
                  trackColor={{ false: Theme.bgHighlight, true: Theme.accent }}
                  thumbColor="#fff"
                  ios_backgroundColor={Theme.bgHighlight}
                />
              </RNView>

              <RNView style={styles.settingDivider} />
              <RNView style={styles.setting}>
                <RNView style={styles.settingText}>
                  <RNText style={styles.settingLabel}>Session Idle</RNText>
                  <RNText style={styles.settingDescription}>
                    When a session is waiting for input
                  </RNText>
                </RNView>
                <Switch
                  value={currentUser?.notification_preferences?.session_idle ?? true}
                  onValueChange={() => handleToggleNotificationType('session_idle')}
                  trackColor={{ false: Theme.bgHighlight, true: Theme.accent }}
                  thumbColor="#fff"
                  ios_backgroundColor={Theme.bgHighlight}
                />
              </RNView>

              <RNView style={styles.settingDivider} />
              <RNView style={styles.setting}>
                <RNView style={styles.settingText}>
                  <RNText style={styles.settingLabel}>Session Errors</RNText>
                  <RNText style={styles.settingDescription}>
                    When a session encounters an error
                  </RNText>
                </RNView>
                <Switch
                  value={currentUser?.notification_preferences?.session_error ?? true}
                  onValueChange={() => handleToggleNotificationType('session_error')}
                  trackColor={{ false: Theme.bgHighlight, true: Theme.accent }}
                  thumbColor="#fff"
                  ios_backgroundColor={Theme.bgHighlight}
                />
              </RNView>

              <RNView style={styles.settingDivider} />
              <RNView style={styles.setting}>
                <RNView style={styles.settingText}>
                  <RNText style={styles.settingLabel}>Task Activity</RNText>
                  <RNText style={styles.settingDescription}>
                    Updates on tasks you're watching
                  </RNText>
                </RNView>
                <Switch
                  value={currentUser?.notification_preferences?.task_activity ?? true}
                  onValueChange={() => handleToggleNotificationType('task_activity')}
                  trackColor={{ false: Theme.bgHighlight, true: Theme.accent }}
                  thumbColor="#fff"
                  ios_backgroundColor={Theme.bgHighlight}
                />
              </RNView>

              <RNView style={styles.settingDivider} />
              <RNView style={styles.setting}>
                <RNView style={styles.settingText}>
                  <RNText style={styles.settingLabel}>Doc Activity</RNText>
                  <RNText style={styles.settingDescription}>
                    Updates on docs you're watching
                  </RNText>
                </RNView>
                <Switch
                  value={currentUser?.notification_preferences?.doc_activity ?? true}
                  onValueChange={() => handleToggleNotificationType('doc_activity')}
                  trackColor={{ false: Theme.bgHighlight, true: Theme.accent }}
                  thumbColor="#fff"
                  ios_backgroundColor={Theme.bgHighlight}
                />
              </RNView>

              <RNView style={styles.settingDivider} />
              <RNView style={styles.setting}>
                <RNView style={styles.settingText}>
                  <RNText style={styles.settingLabel}>Plan Activity</RNText>
                  <RNText style={styles.settingDescription}>
                    Updates on plans you're watching
                  </RNText>
                </RNView>
                <Switch
                  value={currentUser?.notification_preferences?.plan_activity ?? true}
                  onValueChange={() => handleToggleNotificationType('plan_activity')}
                  trackColor={{ false: Theme.bgHighlight, true: Theme.accent }}
                  thumbColor="#fff"
                  ios_backgroundColor={Theme.bgHighlight}
                />
              </RNView>

              {teamMembers && teamMembers.length > 0 && (
                <>
                  <RNView style={{ paddingHorizontal: Spacing.lg, paddingTop: 16, paddingBottom: 4 }}>
                    <RNText style={{ fontSize: 12, fontWeight: '600', color: Theme.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      Team Members
                    </RNText>
                  </RNView>
                  {teamMembers
                    .filter((m: any) => m != null && m._id !== currentUser?._id)
                    .map((member: any, idx: number) => (
                      <RNView key={member._id}>
                        {idx > 0 && <RNView style={styles.settingDivider} />}
                        <RNView style={styles.setting}>
                          <RNView style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: Spacing.md }}>
                            {member.github_avatar_url ? (
                              <Image source={{ uri: member.github_avatar_url }} style={{ width: 32, height: 32, borderRadius: 16, marginRight: Spacing.sm }} />
                            ) : (
                              <RNView style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: Theme.bgHighlight, alignItems: 'center', justifyContent: 'center', marginRight: Spacing.sm }}>
                                <RNText style={{ fontSize: 14, fontWeight: '600', color: Theme.text }}>
                                  {member.name?.[0]?.toUpperCase() || '?'}
                                </RNText>
                              </RNView>
                            )}
                            <RNText style={styles.settingLabel} numberOfLines={1}>{member.name || member.email}</RNText>
                          </RNView>
                          <Switch
                            value={!(currentUser?.muted_members ?? []).includes(member._id)}
                            onValueChange={() => handleToggleMuteMember(member._id)}
                            trackColor={{ false: Theme.bgHighlight, true: Theme.accent }}
                            thumbColor="#fff"
                            ios_backgroundColor={Theme.bgHighlight}
                          />
                        </RNView>
                      </RNView>
                    ))}
                </>
              )}
            </>
          )}
        </RNView>
      </RNView>

      <RNView style={styles.section}>
        <RNText style={styles.sectionTitle}>Security</RNText>
        <RNView style={styles.card}>
          {isBiometricAvailable ? (
            <RNView style={styles.setting}>
              <RNView style={styles.settingText}>
                <RNText style={styles.settingLabel}>Biometric Unlock</RNText>
                <RNText style={styles.settingDescription}>
                  Use Face ID or Touch ID
                </RNText>
              </RNView>
              <Switch
                value={isBiometricEnabled}
                onValueChange={handleToggleBiometric}
                trackColor={{ false: Theme.bgHighlight, true: Theme.accent }}
                thumbColor="#fff"
                ios_backgroundColor={Theme.bgHighlight}
              />
            </RNView>
          ) : (
            <RNView style={styles.setting}>
              <RNText style={styles.settingDisabled}>
                Biometric authentication not available
              </RNText>
            </RNView>
          )}
        </RNView>
      </RNView>

      <RNView style={styles.section}>
        <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut} activeOpacity={0.7}>
          <RNText style={styles.signOutButtonText}>Sign Out</RNText>
        </TouchableOpacity>
      </RNView>

      <RNView style={styles.section}>
        <RNText style={styles.dangerSectionTitle}>Danger Zone</RNText>
        <TouchableOpacity
          style={styles.deleteButton}
          onPress={handleDeleteAccount}
          activeOpacity={0.7}
          disabled={isDeleting}
        >
          <RNText style={styles.deleteButtonText}>
            {isDeleting ? 'Deleting...' : 'Delete Account'}
          </RNText>
        </TouchableOpacity>
        <RNText style={styles.deleteWarning}>
          Permanently delete your account and all data. This cannot be undone.
        </RNText>
      </RNView>

      <RNView style={styles.footer}>
        <RNText style={styles.footerText}>Codecast v1.0.0</RNText>
      </RNView>
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

function EditableRow({ label, value, field, editing, editValue, onEdit, onChange, onSave, placeholder, multiline }: {
  label: string; value?: string | null; field: string; editing: string | null; editValue: string;
  onEdit: (field: string, value?: string | null) => void; onChange: (v: string) => void; onSave: () => void;
  placeholder?: string; multiline?: boolean;
}) {
  const isEditing = editing === field;
  return (
    <TouchableOpacity style={styles.setting} onPress={() => !isEditing && onEdit(field, value)} activeOpacity={0.6} disabled={isEditing}>
      <RNText style={[styles.settingLabel, { width: 60 }]}>{label}</RNText>
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
          <RNText style={{ fontSize: 15, color: value ? Theme.text : Theme.textMuted0, textAlign: 'right' }} numberOfLines={1}>
            {value || placeholder || 'Not set'}
          </RNText>
          <FontAwesome name="pencil" size={12} color={Theme.textMuted0} />
        </RNView>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Theme.bg,
  },
  section: {
    marginTop: Spacing.xl,
    paddingHorizontal: Spacing.lg,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: Theme.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: Spacing.sm,
    marginLeft: Spacing.xs,
  },
  card: {
    backgroundColor: Theme.bgAlt,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    overflow: 'hidden',
  },
  userInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: Theme.bgHighlight,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: Spacing.md,
  },
  avatarText: {
    fontSize: 20,
    fontWeight: '600',
    color: Theme.text,
  },
  userDetails: {
    flex: 1,
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
  setting: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: 14,
  },
  settingDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Theme.borderLight,
    marginLeft: Spacing.lg,
  },
  settingText: {
    flex: 1,
    marginRight: Spacing.md,
  },
  settingLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: Theme.text,
    marginBottom: 2,
  },
  settingDescription: {
    fontSize: 13,
    color: Theme.textMuted,
  },
  settingDisabled: {
    fontSize: 14,
    color: Theme.textMuted0,
    fontStyle: 'italic',
  },
  signOutButton: {
    backgroundColor: Theme.bgAlt,
    padding: Spacing.lg,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Theme.red,
  },
  signOutButtonText: {
    color: Theme.red,
    fontSize: 16,
    fontWeight: '600',
  },
  dangerSectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#ef4444',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: Spacing.sm,
    marginLeft: Spacing.xs,
  },
  deleteButton: {
    backgroundColor: '#ef444420',
    padding: Spacing.lg,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  deleteButtonText: {
    color: '#ef4444',
    fontSize: 16,
    fontWeight: '600',
  },
  deleteWarning: {
    fontSize: 12,
    color: Theme.textMuted,
    textAlign: 'center',
    marginTop: Spacing.sm,
    paddingHorizontal: Spacing.md,
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
  footer: {
    alignItems: 'center',
    paddingVertical: Spacing.xxxl,
  },
  footerText: {
    fontSize: 13,
    color: Theme.textMuted0,
  },
});

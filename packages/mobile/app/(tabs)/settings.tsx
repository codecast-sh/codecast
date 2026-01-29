import { useState } from 'react';
import { StyleSheet, TouchableOpacity, Switch, Alert, ScrollView, View as RNView, Text as RNText, TextInput } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/lib/auth';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { Theme, Spacing } from '@/constants/Theme';

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
  const deleteAccountMutation = useMutation(api.users.deleteAccount);
  const [isDeleting, setIsDeleting] = useState(false);

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

  const handleToggleNotificationType = async (type: 'team_session_start' | 'mention' | 'permission_request') => {
    const currentPrefs = currentUser?.notification_preferences || {
      team_session_start: true,
      mention: true,
      permission_request: true,
    };

    try {
      await updateNotificationPreferences({
        notification_preferences: {
          ...currentPrefs,
          [type]: !currentPrefs[type],
        },
      });
    } catch (error) {
      Alert.alert('Error', 'Failed to update notification preferences');
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

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
      <RNView style={styles.section}>
        <RNText style={styles.sectionTitle}>Account</RNText>
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
        </RNView>
      </RNView>

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
  footer: {
    alignItems: 'center',
    paddingVertical: Spacing.xxxl,
  },
  footerText: {
    fontSize: 13,
    color: Theme.textMuted0,
  },
});

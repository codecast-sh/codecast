import { StyleSheet, TouchableOpacity, Switch, Alert, ScrollView } from 'react-native';
import { Text, View } from '@/components/Themed';
import { useAuth } from '@/lib/auth';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';

export default function SettingsScreen() {
  const {
    signOut,
    isBiometricAvailable,
    isBiometricEnabled,
    enableBiometric,
    disableBiometric,
  } = useAuth();

  const currentUser = useQuery(api.users.getCurrentUser);
  const updateNotificationPreferences = useMutation(api.users.updateNotificationPreferences);

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

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notifications</Text>

        <View style={styles.setting}>
          <View style={styles.settingText}>
            <Text style={styles.settingLabel}>Enable Notifications</Text>
            <Text style={styles.settingDescription}>
              Receive push notifications for team activity
            </Text>
          </View>
          <Switch
            value={currentUser?.notifications_enabled ?? false}
            onValueChange={handleToggleNotifications}
            trackColor={{ false: '#ccc', true: '#d97706' }}
            thumbColor="#fff"
          />
        </View>

        {currentUser?.notifications_enabled && (
          <>
            <View style={styles.setting}>
              <View style={styles.settingText}>
                <Text style={styles.settingLabel}>Team Session Starts</Text>
                <Text style={styles.settingDescription}>
                  Notify when a team member starts a new session
                </Text>
              </View>
              <Switch
                value={currentUser?.notification_preferences?.team_session_start ?? true}
                onValueChange={() => handleToggleNotificationType('team_session_start')}
                trackColor={{ false: '#ccc', true: '#d97706' }}
                thumbColor="#fff"
              />
            </View>

            <View style={styles.setting}>
              <View style={styles.settingText}>
                <Text style={styles.settingLabel}>Mentions</Text>
                <Text style={styles.settingDescription}>
                  Notify when someone mentions you in a comment
                </Text>
              </View>
              <Switch
                value={currentUser?.notification_preferences?.mention ?? true}
                onValueChange={() => handleToggleNotificationType('mention')}
                trackColor={{ false: '#ccc', true: '#d97706' }}
                thumbColor="#fff"
              />
            </View>

            <View style={styles.setting}>
              <View style={styles.settingText}>
                <Text style={styles.settingLabel}>Permission Requests</Text>
                <Text style={styles.settingDescription}>
                  Notify when a session requests permission
                </Text>
              </View>
              <Switch
                value={currentUser?.notification_preferences?.permission_request ?? true}
                onValueChange={() => handleToggleNotificationType('permission_request')}
                trackColor={{ false: '#ccc', true: '#d97706' }}
                thumbColor="#fff"
              />
            </View>
          </>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Security</Text>

        {isBiometricAvailable && (
          <View style={styles.setting}>
            <View style={styles.settingText}>
              <Text style={styles.settingLabel}>Biometric Unlock</Text>
              <Text style={styles.settingDescription}>
                Use Face ID or Touch ID to unlock the app
              </Text>
            </View>
            <Switch
              value={isBiometricEnabled}
              onValueChange={handleToggleBiometric}
              trackColor={{ false: '#ccc', true: '#d97706' }}
              thumbColor="#fff"
            />
          </View>
        )}

        {!isBiometricAvailable && (
          <View style={styles.setting}>
            <Text style={styles.settingDisabled}>
              Biometric authentication not available on this device
            </Text>
          </View>
        )}
      </View>

      <View style={styles.section}>
        <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
          <Text style={styles.signOutButtonText}>Sign Out</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8f8f8',
  },
  header: {
    padding: 20,
    paddingTop: 60,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1a1a1a',
  },
  section: {
    marginTop: 20,
    backgroundColor: '#fff',
    paddingVertical: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  setting: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  settingText: {
    flex: 1,
    marginRight: 12,
  },
  settingLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: '#1a1a1a',
    marginBottom: 2,
  },
  settingDescription: {
    fontSize: 13,
    color: '#888',
  },
  settingDisabled: {
    fontSize: 14,
    color: '#aaa',
    fontStyle: 'italic',
  },
  signOutButton: {
    backgroundColor: '#fff',
    padding: 16,
    marginHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e74c3c',
  },
  signOutButtonText: {
    color: '#e74c3c',
    fontSize: 16,
    fontWeight: '600',
  },
});

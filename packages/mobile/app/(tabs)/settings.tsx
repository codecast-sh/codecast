import { StyleSheet, TouchableOpacity, View as RNView, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { useAuth } from '@/lib/auth';
import { useDevices } from '@/components/DevicesSection';
import { SettingsScroll, SettingsGroup, NavRow } from '@/components/settings/SettingsUI';
import {
  UserAvatar,
  appVersionLabel,
  currentStatusOf,
  useActiveTeamSettings,
  useSettingsUser,
  themeLabelOf,
} from '@/components/settings/SettingsPages';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useHostedMode, useSurface } from '@codecast/web/lib/surfaces';
import { LANE_COPY, meterWords } from '@codecast/web/components/simple/lane';
import { usePlanMeter } from '@codecast/web/components/simple/usePlanFigures';
import { useLaneMailAbilities } from '@codecast/web/components/simple/useLaneMail';

// The settings home is a short list of rows; each opens its own screen
// (app/settings/[section].tsx), so every switch is one tap deeper and the
// first screen stays readable.
export default function SettingsScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const { signOut, isBiometricAvailable, isBiometricEnabled } = useAuth();
  const currentUser = useSettingsUser();
  const { activeTeam } = useActiveTeamSettings();
  const { devices } = useDevices();
  const storeTheme = useInboxStore((s) => s.clientState?.ui?.theme);
  const status = currentStatusOf(currentUser);
  const online = devices.filter((d) => d.online).length;
  // Hosted mode keeps the Machines rows (the agent accounts a machine runs
  // on, the devices) only for an account that runs one.
  const machines = useSurface('settings.machines');
  const meter = usePlanMeter();
  const mail = useLaneMailAbilities();
  // The route is cast for the same reason the inbox's pushes are: expo's
  // typed-route union only regenerates when Metro runs.
  const open = (section: string) => router.push(`/settings/${section}` as never);

  // Hosted mode speaks in sentence case, as the family's other labels do.
  const signOutLabel = useHostedMode() ? 'Sign out' : 'Sign Out';
  const handleSignOut = () => {
    Alert.alert(signOutLabel, 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: signOutLabel, style: 'destructive', onPress: signOut },
    ]);
  };

  return (
    <SettingsScroll>
      <SettingsGroup>
        <TouchableOpacity style={styles.profile} onPress={() => open('profile')} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel="Profile">
          <UserAvatar user={currentUser} size={48} />
          <RNView style={styles.profileText}>
            <RNText style={styles.name} numberOfLines={1}>{currentUser?.name || 'User'}</RNText>
            <RNView style={styles.statusLine}>
              <FontAwesome name={status.icon} size={10} color={status.color} />
              <RNText style={styles.email} numberOfLines={1}>{status.label} · {currentUser?.email}</RNText>
            </RNView>
          </RNView>
          <FontAwesome name="chevron-right" size={10} color={Theme.textMuted0} />
        </TouchableOpacity>
      </SettingsGroup>

      {/* The hosted assistant: its plan and month, and mail and calendar through Whisk. */}
      <SettingsGroup title="Assistant">
        <NavRow
          icon="tachometer"
          label="Plan"
          description={meter.known ? meterWords(meter.figures) : undefined}
          detail={meter.known ? meter.plan.label : undefined}
          onPress={() => open('plan')}
        />
        <NavRow
          icon="envelope-o"
          label={LANE_COPY.connections.mail}
          detail={mail.known ? (mail.connected ? LANE_COPY.connections.on : mail.available === false ? LANE_COPY.connections.coming : LANE_COPY.connections.off) : undefined}
          onPress={() => open('mail')}
        />
      </SettingsGroup>

      <SettingsGroup>
        {machines ? <NavRow icon="key" label="Accounts" onPress={() => router.push('/accounts' as never)} /> : null}
        <NavRow
          icon="bell-o"
          label="Notifications"
          detail={currentUser?.notifications_enabled ? 'On' : 'Off'}
          onPress={() => open('notifications')}
        />
        {machines ? (
          <NavRow
            icon="laptop"
            label="Devices"
            detail={devices.length ? `${online} online` : undefined}
            onPress={() => open('devices')}
          />
        ) : null}
        <NavRow icon="adjust" label="Appearance" detail={themeLabelOf(storeTheme).label} onPress={() => open('appearance')} />
        <NavRow
          icon="lock"
          label="Security"
          detail={isBiometricAvailable ? (isBiometricEnabled ? 'On' : 'Off') : undefined}
          onPress={() => open('security')}
        />
        {activeTeam ? <NavRow icon="users" label="Team" detail={activeTeam.name} onPress={() => open('team')} /> : null}
        <NavRow icon="info-circle" label="About" detail={appVersionLabel().version} onPress={() => open('about')} />
      </SettingsGroup>

      <TouchableOpacity style={styles.signOut} onPress={handleSignOut} activeOpacity={0.7}>
        <RNText style={styles.signOutText}>{signOutLabel}</RNText>
      </TouchableOpacity>
    </SettingsScroll>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  profile: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
  },
  profileText: {
    flex: 1,
    marginHorizontal: Spacing.md,
  },
  name: {
    fontSize: 17,
    fontWeight: '600',
    color: Theme.text,
  },
  statusLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 3,
  },
  email: {
    fontSize: 13,
    color: Theme.textMuted,
    flexShrink: 1,
  },
  signOut: {
    marginTop: Spacing.xl,
    backgroundColor: Theme.bgAlt,
    padding: Spacing.lg,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  signOutText: {
    color: Theme.red,
    fontSize: 16,
    fontWeight: '600',
  },
}));

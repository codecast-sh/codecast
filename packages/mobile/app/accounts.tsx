// Accounts on the phone: per machine, the Claude accounts it can run on and
// its Codex sign-in. One row per account with how much is left; a tap offers
// what that account can do (switch to it, sign in again). Signing in finishes
// here on the phone (SignInSteps, CodexSignIn); the machine opens nothing.
import { useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { Stack } from 'expo-router';
import * as Haptics from 'expo-haptics';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { formatCountdown, isWindowRolled, labeledUsageWindows, worstUsagePercent } from '@codecast/shared/contracts';
import { profileHasSetupToken } from '@codecast/convex/convex/ccAccountsShared';
import { machineSwitchBlock, profileIsFleetAccount } from '@codecast/web/lib/machineAccountSwitch';
import { useMachineSwitchState } from '@codecast/web/hooks/useMachineSwitchState';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { SettingsGroup, SettingsScroll } from '@/components/settings/SettingsUI';
import { showActionSheet } from '@/lib/actionSheet';
import { SignInSteps } from '@/components/accounts/SignInSteps';
import { CodexSignIn } from '@/components/accounts/CodexSignIn';
import { loginFlowPhase, useAccountDevices, useClaudeSignIn, type AccountDevice } from '@/components/accounts/claudeSignIn';

export default function AccountsScreen() {
  const Theme = useTheme();
  const { devices, loaded } = useAccountDevices();
  return (
    <>
      <Stack.Screen options={{ title: 'Accounts' }} />
      <SettingsScroll>
        {!loaded && <ActivityIndicator style={{ marginTop: Spacing.xl }} color={Theme.textMuted} />}
        {loaded && devices.length === 0 && (
          <RNText style={styles.empty}>No machine is reporting accounts. Start codecast on your computer (`cast start`) and they appear here.</RNText>
        )}
        {devices.map((d) => <MachineAccounts key={d.device_id} device={d} single={devices.length === 1} />)}
      </SettingsScroll>
    </>
  );
}

type Profile = AccountDevice['profiles'][number];

function MachineAccounts({ device, single }: { device: AccountDevice; single: boolean }) {
  const Theme = useTheme();
  const now = useCoarseNow(10_000);
  const signIn = useClaudeSignIn();
  const fleet = { activeEmail: device.active_email, launchProfile: device.launch_profile };
  const sw = useMachineSwitchState({ deviceId: device.device_id, ...fleet });
  const [codexOpen, setCodexOpen] = useState(false);
  const machine = device.label || 'This computer';
  const usable = device.online && !device.is_remote;

  const profiles: Profile[] = [...device.profiles].sort((a, b) =>
    Number(profileIsFleetAccount(b, fleet)) - Number(profileIsFleetAccount(a, fleet)));
  // The machine's login with no saved profile yet still gets a row.
  const loginRow = device.active_email && !profiles.some((p) => p.email === device.active_email)
    ? [{ name: device.active_email.split('@')[0], email: device.active_email } as Profile]
    : [];
  const rows = [...loginRow, ...profiles];

  const startSignIn = async (profile?: string) => {
    try {
      await signIn.start(device.device_id, profile, loginFlowPhase(device.login_flow, Date.now(), profile) !== 'idle');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (err) {
      Alert.alert('Could not start the sign-in', err instanceof Error ? err.message : undefined);
    }
  };

  const onRow = (p: Profile) => {
    const current = profileIsFleetAccount(p, fleet);
    const saved = device.profiles.some((x) => x.name === p.name);
    const blocked = machineSwitchBlock({
      isActive: current,
      online: device.online,
      isRemote: device.is_remote,
      loginExpired: !!p.login_expired_at,
      tokenLive: profileHasSetupToken(p, now),
      thisProfile: p.name,
    });
    const items = [];
    if (!blocked && saved) {
      items.push({ label: `Switch ${machine} to ${p.name}`, onPress: () => void sw.request(p.name, p.email) });
    }
    if (usable) {
      // The current login signs in on the machine's own keychain; any other
      // saved account into its own store, leaving the current login alone.
      items.push({ label: 'Sign in again', onPress: () => void startSignIn(current && !p.login_expired_at ? undefined : p.name) });
    }
    if (items.length === 0) {
      Alert.alert(p.name, blocked?.label ?? `${machine} is offline.`);
      return;
    }
    showActionSheet(p.email ?? p.name, items);
  };

  const codex = device.codex_accounts?.profiles?.[0];
  return (
    <>
      <SettingsGroup title={single ? undefined : `${machine}${device.online ? '' : ' · offline'}`}>
        {rows.map((p) => (
          <AccountRow
            key={p.name}
            label={p.email ?? p.name}
            usage={p.usage}
            now={now}
            current={profileIsFleetAccount(p, fleet)}
            switching={sw.switching === p.name}
            expired={!!p.login_expired_at && !profileHasSetupToken(p, now)}
            onPress={() => onRow(p)}
          />
        ))}
        {rows.length === 0 && usable && (
          <TouchableOpacity style={styles.row} onPress={() => void startSignIn()}>
            <RNText style={[styles.label, { color: Theme.accent }]}>Sign in to Claude</RNText>
          </TouchableOpacity>
        )}
        {codex && (
          <AccountRow label="Codex" sub={codex.email} usage={codex.usage} now={now} onPress={() => setCodexOpen((o) => !o)} />
        )}
      </SettingsGroup>
      {sw.outcome?.kind === 'error' && <RNText style={[styles.note, { color: Theme.red }]}>{sw.outcome.message}</RNText>}
      <RNView style={styles.flows}>
        {[undefined, ...device.profiles.map((p) => p.name)].map((profile) =>
          loginFlowPhase(device.login_flow, now, profile) !== 'idle' ? (
            <SignInSteps
              key={profile ?? '(login)'}
              device={device}
              profile={profile}
              who={device.login_flow?.email ?? profile ?? 'your Claude account'}
            />
          ) : null)}
        {codexOpen && <CodexSignIn device={device} />}
      </RNView>
    </>
  );
}

function AccountRow({ label, sub, usage, now, current, switching, expired, onPress }: {
  label: string; sub?: string; usage?: any; now: number; current?: boolean; switching?: boolean; expired?: boolean; onPress: () => void;
}) {
  const Theme = useTheme();
  const pct = usage ? worstUsagePercent(usage, now) : null;
  const tone = pct == null ? Theme.textMuted0 : pct >= 90 ? Theme.red : pct >= 70 ? Theme.yellow : Theme.green;
  // A pegged window says when it opens again instead of a bare 100%.
  const reset = usage ? labeledUsageWindows(usage).find((w) => !isWindowRolled(w, now) && w.percent >= 100)?.resets_at : undefined;
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel={label}>
      <RNView style={styles.rowText}>
        <RNView style={styles.labelLine}>
          <RNText style={styles.label} numberOfLines={1}>{label}</RNText>
          {current && <RNText style={[styles.pill, { color: Theme.green, borderColor: Theme.green + '55' }]}>in use</RNText>}
          {expired && <RNText style={[styles.pill, { color: Theme.red, borderColor: Theme.red + '55' }]}>signed out</RNText>}
          {switching && <ActivityIndicator size="small" color={Theme.accent} />}
        </RNView>
        {sub ? <RNText style={styles.sub} numberOfLines={1}>{sub}</RNText> : null}
        {pct != null && (
          <RNView style={styles.meter}>
            <RNView style={[styles.meterFill, { width: `${Math.min(100, pct)}%`, backgroundColor: tone }]} />
          </RNView>
        )}
      </RNView>
      <RNText style={[styles.pct, { color: tone }]}>
        {reset && reset > now ? `resets ${formatCountdown(reset - now)}` : pct != null ? `${Math.round(pct)}%` : ''}
      </RNText>
      <FontAwesome name="chevron-right" size={10} color={Theme.textMuted0} />
    </TouchableOpacity>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  empty: { fontSize: 14, color: Theme.textMuted, textAlign: 'center', marginTop: Spacing.xxl, paddingHorizontal: Spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingHorizontal: Spacing.md, paddingVertical: 12 },
  rowText: { flex: 1, gap: 5 },
  labelLine: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  label: { fontSize: 15, color: Theme.text, flexShrink: 1 },
  sub: { fontSize: 12, color: Theme.textMuted },
  pill: { fontSize: 10, fontWeight: '600', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, borderWidth: 1, overflow: 'hidden' },
  meter: { height: 3, borderRadius: 2, backgroundColor: Theme.bgHighlight, overflow: 'hidden' },
  meterFill: { height: 3, borderRadius: 2 },
  pct: { fontSize: 12, fontWeight: '600', minWidth: 36, textAlign: 'right' },
  note: { fontSize: 12, marginTop: -Spacing.sm, marginBottom: Spacing.md, paddingHorizontal: Spacing.md },
  flows: { gap: Spacing.md, marginBottom: Spacing.lg },
}));


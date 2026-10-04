// Above the composer of a session stopped by its account: signed out, or out
// of usage. One line says which, one button does the likely fix, and the
// details live on the Accounts screen. Signed out: sign the machine in again
// from here (SignInSteps). Out of usage: continue on the freshest other
// account, by the same rule as web's park card (lib/limitContinue).
import { StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { isBlockedConversation } from '@codecast/convex/convex/ccAccountsShared';
import { standingLabel } from '@codecast/shared/contracts';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { continueOnAccount, limitContinueTarget } from '@codecast/web/lib/limitContinue';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { SignInSteps } from './accounts/SignInSteps';
import { loginFlowPhase, useAccountDevices, useClaudeSignIn } from './accounts/claudeSignIn';

export function AccountRecoveryBanner({ conversationId }: { conversationId: string }) {
  const Theme = useTheme();
  const router = useRouter();
  const now = useCoarseNow(10_000);
  const session = useInboxStore((s) => s.sessions[conversationId]);
  const reviveAt = useInboxStore((s) => s.blockedReviveRequestedAt[conversationId]);
  const blocked = !!session && isBlockedConversation(session as any);
  const { devices } = useAccountDevices();
  const signIn = useClaudeSignIn();
  if (!blocked) return null;

  const device = devices.find((d) => d.device_id === session.owner_device_id) ?? devices.find((d) => !d.is_remote && d.online);
  const auth = session.pending_api_error_kind === 'auth';
  const restarting = !!reviveAt && now - reviveAt < 3 * 60_000;

  if (restarting) {
    return (
      <RNView style={styles.bar}>
        <FontAwesome name="refresh" size={13} color={Theme.green} />
        <RNText style={styles.text}>Restarting on the new account…</RNText>
      </RNView>
    );
  }

  if (auth) {
    const signingIn = device && loginFlowPhase(device.login_flow, now) !== 'idle';
    if (signingIn) return <RNView style={styles.wrap}><SignInSteps device={device} who={device.active_email ?? 'your Claude account'} /></RNView>;
    return (
      <Bar
        icon="sign-in"
        text={`Signed out of Claude${device?.label ? ` on ${device.label}` : ''}`}
        action={device?.online && !device.is_remote ? 'Sign in' : 'Accounts'}
        onAction={() => {
          if (!device?.online || device.is_remote) return router.push('/accounts');
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          void signIn.start(device.device_id);
        }}
      />
    );
  }

  const { best } = limitContinueTarget(device, now, true);
  const canContinue = !!best?.email && !!device?.online && !device.is_remote;
  return (
    <Bar
      icon="hourglass-half"
      text={canContinue ? `Out of usage · ${best!.name} has ${standingLabel(best!.usage, now) ?? 'room'}` : 'Out of usage on this account'}
      action={canContinue ? `Continue on ${best!.name}` : 'Accounts'}
      onAction={() => {
        if (!canContinue) return router.push('/accounts');
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        continueOnAccount(conversationId, best!);
      }}
      onMore={() => router.push('/accounts')}
    />
  );
}

function Bar({ icon, text, action, onAction, onMore }: {
  icon: React.ComponentProps<typeof FontAwesome>['name']; text: string; action: string; onAction: () => void; onMore?: () => void;
}) {
  const Theme = useTheme();
  return (
    <RNView style={styles.bar}>
      <FontAwesome name={icon} size={13} color={Theme.accent} />
      <TouchableOpacity style={{ flex: 1 }} onPress={onMore} disabled={!onMore}>
        <RNText style={styles.text} numberOfLines={2}>{text}</RNText>
      </TouchableOpacity>
      <TouchableOpacity style={styles.button} onPress={onAction} accessibilityRole="button">
        <RNText style={styles.buttonText} numberOfLines={1}>{action}</RNText>
      </TouchableOpacity>
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  wrap: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginHorizontal: Spacing.md,
    marginVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.accent + '55',
    backgroundColor: Theme.accent + '12',
  },
  text: { fontSize: 13, color: Theme.text },
  button: { paddingHorizontal: Spacing.md, paddingVertical: 7, borderRadius: 8, backgroundColor: Theme.accent, maxWidth: 170 },
  buttonText: { fontSize: 13, fontWeight: '700', color: Theme.bg },
}));

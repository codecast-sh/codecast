// Codex on a machine, signed in from the phone: the machine runs
// `codex login --device-auth` and answers a page and a one-time code; the
// phone copies the code and opens the page. Mounting this asks the machine
// where its Codex sign-in stands, so it mounts only when the person asks.
import { ActivityIndicator, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { CLOUD_AGENT_PROVIDERS } from '@codecast/shared/contracts';
import { useCloudAgentLogin } from '@codecast/web/lib/useProviderKeyCommand';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { copyToClipboard } from '@/lib/clipboard';
import type { AccountDevice } from './claudeSignIn';

export function CodexSignIn({ device }: { device: AccountDevice }) {
  const Theme = useTheme();
  const { view, waiting, timedOut, signIn, recheck, prompt } = useCloudAgentLogin(CLOUD_AGENT_PROVIDERS.codex.id, device as any);
  const machine = device.label || 'your computer';

  if (view.state === 'checking') {
    return <RNView style={styles.row}><ActivityIndicator size="small" color={Theme.textMuted} /><RNText style={styles.hint}>Checking Codex on {machine}</RNText></RNView>;
  }
  if (view.state === 'signed_in') {
    return (
      <RNView style={styles.row}>
        <FontAwesome name="check" size={13} color={Theme.green} />
        <RNText style={styles.hint}>Signed in{view.account ? ` as ${view.account}` : ''}{view.plan ? ` · ${view.plan}` : ''}</RNText>
      </RNView>
    );
  }
  if (prompt) {
    return (
      <RNView style={styles.card}>
        <RNText style={styles.hint}>Enter this code on the Codex page:</RNText>
        <RNText selectable style={styles.code}>{prompt.code}</RNText>
        <TouchableOpacity
          style={styles.primary}
          onPress={() => { void copyToClipboard(prompt.code); void WebBrowser.openBrowserAsync(prompt.url).then(() => recheck()); }}
          accessibilityRole="button"
        >
          <RNText style={styles.primaryText}>Copy code & open page</RNText>
          <FontAwesome name="external-link" size={13} color={Theme.bg} />
        </TouchableOpacity>
        {waiting && <RNView style={styles.row}><ActivityIndicator size="small" color={Theme.textMuted} /><RNText style={styles.hint}>Waiting for the sign-in</RNText></RNView>}
      </RNView>
    );
  }
  const problem = view.state === 'failed' ? view.error
    : view.state === 'expired' ? 'The Codex sign-in has expired.'
    : view.state === 'signed_out' ? 'Not signed in to Codex.'
    : 'detail' in view && view.detail ? view.detail : null;
  return (
    <RNView style={styles.card}>
      {problem ? <RNText style={styles.hint}>{problem}</RNText> : null}
      {timedOut && <RNText style={[styles.hint, { color: Theme.red }]}>The sign-in didn&apos;t finish. Try again.</RNText>}
      <TouchableOpacity style={styles.primary} disabled={waiting} onPress={() => void signIn({ deviceCode: true })} accessibilityRole="button">
        <RNText style={styles.primaryText}>{waiting ? 'Getting a code…' : 'Sign in to Codex'}</RNText>
      </TouchableOpacity>
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  card: { gap: Spacing.sm },
  hint: { fontSize: 12, color: Theme.textMuted, flexShrink: 1 },
  code: { fontSize: 26, fontWeight: '700', letterSpacing: 3, color: Theme.text, textAlign: 'center', paddingVertical: Spacing.sm },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: Theme.accent,
  },
  primaryText: { fontSize: 14, fontWeight: '700', color: Theme.bg },
}));

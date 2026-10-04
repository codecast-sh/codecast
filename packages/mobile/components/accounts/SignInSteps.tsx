// A machine's Claude sign-in, finished on the phone: open the sign-in page in
// an in-app browser, copy the code it ends on, come back, paste. Paste reads
// the clipboard and sends in one tap; typing it stays possible.
import { useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Haptics from 'expo-haptics';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { oauthApprovalCode } from '@codecast/shared/contracts';
import { Text as RNText, TextInput } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { readClipboard } from '@/lib/clipboard';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { loginFlowPhase, useClaudeSignIn, type AccountDevice } from './claudeSignIn';

export function SignInSteps({ device, profile, who }: { device: AccountDevice; profile?: string; who: string }) {
  const Theme = useTheme();
  const now = useCoarseNow(2_000);
  const signIn = useClaudeSignIn();
  const flow = device.login_flow;
  const phase = loginFlowPhase(flow, now, profile);
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const machine = device.label || 'your computer';

  const send = async (raw: string) => {
    if (!flow) return;
    let value: string;
    try {
      value = oauthApprovalCode(raw);
    } catch (err) {
      Alert.alert('That is not a sign-in code', err instanceof Error ? err.message : undefined);
      return;
    }
    setSending(true);
    try {
      await signIn.sendCode(device.device_id, flow.started_at, value);
      setCode('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      Alert.alert('Could not send the code', err instanceof Error ? err.message : undefined);
    } finally {
      setSending(false);
    }
  };

  const pasteAndSend = async () => {
    const text = await readClipboard();
    if (text) void send(text);
    else Alert.alert('Nothing to paste', 'Copy the code on the sign-in page, then tap Paste.');
  };

  if (phase === 'confirmed') {
    return (
      <RNView style={[styles.card, styles.cardDone]}>
        <FontAwesome name="check" size={14} color={Theme.green} />
        <RNText style={styles.title}>Signed in{flow?.email ? ` as ${flow.email}` : ''}</RNText>
      </RNView>
    );
  }
  if (phase === 'starting') {
    const slow = flow ? now - flow.started_at > 20_000 : false;
    return (
      <RNView style={styles.card}>
        <RNView style={styles.row}>
          <ActivityIndicator size="small" color={Theme.accent} />
          <RNText style={styles.title}>Starting the sign-in on {machine}</RNText>
        </RNView>
        {slow && <RNText style={styles.hint}>Still waiting. If this stays, update codecast on {machine} (`cast update`).</RNText>}
      </RNView>
    );
  }
  if (phase !== 'open' || !flow?.url) {
    return phase === 'rejected' ? (
      <RNText style={[styles.hint, { color: Theme.red }]}>Last sign-in didn&apos;t finish{flow?.reason ? `: ${flow.reason}` : ''}</RNText>
    ) : null;
  }

  return (
    <RNView style={styles.card}>
      <RNText style={styles.title}>Sign in as {who}</RNText>
      <TouchableOpacity
        style={styles.primary}
        onPress={() => void WebBrowser.openBrowserAsync(flow.url!)}
        accessibilityRole="button"
      >
        <RNText style={styles.primaryText}>1  Open sign-in page</RNText>
        <FontAwesome name="external-link" size={13} color={Theme.bg} />
      </TouchableOpacity>
      <RNText style={styles.hint}>Approve, then copy the code it shows.</RNText>
      <RNView style={styles.row}>
        <TextInput
          value={code}
          onChangeText={(t) => setCode(t.trim())}
          placeholder="2  Paste code"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          onSubmitEditing={() => code && void send(code)}
          returnKeyType="send"
        />
        <TouchableOpacity
          style={styles.secondary}
          disabled={sending}
          onPress={() => (code ? void send(code) : void pasteAndSend())}
          accessibilityRole="button"
        >
          {sending ? <ActivityIndicator size="small" color={Theme.accent} /> : <RNText style={styles.secondaryText}>{code ? 'Send' : 'Paste'}</RNText>}
        </TouchableOpacity>
      </RNView>
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  card: {
    gap: Spacing.sm,
    padding: Spacing.md,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.accent + '55',
    backgroundColor: Theme.accent + '12',
  },
  cardDone: { flexDirection: 'row', alignItems: 'center', borderColor: Theme.green + '55', backgroundColor: Theme.green + '12' },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  title: { fontSize: 14, fontWeight: '600', color: Theme.text, flexShrink: 1 },
  hint: { fontSize: 12, color: Theme.textMuted },
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
  input: {
    flex: 1,
    fontSize: 14,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    backgroundColor: Theme.inputBg,
    color: Theme.text,
  },
  secondary: {
    minWidth: 64,
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Theme.accent,
  },
  secondaryText: { fontSize: 14, fontWeight: '700', color: Theme.accent },
}));

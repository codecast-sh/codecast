// Why a hosted turn stopped short of an answer, on the phone (web
// components/conversation/HostedNotice): the engine's own sentence in one
// calm block with the one thing the person can do about it. The words and
// the move come from lib/hostedNotice (noticeWords, noticeMove), which the
// web reads too. Only the conversation's last notice offers a move; a stop
// that later turns moved past is history, one quiet line in the reply
// column without the invitation to try again.
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome } from '@expo/vector-icons';
import { Text, TextInput } from '@/components/Themed';
import { useTheme } from '@/constants/Theme';
import { NOTICE_TONE, noticeMove, noticeWords } from '@codecast/web/lib/hostedNotice';
import { sendToSession } from '@codecast/web/lib/sendToSession';
import { useUpgradesOpen } from '@codecast/web/components/simple/billing';
import { useThinkingAvailable } from '@codecast/web/components/simple/assistantPromise';
import { PENDING_HOSTED_GRACE_MS } from '@codecast/web/components/conversation/pendingSend';
import type { NoticeKind } from '@codecast/shared/contracts/assistant';
import { EMAIL_PROOF_DIGITS, useEmailProof } from '@codecast/web/components/simple/useEmailProof';
import { useHostedTheme, HOSTED_RADIUS_SM } from './hostedTheme';

export function HostedNoticeRow({ kind, content, conversationId, retryText, live, retries = 0 }: {
  kind: NoticeKind;
  content: string;
  conversationId: string;
  /** The person's last words, which Try again sends again. */
  retryText?: string;
  /** Whether this is the conversation's last row, so its move still applies. */
  live: boolean;
  /** How many times Try again already ran into this same stop. */
  retries?: number;
}) {
  const Theme = useTheme();
  const { c } = useHostedTheme();
  const router = useRouter();
  const upgradesOpen = useUpgradesOpen();
  const move = live ? noticeMove(kind, retryText, upgradesOpen) : null;
  // While no provider can serve, a retry is a known failure: the button
  // waits, and comes back by itself when the server's probe gets through.
  const down = useThinkingAvailable() === false && (kind === 'error' || kind === 'unavailable');
  // A sent move holds the button until the row it sends replaces this
  // notice; a send that never lands frees it after the pending grace.
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(false), PENDING_HOSTED_GRACE_MS);
    return () => clearTimeout(t);
  }, [sent]);
  const dot = Theme[NOTICE_TONE[kind]];
  const words = noticeWords(content, retries, !!move || !live);

  if (!live) {
    return (
      <View style={styles.pastRow} testID={`hosted-notice-past-${kind}`}>
        <View style={[styles.pastDot, { backgroundColor: dot }]} />
        <Text style={[styles.pastText, { color: c.faint }]}>{words}</Text>
      </View>
    );
  }

  const run = () => {
    if (!move || sent || down) return;
    if (move.send) {
      setSent(true);
      sendToSession(conversationId, move.send);
    } else {
      router.push('/settings/plan' as never);
    }
  };
  const label = down ? 'Back soon' : sent && move?.busy ? move.busy : move?.label;
  return (
    <View style={[styles.card, { borderColor: c.lineStrong, backgroundColor: 'transparent' }]} testID={`hosted-notice-${kind}`}>
      <View style={styles.wordsRow}>
        <View style={[styles.dot, { backgroundColor: dot }]} />
        <Text style={[styles.text, { color: c.ink2 }]}>{words}</Text>
      </View>
      {kind === 'verify' && <EmailProofForm conversationId={conversationId} />}
      {move && (
        <Pressable
          onPress={run}
          disabled={sent || down}
          accessibilityRole="button"
          accessibilityLabel={label}
          style={({ pressed }) => [
            styles.button,
            { borderColor: c.lineStrong, backgroundColor: pressed ? c.hover : c.sheet, opacity: sent || down ? 0.6 : 1 },
          ]}
        >
          <FontAwesome name={move.send && kind !== 'time' ? 'repeat' : 'arrow-right'} size={11} color={c.ink2} />
          <Text style={[styles.buttonText, { color: c.ink }]}>{label}</Text>
        </Pressable>
      )}
    </View>
  );
}

/** The `verify` stop's move: the mailed code proves the address and the
 *  stopped ask picks up by itself (web components/simple/useEmailProof). */
function EmailProofForm({ conversationId }: { conversationId: string }) {
  const { c } = useHostedTheme();
  const proof = useEmailProof(conversationId);
  if (proof.phase === 'done') {
    return <Text style={[styles.proofNote, { color: c.ink2 }]}>Thanks, your email is confirmed. Picking this up now.</Text>;
  }
  return (
    <View style={styles.proof} testID="hosted-email-proof">
      <View style={styles.proofRow}>
        <TextInput
          value={proof.code}
          onChangeText={proof.setCode}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          maxLength={EMAIL_PROOF_DIGITS}
          placeholder="6-digit code"
          placeholderTextColor={c.faint}
          onSubmitEditing={() => void proof.submit()}
          accessibilityLabel="Code from the email"
          style={[styles.codeInput, { borderColor: c.lineStrong, color: c.ink, backgroundColor: c.sheet }]}
        />
        <Pressable
          onPress={() => void proof.submit()}
          disabled={!proof.ready}
          accessibilityRole="button"
          style={({ pressed }) => [styles.button, styles.proofButton, { borderColor: c.lineStrong, backgroundColor: pressed ? c.hover : c.sheet, opacity: proof.ready ? 1 : 0.6 }]}
        >
          <Text style={[styles.buttonText, { color: c.ink }]}>{proof.phase === 'checking' ? 'Checking…' : 'Confirm'}</Text>
        </Pressable>
      </View>
      <Pressable onPress={() => void proof.resend()} disabled={proof.phase === 'sending'} accessibilityRole="button" hitSlop={8}>
        <Text style={[styles.proofLink, { color: c.faint }]}>
          {proof.phase === 'sending' ? 'Sending…' : proof.phase === 'sent' ? 'Sent. Check your email' : 'Send a new code'}
        </Text>
      </Pressable>
      {!!proof.error && <Text style={[styles.proofNote, { color: c.danger }]}>{proof.error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  pastRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingLeft: 18, paddingRight: 14, paddingVertical: 4 },
  pastDot: { marginTop: 8, width: 4, height: 4, borderRadius: 2, opacity: 0.7 },
  pastText: { flex: 1, fontSize: 13, lineHeight: 20 },
  // Outlined rather than filled, so a stop never reads as the person's own
  // words, which sit in a filled note.
  card: { marginVertical: 8, paddingVertical: 12, paddingHorizontal: 14, borderRadius: HOSTED_RADIUS_SM, borderWidth: 1, gap: 10 },
  wordsRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  dot: { marginTop: 7, width: 6, height: 6, borderRadius: 3 },
  text: { flex: 1, fontSize: 14, lineHeight: 21 },
  button: { alignSelf: 'flex-start', marginLeft: 16, flexDirection: 'row', alignItems: 'center', gap: 7, height: 34, paddingHorizontal: 13, borderRadius: HOSTED_RADIUS_SM, borderWidth: StyleSheet.hairlineWidth },
  buttonText: { fontSize: 14, fontWeight: '500' },
  proof: { marginLeft: 16, gap: 8 },
  proofRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  proofButton: { marginLeft: 0, alignSelf: 'auto' },
  codeInput: { width: 132, height: 34, paddingHorizontal: 10, borderRadius: HOSTED_RADIUS_SM, borderWidth: StyleSheet.hairlineWidth, fontSize: 15, letterSpacing: 2 },
  proofLink: { fontSize: 13 },
  proofNote: { marginLeft: 16, fontSize: 13, lineHeight: 19 },
});

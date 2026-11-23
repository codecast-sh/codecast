import { StyleSheet, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';
import { OwnerFace } from '@/components/owners/OwnerFace';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useOwners } from '@codecast/web/hooks/useOwners';
import { useStoreOwnersEnv } from '@codecast/web/hooks/useOwnersStoreEnv';
import { rowEnvRoster } from '@/lib/inboxRowEnv';
import { composerOwnerLine, setComposerTell, useComposerOwnership } from '@codecast/web/lib/composerOwnership';

/**
 * The line above a session's composer that says what sending does to its
 * role, the phone twin of the web ComposerOwnerStrip and read by the same
 * rule (lib/composerOwnership composerOwnerLine):
 *   - the role is Active: "Sending pauses @role.", Pause and send | Tell @role
 *   - you paused the role: "@role is paused.", Resume
 * Between people there is no line. The Active line shows once the box holds
 * text; the send reads the choice through composerSendRoute.
 */
export function ComposerOwnerStrip({ conversationId, active }: { conversationId: string; active: boolean }) {
  const Theme = useTheme();
  const currentUser = useInboxStore((s) => s.currentUser) as any;
  // The roster's identity fields only: every teammate presence beat hands the
  // store a new roster array, and this line is mounted while a session is open.
  const teamMembers = useInboxStore(rowEnvRoster) as any[];
  const owners = useOwners(conversationId, useStoreOwnersEnv(conversationId, { teamMembers, currentUser, notify: () => {} }));
  const tell = useComposerOwnership((s) => !!s.tell[conversationId]);
  const standing = useInboxStore((s: any) => {
    const row = s.sessions?.[s.resolveLiveSessionId?.(conversationId) ?? conversationId] ?? s.conversations?.[conversationId];
    return !!row?.standing_role_id;
  });
  const line = composerOwnerLine(owners, standing, tell);
  const tap = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

  if (line?.kind === 'paused') {
    const me = owners.currentUser?._id?.toString?.();
    return (
      <View style={styles.strip} testID="composer-owner-strip-paused">
        <OwnerFace role={line.role} size={16} paused />
        <Text style={styles.words} numberOfLines={2}>
          <Text style={styles.name}>{line.tag}</Text> is paused.
        </Text>
        <TouchableOpacity
          style={styles.button}
          activeOpacity={0.6}
          accessibilityRole="button"
          onPress={() => { tap(); owners.applyChange({ driver: { kind: 'role' } }, { driver: { kind: 'user', user_id: me } }); }}
        >
          <Text style={styles.buttonText}>Resume</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!active || !line) return null;
  const { tag, telling } = line;
  const choice = (on: boolean, label: string) => (
    <TouchableOpacity
      style={[styles.segment, on ? styles.segmentLast : styles.segmentFirst, telling === on && { backgroundColor: Theme.text, borderColor: Theme.text }]}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityState={{ selected: telling === on }}
      onPress={() => { tap(); setComposerTell(conversationId, on); }}
    >
      <Text style={[styles.segmentText, telling === on && { color: Theme.bg }]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
  return (
    <View style={[styles.strip, styles.wrap]} testID="composer-owner-strip-active">
      <OwnerFace role={line.role} size={16} />
      <Text style={[styles.words, styles.wordsWrap]}>
        {telling
          ? <>Goes to <Text style={styles.name}>{tag}</Text>, which stays active.</>
          : <>Sending pauses <Text style={styles.name}>{tag}</Text>.</>}
      </Text>
      <View style={styles.segments}>
        {choice(false, 'Pause and send')}
        {choice(true, `Tell ${tag}`)}
      </View>
    </View>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    backgroundColor: Theme.bgAlt,
  },
  words: { flex: 1, minWidth: 0, fontSize: 13, color: Theme.textMuted },
  // On a phone the sentence and the two segments do not fit one row without
  // cutting the role's handle, so the segments wrap to a row of their own.
  wrap: { flexWrap: 'wrap', rowGap: 4 },
  wordsWrap: { flexBasis: 170 },
  name: { fontWeight: '600', color: Theme.text },
  button: {
    minHeight: 44,
    paddingHorizontal: 10,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    justifyContent: 'center',
  },
  buttonText: { fontSize: 12, fontWeight: '600', color: Theme.text },
  // Nothing here clips: a clipping parent refuses touches outside its
  // bounds on the new architecture, so each segment is a full 44pt target and
  // rounds its own outer corners.
  segments: { flexDirection: 'row', marginLeft: 'auto' },
  segment: {
    minHeight: 44,
    paddingHorizontal: 9,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
  },
  segmentFirst: { borderTopLeftRadius: 7, borderBottomLeftRadius: 7, borderRightWidth: 0 },
  segmentLast: { borderTopRightRadius: 7, borderBottomRightRadius: 7 },
  segmentText: { fontSize: 12, fontWeight: '600', color: Theme.text },
}));

/**
 * The composer's Tell: the words go to the role's own session (store
 * tellSessionRole). `sent` gets the line to show once the server has queued
 * them, or once they are parked in the outbox offline (they go on reconnect);
 * `failed` gets why not, and the words stay in the box.
 */
export function tellRoleFromComposer(conversationId: string, text: string, sent: (notice: string) => void, failed: (message: string) => void): void {
  const st = useInboxStore.getState() as any;
  const to: string = (st.sessions?.[st.resolveLiveSessionId?.(conversationId) ?? conversationId] ?? st.conversations?.[conversationId])?.role?.name ?? 'the role';
  void st.tellSessionRole(conversationId, text, crypto.randomUUID()).then(
    () => sent(`Sent to ${to}`),
    (err: unknown) => {
      if ((err as { parked?: boolean } | null)?.parked) sent(`Queued for ${to}`);
      else failed(err instanceof Error ? err.message : `Could not send to ${to}`);
    },
  );
}

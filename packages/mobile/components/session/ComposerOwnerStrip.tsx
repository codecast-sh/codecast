import { StyleSheet, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';
import { OwnerFace } from '@/components/owners/OwnerFace';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useOwners } from '@codecast/web/hooks/useOwners';
import { useStoreOwnersEnv } from '@codecast/web/hooks/useOwnersStoreEnv';
import { teamMembersOf } from '@codecast/web/lib/activeTeam';
import { composerOwnerLine, setComposerTell, useComposerOwnership } from '@codecast/web/lib/composerOwnership';

/**
 * The line above a session's composer that says what sending does to who
 * drives it, the phone twin of the web ComposerOwnerStrip and read by the same
 * rule (lib/composerOwnership composerOwnerLine):
 *   - a role drives: "Sending takes over from <role>", Take over | Tell <role>
 *   - another person drives: the same, naming them
 *   - you drive and the role waits: "<role> paused while you drive", Make driver
 * The take-over line shows once the box holds text; the send reads the choice
 * through composerSendRoute.
 */
export function ComposerOwnerStrip({ conversationId, active }: { conversationId: string; active: boolean }) {
  const Theme = useTheme();
  const currentUser = useInboxStore((s) => s.currentUser) as any;
  const teamMembers = useInboxStore(teamMembersOf) as any[];
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
          <Text style={styles.name}>{line.role.name}</Text> paused while you drive
        </Text>
        <TouchableOpacity
          style={styles.button}
          activeOpacity={0.6}
          hitSlop={{ top: 8, bottom: 8 }}
          accessibilityRole="button"
          onPress={() => { tap(); owners.applyChange({ driver: { kind: 'role' } }, { driver: { kind: 'user', user_id: me } }); }}
        >
          <Text style={styles.buttonText}>Make driver</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!active || !line) return null;
  const { driverName, telling } = line;
  const choice = (on: boolean, label: string) => (
    <TouchableOpacity
      style={[styles.segment, telling === on && { backgroundColor: Theme.text }]}
      activeOpacity={0.6}
      hitSlop={{ top: 8, bottom: 8 }}
      accessibilityRole="button"
      accessibilityState={{ selected: telling === on }}
      onPress={() => { tap(); setComposerTell(conversationId, on); }}
    >
      <Text style={[styles.segmentText, telling === on && { color: Theme.bg }]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
  return (
    <View style={styles.strip} testID={`composer-owner-strip-${line.kind}`}>
      {line.kind === 'role' ? <OwnerFace role={line.role} size={16} driver /> : <OwnerFace person={line.person} size={16} driver />}
      <Text style={styles.words} numberOfLines={3}>
        {telling
          ? <>Goes to <Text style={styles.name}>{driverName}</Text>, who stays driver</>
          : <>Sending takes over from <Text style={styles.name}>{driverName}</Text></>}
      </Text>
      <View style={styles.segments}>
        {choice(false, 'Take over')}
        {choice(true, `Tell ${driverName}`)}
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
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    backgroundColor: Theme.bgAlt,
  },
  words: { flex: 1, minWidth: 0, fontSize: 13, color: Theme.textMuted },
  name: { fontWeight: '600', color: Theme.text },
  button: {
    height: 30,
    paddingHorizontal: 10,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    justifyContent: 'center',
  },
  buttonText: { fontSize: 12, fontWeight: '600', color: Theme.text },
  segments: {
    flexDirection: 'row',
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    overflow: 'hidden',
  },
  segment: { height: 30, paddingHorizontal: 9, justifyContent: 'center' },
  segmentText: { fontSize: 12, fontWeight: '600', color: Theme.text },
}));

// The line above a session's composer under the session_owners model, the
// phone twin of the web ComposerOwnerStrip: an agent owner (its role, else the
// session it works for) answers the session: while the box is focused or
// holds text, "<agent> answers here too" with Take it over, which removes every
// agent owner and makes you an owner. Sending never takes anything over. It
// draws nothing for a session off the model, nor reads past one store selector
// there.
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/Themed';
import { themedStyles } from '@/constants/Theme';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useSessionOwners } from '@codecast/web/hooks/useSessionOwners';
import { mayHandToIn, ownersModelOnFor } from '@codecast/web/store/sessionOwnersSlice';
import { takeOverChange } from '@codecast/web/lib/ownersDraft';
import { applyOwnersWithUndo } from '@/lib/ownersGestures';
import { OwnerFace, ParentSessionFace } from '@/components/owners/OwnerFace';

const tap = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

type Props = { conversationId: string };

export function ComposerOwnerStrip({ conversationId, active }: Props & { active: boolean }) {
  const on = useInboxStore((s) => ownersModelOnFor(s as never, conversationId));
  return on && active ? <OwnerStrip conversationId={conversationId} /> : null;
}

function OwnerStrip({ conversationId }: Props) {
  const view = useSessionOwners(conversationId);
  const agent = view.agent;
  if (!agent || !view.meId) return null;
  const name = agent.kind === 'role' ? agent.role.name : agent.title;
  const takeOver = () => {
    tap();
    const parent = view.draft.parent;
    const { change, inverse } = takeOverChange(view.draft, view.meId!, { mayRestore: !parent || mayHandToIn(useInboxStore.getState() as never, parent) });
    applyOwnersWithUndo(conversationId, change, inverse, `${name} removed`);
  };
  return (
    <View style={styles.strip} testID="composer-owner-strip">
      {agent.kind === 'role' ? <OwnerFace role={agent.role} size={16} /> : <ParentSessionFace sessionId={agent.id} size={16} />}
      {/* The name gives way first, so "answers here too" never breaks. */}
      <View style={styles.wordsRow}>
        <Text style={styles.name} numberOfLines={1}>{name}</Text>
        <Text style={styles.wordsTail} numberOfLines={1}> answers here too</Text>
      </View>
      {view.canEdit && (
        <TouchableOpacity style={styles.button} activeOpacity={0.6} onPress={takeOver} accessibilityRole="button" testID="composer-take-over">
          <Text style={styles.buttonText}>Take it over</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
    marginHorizontal: 10,
    paddingLeft: 10,
    paddingRight: 4,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    backgroundColor: Theme.bgAlt,
  },
  wordsRow: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' },
  name: { flexShrink: 1, fontSize: 13, fontWeight: '600', color: Theme.text },
  wordsTail: { flexShrink: 0, fontSize: 13, color: Theme.textMuted },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 44,
    paddingHorizontal: 10,
    justifyContent: 'center',
  },
  buttonText: { fontSize: 13, fontWeight: '600', color: Theme.text },
}));

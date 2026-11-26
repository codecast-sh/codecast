// The agents working for this session, on the phone, under the session_owners
// model (the web SessionAgentsBand): its sub-agents and the sessions it
// spawned, which it owns, so they stay out of every inbox (store
// `sessionAgents`, fed by web hooks/useSyncSessionOwners; each agent's owners
// from `sessionOwners`, web lib/sessionAgents). Collapsed it is one line,
// "N agents · M working"; open, each agent with its state and owners, and
// Add me, which puts it in your inbox ("In your inbox" takes it out).
// Nothing for a session off the model or with no agents.
import { useState } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { Text } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { ownersModelOnFor } from '@codecast/web/store/sessionOwnersSlice';
import { SESSION_STATUS } from '@codecast/web/lib/sessionStatus';
import { agentOwnersOf, agentStateOf, agentsSig, type SessionAgentRow } from '@codecast/web/lib/sessionAgents';
import { holdOwnerCard } from '@codecast/web/lib/visibleOwnerCards';
import { applyOwnersWithUndo } from '@/lib/ownersGestures';
import { isConvexId } from '@codecast/web/lib/entityLinks';
import { useWatchEffect } from '@codecast/web/hooks/useWatchEffect';
import { ParentSessionFace, PersonFace } from '@/components/owners/OwnerFace';

const BUSY = new Set(['working', 'starting']);
const tap = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

export function SessionAgentsList({ conversationId }: { conversationId: string }) {
  const Theme = useTheme();
  const sig = useInboxStore((s) => (ownersModelOnFor(s as never, conversationId) ? agentsSig(s, conversationId) : ''));
  const meId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const [open, setOpen] = useState(false);
  // Its agents' owners come from the owners home, read with the rows on
  // screen while the list is open (closed, it draws no owners).
  const agentIds = sig && open ? sig.split('|').map((a) => a.split(':')[0]).filter(isConvexId).join(',') : '';
  useWatchEffect(() => {
    const releases = agentIds ? agentIds.split(',').map(holdOwnerCard) : [];
    return () => { for (const release of releases) release(); };
  }, [agentIds]);
  if (!sig) return null;
  const st = useInboxStore.getState() as any;
  const agents: SessionAgentRow[] = st.sessionAgents?.[conversationId]?.agents ?? [];
  const busy = agents.filter((a) => BUSY.has(agentStateOf(a.agent_status))).length;
  const change = (agentId: string, title: string, add: boolean) => {
    if (!meId) return;
    tap();
    applyOwnersWithUndo(agentId, add ? { add: [meId] } : { remove: [meId] }, add ? { remove: [meId] } : { add: [meId] }, add ? `${title} is in your inbox` : `${title} left your inbox`);
  };
  return (
    <View style={styles.band} testID="session-agents">
      <TouchableOpacity
        style={styles.head}
        activeOpacity={0.6}
        onPress={() => { tap(); setOpen((o) => !o); }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}, ${busy} working`}
      >
        <FontAwesome name={open ? 'chevron-down' : 'chevron-right'} size={10} color={Theme.textMuted} />
        <Text style={styles.headText}>{agents.length} {agents.length === 1 ? 'agent' : 'agents'}</Text>
        <Text style={styles.headDim}>· {busy} working</Text>
      </TouchableOpacity>
      {/* Open, it scrolls inside the floating header past 180pt (web's band cap). */}
      {open && (
      <ScrollView style={styles.list} nestedScrollEnabled testID="session-agents-list">
      {agents.map((a) => {
        const state = SESSION_STATUS[agentStateOf(a.agent_status)];
        const owners = agentOwnersOf(st, conversationId, a);
        const mine = !!meId && owners.people.some((o) => o._id === meId);
        const title = a.title?.trim() || a.short_id;
        return (
          <View key={a._id} style={styles.row} testID={`session-agent-${a._id}`}>
            <TouchableOpacity style={styles.rowText} activeOpacity={0.6} onPress={() => router.push(`/session/${a._id}` as never)} accessibilityRole="link">
              <Text style={styles.title} numberOfLines={1}>{title}</Text>
              <Text style={[styles.state, { color: stateColor(Theme, state.word) }]} numberOfLines={1}>{state.word}</Text>
            </TouchableOpacity>
            <View style={styles.faces} accessible importantForAccessibility="no-hide-descendants" accessibilityLabel={`Owners: ${[...(owners.ownedByParent ? ['this session'] : []), ...owners.people.map((o) => (o._id === meId ? 'You' : o.name))].join(', ')}`}>
              {owners.ownedByParent && <ParentSessionFace sessionId={conversationId} size={16} />}
              {owners.people.map((o) => <PersonFace key={o._id} name={o.name} image={o.image ?? null} size={16} />)}
            </View>
            {meId && (
              <TouchableOpacity style={[styles.button, !mine && styles.outline]} activeOpacity={0.6} onPress={() => change(a._id, title, !mine)} accessibilityRole="button" testID={mine ? `agent-unwatch-${a._id}` : `agent-add-me-${a._id}`}>
                <FontAwesome name={mine ? 'check' : 'plus'} size={11} color={Theme.text} />
                <Text style={styles.buttonText}>{mine ? 'In your inbox' : 'Add me'}</Text>
              </TouchableOpacity>
            )}
          </View>
        );
      })}
      </ScrollView>
      )}
    </View>
  );
}

function stateColor(Theme: any, word: string): string {
  if (word === 'Working' || word === 'Starting') return Theme.green;
  if (word === 'Needs you') return Theme.yellow;
  if (word === 'Done') return Theme.cyan;
  return Theme.textMuted;
}

const styles = themedStyles((Theme) => StyleSheet.create({
  band: { marginTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.border },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 },
  headText: { fontSize: 13, fontWeight: '600', color: Theme.textMuted },
  headDim: { fontSize: 13, color: Theme.textMuted0 },
  list: { maxHeight: 180 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.border },
  rowText: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center' },
  title: { fontSize: 14, color: Theme.text },
  state: { fontSize: 12 },
  faces: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  button: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44, paddingHorizontal: 10, borderRadius: 8, justifyContent: 'center' },
  outline: { borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.border },
  buttonText: { fontSize: 12, fontWeight: '600', color: Theme.text },
}));

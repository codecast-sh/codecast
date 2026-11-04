// The Tasks tab's triggers on the phone (on the web, the triggers page): every
// armed one in the shared roster order
// (compareTriggerRoster: running, then scheduled by next run, then paused), each
// in a plain sentence with when it runs next and how its last run went, and
// pause, open and cancel. The rows come from the store's trigger roster
// (useTriggers), so a pause or a cancel shows before the server answers. An
// armed row is cancelled, never deleted (triggerEndVerb), as the inbox dock
// and the web triggers page do.
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Text } from '@/components/Themed';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useTriggers } from '@codecast/web/hooks/useSyncTriggers';
import { ARMED_STATUSES, compareTriggerRoster, taskDisplayTitle, triggerEndVerb, triggerEndWords, type TaskRow } from '@codecast/web/components/triggerTasks';
import { LANE_COPY, routineLastRun, routineSchedule } from '@codecast/web/components/simple/lane';
import { Empty, HostedButton } from './HostedUI';
import { useHostedTheme } from './hostedTheme';

const WORDS = LANE_COPY.routines;

function RoutineRow({ routine, now, first }: { routine: TaskRow; now: number; first: boolean }) {
  const { c, s } = useHostedTheme();
  const [confirming, setConfirming] = useState(false);
  const verb = triggerEndVerb(routine.status);
  const ending = verb ? triggerEndWords(verb, 'Trigger') : null;
  const end = () => verb === 'delete' ? store().deleteTrigger(routine._id) : store().triggerAction(routine._id, 'cancel');
  const store = useInboxStore.getState;
  const paused = routine.status === 'paused';
  const last = routineLastRun(routine, now);
  return (
    <View style={[{ paddingTop: 14, paddingBottom: 10, paddingHorizontal: 15 }, !first && s.rowRule]}>
      <Text style={{ fontSize: 14.5, lineHeight: 20, fontWeight: '600', color: paused ? c.soft : c.ink }}>{taskDisplayTitle(routine)}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
        <Feather name="clock" size={12} color={c.soft} />
        <Text style={{ flex: 1, fontSize: 12.5, color: c.soft }}>{routineSchedule(routine, now)}</Text>
      </View>
      {last ? <Text style={{ marginTop: 5, fontSize: 12.5, lineHeight: 18, color: last.trouble ? c.attention : c.soft }}>{last.text}</Text> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 2, marginTop: 8, marginLeft: -10 }}>
        {confirming && ending ? (
          <>
            {/* The question takes its own line, so its two answers stay together under it. */}
            <Text style={[s.muted, { flexBasis: '100%', paddingHorizontal: 10, paddingBottom: 2, fontSize: 13 }]}>{ending.ask}</Text>
            <HostedButton small tone="danger" label={ending.confirm} onPress={end} />
            <HostedButton small tone="no" label={WORDS.keep} onPress={() => setConfirming(false)} />
          </>
        ) : (
          <>
            <HostedButton small tone="no" label={paused ? WORDS.resume : WORDS.pause} onPress={() => store().triggerAction(routine._id, paused ? 'resume' : 'pause')} />
            {routine.originating_conversation_id ? (
              <HostedButton small tone="no" label={WORDS.open} onPress={() => router.push(`/session/${routine.originating_conversation_id}` as never)} />
            ) : null}
            {ending ? <HostedButton small tone="no" label={ending.label} onPress={() => setConfirming(true)} /> : null}
          </>
        )}
      </View>
    </View>
  );
}

export function RoutineList() {
  const { s } = useHostedTheme();
  const now = useCoarseNow(60_000);
  const { tasks, ready } = useTriggers();
  const routines = useMemo(() => (tasks as TaskRow[]).filter((t) => ARMED_STATUSES.has(t.status)).sort(compareTriggerRoster), [tasks]);
  if (routines.length === 0) {
    if (!ready) return <Empty>Loading triggers</Empty>;
    // The web's empty hint leads into a `cast` command the phone cannot run,
    // so the list says only that it is empty.
    return <Empty>No triggers yet</Empty>;
  }
  return (
    <View style={s.list}>
      {routines.map((r, n) => <RoutineRow key={r._id} routine={r} now={now} first={n === 0} />)}
    </View>
  );
}

// The Tasks tab's routines on the phone (on the web, the triggers page; in
// hosted mode they are named routines): every armed one in the shared roster order
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
import { useModeWords, useSurface } from '@codecast/web/lib/surfaces';
import { ARMED_STATUSES, compareTriggerRoster, taskDisplayTitle, triggerEndVerb, triggerEndWords, type TaskRow } from '@codecast/web/components/triggerTasks';
import { routineExamples } from '@codecast/web/components/triggers/hostedSchedule';
import { useLaneMailAbilities } from '@codecast/web/components/simple/useLaneMail';
import { LANE_COPY, routineLastRun, routineSchedule } from '@codecast/web/components/simple/lane';
import { StarterChip } from './AssistantStart';
import { Empty, HostedButton } from './HostedUI';
import { useHostedTheme } from './hostedTheme';

const WORDS = LANE_COPY.routines;

function RoutineRow({ routine, now, first }: { routine: TaskRow; now: number; first: boolean }) {
  const { c, s } = useHostedTheme();
  const words = useModeWords();
  const [confirming, setConfirming] = useState(false);
  const verb = triggerEndVerb(routine.status);
  const ending = verb ? triggerEndWords(verb, words.trigger) : null;
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

/** Hosted mode's empty list: the web's routine examples (hostedSchedule
 *  routineExamples), each opening a new conversation with the ask typed in,
 *  since on the phone the assistant sets a routine up from plain words. */
function RoutineExamples() {
  const { c } = useHostedTheme();
  const words = useModeWords();
  const { connected } = useLaneMailAbilities();
  const ask = (text?: string) => router.push({ pathname: '/(tabs)/inbox', params: text ? { ask: text } : {} } as never);
  return (
    <View style={{ paddingHorizontal: 20, paddingVertical: 28, alignItems: 'center', gap: 12 }}>
      <Text style={{ fontSize: 14, color: c.ink2 }}>{`${words.noTriggers}.`}</Text>
      <Text style={{ fontSize: 13, lineHeight: 19, color: c.soft, textAlign: 'center', maxWidth: 320 }}>{words.triggersEmptyHint}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 4 }}>
        {routineExamples(connected).map((example) => (
          <StarterChip key={example.label} label={example.label} onPress={() => ask(example.label)} />
        ))}
      </View>
      <HostedButton small tone="plain" label={WORDS.writeOwn} onPress={() => ask()} />
    </View>
  );
}

export function RoutineList() {
  const { s } = useHostedTheme();
  const words = useModeWords();
  // The developer hint leads into a `cast` command the phone cannot run, so
  // the developer list says only that it is empty.
  const cliHint = useSurface('hint.cli');
  const now = useCoarseNow(60_000);
  const { tasks, ready } = useTriggers();
  const routines = useMemo(() => (tasks as TaskRow[]).filter((t) => ARMED_STATUSES.has(t.status)).sort(compareTriggerRoster), [tasks]);
  if (routines.length === 0) {
    if (!ready) return <Empty>{`Loading ${words.triggersPlural}`}</Empty>;
    return cliHint ? <Empty>{words.noTriggers}</Empty> : <RoutineExamples />;
  }
  return (
    <View style={s.list}>
      {routines.map((r, n) => <RoutineRow key={r._id} routine={r} now={now} first={n === 0} />)}
    </View>
  );
}

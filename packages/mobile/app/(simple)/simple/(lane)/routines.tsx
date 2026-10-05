// Routines: the things the assistant does on a schedule, each in a plain
// sentence with when it runs next, and pause and delete (web
// app/simple/routines/page.tsx).
import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Text } from '@/components/Themed';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { taskDisplayTitle, type TaskRow } from '@codecast/web/components/triggerTasks';
import { LANE_COPY, conversationPath, routineLastRun, routineSchedule } from '@codecast/web/components/simple/lane';
import { useLaneConversations, useLaneIds, useLaneRoutines } from '@codecast/web/components/simple/useLane';
import { LaneTop, useTabBarClearance } from '@/components/simple/LaneChrome';
import { Empty, LaneButton, LanePage, Rise } from '@/components/simple/LaneUI';
import { useLaneTheme } from '@/components/simple/laneTheme';

const WORDS = LANE_COPY.routines;

function RoutineRow({ routine, now, first }: { routine: TaskRow; now: number; first: boolean }) {
  const { c, s } = useLaneTheme();
  const [confirming, setConfirming] = useState(false);
  const store = useInboxStore.getState;
  const paused = routine.status === 'paused';
  const last = routineLastRun(routine, now);
  return (
    <View style={[{ paddingTop: 16, paddingBottom: 12, paddingHorizontal: 17 }, !first && s.rowRule]}>
      <Text style={{ fontSize: 16, lineHeight: 22, fontWeight: '600', letterSpacing: -0.08, color: paused ? c.soft : c.ink }}>{taskDisplayTitle(routine)}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 5 }}>
        <Feather name="clock" size={13} color={c.soft} />
        <Text style={{ flex: 1, fontSize: 14, color: c.soft }}>{routineSchedule(routine, now)}</Text>
      </View>
      {last ? <Text style={{ marginTop: 6, fontSize: 13.5, lineHeight: 19, color: last.trouble ? c.sunInk : c.soft }}>{last.text}</Text> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 9, marginLeft: -8 }}>
        {confirming ? (
          <>
            <Text style={[s.muted, { paddingHorizontal: 8, fontSize: 14 }]}>{WORDS.deleteAsk}</Text>
            <LaneButton small tone="danger" label={WORDS.delete} onPress={() => store().deleteTrigger(routine._id)} />
            <LaneButton small tone="no" label={WORDS.keep} onPress={() => setConfirming(false)} />
          </>
        ) : (
          <>
            <LaneButton small tone="no" label={paused ? WORDS.resume : WORDS.pause} onPress={() => store().triggerAction(routine._id, paused ? 'resume' : 'pause')} />
            {routine.originating_conversation_id ? (
              <LaneButton small tone="no" label={WORDS.open} onPress={() => router.push(conversationPath(String(routine.originating_conversation_id)) as never)} />
            ) : null}
            <LaneButton small tone="no" label={WORDS.delete} onPress={() => setConfirming(true)} />
          </>
        )}
      </View>
    </View>
  );
}

export default function SimpleRoutines() {
  const { s } = useLaneTheme();
  const now = useCoarseNow(60_000);
  const laneIds = useLaneIds(useLaneConversations());
  const { routines, ready } = useLaneRoutines(laneIds);
  return (
    <LanePage bottomInset={useTabBarClearance()}>
      <LaneTop />
      <Rise><Text style={s.pageTitle} accessibilityRole="header">{WORDS.title}</Text></Rise>
      <Rise i={1}>
        <Text style={s.lede}>{WORDS.lede}</Text>
      </Rise>
      {routines.length === 0 ? (
        <Rise i={2}><Empty>{ready ? WORDS.empty : WORDS.loading}</Empty></Rise>
      ) : (
        <Rise i={2} style={s.list}>
          {routines.map((r, n) => <RoutineRow key={r._id} routine={r} now={now} first={n === 0} />)}
        </Rise>
      )}
    </LanePage>
  );
}

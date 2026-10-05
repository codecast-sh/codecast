// The assistant lane's home on the phone (web app/simple/page.tsx): one
// composer, then what needs you, what is happening and what is done.
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Text } from '@/components/Themed';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { taskDisplayTitle } from '@codecast/web/components/triggerTasks';
import { HOME_APPROVALS, LANE_COPY, LANE_PATHS, conversationPath, greeting, homeBands, homeIdeas, homeView, routineLastRun, routineSchedule, runsToday } from '@codecast/web/components/simple/lane';
import { useLaneData, useLaneRoutines } from '@codecast/web/components/simple/useLane';
import { useLaneGoogleAbilities } from '@codecast/web/components/simple/useLaneGoogle';
import { useStartConversation } from '@codecast/web/components/simple/startConversation';
import { ApprovalCard } from '@/components/simple/ApprovalCard';
import { Composer } from '@/components/simple/Composer';
import { ConversationRow } from '@/components/simple/ConversationRow';
import { LaneTop, useTabBarClearance } from '@/components/simple/LaneChrome';
import { LaneButton, LanePage, LaneRow, Rise, SectionHead } from '@/components/simple/LaneUI';
import { useLaneTheme } from '@/components/simple/laneTheme';

export default function SimpleHome() {
  const { c, s } = useLaneTheme();
  const now = useCoarseNow(60_000);
  const name = useInboxStore((st) => (st.currentUser as any)?.name ?? null);
  const { conversations, laneIds, approvals, approvalCounts, titles, ready } = useLaneData();
  const { routines } = useLaneRoutines(laneIds);
  const bands = useMemo(() => homeBands(conversations, approvalCounts, now), [conversations, approvalCounts, now]);
  const today = useMemo(() => routines.filter((r) => runsToday(r, now)), [routines, now]);
  const start = useStartConversation();
  const google = useLaneGoogleAbilities();
  const [seed, setSeed] = useState<{ text: string; at: number } | null>(null);
  const [allDone, setAllDone] = useState(false);
  const clearance = useTabBarClearance();

  const { waitingRows, nothingYet, loading, done, moreDone } = homeView(bands, approvalCounts, conversations.length, ready, allDone);
  const words = LANE_COPY.home;
  let i = 0;

  return (
    <LanePage bottomInset={clearance}>
      <LaneTop />
      <Rise i={i++}>
        <Text style={s.hello} accessibilityRole="header">{greeting(now, name)}</Text>
      </Rise>
      <Rise i={i++}>
        <Text style={s.lede}>{words.lede}</Text>
      </Rise>
      <Rise i={i++}>
        <Composer
          hero
          placeholder={words.placeholder}
          seed={seed}
          onSend={(text) => router.push(conversationPath(start(text)) as never)}
        />
        {nothingYet && google.known ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 13 }}>
            {homeIdeas(google.can).map((idea) => (
              <Pressable
                key={idea}
                accessibilityRole="button"
                onPress={() => setSeed({ text: idea, at: Date.now() })}
                style={({ pressed }) => ({
                  paddingVertical: 8,
                  paddingHorizontal: 14,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: pressed ? c.lineStrong : c.line,
                  backgroundColor: pressed ? c.hover : c.sheet,
                  transform: [{ scale: pressed ? 0.97 : 1 }],
                })}
              >
                <Text style={{ fontSize: 14.5, color: c.ink2 }}>{idea}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {loading ? (
          <Text accessibilityRole="text" style={[s.muted, { marginTop: 18, marginLeft: 3, fontSize: 14.5 }]}>{words.loading}</Text>
        ) : null}
      </Rise>

      {approvals.length > 0 || waitingRows.length > 0 ? (
        <Rise i={i++} style={s.section}>
          <SectionHead
            title={words.waiting}
            count={approvals.length + waitingRows.length}
            action={approvals.length > HOME_APPROVALS ? { label: words.seeAll, onPress: () => router.navigate(LANE_PATHS.approvals as never) } : undefined}
          />
          <View style={{ gap: 13 }}>
            {approvals.slice(0, HOME_APPROVALS).map((d, n) => (
              <ApprovalCard key={d._id} decision={d} from={titles.get(String(d.conversation_id))} index={n} />
            ))}
            {waitingRows.length > 0 ? (
              <View style={s.list}>
                {waitingRows.map((row, n) => <ConversationRow key={row._id} row={row} state="waiting" now={now} first={n === 0} />)}
              </View>
            ) : null}
          </View>
        </Rise>
      ) : null}

      {bands.working.length > 0 || today.length > 0 ? (
        <Rise i={i++} style={s.section}>
          <SectionHead title={words.happening} />
          <View style={s.list}>
            {bands.working.map((row, n) => <ConversationRow key={row._id} row={row} state="working" now={now} first={n === 0} />)}
            {today.map((r, n) => {
              const last = routineLastRun(r, now);
              return (
                <LaneRow key={r._id} first={bands.working.length === 0 && n === 0} label={taskDisplayTitle(r)} onPress={() => router.navigate(LANE_PATHS.routines as never)}>
                  <Feather name="clock" size={16} color={c.faint} style={{ width: 18, textAlign: 'center' }} />
                  <View style={s.rowMain}>
                    <Text style={s.rowTitle} numberOfLines={1}>{taskDisplayTitle(r)}</Text>
                    <Text style={s.rowSub} numberOfLines={1}>{routineSchedule(r, now)}</Text>
                    {last?.trouble ? <Text style={[s.rowSub, s.trouble]} numberOfLines={2}>{last.text}</Text> : null}
                  </View>
                </LaneRow>
              );
            })}
          </View>
        </Rise>
      ) : null}

      {bands.done.length > 0 ? (
        <Rise i={i++} style={s.section}>
          <SectionHead title={words.done} count={bands.done.length} />
          <View style={s.list}>
            {done.map((row, n) => <ConversationRow key={row._id} row={row} state="done" now={now} first={n === 0} />)}
          </View>
          {moreDone > 0 ? (
            <LaneButton small tone="no" label={words.showMore(moreDone)} onPress={() => setAllDone(true)} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
          ) : null}
        </Rise>
      ) : null}
    </LanePage>
  );
}

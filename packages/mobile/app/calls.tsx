// The phone's Calls page, the twin of web's /calls list: the huddles live now
// at the top, then every call with its transcript (huddles and recordings in
// one history, as the web lists them). A row opens the call's own screen
// (recording/[id] takes any call), and the header starts a recording or a
// huddle.
import { memo, useMemo } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { isRecRoomKey, callLength } from '@codecast/shared/contracts';
import { useCallList, useCallPlaces } from '@codecast/web/hooks/useSyncCalls';
import { isCallLive } from '@codecast/web/lib/calls/callStatus';
import { callTitle, type CallPlace } from '@codecast/web/lib/calls/roomLabels';
import { firstName } from '@codecast/web/components/calls/speakers';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { Text as RNText } from '@/components/Themed';
import { RelativeTime } from '@/components/RelativeTime';
import { LivePulse, LiveRoomCard, useCallsOn, useLiveRooms } from '@/components/calls/LiveRooms';
import { FontSize, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { recordingIsWorking, recordingStatusLine } from '@/lib/recordingStatus';

type Item =
  | { t: 'head'; key: string; label: string; live?: boolean }
  | { t: 'room'; key: string; row: ReturnType<typeof useLiveRooms>[number] }
  | { t: 'call'; key: string; call: any };

export default function CallsScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const callsOn = useCallsOn();
  const liveRooms = useLiveRooms(callsOn);
  // Asked whatever the team's feature says: recordings are personal and the
  // server answers with exactly the calls this viewer may read.
  const { calls, ready } = useCallList(100);
  const places = useCallPlaces(calls);

  const items = useMemo(() => {
    const out: Item[] = [];
    if (liveRooms.length > 0) {
      out.push({ t: 'head', key: 'h:live', label: 'Live now', live: true });
      for (const row of liveRooms) out.push({ t: 'room', key: `r:${row.roomKey}`, row });
    }
    if (calls.length > 0) {
      out.push({ t: 'head', key: 'h:history', label: 'History' });
      for (const call of calls) out.push({ t: 'call', key: `c:${call._id}`, call });
    }
    return out;
  }, [liveRooms, calls]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <RNView style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} activeOpacity={0.6} accessibilityLabel="Back">
          <FontAwesome name="angle-left" size={24} color={Theme.textMuted} />
        </TouchableOpacity>
        <RNText style={styles.headerTitle}>Calls</RNText>
        <RNView style={{ flex: 1 }} />
        {callsOn && (
          <TouchableOpacity
            style={[styles.iconBtn, { backgroundColor: Theme.violet + '1a' }]}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.push({ pathname: '/chat/new', params: { huddle: '1' } } as never);
            }}
            activeOpacity={0.7}
            accessibilityLabel="Start a huddle"
          >
            <Ionicons name="headset" size={17} color={Theme.violet} />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.iconBtn, { backgroundColor: Theme.red + '1a' }]}
          onPress={() => router.push('/record' as never)}
          activeOpacity={0.7}
          accessibilityLabel="Record a meeting"
        >
          <FontAwesome name="microphone" size={16} color={Theme.red} />
        </TouchableOpacity>
      </RNView>

      <FlatList
        data={items}
        keyExtractor={(item) => item.key}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => {
          if (item.t === 'head') {
            return (
              <RNView style={styles.sectionHead}>
                {item.live && <LivePulse color={Theme.green} size={7} />}
                <RNText style={[styles.sectionLabel, item.live && { color: Theme.green }]}>{item.label}</RNText>
              </RNView>
            );
          }
          if (item.t === 'room') return <RNView style={styles.roomCard}><LiveRoomCard row={item.row} /></RNView>;
          return (
            <CallRow
              call={item.call}
              place={places[String(item.call._id)]}
              onPress={() => router.push({ pathname: '/recording/[id]', params: { id: String(item.call._id) } } as never)}
            />
          );
        }}
        ListFooterComponent={!ready && calls.length === 0 && items.length > 0 ? (
          <ActivityIndicator style={{ marginTop: Spacing.lg }} color={Theme.textMuted0} />
        ) : null}
        ListEmptyComponent={
          !ready ? (
            <ActivityIndicator style={{ marginTop: Spacing.xxl }} color={Theme.textMuted0} />
          ) : (
            <RNView style={styles.empty}>
              <FontAwesome name="phone" size={24} color={Theme.textMuted0} />
              <RNText style={styles.emptyTitle}>No calls yet</RNText>
            </RNView>
          )
        }
      />
    </SafeAreaView>
  );
}

/** One call: its name, how long it ran and when, and who spoke (or, for a
 *  recording, where its transcript stands). */
const CallRow = memo(function CallRow({ call, place, onPress }: { call: any; place?: CallPlace | null; onPress: () => void }) {
  const Theme = useTheme();
  const live = isCallLive(call);
  const recording = isRecRoomKey(call.room_key);
  const people: any[] = call.participants || [];
  const silent = !recording && !live && !call.filmed && people.length === 0;
  // A string out of the selector, so the row re-renders only when its name changes.
  const title = useInboxStore((s) =>
    callTitle({ ...call, place }, s as any, { untitled: silent ? 'Typed huddle, nothing said' : undefined }),
  );
  const actions = call.action_items?.length ?? 0;
  const detail = recording
    ? recordingStatusLine(call)
    : people.length > 0 ? people.map((p) => firstName(p.name)).join(', ') : live ? 'no one spoke yet' : null;
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.6} accessibilityRole="button">
      <RNView style={styles.rowGlyph}>
        {live ? (
          <LivePulse color={Theme.green} size={7} />
        ) : (
          <FontAwesome
            name={recording ? 'microphone' : call.filmed ? 'video-camera' : 'phone'}
            size={14}
            color={recording && recordingIsWorking(call) ? Theme.accentAmber : Theme.textMuted0}
          />
        )}
      </RNView>
      <RNView style={styles.rowBody}>
        <RNView style={styles.rowTop}>
          <RNText style={[styles.rowTitle, silent && { color: Theme.textMuted }]} numberOfLines={2}>{title}</RNText>
          <RNText style={[styles.rowLength, live && { color: Theme.green }]}>{callLength(call.started_at, call.ended_at)}</RNText>
        </RNView>
        <RNView style={styles.rowMeta}>
          <RelativeTime timestamp={call.started_at} style={styles.rowMetaText} />
          {detail ? <RNText style={[styles.rowMetaText, styles.rowMetaShrink]} numberOfLines={1}>· {detail}</RNText> : null}
          {actions > 0 ? <RNText style={styles.rowMetaText}>· {actions} to do</RNText> : null}
        </RNView>
      </RNView>
    </TouchableOpacity>
  );
});

const styles = themedStyles((Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Theme.borderLight,
    backgroundColor: Theme.bgAlt,
  },
  headerTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Theme.text },
  iconBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  listContent: { paddingBottom: Spacing.xxxl },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', color: Theme.textMuted0 },
  roomCard: { paddingHorizontal: Spacing.md, paddingBottom: Spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.borderLight,
  },
  rowGlyph: { width: 16, height: 20, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1, gap: 3 },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  rowTitle: { flex: 1, fontSize: FontSize.md, fontWeight: '500', color: Theme.text, lineHeight: 20 },
  rowLength: { fontSize: 12, color: Theme.textMuted0, fontVariant: ['tabular-nums'], lineHeight: 20 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  rowMetaText: { fontSize: 12, color: Theme.textMuted },
  rowMetaShrink: { flexShrink: 1 },
  empty: { alignItems: 'center', gap: 8, paddingTop: 80 },
  emptyTitle: { fontSize: 15, fontWeight: '600', color: Theme.textMuted },
}));

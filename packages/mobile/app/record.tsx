// Record a meeting with the phone's microphone, and browse the ones already
// recorded.
//
// One screen on purpose. The button and the history belong together — you open
// this to start a recording or to read the last one, and splitting them would
// put a tap between the two things anybody comes here for.
//
// WHAT THIS SCREEN WILL NOT DO is show live words. The phone has no recognizer
// (see lib/recorder.ts), so while it captures there is an elapsed clock and a
// level, which are honest, and nothing pretending to be a transcript.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Pressable,
  StyleSheet,
  TouchableOpacity,
  View as RNView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useConvex, useQuery } from 'convex/react';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import * as Haptics from 'expo-haptics';
import { api } from '@codecast/convex/convex/_generated/api';
import { isRecRoomKey } from '@codecast/shared/contracts';
import { fmtClock } from '@codecast/web/components/calls/speakers';
import { Text as RNText } from '@/components/Themed';
import { Theme, Spacing, FontSize, BorderRadius, CHROME_FONT_CAP } from '@/constants/Theme';
import {
  dismissRecorderError,
  getRecorderSnapshot,
  startRecording,
  stopRecording,
  subscribeLevel,
  subscribeRecorder,
} from '@/lib/recorder';
import { recordingIsWorking, recordingStatusLine } from '@/lib/recordingStatus';

/** The clock, in its own component with its own interval, so a ticking second
 *  re-renders eleven characters instead of the screen. */
function Elapsed({ startedAt }: { startedAt: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <RNText style={styles.clock}>{fmtClock(Date.now() - startedAt)}</RNText>;
}

/** The level, driven imperatively. It moves four times a second and must never
 *  cost a React render for it — the recorder publishes to a plain subscriber
 *  list and this writes straight into an Animated.Value. */
function LevelBar() {
  const width = useRef(new Animated.Value(0)).current;
  useEffect(() => subscribeLevel((v) => width.setValue(v)), [width]);
  return (
    <RNView style={styles.levelTrack}>
      <Animated.View
        style={[
          styles.levelFill,
          {
            transform: [{ scaleX: width }],
          },
        ]}
      />
    </RNView>
  );
}

export default function RecordScreen() {
  const router = useRouter();
  const convex = useConvex();
  const rec = useSyncExternalStore(subscribeRecorder, getRecorderSnapshot, getRecorderSnapshot);

  const calls = useQuery(api.transcripts.webListCalls, { limit: 50 });
  // A recording is the only thing this screen lists. Huddle transcripts are a
  // team's shared record behind the calls feature; a recording is one person's
  // and is exempt from it, so mixing them here would put rows in the list that
  // half the app cannot open.
  const recordings = (calls ?? []).filter((c: any) => isRecRoomKey(c.room_key));

  const onPress = useCallback(async () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (rec.phase === 'error') {
      dismissRecorderError();
      return;
    }
    if (rec.phase === 'recording') {
      const id = await stopRecording();
      if (id) router.push({ pathname: '/recording/[id]', params: { id } } as never);
      return;
    }
    if (rec.phase === 'idle') await startRecording(convex);
  }, [rec.phase, convex, router]);

  const busy = rec.phase === 'starting' || rec.phase === 'finishing';
  const recording = rec.phase === 'recording';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <RNView style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          activeOpacity={0.6}
        >
          <FontAwesome name="angle-left" size={24} color={Theme.textMuted} />
        </TouchableOpacity>
        <RNText style={styles.headerTitle}>Record</RNText>
        <RNView style={{ flex: 1 }} />
      </RNView>

      <RNView style={styles.stage}>
        <Pressable
          onPress={onPress}
          disabled={busy}
          style={({ pressed }) => [
            styles.button,
            recording && styles.buttonRecording,
            pressed && { opacity: 0.75 },
            busy && { opacity: 0.5 },
          ]}
          accessibilityRole="button"
          accessibilityLabel={recording ? 'Stop recording' : 'Start recording'}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <FontAwesome
              name={recording ? 'stop' : 'microphone'}
              size={recording ? 30 : 36}
              color="#fff"
            />
          )}
        </Pressable>

        {recording && rec.startedAt ? (
          <>
            <Elapsed startedAt={rec.startedAt} />
            <LevelBar />
            <RNText style={styles.hint} maxFontSizeMultiplier={CHROME_FONT_CAP}>
              Records from this phone&apos;s microphone. You can lock the screen.
            </RNText>
          </>
        ) : null}

        {rec.phase === 'idle' ? (
          <>
            <RNText style={styles.buttonLabel}>Record a meeting</RNText>
            <RNText style={styles.hint} maxFontSizeMultiplier={CHROME_FONT_CAP}>
              Records from this phone&apos;s microphone. The words and a summary
              arrive after you stop. Only you can open it.
            </RNText>
          </>
        ) : null}

        {rec.phase === 'starting' ? (
          <RNText style={styles.hint}>Waiting for the microphone</RNText>
        ) : null}

        {rec.phase === 'finishing' ? (
          <RNText style={styles.hint}>Saving the recording</RNText>
        ) : null}

        {rec.phase === 'error' && rec.error ? (
          <RNView style={styles.errorBox}>
            <RNText style={styles.errorText}>{rec.error}</RNText>
            <RNText style={styles.errorDismiss}>Tap the button to try again</RNText>
          </RNView>
        ) : null}

        {rec.stoppedAtLimit ? (
          <RNText style={styles.hint}>
            Stopped at the length limit — a longer file cannot be transcribed.
          </RNText>
        ) : null}
      </RNView>

      <FlatList
        data={recordings}
        keyExtractor={(item: any) => String(item._id)}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          recordings.length ? (
            <RNText style={styles.sectionLabel}>YOUR RECORDINGS</RNText>
          ) : null
        }
        ListEmptyComponent={
          calls === undefined ? null : (
            <RNText style={styles.empty}>Nothing recorded yet.</RNText>
          )
        }
        renderItem={({ item }: { item: any }) => (
          <RecordingListItem
            row={item}
            onPress={() =>
              router.push({ pathname: '/recording/[id]', params: { id: String(item._id) } } as never)
            }
          />
        )}
      />
    </SafeAreaView>
  );
}

function RecordingListItem({ row, onPress }: { row: any; onPress: () => void }) {
  const status = recordingStatusLine(row);
  const working = recordingIsWorking(row);
  const duration = row.ended_at ? fmtClock(row.ended_at - row.started_at) : null;
  const actions = row.action_items?.length ?? 0;
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.6}>
      <FontAwesome
        name="microphone"
        size={14}
        color={working ? Theme.accentAmber : Theme.textMuted0}
        style={styles.rowGlyph}
      />
      <RNView style={styles.rowBody}>
        <RNText style={styles.rowTitle} numberOfLines={1}>
          {row.title || 'Recording'}
        </RNText>
        <RNText style={styles.rowMeta} numberOfLines={1}>
          {[
            status,
            duration,
            actions ? `${actions} action item${actions === 1 ? '' : 's'}` : null,
          ]
            .filter(Boolean)
            .join('  ·  ')}
        </RNText>
      </RNView>
      {working ? <ActivityIndicator size="small" color={Theme.textMuted0} /> : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
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

  stage: {
    alignItems: 'center',
    paddingVertical: Spacing.xxl,
    paddingHorizontal: Spacing.xxl,
    gap: Spacing.md,
  },
  button: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: Theme.red,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonRecording: { backgroundColor: Theme.textMuted },
  buttonLabel: { fontSize: FontSize.md, fontWeight: '600', color: Theme.text },
  clock: {
    fontSize: 34,
    color: Theme.text,
    fontVariant: ['tabular-nums'],
  },
  hint: {
    fontSize: FontSize.sm,
    color: Theme.textMuted,
    textAlign: 'center',
    lineHeight: 18,
  },

  levelTrack: {
    width: '70%',
    height: 4,
    borderRadius: 2,
    backgroundColor: Theme.bgInset,
    overflow: 'hidden',
  },
  levelFill: {
    width: '100%',
    height: 4,
    borderRadius: 2,
    backgroundColor: Theme.accentAmber,
    // scaleX grows from the centre by default, which reads as a pulse rather
    // than a level; the origin is what makes it fill from the left edge.
    transformOrigin: 'left',
    transform: [{ scaleX: 0 }],
  },

  errorBox: {
    backgroundColor: Theme.red + '18',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    gap: Spacing.xs,
  },
  errorText: { fontSize: FontSize.sm, color: Theme.red, textAlign: 'center' },
  errorDismiss: { fontSize: FontSize.xs, color: Theme.textMuted0, textAlign: 'center' },

  list: { flex: 1 },
  listContent: { paddingBottom: Spacing.xxxl },
  sectionLabel: {
    fontSize: FontSize.xs,
    color: Theme.textMuted0,
    letterSpacing: 1,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  empty: {
    fontSize: FontSize.sm,
    color: Theme.textMuted0,
    textAlign: 'center',
    paddingTop: Spacing.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderTopWidth: 1,
    borderTopColor: Theme.borderLight,
  },
  rowGlyph: { width: 16, textAlign: 'center' },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { fontSize: FontSize.md, color: Theme.text },
  rowMeta: { fontSize: FontSize.xs, color: Theme.textMuted },
});

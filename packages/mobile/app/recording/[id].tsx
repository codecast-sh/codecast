// One recording: what it was about, what somebody has to do about it, and
// every word, with the audio underneath.
//
// Tapping a line seeks the player to it. That is the thing a recording can do
// that a huddle transcript cannot — the audio and the words came out of the
// same file, so the timestamps are exact — and it is what makes a transcript
// worth scrolling instead of just reading the summary.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  View as RNView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { api } from '@codecast/convex/convex/_generated/api';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import { fmtClock } from '@codecast/web/components/calls/speakers';
import { Text as RNText } from '@/components/Themed';
import { Theme, Spacing, FontSize, BorderRadius, CHROME_FONT_CAP } from '@/constants/Theme';
import { recordingState } from '@/lib/recordingStatus';

// Same lazy probe as lib/calls/ringtone.ts and lib/recorder.ts: a JS bundle
// newer than the installed binary must lose the player, not the screen.
let audio: typeof import('expo-audio') | null | undefined;
function getAudio() {
  if (audio !== undefined) return audio;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { requireOptionalNativeModule } = require('expo');
    audio = requireOptionalNativeModule('ExpoAudio') ? require('expo-audio') : null;
  } catch {
    audio = null;
  }
  return audio;
}

/** What the screen says while the server is still working on the recording.
 *  Every one of these is a real, reachable state — see lib/recordingStatus. */
const WAITING_COPY: Record<string, { title: string; detail: string }> = {
  recording: { title: 'Recording', detail: 'This one is still going.' },
  transcribing: {
    title: 'Getting the words',
    detail: 'The recording is being read. This takes about a minute for an hour of audio.',
  },
  summarizing: {
    title: 'Writing the summary',
    detail: 'The words are in. The summary and action items are next.',
  },
  no_words: {
    title: 'No words',
    detail: 'Nothing could be read from this recording. The audio is still here if there is any.',
  },
  no_summary: {
    title: 'Transcript only',
    detail: 'Too little was said to be worth summarizing.',
  },
};

export default function RecordingDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const call = useQuery(
    api.transcripts.webGetCall,
    id ? { transcript_id: id as Id<'transcripts'> } : 'skip',
  );

  const player = useRef<any>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const url: string | null = call?.recording_url ?? null;

  useEffect(() => {
    const a = getAudio();
    if (!a || !url) return;
    let p: any = null;
    try {
      p = a.createAudioPlayer(url);
      player.current = p;
    } catch {
      return;
    }
    const t = setInterval(() => {
      try {
        setPosition((p.currentTime ?? 0) * 1000);
        setPlaying(!!p.playing);
      } catch {}
    }, 500);
    return () => {
      clearInterval(t);
      player.current = null;
      try {
        p.pause();
        p.remove();
      } catch {}
    };
  }, [url]);

  const toggle = useCallback(() => {
    const p = player.current;
    if (!p) return;
    try {
      if (p.playing) p.pause();
      else p.play();
      setPlaying(!p.playing);
    } catch {}
  }, []);

  const seekTo = useCallback((ms: number) => {
    const p = player.current;
    if (!p) return;
    try {
      p.seekTo(ms / 1000);
      p.play();
      setPosition(ms);
    } catch {}
  }, []);

  const state = call ? recordingState(call as any) : null;
  const waiting = state && state !== 'ready' ? WAITING_COPY[state] : null;
  const segments = call?.segments ?? [];

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
        <RNText style={styles.headerTitle} numberOfLines={1}>
          {call?.title || 'Recording'}
        </RNText>
      </RNView>

      {call === undefined ? (
        <RNView style={styles.center}>
          <ActivityIndicator color={Theme.textMuted0} />
        </RNView>
      ) : call === null ? (
        <RNView style={styles.center}>
          <RNText style={styles.hint}>This recording is not yours to open.</RNText>
        </RNView>
      ) : (
        <FlatList
          data={segments}
          keyExtractor={(s: any) => String(s.seq)}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <RNView style={styles.head}>
              <RNText style={styles.when}>
                {/* Seconds are noise on a line about a meeting. */}
                {new Date(call.started_at).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
                {call.ended_at ? `  ·  ${fmtClock(call.ended_at - call.started_at)}` : ''}
              </RNText>

              {url ? (
                <RNView style={styles.player}>
                  <TouchableOpacity onPress={toggle} style={styles.playBtn} activeOpacity={0.7}>
                    <FontAwesome name={playing ? 'pause' : 'play'} size={16} color="#fff" />
                  </TouchableOpacity>
                  <RNText style={styles.playerTime}>{fmtClock(position)}</RNText>
                  <RNText style={styles.playerHint} maxFontSizeMultiplier={CHROME_FONT_CAP}>
                    Tap any line to jump there
                  </RNText>
                </RNView>
              ) : null}

              {waiting ? (
                <RNView style={styles.waiting}>
                  <RNText style={styles.waitingTitle}>{waiting.title}</RNText>
                  <RNText style={styles.hint}>{waiting.detail}</RNText>
                </RNView>
              ) : null}

              {call.summary ? (
                <RNView style={styles.block}>
                  <RNText style={styles.blockLabel}>SUMMARY</RNText>
                  <RNText style={styles.summary}>{call.summary}</RNText>
                </RNView>
              ) : null}

              {call.action_items?.length ? (
                <RNView style={styles.block}>
                  <RNText style={styles.blockLabel}>ACTION ITEMS</RNText>
                  {call.action_items.map((a: string, i: number) => (
                    <RNView key={i} style={styles.actionRow}>
                      <RNText style={styles.actionBullet}>·</RNText>
                      <RNText style={styles.action}>{a}</RNText>
                    </RNView>
                  ))}
                </RNView>
              ) : null}

              {segments.length ? (
                <RNText style={[styles.blockLabel, styles.transcriptLabel]}>TRANSCRIPT</RNText>
              ) : null}
            </RNView>
          }
          renderItem={({ item }: { item: any }) => {
            const here = position >= item.t0 && position < item.t1;
            return (
              <TouchableOpacity
                style={[styles.line, here && styles.lineHere]}
                onPress={() => seekTo(item.t0)}
                activeOpacity={0.6}
                disabled={!url}
              >
                <RNText style={styles.lineTime}>{fmtClock(item.t0)}</RNText>
                <RNText style={styles.lineText}>{item.text}</RNText>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </SafeAreaView>
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
  headerTitle: { flex: 1, fontSize: FontSize.lg, fontWeight: '600', color: Theme.text },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xxl },

  listContent: { paddingBottom: Spacing.xxxl },
  head: { padding: Spacing.lg, gap: Spacing.lg },
  when: { fontSize: FontSize.xs, color: Theme.textMuted0 },

  player: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: Theme.bgAlt,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
  },
  playBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Theme.accentAmber,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playerTime: { fontSize: FontSize.md, color: Theme.text, fontVariant: ['tabular-nums'] },
  playerHint: { flex: 1, fontSize: FontSize.xs, color: Theme.textMuted0, textAlign: 'right' },

  waiting: {
    backgroundColor: Theme.bgInset,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    gap: Spacing.xs,
  },
  waitingTitle: { fontSize: FontSize.sm, fontWeight: '600', color: Theme.text },
  hint: { fontSize: FontSize.sm, color: Theme.textMuted, lineHeight: 18 },

  block: { gap: Spacing.sm },
  blockLabel: { fontSize: FontSize.xs, color: Theme.textMuted0, letterSpacing: 1 },
  transcriptLabel: { paddingTop: Spacing.sm },
  summary: { fontSize: FontSize.md, color: Theme.text, lineHeight: 22 },
  actionRow: { flexDirection: 'row', gap: Spacing.sm },
  actionBullet: { fontSize: FontSize.md, color: Theme.accentAmber },
  action: { flex: 1, fontSize: FontSize.md, color: Theme.text, lineHeight: 22 },

  line: {
    flexDirection: 'row',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  lineHere: { backgroundColor: Theme.bgHighlight },
  lineTime: {
    fontSize: FontSize.xs,
    color: Theme.textMuted0,
    fontVariant: ['tabular-nums'],
    paddingTop: 3,
    width: 48,
  },
  lineText: { flex: 1, fontSize: FontSize.md, color: Theme.text, lineHeight: 22 },
});

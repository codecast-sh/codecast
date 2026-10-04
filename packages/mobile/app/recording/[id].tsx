// One recording: what it was about, what somebody has to do about it, and
// every word, with the audio underneath.
//
// Tapping a line seeks the player to it. That is the thing a recording can do
// that a huddle transcript cannot — the audio and the words came out of the
// same file, so the timestamps are exact — and it is what makes a transcript
// worth scrolling instead of just reading the summary.
//
// Any call opens here, a huddle as well as a recording: a `cl-42` pill, a
// `cl-42@2:30` frame reference and a pasted call link all land on this
// screen, by short id or full id. A moment (`?t=150`) or lines (`?turns=5-9`)
// open scrolled to that line and marked, found by the rule the web page
// lights its line by (segmentAt). A huddle's video plays on the web only for
// now, and the screen says so with the way there.

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
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useCallDetail } from '@codecast/web/hooks/useSyncCalls';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { api as _api } from '@codecast/convex/convex/_generated/api';
import { parseCallAnchor, parseCallMomentParam, segmentAt } from '@codecast/shared/contracts';
import { buildEntityUrl, callRefId, formatCallTime, isConvexId } from '@codecast/shared/entities';
import { openWebPage } from '@/lib/links';
import { fmtClock } from '@codecast/web/components/calls/speakers';
import { Text as RNText } from '@/components/Themed';
import { Theme, Spacing, FontSize, BorderRadius, CHROME_FONT_CAP, themedStyles, useTheme } from '@/constants/Theme';
import { recordingState } from '@/lib/recordingStatus';
import { optionalNative } from '@/lib/optionalNative';

// Same lazy probe as lib/calls/ringtone.ts and lib/recorder.ts: a JS bundle
// newer than the installed binary must lose the player, not the screen.
let audio: typeof import('expo-audio') | null | undefined;
function getAudio() {
  if (audio !== undefined) return audio;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  audio = optionalNative('ExpoAudio', () => require('expo-audio'));
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

const api = _api as any;

export default function RecordingDetailScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; t?: string; turns?: string }>();
  const ref = params.id;
  // A short id (`cl-42`, what a pill carries) is resolved to the call's full
  // id, which the store keeps its detail under.
  const byShortId = !!ref && !isConvexId(ref);
  const resolved = useQueryNoThrow(api.transcripts.webGetCallRef, byShortId ? { ref } : 'skip').data;
  const id: string | undefined = byShortId ? (resolved?._id ? String(resolved._id) : undefined) : ref;
  // Off the store's persisted call detail; the list row the person tapped
  // names the page while a never-opened recording's detail is on its way.
  const detail = useCallDetail(id);
  const call = byShortId && resolved === null ? null : detail;
  const listRow = useInboxStore((s: any) => (id ? s.callList?.[id] : undefined));
  // The place the link named: a moment of the call, or a run of lines.
  const read = { get: (k: string) => ((params as any)[k] ?? null) as string | null };
  const atMs = parseCallMomentParam(read);
  const anchor = parseCallAnchor(read);

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

  // The line the link named, marked until the person plays or taps.
  const focusIndex = (() => {
    if (!segments.length) return null;
    if (anchor?.kind === 'turns') {
      const i = segments.findIndex((s: any) => s.seq >= anchor.from_seq);
      return i >= 0 ? i : null;
    }
    return atMs !== null ? segmentAt(segments, atMs, { holdMs: Infinity })?.index ?? 0 : null;
  })();
  const focusSeq = focusIndex !== null ? segments[focusIndex]?.seq : null;
  const [marked, setMarked] = useState(true);
  const list = useRef<FlatList<any>>(null);
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || focusIndex === null) return;
    landed.current = true;
    // After the first layout, so the header above the lines has a height.
    requestAnimationFrame(() => list.current?.scrollToIndex({ index: focusIndex, viewPosition: 0.3, animated: false }));
  }, [focusIndex]);
  // The audio waits at the moment, not playing until asked.
  const seeked = useRef(false);
  useEffect(() => {
    const p = player.current;
    if (seeked.current || !p || atMs === null) return;
    seeked.current = true;
    try {
      p.seekTo(atMs / 1000);
      setPosition(atMs);
    } catch {}
  }, [url, atMs]);
  // Where the call's video plays: the web page, at the same moment.
  const videoUrl = call?.filmed ? buildEntityUrl('call', atMs !== null ? callRefId(String(call._id), null, atMs) : String(call._id)) : null;

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
          {call?.title || listRow?.title || 'Recording'}
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
          ref={list}
          data={segments}
          onScrollToIndexFailed={(info) => {
            // Lines not measured yet: land near, then exactly once they are.
            list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
            setTimeout(() => list.current?.scrollToIndex({ index: info.index, viewPosition: 0.3, animated: false }), 60);
          }}
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
                  <TouchableOpacity
                    onPress={() => {
                      setMarked(false);
                      toggle();
                    }}
                    style={styles.playBtn} activeOpacity={0.7}>
                    <FontAwesome name={playing ? 'pause' : 'play'} size={16} color="#fff" />
                  </TouchableOpacity>
                  <RNText style={styles.playerTime}>{fmtClock(position)}</RNText>
                  <RNText style={styles.playerHint} maxFontSizeMultiplier={CHROME_FONT_CAP}>
                    Tap any line to jump there
                  </RNText>
                </RNView>
              ) : null}

              {videoUrl ? (
                <RNView style={styles.videoNote}>
                  <RNText style={[styles.hint, styles.videoText]}>
                    {atMs !== null ? `This call has video. It plays on the web for now, at ${formatCallTime(atMs)}.` : 'This call has video. It plays on the web for now.'}
                  </RNText>
                  <TouchableOpacity onPress={() => void openWebPage(videoUrl)} activeOpacity={0.6} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <RNText style={styles.videoLink}>Open video</RNText>
                  </TouchableOpacity>
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
            const here = (position >= item.t0 && position < item.t1) || (marked && !playing && item.seq === focusSeq);
            return (
              <TouchableOpacity
                style={[styles.line, here && styles.lineHere]}
                onPress={() => {
                  setMarked(false);
                  seekTo(item.t0);
                }}
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
  videoNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: Theme.bgInset,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
  },
  videoText: { flex: 1 },
  videoLink: { fontSize: FontSize.sm, fontWeight: '600', color: Theme.blue },

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
}));

// A screen recording the person sent to the session, on the phone: the
// web's card (web components/calls/ScreenRecordingCard) as the phone draws
// it. Each line of what was said plays the video from that moment in the
// app's own player (InlineVideo's VideoPlayerModal), with the lines under it,
// the one being said marked.
import { useMemo, useState } from 'react';
import { StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import { Text as RNText } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';
import { canPlayInApp, VideoPlayerModal } from '@/components/InlineVideo';
import { openLink } from '@/lib/links';
import { formatCallTime, type ParsedScreenRecording } from '@codecast/shared/contracts';
import { useCallDetail } from '@codecast/web/hooks/useSyncCalls';
import { useCallRecordings } from '@codecast/web/lib/calls/callRecordingsFeed';
import { playableFiles } from '@codecast/web/lib/calls/callVideo';

export function ScreenRecordingCard({ recording }: { recording: ParsedScreenRecording }) {
  const Theme = useTheme();
  const router = useRouter();
  const id = recording.transcriptId ?? undefined;
  const call = useCallDetail(id);
  const recs = useCallRecordings(id ?? null);
  const file = useMemo(() => playableFiles((recs?.recordings ?? []).map((r) => ({ ...r, id: r._id })))[0] ?? null, [recs]);
  const lines = useMemo(() => {
    if (call?.segments?.length) return call.segments.map((s: any) => ({ t0: s.t0 as number, text: s.text as string }));
    return recording.lines.map((l) => ({ t0: l.atMs, text: l.text }));
  }, [call?.segments, recording.lines]);
  const durationMs = file?.duration_ms ?? recording.durationMs;
  // Not in the store yet reads as on its way, never as "no words".
  const pending = !!id && !recording.lines.length && (call === undefined || call?.transcribe_status === 'pending');
  const noAudio = !!call?.screen?.no_audio;
  const openPage = () => router.push(`/recording/${id ?? recording.call}` as any);
  // The player opens at a moment with the lines under it; without the
  // in-app player the file opens in the browser at that second.
  const [playingFrom, setPlayingFrom] = useState<number | null>(null);
  const play = (ms: number) => {
    if (!file?.url) return openPage();
    if (canPlayInApp) setPlayingFrom(ms);
    else void openLink(`${file.url}#t=${Math.floor(ms / 1000)}`);
  };

  return (
    <RNView style={styles.card}>
      <TouchableOpacity style={styles.head} onPress={openPage} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Open the recording">
        <Feather name="video" size={13} color={Theme.cyan} />
        <RNText style={styles.title}>Screen recording</RNText>
        <RNText style={styles.dim}>{formatCallTime(durationMs)}</RNText>
        {pending ? <RNText style={[styles.dim, { color: Theme.yellow }]}>transcribing</RNText> : null}
        {noAudio ? <RNText style={[styles.dim, { color: Theme.orange }]}>no sound</RNText> : null}
        <RNView style={{ flex: 1 }} />
        <RNText style={styles.dim}>{recording.call}</RNText>
        <Feather name="chevron-right" size={13} color={Theme.textDim} />
      </TouchableOpacity>
      {file?.url ? (
        <TouchableOpacity style={styles.frame} onPress={() => play(0)} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel="Play the recording">
          <RNView style={styles.playBtn}>
            <Feather name="play" size={20} color="#fff" style={{ marginLeft: 3 }} />
          </RNView>
        </TouchableOpacity>
      ) : null}
      {file?.url ? (
        <VideoPlayerModal src={file.url} visible={playingFrom !== null} onClose={() => setPlayingFrom(null)} startMs={playingFrom ?? 0} lines={lines} caption="Screen recording" />
      ) : null}
      {lines.length === 0 ? (
        <RNText style={[styles.dim, styles.empty]}>
          {pending ? 'Reading what was said…' : noAudio ? 'Recorded without the microphone, so there are no words.' : 'No words in this recording.'}
        </RNText>
      ) : (
        lines.map((l: { t0: number; text: string }, i: number) => (
          <TouchableOpacity key={i} style={styles.line} onPress={() => play(l.t0)} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel={`Play from ${formatCallTime(l.t0)}`}>
            <RNText style={styles.time}>{formatCallTime(l.t0)}</RNText>
            <RNText style={styles.text}>{l.text}</RNText>
          </TouchableOpacity>
        ))
      )}
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    backgroundColor: Theme.bgAlt,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontSize: 12, fontWeight: '600', color: Theme.text },
  dim: { fontSize: 11, color: Theme.textDim },
  empty: { marginTop: 6 },
  frame: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 8,
    marginTop: 8,
    marginBottom: 4,
    backgroundColor: '#0c0b10',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  line: { flexDirection: 'row', gap: 8, paddingVertical: 4 },
  time: { width: 34, textAlign: 'right', fontSize: 11, color: Theme.textDim, fontVariant: ['tabular-nums'], paddingTop: 1 },
  text: { flex: 1, fontSize: 13, color: Theme.text },
}));

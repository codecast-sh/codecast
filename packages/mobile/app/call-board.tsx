// The call's board on the phone (pl-1145), opened from the call screen's
// Board button: themes as a column (the default; the zoomable canvas one
// toggle away), with the banners that bring Scribe in. Got, or made if the
// call has none, through callStage.openCallBoard: looking at it pins nothing,
// so nobody else's stage moves.
import { useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View as RNView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { api } from '@codecast/convex/convex/_generated/api';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { useMountEffect } from '@codecast/web/hooks/useMountEffect';
import { useLiveArtifact } from '@codecast/web/components/live/useLiveArtifact';
import { huddleWorkspaceKey, setHuddleSettings, useHuddleSetting } from '@codecast/web/lib/calls/huddleSettings';
import { autoScribeLedger } from '@codecast/web/components/consequential/ledgers';
import { ledgerLines } from '@codecast/web/components/consequential/roleOnline';
import { Text } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { ArtifactView } from '@/components/artifacts/ArtifactView';
import { BoardColumn } from '@/components/calls/BoardColumn';
import { appAlert } from '@/lib/popups';
import { usePhoneScribe, type PhoneScribeLive } from '@/lib/calls/usePhoneScribe';
import { INVITE_WORDS, nextTimeSeenPatch, phoneBannerState, readNextTimeSeen, type PhoneBannerMemo } from '@/lib/calls/huddleBanner';

export default function CallBoardScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { room } = useLocalSearchParams<{ room: string }>();
  const roomKey = room ?? null;
  const live = useQueryNoThrow(api.transcripts.getLive, roomKey ? { room_key: roomKey, tail: 1 } : 'skip').data as PhoneScribeLive;
  const key = `${roomKey}|${live?.transcript_id ?? ''}`;
  const [docId, setDocId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canvas, setCanvas] = useState(false);
  const scribe = usePhoneScribe(roomKey, live);

  useMountEffect(() => {
    if (!roomKey) return;
    let gone = false;
    useInboxStore
      .getState()
      .openCallBoard(roomKey)
      .then((r) => {
        if (r?.doc_id && !gone) setDocId(r.doc_id);
      })
      .catch((e: any) => !gone && setError(typeof e?.data === 'string' ? e.data : e?.message ?? 'Could not open the board'));
    return () => {
      gone = true;
    };
  });

  const workspace = huddleWorkspaceKey(live?.team_id);
  const workspaceName = useInboxStore((s: any) => (s.teams ?? []).find((t: any) => String(t?._id) === live?.team_id)?.name ?? 'this workspace');
  const banner = roomKey && live ? <BoardBanner callKey={key} workspace={workspace} workspaceName={workspaceName} scribe={scribe} /> : null;

  return (
    <RNView style={[styles.root, { paddingTop: insets.top }]}>
      <RNView style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={({ pressed }) => [styles.back, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel="Back to the call">
          <Ionicons name="chevron-back" size={20} color={Theme.text} />
          <Text style={styles.headerTitle}>Board</Text>
        </Pressable>
        <RNView style={styles.headerEnd}>
          <ScribeChip scribe={scribe} />
          <Pressable
            onPress={() => setCanvas((c) => !c)}
            disabled={!docId}
            style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={canvas ? 'Show as a column' : 'Show the canvas'}
          >
            <Ionicons name={canvas ? 'list' : 'easel-outline'} size={15} color={Theme.text} />
            <Text style={styles.toggleText}>{canvas ? 'Column' : 'Canvas'}</Text>
          </Pressable>
        </RNView>
      </RNView>
      {!docId ? (
        <RNView style={styles.cold}>
          {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator size="small" color={Theme.textMuted} />}
        </RNView>
      ) : canvas ? (
        <RNView style={[styles.fill, { paddingBottom: insets.bottom }]}>
          {banner}
          <ArtifactView doc={{ _id: docId, title: 'Call board', doc_type: 'board' }} />
        </RNView>
      ) : (
        <ColumnBody docId={docId} banner={banner} bottom={insets.bottom} />
      )}
    </RNView>
  );
}

/** The column, with the board's live feeder mounted (ArtifactView mounts its own). */
function ColumnBody({ docId, banner, bottom }: { docId: string; banner: React.ReactNode; bottom: number }) {
  useLiveArtifact(docId);
  return (
    <RNView style={[styles.fill, { paddingBottom: bottom }]}>
      <BoardColumn docId={docId} header={banner} />
    </RNView>
  );
}

type Scribe = ReturnType<typeof usePhoneScribe>;

/** Scribe while it is in the call; a tap offers Remove. */
function ScribeChip({ scribe }: { scribe: Scribe }) {
  if (!scribe.present) return null;
  const word = scribe.status === 'listening' ? 'listening' : 'joining';
  return (
    <Pressable
      onPress={() =>
        appAlert('Scribe', `Scribe is ${word}.`, [
          { text: 'Keep', style: 'cancel' },
          { text: 'Remove from the call', style: 'destructive', onPress: scribe.remove },
        ])
      }
      style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`Scribe, ${word}`}
    >
      <RNView style={styles.chipDot} />
      <Text style={styles.chipText}>Scribe · {word}</Text>
    </Pressable>
  );
}

// ── The banners ───────────────────────────────────────────────────────────

const memos = new Map<string, PhoneBannerMemo>();
const memoListeners = new Set<() => void>();
const EMPTY: PhoneBannerMemo = {};
function noteBanner(callKey: string, patch: PhoneBannerMemo) {
  memos.set(callKey, { ...memos.get(callKey), ...patch });
  memoListeners.forEach((fn) => fn());
}
const subscribeMemos = (fn: () => void) => {
  memoListeners.add(fn);
  return () => void memoListeners.delete(fn);
};

function BoardBanner({ callKey, workspace, workspaceName, scribe }: { callKey: string; workspace: string | null; workspaceName: string; scribe: Scribe }) {
  const Theme = useTheme();
  const memo = useSyncExternalStore(subscribeMemos, () => memos.get(callKey) ?? EMPTY, () => EMPTY);
  const nextSeen = useInboxStore((s: any) => readNextTimeSeen(s.clientState?.ui, workspace));
  const state = phoneBannerState({ present: scribe.present, memo, nextSeen });
  if (state === 'invite') {
    return (
      <RNView style={styles.banner} accessibilityRole="summary">
        <Text style={styles.bannerText}>{INVITE_WORDS}</Text>
        <RNView style={styles.bannerActions}>
          <Pressable
            onPress={() => {
              noteBanner(callKey, { invited: true });
              scribe.invite();
            }}
            style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
            accessibilityRole="button"
          >
            <Text style={styles.primaryText}>Invite Scribe</Text>
          </Pressable>
          <Pressable onPress={() => noteBanner(callKey, { dismissed: true })} style={({ pressed }) => [styles.close, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel="Dismiss for this call">
            <Ionicons name="close" size={18} color={Theme.textMuted} />
          </Pressable>
        </RNView>
      </RNView>
    );
  }
  if (state === 'next' && workspace) {
    return <NextTimeBanner callKey={callKey} workspace={workspace} workspaceName={workspaceName} onClose={() => noteBanner(callKey, { nextClosed: true })} />;
  }
  return null;
}

function NextTimeBanner({ callKey, workspace, workspaceName, onClose }: { callKey: string; workspace: string; workspaceName: string; onClose: () => void }) {
  const Theme = useTheme();
  const autoScribeOn = useHuddleSetting('huddleAutoScribe', workspace);
  const [boardView, setBoardView] = useState(true);
  const [autoScribe, setAutoScribe] = useState(true);
  // Shown once per workspace, ever: marked seen as it first shows, and held
  // up for the rest of this call by the memo.
  useMountEffect(() => {
    if (memos.get(callKey)?.nextShown) return;
    noteBanner(callKey, { nextShown: true });
    const s = useInboxStore.getState();
    s.updateClientUI(nextTimeSeenPatch(s.clientState?.ui, workspace) as any);
  });
  const save = () => {
    setHuddleSettings(workspace, { huddleBoardView: boardView, huddleAutoScribe: autoScribe });
    onClose();
  };
  const onSave = () => {
    // Turning "Invite Scribe" on starts an agent in every huddle: the same review web shows.
    if (!autoScribe || autoScribeOn) return save();
    const l = autoScribeLedger({ workspace: workspaceName });
    appAlert(l.subject ? `${l.name}: ${l.subject}` : l.name, ledgerLines(l).join('\n'), [
      { text: l.keep ?? 'Not now', style: 'cancel' },
      { text: l.confirm, onPress: save },
    ]);
  };
  return (
    <RNView style={styles.banner} accessibilityRole="summary">
      <Text style={styles.bannerText}>
        Next time in <Text style={styles.workspace}>{workspaceName}</Text>:
      </Text>
      <Check label="Open huddles on the board" on={boardView} onPress={() => setBoardView((v) => !v)} />
      <Check label="Invite Scribe" on={autoScribe} onPress={() => setAutoScribe((v) => !v)} />
      <RNView style={styles.bannerActions}>
        <Pressable onPress={onSave} style={({ pressed }) => [styles.primary, pressed && styles.pressed]} accessibilityRole="button">
          <Text style={styles.primaryText}>Save</Text>
        </Pressable>
        <Pressable onPress={onClose} style={({ pressed }) => [styles.close, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel="Close">
          <Ionicons name="close" size={18} color={Theme.textMuted} />
        </Pressable>
      </RNView>
    </RNView>
  );
}

function Check({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const Theme = useTheme();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.check, pressed && styles.pressed]} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
      <Ionicons name={on ? 'checkbox' : 'square-outline'} size={20} color={on ? Theme.violet : Theme.textMuted} />
      <Text style={styles.checkText}>{label}</Text>
    </Pressable>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  root: { flex: 1, backgroundColor: Theme.bg },
  fill: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.sm,
    minHeight: 48,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
  },
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 44, paddingHorizontal: 6 },
  headerTitle: { fontSize: 16, fontWeight: '600', color: Theme.text },
  headerEnd: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 12, borderRadius: 10, backgroundColor: Theme.bgAlt },
  toggleText: { fontSize: 13, color: Theme.text },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 10, borderRadius: 10, backgroundColor: Theme.bgAlt },
  chipDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Theme.violet },
  chipText: { fontSize: 12, color: Theme.violet },
  cold: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg },
  error: { fontSize: 14, color: Theme.textMuted, textAlign: 'center' },
  banner: {
    gap: 8,
    margin: Spacing.md,
    marginBottom: 0,
    padding: Spacing.md,
    borderRadius: 12,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.violet,
  },
  bannerText: { fontSize: 14, color: Theme.text },
  workspace: { fontWeight: '600' },
  bannerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  primary: { minHeight: 44, paddingHorizontal: 16, borderRadius: 10, justifyContent: 'center', backgroundColor: Theme.violet },
  primaryText: { fontSize: 14, fontWeight: '600', color: '#fdf6e3' },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  check: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  checkText: { fontSize: 14, color: Theme.text },
  pressed: { opacity: 0.6 },
}));

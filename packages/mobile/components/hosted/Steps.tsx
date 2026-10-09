// One tool step of the hosted assistant in the session screen's transcript,
// said as a plain line ("Searched your mail for Dana") in the words the web's
// condensed receipt uses (@platform/assistant/steps), with a mark for how it
// came out. A step that made one thing reads as the web's made line (the
// words, then the thing's name to open, and its state now), and a note it
// wrote as a quiet card with its opening lines (web HostedMadeLine; the rules
// are lib/madeLine). Nothing opens to the raw call: that is a developer's view.
import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { Text } from '@/components/Themed';
import { Serif } from '@/constants/fonts';
import { stepOutcome, stepText, type ToolCallLike, type ToolResultLike } from '@codecast/web/components/simple/lane';
import { useConversationApprovals, useConversationWorking } from '@codecast/web/components/simple/useLane';
import { createdRefs, siteOf } from '@codecast/web/lib/hostedReceipt';
import type { Source } from '@platform/assistant/sources';
import { openWebPage } from '@/lib/links';
import { madeLineParts, notePreview, routineState } from '@codecast/web/lib/madeLine';
import { hostedApprovalState } from '@codecast/web/lib/hostedApproval';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useTriggers } from '@codecast/web/hooks/useSyncTriggers';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { api as _api } from '@codecast/convex/convex/_generated/api';
import { entityTypeFromId } from '@codecast/shared/entities';
import { mobileEntityRoute } from '@/lib/linkRoutes';
import { useHostedTheme } from './hostedTheme';

const api = _api as any;

/** Running while the turn works, waiting while a parked call waits on the
 *  person, skipped for a step the person declined or that was never tried,
 *  failed only for one that was tried and went wrong. A "no" is the person's
 *  choice, so it must not wear the mark of an error. */
type StepState = 'running' | 'waiting' | 'done' | 'skipped' | 'failed';

function StepMark({ state }: { state: StepState }) {
  const { c } = useHostedTheme();
  const breathe = useSharedValue(1);
  useEffect(() => {
    breathe.value = state === 'running' ? withRepeat(withTiming(0.35, { duration: 700 }), -1, true) : 1;
  }, [state, breathe]);
  const style = useAnimatedStyle(() => ({ opacity: breathe.value }));
  const done = state === 'done';
  return (
    <Animated.View
      style={[
        {
          marginTop: 5,
          width: 9,
          height: 9,
          borderRadius: 5,
          borderWidth: 1.5,
          backgroundColor: done ? c.ok : c.paper,
          borderColor: done ? c.ok : state === 'running' ? c.working : state === 'failed' ? c.danger : c.lineStrong,
        },
        style,
      ]}
    />
  );
}

function StepLine({ text, state }: { text: string; state: StepState }) {
  const { c } = useHostedTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 3 }}>
      <StepMark state={state} />
      <Text style={{ flex: 1, fontSize: 13, lineHeight: 19, color: state === 'failed' || state === 'skipped' ? c.faint : state === 'running' ? c.ink2 : c.soft }}>{text}</Text>
    </View>
  );
}

/** A call with no result yet: in progress while the turn runs, and once it
 *  stops, parked on the person's approval. Only this case reads the row.
 *  While the approval card is up it says the same thing right below, with
 *  the draft and the answers, so the line steps aside for it. */
function OpenStep({ call, conversationId }: { call: ToolCallLike; conversationId: string }) {
  const live = useConversationWorking(conversationId);
  const asked = useConversationApprovals(conversationId).length > 0;
  // Once the store holds the answer the step is under way again, whatever
  // the lagging status says, so it never reads "Waiting for your go-ahead"
  // over "You said not now" (lib/hostedApproval, as the web reads it).
  const answered = useInboxStore((s) => hostedApprovalState(s.messages[conversationId] as any, Object.values(s.sessionDecisions) as any[], conversationId).startsWith('answered:'));
  if (!live && asked) return null;
  const running = live || answered;
  return <StepLine text={stepText(call, undefined, { asking: !running })} state={running ? 'running' : 'waiting'} />;
}

/** Where a made thing opens on the phone: a routine on the Tasks tab's
 *  routines segment (the phone has no routine screen), anything else on its
 *  own screen. */
function madeRoute(refId: string): string | null {
  if (/^tr-/i.test(refId)) return '/(tabs)/tasks?segment=routines';
  if (/^doc:/i.test(refId)) return mobileEntityRoute('doc', refId.slice(4));
  const type = entityTypeFromId(refId);
  return type ? mobileEntityRoute(type, refId) : null;
}

/** One step that made one thing: its words, the thing's name in ink to open
 *  it, and a routine's state now when it changed since (paused, stopped, or
 *  deleted, when the roster no longer holds it). */
function MadeLine({ words, name, refId }: { words: string; name: string; refId: string }) {
  const { c } = useHostedTheme();
  const router = useRouter();
  const routine = /^tr-/i.test(refId);
  const { tasks: routines, ready } = useTriggers();
  const row = routine ? routines.find((t) => t.short_id === refId) : null;
  const gone = routine && ready && !row;
  const state = gone ? 'Deleted' : row ? routineState(row.status, row) : null;
  const route = gone ? null : madeRoute(refId);
  return (
    <Text style={{ fontSize: 13, lineHeight: 19, color: c.faint, paddingVertical: 4 }}>
      {words}{' '}
      <Text
        style={{ color: c.ink, fontWeight: '500' }}
        onPress={route ? () => router.push(route as any) : undefined}
        accessibilityRole={route ? 'link' : undefined}
      >
        {row?.display_title || row?.title || name}
      </Text>
      {state ? ` · ${state}` : ''}
    </Text>
  );
}

/** The note a step wrote, as the web's card: the step's words, the note's
 *  title in the reading face, its opening lines (or a table's first rows) in
 *  muted ink, and "Open note". Paints from the cached body first. */
function NoteCard({ words, docId, name }: { words: string; docId: string; name?: string }) {
  const { c } = useHostedTheme();
  const router = useRouter();
  const cached = useInboxStore((s) => (s.docDetails as Record<string, { content?: string; title?: string } | undefined>)[docId]);
  const listed = useInboxStore((s) => (s.docs as Record<string, { title?: string } | undefined>)[docId]?.title);
  const served = useQueryNoThrow(api.docs.webGet, cached?.content ? 'skip' : { id: docId }).data as { title?: string; content?: string } | null | undefined;
  const title = cached?.title || listed || served?.title || name || 'Note';
  const preview = notePreview(cached?.content ?? served?.content, title);
  const route = mobileEntityRoute('doc', docId);
  const lines = !preview ? [] : preview.kind === 'lines' ? preview.lines : preview.rows.map((row) => row.join('  ·  '));
  return (
    <View style={{ marginVertical: 8 }}>
      <Text style={{ fontSize: 12.5, color: c.faint, marginBottom: 6 }}>{words.replace(/[:\s]+$/, '')}</Text>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Open note ${title}`}
        onPress={route ? () => router.push(route as any) : undefined}
        style={({ pressed }) => ({
          borderRadius: 10,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: c.lineStrong,
          backgroundColor: pressed ? c.hover : c.sheet,
          paddingHorizontal: 14,
          paddingTop: 11,
          paddingBottom: 10,
        })}
      >
        <Text numberOfLines={1} style={{ fontFamily: Serif.regular, fontSize: 17, lineHeight: 23, color: c.ink }}>{title}</Text>
        {lines.map((line, i) => (
          <Text key={i} numberOfLines={1} style={{ marginTop: i === 0 ? 5 : 1, fontSize: 13, lineHeight: 19, color: c.soft, opacity: 1 - i * 0.22 }}>{line}</Text>
        ))}
        <Text style={{ marginTop: 8, fontSize: 12.5, fontWeight: '500', color: c.ink2 }}>Open note</Text>
      </Pressable>
    </View>
  );
}

export function HostedStep({ call, result, conversationId }: { call: ToolCallLike; result?: ToolResultLike; conversationId: string }) {
  const outcome = stepOutcome(result);
  if (outcome === 'pending') return <OpenStep call={call} conversationId={conversationId} />;
  const text = stepText(call, result);
  if (outcome === 'done') {
    const refs = createdRefs([call], () => result);
    if (refs.length === 1) {
      const parts = madeLineParts(text);
      if (/^doc:/i.test(refs[0])) return <NoteCard words={parts?.words ?? text} name={parts?.name} docId={refs[0].slice(4)} />;
      if (parts) return <MadeLine words={parts.words} name={parts.name} refId={refs[0]} />;
    }
  }
  return <StepLine text={text} state={outcome === 'done' ? 'done' : outcome === 'failed' ? 'failed' : 'skipped'} />;
}

/** The pages a message's web searches drew on, as one quiet line under its
 *  steps (the web's HostedSources, read through hostedReceipt
 *  searchedSources): "Sources tomsguide.com · eufy.com", each site opening
 *  its page, so a claim can be checked. */
export function HostedSources({ sources }: { sources: Source[] }) {
  const { c } = useHostedTheme();
  if (sources.length === 0) return null;
  return (
    <Text style={{ fontSize: 12.5, lineHeight: 19, color: c.faint, paddingVertical: 4 }}>
      {'Sources  '}
      {sources.map((source, i) => (
        <Text key={source.url}>
          {i > 0 ? '  ·  ' : ''}
          <Text
            accessibilityRole="link"
            accessibilityLabel={source.title ?? siteOf(source.url) ?? source.url}
            onPress={() => void openWebPage(source.url)}
            style={{ color: c.soft, textDecorationLine: 'underline', textDecorationColor: c.lineStrong }}
          >
            {siteOf(source.url) ?? source.url}
          </Text>
        </Text>
      ))}
    </Text>
  );
}

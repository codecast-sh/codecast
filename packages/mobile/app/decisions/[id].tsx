import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Text, TextInput } from '@/components/Themed';
import { Spacing, BorderRadius, themedStyles, useTheme } from '@/constants/Theme';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { CollapsibleBody } from '@/components/CollapsibleBody';
import { QueueChip, askingSessionLine } from '@/components/decisions/QueueMeta';
import { openLink } from '@/lib/links';
import { rosterEscalationTargets, useInboxStore, type DecisionAnswerInput, type SessionDecisionItem } from '@codecast/web/store/inboxStore';
import { useDecisionQueue } from '@codecast/web/hooks/useDecisionQueue';
import { decisionQueueItems } from '@codecast/web/lib/decisionQueue';
import { useDecisionDraft } from '@codecast/web/hooks/useDecisionDraft';
import { useSyncDecisionDetail, useDecisionDetail } from '@codecast/web/hooks/useSyncDecisionDetail';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import type { AnswerDraft } from '@codecast/web/lib/decisionAnswer';
import { AnswerButton, AnswerControls, appAnswerLook } from '@/components/decisions/AnswerControls';
import { decisionAnswerLabel } from '@codecast/shared/contracts';
import { approvesSecretRead } from '@codecast/shared/contracts/secrets';
import { confirmPresence } from '@/lib/presence';
import { DecisionThread } from '@/components/decisions/DecisionThread';

const pageUrl = (slug: string) => `https://codecast.sh/a/${slug}`;

// One `cast decide` at a time. The queue (useDecisionQueue) is the same model
// web's stepper walks; this screen shows the decision named in the route and,
// once it is answered, skipped or dismissed, replaces itself with the next one
// in queue order. Answering is the store's answerDecision: the row flips
// locally and the answer is delivered into the asking session.
export default function DecisionScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const now = useCoarseNow(60_000);

  const queue = useDecisionQueue();
  const decideQueue = useMemo(() => queue.filter((i) => i.source === 'decide'), [queue]);
  const position = decideQueue.findIndex((i) => i.decisionId === id || i.shortId === id);
  const queued = position >= 0 ? decideQueue[position] : undefined;

  // The document body, the asking people and an answered row all come from
  // the detail feed; the queue item paints first from the store.
  useSyncDecisionDetail(id);
  const detail = useDecisionDetail(id);
  const row: SessionDecisionItem | undefined = useInboxStore((s) => {
    if (!id) return undefined;
    return s.sessionDecisions[id] ?? Object.values(s.sessionDecisions).find((d) => d.short_id === id);
  }) ?? detail?.decision;
  // An advisory ask sits outside the stacked queue (isStackedAsk) but is still
  // answerable when a link opens it; read it as a queue item from its row.
  const session = useInboxStore((s) => (row ? s.sessions[row.conversation_id] : undefined));
  const item = queued ?? (row?.status === 'pending' ? decisionQueueItems({ [row._id]: row }, session ? { [row.conversation_id]: session } : {})[0] : undefined);
  const decisionId = item?.decisionId ?? row?._id ?? id ?? '';

  const [draft, patchDraft] = useDecisionDraft<AnswerDraft>(decisionId);
  const [handoff, setHandoff] = useState<'pass' | 'escalate' | null>(null);
  const answerDecision = useInboxStore((s) => s.answerDecision);
  const look = appAnswerLook(Theme);

  // The next decision after this one, wrapping, never this one.
  const nextId = useMemo(() => {
    const rest = decideQueue.filter((i) => i.decisionId !== decisionId);
    if (rest.length === 0) return null;
    const after = position >= 0 ? decideQueue.slice(position + 1).find((i) => i.decisionId !== decisionId) : undefined;
    return (after ?? rest[0]).decisionId ?? null;
  }, [decideQueue, decisionId, position]);

  const goNext = useCallback(() => {
    if (nextId) router.replace(`/decisions/${nextId}`);
    else router.back();
  }, [nextId, router]);

  const source = item ?? row;
  // Approving an Ask first read takes Touch ID first (lib/presence); one
  // confirmation at a time, so a second press while the sheet is up is a no-op.
  const confirming = useRef(false);
  const answer = useCallback(async (input: DecisionAnswerInput) => {
    if (source && 'index' in input && input.index !== undefined && approvesSecretRead(source, input.index)) {
      if (confirming.current) return;
      confirming.current = true;
      try {
        const presence = await confirmPresence('approve', decisionId);
        if (!presence) return;
        input = { ...input, presence };
      } catch (e) {
        Alert.alert('Touch ID', (e as Error).message);
        return;
      } finally {
        confirming.current = false;
      }
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    answerDecision(decisionId, input);
    goNext();
  }, [answerDecision, decisionId, goNext, source]);

  if (!source) {
    return (
      <>
        <Stack.Screen options={{ title: 'Decision' }} />
        <View style={[styles.center, { backgroundColor: Theme.bg }]}>
          <Text style={styles.muted}>{detail === undefined ? 'Loading…' : 'This decision is gone.'}</Text>
        </View>
      </>
    );
  }

  const options = source.options ?? [];
  const kind = source.kind ?? 'single';
  const blocking = item ? item.blocking : !!row?.blocking;
  const defaultOption = item ? item.defaultOption : row?.default_option;
  const contextMd = item ? item.contextMd : row?.context_md;
  const reportSlug = item ? item.reportSlug : row?.report_slug;
  const docBody = detail?.doc?.content?.trim();
  const otherText = draft.otherText ?? '';
  // A typed answer is the rare path: its box opens on request, or holds a saved draft.
  const writing = !!draft.otherOpen || !!otherText;

  const title = queued ? `${position + 1} of ${decideQueue.length}` : 'Decision';

  // Settled: say how, and move on.
  if (!item) {
    const settled = row && row.status !== 'pending'
      ? row.status === 'answered' ? `Answered: ${decisionAnswerLabel(row, row) ?? ''}` : row.status === 'withdrawn' ? 'The agent withdrew this question.' : 'Dismissed.'
      : 'This decision is no longer in your queue.';
    return (
      <>
        <Stack.Screen options={{ title, headerBackTitle: 'Back' }} />
        <ScrollView style={{ backgroundColor: Theme.bg }} contentContainerStyle={styles.body}>
          <Text style={styles.question}>{source.question}</Text>
          <Text style={styles.muted}>{settled}</Text>
          {nextId ? <AnswerButton look={look} label="Next decision" onPress={goNext} /> : null}
        </ScrollView>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title, headerBackTitle: 'Back' }} />
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: Theme.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <QueueChip item={item} now={now} />
          <Text style={styles.question} selectable>{item.question}</Text>
          {row ? <HandoffNote row={row} /> : null}
          {askingSessionLine(item) ? (
            <TouchableOpacity onPress={() => router.push(`/session/${item.conversationId}`)} hitSlop={8}>
              <Text style={styles.session} numberOfLines={1}>{askingSessionLine(item)} ›</Text>
            </TouchableOpacity>
          ) : null}

          {/* The reasoning folds, so the answers stay in reach without scrolling. */}
          {contextMd || (docBody && docBody !== contextMd?.trim()) ? (
            <CollapsibleBody fadeColor={Theme.bg} height={150}>
              {contextMd ? <MarkdownContent text={contextMd} baseStyle={styles.context} /> : null}
              {docBody && docBody !== contextMd?.trim() ? <MarkdownContent text={docBody} baseStyle={styles.context} /> : null}
            </CollapsibleBody>
          ) : null}
          {reportSlug ? <LinkRow label="Open the report" onPress={() => openLink(pageUrl(reportSlug))} /> : null}

          <AnswerControls decisionId={decisionId} decision={{ options, form: source.form, kind }} onAnswer={answer} look={look} proceedingWith={blocking ? undefined : defaultOption} guarded={(i) => approvesSecretRead(source, i)} />

          {kind === 'single' && !writing ? (
            <TouchableOpacity onPress={() => patchDraft({ otherOpen: true })} hitSlop={8}>
              <Text style={styles.footerText}>Answer in your own words</Text>
            </TouchableOpacity>
          ) : null}
          {kind === 'single' && writing ? (
            <View style={styles.other}>
              <TextInput
                style={[styles.input, styles.otherInput]}
                value={otherText}
                onChangeText={(t) => patchDraft({ otherText: t })}
                placeholder="Your answer"
                autoFocus
                placeholderTextColor={Theme.inputPlaceholder}
                multiline
              />
              {otherText.trim() ? <AnswerButton look={look} label="Send" onPress={() => answer({ text: otherText.trim() })} /> : null}
            </View>
          ) : null}

          <View style={styles.footer}>
            <TouchableOpacity onPress={() => answer({ dismiss: true })} hitSlop={8}>
              <Text style={styles.footerText}>Dismiss</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setHandoff(handoff === 'pass' ? null : 'pass')} hitSlop={8}>
              <Text style={[styles.footerText, handoff === 'pass' && { color: Theme.text }]}>Pass</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setHandoff(handoff === 'escalate' ? null : 'escalate')} hitSlop={8}>
              <Text style={[styles.footerText, { color: Theme.orange }]}>Escalate</Text>
            </TouchableOpacity>
            {nextId ? (
              <TouchableOpacity onPress={goNext} hitSlop={8}>
                <Text style={styles.footerText}>Skip ›</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {handoff ? <HandoffPanel key={handoff} mode={handoff} decisionId={decisionId} holderKey={row?.holder_key} onDone={goNext} /> : null}
          <DecisionThread decisionId={decisionId} conversationId={item?.conversationId ?? row?.conversation_id} />
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

// Why it reached its owner, in the sender's words: an escalation, or a pass with a note.
function HandoffNote({ row }: { row: SessionDecisionItem }) {
  const Theme = useTheme();
  const up = row.escalated;
  const note = up?.note ?? row.passed_to?.note;
  const by = useInboxStore((s) => {
    const id = up?.by ?? row.passed_to?.by;
    const m = id ? (s.teamMembers ?? []).find((u: any) => String(u._id) === id) : null;
    return m?.name ?? m?.email ?? null;
  });
  if (row.status !== 'pending' || !note) return null;
  return (
    <View style={[styles.handoffNote, { borderColor: up ? Theme.orange : Theme.borderLight }]}>
      <Text style={[styles.handoffLabel, { color: up ? Theme.orange : Theme.textMuted }]}>{up ? 'Escalated' : 'Passed'}{by ? ` by ${by}` : ''}</Text>
      <Text style={styles.context} selectable>{note}</Text>
    </View>
  );
}

// Pass: pick a teammate, add a note if you like. Escalate: to the owner's
// manager, else the admins, named before it goes, with a note it needs.
function HandoffPanel({ mode, decisionId, holderKey, onDone }: { mode: 'pass' | 'escalate'; decisionId: string; holderKey?: string; onDone: () => void }) {
  const Theme = useTheme();
  const [note, setNote] = useState('');
  const [to, setTo] = useState<string | null>(null);
  const meId = useInboxStore((s) => String(s.currentUser?._id ?? ''));
  const members = useInboxStore((s) => s.teamMembers);
  const orgPeople = useInboxStore((s) => s.orgTree?.people);
  const passDecision = useInboxStore((s) => s.passDecision);
  const escalateDecision = useInboxStore((s) => s.escalateDecision);
  const people = useMemo(() => (members ?? []).filter((m: any) => !m.is_bot && String(m._id) !== meId && holderKey !== `user:${m._id}`), [members, meId, holderKey]);
  const nameOf = (id: string) => { const m = (members ?? []).find((u: any) => String(u._id) === id); return m?.name ?? m?.email ?? 'a teammate'; };
  const upTo = useMemo(() => {
    const owner = holderKey?.startsWith('user:') ? holderKey.slice(5) : meId;
    return rosterEscalationTargets(owner, orgPeople, members);
  }, [holderKey, meId, orgPeople, members]);
  const escalating = mode === 'escalate';
  const ready = escalating ? !!note.trim() && upTo.length > 0 : !!to;
  const send = () => {
    if (!ready) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    if (escalating) escalateDecision(decisionId, note);
    else passDecision(decisionId, { kind: 'user', id: to! }, note);
    onDone();
  };
  return (
    <View style={styles.other}>
      {escalating ? (
        <Text style={styles.muted}>To {upTo.length ? upTo.map(nameOf).join(', ') : 'nobody above you'}</Text>
      ) : (
        <View style={styles.people}>
          {people.map((m: any) => {
            const picked = to === String(m._id);
            return (
              <TouchableOpacity key={String(m._id)} onPress={() => setTo(picked ? null : String(m._id))} style={[styles.person, picked && { borderColor: Theme.blue }]}>
                <Text style={[styles.personText, picked && { color: Theme.blue }]}>{m.name ?? m.email}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
      <TextInput
        style={[styles.input, styles.otherInput]}
        value={note}
        onChangeText={setNote}
        placeholder={escalating ? 'Why it goes up' : 'Note for them (optional)'}
        placeholderTextColor={Theme.inputPlaceholder}
        multiline
      />
      {ready ? <AnswerButton look={appAnswerLook(Theme)} label={escalating ? 'Escalate' : `Pass to ${nameOf(to!)}`} onPress={send} /> : null}
    </View>
  );
}

function LinkRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} hitSlop={6}>
      <Text style={styles.link}>{label} ↗</Text>
    </TouchableOpacity>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.xxxl * 2 },
  question: { fontSize: 19, lineHeight: 26, color: Theme.text, fontWeight: '600' },
  session: { fontSize: 12, color: Theme.textMuted0 },
  context: { fontSize: 14, lineHeight: 21, color: Theme.textSecondary },
  muted: { fontSize: 13, color: Theme.textMuted },
  link: { fontSize: 13, color: Theme.blue },
  input: {
    fontSize: 15,
    color: Theme.text,
    backgroundColor: Theme.card,
    borderWidth: 1,
    borderColor: Theme.borderLight,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
  },
  other: { gap: Spacing.sm, marginTop: Spacing.sm },
  otherInput: { minHeight: 48, textAlignVertical: 'top' },
  footer: { flexDirection: 'row', justifyContent: 'space-between', marginTop: Spacing.lg },
  footerText: { fontSize: 14, color: Theme.textMuted },
  handoffNote: { borderLeftWidth: 2, paddingLeft: Spacing.md, gap: 2 },
  handoffLabel: { fontSize: 12, fontWeight: '600' },
  people: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  person: { borderWidth: 1, borderColor: Theme.borderLight, borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md, paddingVertical: 6 },
  personText: { fontSize: 14, color: Theme.text },
}));

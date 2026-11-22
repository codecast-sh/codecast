import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { answerChangeable } from '@codecast/shared/contracts';
import { Text, TextInput } from '@/components/Themed';
import { Spacing, BorderRadius, themedStyles, useTheme } from '@/constants/Theme';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { CollapsibleBody } from '@/components/CollapsibleBody';
import { useInboxStore, type DecisionAnswerInput, type DecisionParty, type SessionDecisionItem } from '@codecast/web/store/inboxStore';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { answerLockedReason, answerTimeline, inputLabel, sameAnswer, type AnswerEntry } from '@codecast/web/lib/decisions/decisionHistory';
import { ageShort } from '@codecast/web/lib/lineFlow';
import { AnswerButton, AnswerControls, appAnswerLook } from './AnswerControls';
import { DecisionThread } from './DecisionThread';
import { useDecisionAnswer } from './DecisionCard';

/** Who an answer came from, in the words a person reads: you, a teammate, a role, a stack default. */
export function usePartyName(): (by: DecisionParty | undefined) => string {
  const me = useInboxStore((s) => String(s.currentUser?._id ?? ''));
  const members = useInboxStore((s) => s.teamMembers);
  const roles = useInboxStore((s) => s.orgTree?.roles);
  return useMemo(() => (by) => {
    if (!by) return 'Someone';
    if (by.kind === 'policy') return 'A stack default';
    if (by.kind === 'role') return (roles ?? []).find((r: any) => String(r._id) === by.id)?.name ?? 'A role';
    const name = by.id === me ? 'You' : (members ?? []).find((m: any) => String(m._id) === by.id)?.name ?? 'A teammate';
    return by.via ? `${name}, through ${by.id === me ? 'your' : 'their'} agent` : name;
  }, [me, members, roles]);
}

/** Who answered the row's answer on record; a change not yet echoed by the server is the viewer's. */
export function useAnswererName(d: SessionDecisionItem, me: string): string {
  const nameOf = usePartyName();
  const unechoed = (d.answer_revision ?? 0) > (d.answer_history?.length ?? 0);
  return nameOf(unechoed ? { kind: 'user', id: me } : d.answered_by);
}

// A decision that is no longer waiting: the answer on record, who gave it and
// when, every answer it replaced, and the reasoning it was asked with. When
// the answer only steered the agent (answerChangeable), Change answer opens
// the options again; a pick then shows the change whole (from, to, who hears
// it) before it goes to the asking session as one more message.
export function SettledDecision({ row, nextId, onNext }: { row: SessionDecisionItem; nextId: string | null; onNext: () => void }) {
  const Theme = useTheme();
  const router = useRouter();
  const now = useCoarseNow(60_000);
  const look = appAnswerLook(Theme);
  const me = useInboxStore((s) => String(s.currentUser?._id ?? ''));
  const nameOf = usePartyName();
  const answerer = useAnswererName(row, me);
  const timeline = useMemo(() => answerTimeline(row), [row]);
  const current = timeline[0];
  const earlier = timeline.slice(1);
  const changeable = answerChangeable(row) && !row.card;
  const answer = useDecisionAnswer(row, row._id);
  const [mode, setMode] = useState<'view' | 'pick' | 'own'>('view');
  const [own, setOwn] = useState('');
  const [proposed, setProposed] = useState<DecisionAnswerInput | null>(null);
  const close = () => { setMode('view'); setProposed(null); setOwn(''); };
  const propose = (input: DecisionAnswerInput) => { if (!('dismiss' in input) && !sameAnswer(row, input)) setProposed(input); };
  const confirm = () => { if (proposed) void answer({ ...proposed, change: true } as DecisionAnswerInput); close(); };

  const dismissed = row.status === 'dismissed';
  const withdrawn = row.status === 'withdrawn';
  const state = withdrawn ? 'Withdrawn' : dismissed ? 'Dismissed' : 'Answered';
  const stateColor = withdrawn || dismissed ? Theme.textMuted : Theme.green;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: Theme.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.stateRow}>
          <View style={[styles.dot, { backgroundColor: stateColor }]} />
          <Text style={[styles.state, { color: stateColor }]}>{state}</Text>
        </View>
        <Text style={styles.question} selectable>{row.question}</Text>
        {row.session_title ? (
          <TouchableOpacity onPress={() => router.push(`/session/${row.conversation_id}`)} hitSlop={8}>
            <Text style={styles.session} numberOfLines={1}>Asked by {row.session_title} ›</Text>
          </TouchableOpacity>
        ) : null}

        {withdrawn ? <Text style={styles.muted}>The agent withdrew this question.</Text> : (
          <View style={[styles.record, { borderColor: dismissed ? Theme.borderLight : Theme.green }]} accessibilityLabel="The answer on record">
            <Text style={styles.recordLabel}>{dismissed ? 'Closed without an answer' : 'The answer'}</Text>
            {!dismissed ? <Text style={styles.recordText} selectable>{current?.label}</Text> : null}
            <Text style={styles.recordBy}>{answerer}{row.resolved_at ? ` · ${ago(now - row.resolved_at)}` : ''}</Text>
          </View>
        )}

        {!changeable && answerLockedReason(row) ? <Text style={styles.muted}>{answerLockedReason(row)}</Text> : null}
        {changeable && mode === 'view' && !proposed ? (
          <AnswerButton look={look} label={dismissed ? 'Answer it now' : 'Change answer'} onPress={() => setMode('pick')} />
        ) : null}

        {proposed ? (
          <View style={[styles.confirm, { borderColor: Theme.borderLight }]}>
            <ChangeLine label="From" value={dismissed ? 'Dismissed' : current?.label ?? ''} struck />
            <ChangeLine label="To" value={inputLabel(row, proposed)} strong />
            <ChangeLine label="Tells" value={row.session_title || 'The asking session'} />
            <AnswerButton look={look} label="Change answer" onPress={confirm} />
            <View style={styles.links}>
              <TouchableOpacity onPress={() => setProposed(null)} hitSlop={8}><Text style={styles.footerText}>Pick again</Text></TouchableOpacity>
              <TouchableOpacity onPress={close} hitSlop={8}><Text style={styles.footerText}>Cancel</Text></TouchableOpacity>
            </View>
          </View>
        ) : mode === 'pick' ? (
          <View style={styles.pick}>
            <Text style={styles.recordLabel}>New answer</Text>
            <AnswerControls decisionId={row._id} decision={{ options: row.options ?? [], form: row.form, kind: row.kind ?? 'single' }} onAnswer={propose} look={look} onRecord={row.status === 'answered' && !row.answer_text ? row.answer_index : undefined} />
            <View style={styles.links}>
              {(row.kind ?? 'single') === 'single' ? <TouchableOpacity onPress={() => setMode('own')} hitSlop={8}><Text style={styles.footerText}>Answer in your own words</Text></TouchableOpacity> : null}
              <TouchableOpacity onPress={close} hitSlop={8}><Text style={styles.footerText}>Cancel</Text></TouchableOpacity>
            </View>
          </View>
        ) : mode === 'own' ? (
          <View style={styles.pick}>
            <TextInput style={styles.input} value={own} onChangeText={setOwn} placeholder="Your answer" placeholderTextColor={Theme.inputPlaceholder} autoFocus multiline />
            {own.trim() ? <AnswerButton look={look} label="Review the change" onPress={() => propose({ text: own.trim() })} /> : null}
            <TouchableOpacity onPress={close} hitSlop={8}><Text style={styles.footerText}>Cancel</Text></TouchableOpacity>
          </View>
        ) : null}

        {earlier.length ? (
          <View style={styles.earlier}>
            <Text style={styles.recordLabel}>Earlier answers</Text>
            {earlier.map((e: AnswerEntry, i) => (
              <View key={i} style={styles.earlierRow}>
                <Text style={styles.earlierText}>{e.label}</Text>
                <Text style={styles.earlierBy}>{nameOf(e.by)} · replaced by {inSentence(nameOf(e.replacedBy ? { kind: 'user', id: e.replacedBy } : undefined))} {e.replacedAt ? ago(now - e.replacedAt) : ''}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {row.context_md ? (
          <View style={styles.pick}>
            <Text style={styles.recordLabel}>Why it was asked</Text>
            <CollapsibleBody fadeColor={Theme.bg} height={120}>
              <MarkdownContent text={row.context_md} baseStyle={styles.context} />
            </CollapsibleBody>
          </View>
        ) : null}

        {nextId ? (
          <TouchableOpacity onPress={onNext} hitSlop={8} style={styles.next}>
            <Text style={[styles.footerText, { color: Theme.blue }]}>Next open decision ›</Text>
          </TouchableOpacity>
        ) : null}
        <DecisionThread decisionId={row._id} conversationId={row.conversation_id} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const ago = (ms: number) => (ms < 60_000 ? 'just now' : `${ageShort(ms)} ago`);

/** A name mid-sentence: "You" and "A teammate" lower their first letter, a person's name keeps it. */
const inSentence = (n: string) => (n === 'You' || n === 'Someone' || n.startsWith('A ') ? n[0].toLowerCase() + n.slice(1) : n);

function ChangeLine({ label, value, struck, strong }: { label: string; value: string; struck?: boolean; strong?: boolean }) {
  return (
    <View style={styles.changeLine}>
      <Text style={styles.changeKey}>{label}</Text>
      <Text style={[styles.changeValue, struck && styles.struck, strong && styles.strong]} numberOfLines={3}>{value}</Text>
    </View>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  body: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.xxxl * 2 },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  state: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  question: { fontSize: 19, lineHeight: 26, color: Theme.text, fontWeight: '600' },
  session: { fontSize: 12, color: Theme.textMuted0 },
  muted: { fontSize: 13, color: Theme.textMuted },
  record: { borderLeftWidth: 3, paddingLeft: Spacing.md, paddingVertical: 2, gap: 4 },
  recordLabel: { fontSize: 11, fontWeight: '700', color: Theme.textMuted, textTransform: 'uppercase', letterSpacing: 0.6 },
  recordText: { fontSize: 16, lineHeight: 23, color: Theme.text, fontWeight: '500' },
  recordBy: { fontSize: 12, color: Theme.textMuted },
  confirm: { borderWidth: 1, borderRadius: BorderRadius.lg, padding: Spacing.md, gap: Spacing.sm, backgroundColor: Theme.card },
  changeLine: { flexDirection: 'row', gap: Spacing.md },
  changeKey: { width: 44, fontSize: 13, color: Theme.textMuted0 },
  changeValue: { flex: 1, fontSize: 14, lineHeight: 20, color: Theme.textSecondary },
  struck: { textDecorationLine: 'line-through', color: Theme.textMuted },
  strong: { color: Theme.text, fontWeight: '600' },
  pick: { gap: Spacing.sm },
  links: { flexDirection: 'row', justifyContent: 'space-between', marginTop: Spacing.xs },
  footerText: { fontSize: 14, color: Theme.textMuted },
  input: { fontSize: 15, color: Theme.text, backgroundColor: Theme.card, borderWidth: 1, borderColor: Theme.borderLight, borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md, paddingVertical: 10, minHeight: 48, textAlignVertical: 'top' },
  earlier: { gap: Spacing.sm, marginTop: Spacing.sm },
  earlierRow: { gap: 2 },
  earlierText: { fontSize: 14, color: Theme.textMuted, textDecorationLine: 'line-through' },
  earlierBy: { fontSize: 12, color: Theme.textMuted0 },
  context: { fontSize: 14, lineHeight: 21, color: Theme.textSecondary },
  next: { marginTop: Spacing.md },
}));

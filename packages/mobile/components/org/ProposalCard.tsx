// A staffing proposal written alone on its line (`op-N`), drawn the way the
// web transcript draws it (web components/org/ProposalCard.tsx): its title,
// what waits and who proposed it, the author's letter, the totals, then one
// entry per subject with Accept and Adjust (Reject is inside Adjust), and
// Accept the rest. The rules are the web's (proposalLedgerModel,
// proposalSubjects): an answer fires nothing, it waits in this
// conversation's batch, and the send (this card's, or the composer's)
// applies the acceptances and tells the agent the rest in words.
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Text, TextInput } from '@/components/Themed';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { CollapsibleBody } from '@/components/CollapsibleBody';
import { themedStyles, useTheme } from '@/constants/Theme';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { findEntityInStore } from '@codecast/web/lib/liveEntities';
import { useSyncOrgProposal } from '@codecast/web/hooks/useSyncOrgProposals';
import { useProposalChanges } from '@codecast/web/components/org/proposalHooks';
import { batchSendWords } from '@codecast/web/lib/reviewActions';
import { ledgerLines, newRolesLedger } from '@codecast/web/components/consequential/roleOnline';
import { changeReply, fieldText, proposalProgressWords, subjectStatusWords, type RecordGroupCard, type SubjectCard } from '@codecast/web/components/org/proposalSubjects';
import {
  FIELD_ASKS, cardRef, groupRef, newRolesOf, stagedWords, useAcceptRest, useCardAnswer, useEntryAnswer, useProposalEntries,
  type BatchEntry, type HireReview, type Proposal, type ProposalBatch, type SubjectAnswer,
} from '@codecast/web/components/org/proposalLedgerModel';
import { ORG_REPLY_WORDS, isOrgChangeApprovable, type OrgReplyVerdict } from '@codecast/shared/contracts/orgProposal';
import type { ChangeField } from '@codecast/shared/contracts/orgChangeWords';
import type { OrgProposalChange, OrgProposalListRow } from '@codecast/web/components/org/orgStaffingTypes';
import { appAlert } from '@/lib/popups';

/** The conversation whose send carries a proposal's answers, and whether this
 *  viewer can send there. Absent (a share, a chat room): cards read only. */
export const ProposalBatchContext = createContext<{ conversationId: string; canSend: boolean; send: () => void } | null>(null);

function useBatch(): ProposalBatch & { send?: () => void } {
  const ctx = useContext(ProposalBatchContext);
  const key = ctx?.canSend ? ctx.conversationId : null;
  const comments = useInboxStore((s) => (key ? s.reviewComments[key] : undefined));
  return { key, comments, send: key ? ctx!.send : undefined };
}

/** The phone's confirm before a new role comes online: the same ledger the web's review draws, as an alert. */
function useHireConfirm(): HireReview {
  const host = useInboxStore((s) => (s.currentUser as { name?: string } | null)?.name ?? 'The approver');
  return (roles, go) => {
    const l = newRolesLedger(roles, host);
    appAlert(l.name, ledgerLines(l).join('\n'), [{ text: l.keep ?? 'Not yet', style: 'cancel' }, { text: l.confirm, onPress: go }]);
  };
}

/** `op-N` alone on its line. `op-N#k` stays a pill, as on the web. */
export function ProposalCard({ refId }: { refId: string }) {
  const Theme = useTheme();
  const feed = useSyncOrgProposal(refId);
  const row = useInboxStore((s) => findEntityInStore(s, 'proposal', refId)) as OrgProposalListRow | undefined;
  const changes = useProposalChanges(row?._id);
  if (!row) {
    return (
      <View style={styles.card}>
        <Text style={styles.meta}>{feed.missing ? `${refId} is not available` : `Loading ${refId}…`}</Text>
      </View>
    );
  }
  return (
    <View style={styles.card} accessibilityLabel={`Proposal: ${row.title}`}>
      <View style={styles.head}>
        <Feather name="share-2" size={13} color={Theme.violet} style={{ marginTop: 3 }} />
        <Text style={styles.title}>{row.title}</Text>
      </View>
      {changes.length === 0 ? <Text style={styles.meta}>Loading the changes…</Text> : <ProposalBody proposal={row} changes={changes} />}
    </View>
  );
}

function ProposalBody({ proposal, changes }: { proposal: OrgProposalListRow; changes: readonly OrgProposalChange[] }) {
  const Theme = useTheme();
  const entries = useProposalEntries(proposal, changes);
  const batch = useBatch();
  const review = useHireConfirm();
  const open = proposal.status === 'open';
  const total = proposal.counts?.total ?? 0;
  const progress = proposal.status === 'withdrawn' ? 'withdrawn'
    : proposalProgressWords(entries.cards, entries.records ? changes : undefined) || (total ? `${total} ${total === 1 ? 'change' : 'changes'}` : 'proposal');
  const totals = entries.records && entries.groups.length === 1 ? null : entries.totals.line;
  const summary = proposal.summary_md?.trim();
  const list: BatchEntry[] = entries.records
    ? entries.groups.map((g) => ({ waiting: g.waiting, ref: groupRef(proposal, g), changes: [] }))
    : entries.cards.map((c, i) => ({ waiting: c.waiting, ref: cardRef(proposal, c, i + 1), changes: c.changes }));
  const rest = useAcceptRest(list, batch, review);
  const waiting = list.filter((e) => e.waiting > 0).length;
  const answerable = !!batch.key && open && waiting > 0;
  const mine = (batch.comments ?? []).filter((c) => c.proposal?.id === proposal._id);
  const send = batchSendWords(mine);
  const decided = list.some((e) => e.waiting === 0);
  const restLabel = rest.answers.length === 0 && !decided ? `${ORG_REPLY_WORDS.approve.act} all ${rest.rest.length}` : `${ORG_REPLY_WORDS.approve.act} the rest`;
  const outcome = proposal.status === 'withdrawn' ? 'Withdrawn' : waiting === 0 ? proposalProgressWords(entries.cards, entries.records ? changes : undefined) || 'Nothing to decide' : null;
  const lone = entries.cards.length === 1;

  return (
    <View>
      <Text style={styles.meta}>
        {progress.split(' · ').join('  ·  ')}
        {proposal.author?.name ? <Text style={styles.metaDim}>{`  ·  from ${proposal.author.name}`}</Text> : null}
      </Text>
      {summary ? (
        <View style={{ marginTop: 8 }}>
          <CollapsibleBody fadeColor={Theme.card} height={84} labels={['Read the rest', 'Show less']}>
            <MarkdownContent text={summary} baseStyle={styles.summary} />
          </CollapsibleBody>
        </View>
      ) : null}
      {totals ? <Text style={[styles.metaDim, { marginTop: 8 }]}>{totals}</Text> : null}
      <View style={{ marginTop: 6 }}>
        {entries.records
          ? entries.groups.map((g) => <GroupEntry key={g.key} proposal={proposal} batch={batch} group={g} />)
          : entries.cards.map((card, i) => <SubjectEntry key={card.key} proposal={proposal} batch={batch} card={card} ordinal={lone ? undefined : i + 1} review={review} why={!(lone && summary)} />)}
      </View>
      {!batch.key && open && waiting > 0 ? (
        <Text style={[styles.metaDim, { marginTop: 8 }]}>Open this in {proposal.author?.name ? `${proposal.author.name}'s` : "the author's"} thread to answer.</Text>
      ) : null}
      {(answerable && list.length > 1 && (rest.rest.length > 0 || rest.pressed)) || outcome ? (
        <View style={styles.foot}>
          {outcome ? <Text style={styles.metaDim}>{outcome}</Text> : <View />}
          {answerable && list.length > 1 && (rest.rest.length > 0 || rest.pressed) ? (
            <Word label={restLabel} pressed={rest.pressed} onPress={() => rest.press(false)} />
          ) : null}
        </View>
      ) : null}
      {send.head && batch.send ? (
        <View style={styles.sendRow}>
          <Text style={[styles.metaDim, { flex: 1 }]}>{send.head}</Text>
          <Pressable accessibilityRole="button" onPress={batch.send} style={[styles.sendButton, { backgroundColor: Theme.violet }]}>
            <Text style={styles.sendText}>{send.button ?? 'Send'}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/** One subject: its sentence, the fields it moves (folded), why, and the answer. */
function SubjectEntry({ proposal, batch, card, ordinal, review, why }: { proposal: Proposal; batch: ProposalBatch; card: SubjectCard; ordinal?: number; review: HireReview; why: boolean }) {
  const { answer, onAnswer, revised } = useCardAnswer(proposal, batch.key, batch.comments, card, ordinal);
  const roles = newRolesOf(card.changes);
  // Approving a new role starts its standing session: the confirm comes first.
  const put = onAnswer && proposal.status === 'open'
    ? (a: SubjectAnswer | null) => (a?.verdict === 'approve' && answer?.verdict !== 'approve' && roles.length ? review(roles, () => onAnswer(a)) : onAnswer(a))
    : undefined;
  const members = [...card.changes, ...card.carried, ...card.riders];
  const reply = card.reply ?? (card.changes[0] ? changeReply(card.changes[0]) : null);
  return (
    <Entry
      ordinal={ordinal}
      sentence={card.sentence}
      span={card.subjectSpan}
      settled={card.waiting === 0}
      state={subjectStatusWords(card)}
      revised={revised}
      canAccept={members.some((c) => isOrgChangeApprovable(c.status))}
      answer={answer}
      onAnswer={card.waiting > 0 ? put : undefined}
      stored={reply?.text?.trim() ? reply.text : null}
      notes={[...new Set(card.failed.map((f) => f.note))]}
      details={card.rows.filter((r) => r.op !== 'same').length > 0 || (why && card.reasons.length > 0)
        ? <Details rows={card.rows} reasons={why ? card.reasons : []} />
        : null}
    />
  );
}

/** A records proposal's group (many tasks or plans at once): its title, its totals, and one answer for all of them. */
function GroupEntry({ proposal, batch, group }: { proposal: Proposal; batch: ProposalBatch; group: RecordGroupCard }) {
  const { answer, onAnswer, revised } = useEntryAnswer(batch.key, batch.comments, groupRef(proposal, group), group.rows.map((r) => r.change));
  return (
    <Entry
      sentence={group.title}
      span={[0, group.title.length]}
      settled={group.waiting === 0}
      state={group.totals}
      revised={revised}
      canAccept={group.rows.some((r) => isOrgChangeApprovable(r.status))}
      answer={answer}
      onAnswer={group.waiting > 0 && proposal.status === 'open' ? onAnswer : undefined}
      stored={group.reply?.text?.trim() ? group.reply.text : null}
      notes={[]}
      details={<Text style={styles.metaDim}>{group.totals}</Text>}
    />
  );
}

function Entry({ ordinal, sentence, span, settled, state, revised, canAccept, answer, onAnswer, stored, notes, details }: {
  ordinal?: number;
  sentence: string;
  span: [number, number] | null;
  settled: boolean;
  state: string;
  revised: boolean;
  canAccept: boolean;
  answer: SubjectAnswer | null;
  onAnswer?: (a: SubjectAnswer | null) => void;
  stored: string | null;
  notes: string[];
  details: ReactNode;
}) {
  const Theme = useTheme();
  const [open, setOpen] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const staged = !!answer && !!onAnswer;
  const verdict: OrgReplyVerdict = answer?.verdict ?? 'note';
  const closeField = () => { setOpen(false); if (answer?.verdict === 'note' && !answer.text?.trim()) onAnswer?.(null); };
  const [lead, after] = span ? [sentence.slice(0, span[0]), sentence.slice(span[1])] : [sentence, ''];
  const name = span ? sentence.slice(span[0], span[1]) : '';
  const [bandHead, bandTail] = answer ? stagedWords(answer) : ['', ''];
  const bandColor = answer?.verdict === 'approve' ? Theme.green : answer?.verdict === 'reject' ? Theme.red : Theme.textMuted;

  return (
    <View style={[styles.entry, ordinal != null && styles.entryRule]}>
      <View style={styles.entryHead}>
        {ordinal != null ? <Text style={styles.ordinal}>{ordinal}</Text> : null}
        <Pressable style={{ flex: 1 }} onPress={details ? () => setShowDetails((v) => !v) : undefined} accessibilityRole={details ? 'button' : undefined}>
          <Text style={[styles.sentence, settled && { color: Theme.textMuted }]}>
            {lead}<Text style={{ fontWeight: '700' }}>{name}</Text>{after}
            {details ? <Text style={styles.metaDim}>{showDetails ? '  ▴' : '  ▾'}</Text> : null}
          </Text>
        </Pressable>
      </View>
      <View style={ordinal != null ? styles.indent : undefined}>
        {revised ? <Text style={[styles.metaDim, { color: Theme.violet, marginTop: 4 }]}>Revised since you last looked</Text> : null}
        {notes.map((n) => <Text key={n} style={[styles.metaDim, { color: Theme.red, marginTop: 4 }]}>{n}</Text>)}
        {showDetails ? <View style={{ marginTop: 6 }}>{details}</View> : null}
        {!staged && stored ? <Text style={[styles.you, { marginTop: 6 }]}><Text style={styles.metaDim}>You: </Text>{stored}</Text> : null}
        {staged ? (
          <View style={[styles.band, { backgroundColor: bandColor + '14' }]}>
            <Text style={[styles.bandText, { flex: 1 }]}>
              <Text style={{ color: bandColor, fontWeight: '600' }}>{bandHead}</Text> {bandTail}
            </Text>
            <Pressable hitSlop={8} onPress={() => { onAnswer!(null); setOpen(false); }} accessibilityRole="button" accessibilityLabel="Undo this answer">
              <Text style={styles.metaDim}>Undo</Text>
            </Pressable>
          </View>
        ) : null}
        {staged && !open && answer?.text?.trim() ? (
          <Pressable onPress={() => setOpen(true)}><Text style={[styles.you, { marginTop: 4 }]}><Text style={styles.metaDim}>You: </Text>{answer.text}</Text></Pressable>
        ) : null}
        {open && onAnswer ? (
          <View style={{ marginTop: 8, gap: 6 }}>
            <TextInput
              autoFocus
              multiline
              value={answer?.text ?? ''}
              placeholder={FIELD_ASKS[verdict]}
              onChangeText={(t) => onAnswer({ ...answer, verdict, text: t })}
              onBlur={closeField}
              style={styles.field}
            />
            <View style={styles.fieldRow}>
              {verdict !== 'approve' ? (
                <Word
                  label={ORG_REPLY_WORDS.reject.act}
                  pressed={verdict === 'reject'}
                  tone={Theme.red}
                  onPress={() => onAnswer({ verdict: verdict === 'reject' ? 'note' : 'reject', ...(answer?.text ? { text: answer.text } : {}) })}
                />
              ) : <View />}
              <Word label="Done" onPress={closeField} />
            </View>
          </View>
        ) : null}
        {settled || !onAnswer ? (
          <Text style={[styles.metaDim, { marginTop: 6 }]}>{state}</Text>
        ) : !staged && !open ? (
          <View style={styles.controls}>
            <Pressable accessibilityRole="button" onPress={() => setOpen(true)} style={[styles.button, { borderColor: Theme.borderLight }]}>
              <Feather name="edit-3" size={12} color={Theme.textMuted} />
              <Text style={styles.buttonText}>{ORG_REPLY_WORDS.note.act}</Text>
            </Pressable>
            {canAccept ? (
              <Pressable accessibilityRole="button" onPress={() => onAnswer({ verdict: 'approve' })} style={[styles.button, { backgroundColor: Theme.green, borderColor: Theme.green }]}>
                <Feather name="check" size={12} color="#fff" />
                <Text style={[styles.buttonText, { color: '#fff' }]}>{ORG_REPLY_WORDS.approve.act}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** What a change moves, one field a line (before, then after), and why. */
function Details({ rows, reasons }: { rows: readonly ChangeField[]; reasons: readonly string[] }) {
  const Theme = useTheme();
  const shown = useMemo(() => rows.filter((r) => r.op !== 'same'), [rows]);
  const value = (f: ChangeField, side: 'before' | 'after') => {
    const v = f[side];
    if (!v) return null;
    if (f.kind === 'list') return v.items?.join(', ') ?? v.text;
    if (f.kind === 'measures') return (v.measures ?? []).map((m) => (m.target ? `${m.name}, target ${m.target}` : m.name)).join('\n');
    return fieldText(v) ?? null;
  };
  return (
    <View style={{ gap: 4 }}>
      {shown.map((f) => {
        const before = value(f, 'before');
        const after = value(f, 'after');
        const gone = !!f.before && !f.before.none && (f.op === 'change' || f.op === 'clear');
        return (
          <Text key={`${f.seq}:${f.key}`} style={styles.fieldLine}>
            <Text style={styles.metaDim}>{f.label}  </Text>
            {before ? <Text style={[{ color: Theme.textMuted }, gone && { textDecorationLine: 'line-through' }]} numberOfLines={3}>{before}</Text> : null}
            {before && after ? <Text style={styles.metaDim}>{'  →  '}</Text> : null}
            {after ? <Text numberOfLines={4}>{after}</Text> : null}
          </Text>
        );
      })}
      {reasons.length ? (
        <Text style={styles.fieldLine}>
          <Text style={styles.metaDim}>Why  </Text>
          <Text style={{ color: Theme.textSecondary }}>{reasons.join('\n')}</Text>
        </Text>
      ) : null}
    </View>
  );
}

function Word({ label, pressed, tone, onPress }: { label: string; pressed?: boolean; tone?: string; onPress: () => void }) {
  const Theme = useTheme();
  const color = tone ?? (pressed ? Theme.violet : Theme.textMuted);
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: !!pressed }} hitSlop={8} onPress={onPress} style={[styles.word, pressed && { backgroundColor: color + '1a' }]}>
      {pressed ? <Feather name="check" size={11} color={color} /> : null}
      <Text style={[styles.wordText, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  card: {
    backgroundColor: Theme.card,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    borderLeftWidth: 2,
    borderLeftColor: Theme.violet,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  head: { flexDirection: 'row', gap: 8 },
  title: { flex: 1, fontSize: 15, lineHeight: 21, fontWeight: '600', color: Theme.text },
  meta: { fontSize: 12, lineHeight: 17, color: Theme.textMuted, marginTop: 3 },
  metaDim: { fontSize: 12, lineHeight: 17, color: Theme.textDim },
  summary: { fontSize: 13.5, lineHeight: 20, color: Theme.textSecondary },
  entry: { paddingVertical: 10 },
  entryRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight },
  entryHead: { flexDirection: 'row', gap: 8 },
  ordinal: { width: 14, fontSize: 11, lineHeight: 20, color: Theme.textDim, fontVariant: ['tabular-nums'] },
  indent: { paddingLeft: 22 },
  sentence: { fontSize: 14, lineHeight: 20, color: Theme.text },
  you: { fontSize: 13, lineHeight: 19, color: Theme.text },
  controls: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 8 },
  button: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 7, paddingHorizontal: 12, paddingVertical: 7 },
  buttonText: { fontSize: 13, fontWeight: '600', color: Theme.text },
  band: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 7, paddingHorizontal: 10, paddingVertical: 7, marginTop: 8 },
  bandText: { fontSize: 12.5, lineHeight: 18, color: Theme.textSecondary },
  field: { minHeight: 56, fontSize: 13.5, lineHeight: 19, color: Theme.text, borderWidth: 1, borderColor: Theme.borderLight, borderRadius: 7, paddingHorizontal: 10, paddingVertical: 8, textAlignVertical: 'top' },
  fieldRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fieldLine: { fontSize: 12.5, lineHeight: 18, color: Theme.text },
  foot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight, paddingTop: 8, marginTop: 2 },
  word: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5 },
  wordText: { fontSize: 13 },
  sendRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  sendButton: { borderRadius: 7, paddingHorizontal: 12, paddingVertical: 7 },
  sendText: { fontSize: 13, fontWeight: '600', color: '#fff' },
}));

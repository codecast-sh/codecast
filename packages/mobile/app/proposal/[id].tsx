// One org proposal on the phone, the twin of the web's org page with the
// proposal open (/org?proposal=op-N): what it changes in the org's structure
// (each role it adds, moves or retires, who it reports to before and after,
// and what it looks after), its status and author, then every change with its
// answer, the same ledger a proposal card draws in a transcript.
//
// Answers collect in this screen's own batch and nothing is decided on a
// press; the Send asks first, then applies them through the same path the web
// uses for a surface with no composer (takeProposalAnswers with `say`), and
// the words go into the author's thread. Only an admin of the proposal's
// workspace (or a personal workspace's owner) gets the answer controls.
import { useMemo } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme, CHROME_FONT_CAP } from '@/constants/Theme';
import { FactChip, ObjectHeader, ObjectMissing, SectionLabel } from '@/components/objects/ObjectParts';
import { ProposalBatchContext, ProposalBody } from '@/components/org/ProposalCard';
import { RoleFace } from '@/components/org/RoleFace';
import { appAlert } from '@/lib/popups';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { findEntityInStore } from '@codecast/web/lib/liveEntities';
import { batchSendWords, takeProposalAnswers } from '@codecast/web/lib/reviewActions';
import { useSyncOrgProposal } from '@codecast/web/hooks/useSyncOrgProposals';
import { useProposalChanges, useProposalTree } from '@codecast/web/components/org/proposalHooks';
import { useProposalEntries } from '@codecast/web/components/org/proposalLedgerModel';
import { proposalProgressWords } from '@codecast/web/components/org/proposalSubjects';
import { ghostsFor } from '@codecast/web/components/org/orgGhostsFor';
import { roleNodeId } from '@codecast/web/components/org/orgLayout';
import { parentName } from '@codecast/web/components/org/orgMeta';
import type { OrgProposalChange, OrgProposalListRow } from '@codecast/web/components/org/orgStaffingTypes';
import type { OrgRole, OrgTree } from '@codecast/web/components/org/orgTypes';

type Shift = { key: string; role: OrgRole; kind: 'new' | 'move' | 'retire' | 'change'; accepted: boolean; before: string | null; after: string | null; notes: string[] };

/** The structure a proposal changes, one row per role it touches: its reporting line before and after, and the rest of what it changes there. */
function structureOf(tree: OrgTree, changes: readonly OrgProposalChange[]): Shift[] {
  const plan = ghostsFor(tree, changes);
  const m = plan.merged;
  const byNode = new Map(m.roles.map((r) => [roleNodeId(r._id), r]));
  const out = new Map<string, Shift>();
  const shift = (nodeId: string, kind: Shift['kind'], accepted = false): Shift | null => {
    const role = byNode.get(nodeId);
    if (!role) return null;
    const s = out.get(nodeId) ?? { key: nodeId, role, kind, accepted, before: null, after: null, notes: [] };
    if (kind !== 'change') s.kind = kind;
    out.set(nodeId, s);
    return s;
  };
  for (const [nodeId, stub] of Object.entries(plan.stubs)) {
    if (stub.kind !== 'role') continue;
    const s = shift(nodeId, 'new', stub.solid);
    if (s) s.after = parentName(m, s.role.reports_to);
  }
  for (const mv of plan.moves) {
    const s = shift(mv.nodeId, 'move');
    if (s) { s.before = parentName(m, mv.from); s.after = parentName(m, mv.to); }
  }
  for (const nodeId of Object.keys(plan.retires)) {
    const s = shift(nodeId, 'retire');
    if (s) s.before = parentName(m, s.role.reports_to);
  }
  for (const [nodeId, chips] of Object.entries(plan.chips)) {
    const s = shift(nodeId, 'change');
    if (s) s.notes.push(...chips.filter((c) => c.kind !== 'move').map((c) => c.line));
  }
  const order = { new: 0, move: 1, retire: 2, change: 3 };
  return [...out.values()].sort((a, b) => order[a.kind] - order[b.kind]);
}

/** What a role looks after: the projects and plans in its scope, else its charter's first line. */
function looksAfter(role: OrgRole): string | null {
  const names = [...role.scope_names.projects.map((p) => p.title), ...role.scope_names.plans.map((p) => p.short_id ?? p.title)];
  if (names.length) return names.join(', ');
  return (role.charter ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? null;
}

export default function ProposalScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const { id: rawId } = useLocalSearchParams<{ id: string; focus?: string }>();
  const id = rawId?.trim().toLowerCase() ?? '';
  const feed = useSyncOrgProposal(id || null);
  const row = useInboxStore((s) => (id ? findEntityInStore(s, 'proposal', id) : undefined)) as OrgProposalListRow | undefined;
  const changes = useProposalChanges(row?._id);
  const tree = useProposalTree(row);
  const entries = useProposalEntries(row, changes);
  const structure = useMemo(() => (tree && changes.length ? structureOf(tree, changes) : []), [tree, changes]);

  if (!row) return <ObjectMissing what="Proposal" id={id || rawId} loading={!feed.missing} />;

  const me = tree?.people.find((p) => p.is_me);
  const mayDecide = !!tree && (tree.workspace.kind === 'user' || me?.role === 'admin' || me?.role === 'owner');
  const open = row.status === 'open';
  const batchKey = `proposal:${row._id}`;
  const thread = row.thread?.conversation_id ?? null;
  const total = row.counts?.total ?? changes.length;
  const progress = row.status === 'withdrawn' ? 'Withdrawn' : proposalProgressWords(entries.cards, entries.records ? changes : undefined) || (total ? `${total} ${total === 1 ? 'change' : 'changes'}` : '');
  const status = row.status === 'open'
    ? { label: 'Open', color: Theme.yellow, icon: 'circle-o' as const }
    : row.status === 'resolved' ? { label: 'Resolved', color: Theme.green, icon: 'check' as const } : { label: 'Withdrawn', color: Theme.textMuted, icon: 'ban' as const };
  const author = row.author;
  const authorRoute = author?.kind === 'role' && author.short_id ? `/org/${author.short_id}` : author?.kind === 'session' ? `/session/${author.short_id ?? author.id}` : null;

  // Applying answers changes the org for real: the press says what it applies, and asks.
  const send = () => {
    const mine = (useInboxStore.getState().reviewComments[batchKey] ?? []).filter((c: any) => c.proposal?.id === row._id);
    const words = batchSendWords(mine);
    if (!words.head) return;
    appAlert(`${row.short_id}: ${row.title}`, `${words.head}.${thread ? `\n\nYour answers also go to ${author?.name ?? 'the author'}'s thread.` : ''}`, [
      { text: 'Not yet', style: 'cancel' },
      {
        text: words.button ?? 'Send',
        onPress: () => {
          takeProposalAnswers(batchKey, { proposalId: row._id, ...(thread ? { say: { thread, client_id: `optimistic_${Date.now()}_${Math.random().toString(36).slice(2)}` } } : {}) });
        },
      },
    ]);
  };
  const readonlyWords = !open ? undefined : !tree ? 'Switch to the workspace it belongs to to answer it.' : !mayDecide ? 'Only a team admin can decide this proposal.' : undefined;

  return (
    <>
      <ObjectHeader type="proposal" shortId={row.short_id} title={row.title} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content} testID="proposal-screen">
        <RNText style={styles.title}>{row.title}</RNText>
        <RNView style={styles.chips}>
          <FactChip icon={status.icon} label={status.label} color={status.color} testID={`proposal-status-${row.status}`} />
          {progress && progress !== 'Withdrawn' ? <FactChip label={progress} color={Theme.textMuted} /> : null}
        </RNView>

        <RNView style={styles.card}>
          {author ? (
            <LinkLine
              icon={author.kind === 'role' ? 'users' : author.kind === 'session' ? 'message-square' : 'user'}
              label={row.applied_by_author ? 'Applied by' : 'From'}
              value={author.name ?? author.title ?? author.short_id ?? 'Someone'}
              onPress={authorRoute ? () => router.push(authorRoute as never) : undefined}
            />
          ) : null}
          {thread ? <LinkLine icon="message-circle" label="Thread" value={`Talk to ${author?.name ?? 'the author'} about it`} rule onPress={() => router.push(`/session/${thread}` as never)} testID="proposal-thread" /> : null}
          {row.supersedes ? <LinkLine icon="corner-up-left" label="Replaces" value={row.supersedes.short_id} rule onPress={() => router.push(`/proposal/${row.supersedes!.short_id}` as never)} /> : null}
          {row.superseded_by ? <LinkLine icon="corner-down-right" label="Replaced by" value={row.superseded_by.short_id} tone={Theme.orange} rule onPress={() => router.push(`/proposal/${row.superseded_by!.short_id}` as never)} /> : null}
          <LinkLine icon="clock" label="Posted" value={new Date(row.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} rule />
        </RNView>

        {structure.length ? (
          <RNView style={styles.section}>
            <SectionLabel>{open ? 'The org after it' : 'What it changed'}</SectionLabel>
            <RNView style={styles.list}>
              {structure.map((s, i) => <ShiftRow key={s.key} shift={s} first={i === 0} onOpen={s.kind === 'new' ? undefined : () => router.push(`/org/${s.role.short_id}` as never)} />)}
            </RNView>
          </RNView>
        ) : null}

        <RNView style={styles.section}>
          <SectionLabel>{`Changes · ${total}`}</SectionLabel>
          <RNView style={styles.ledger}>
            {changes.length === 0 ? <RNText style={styles.dim}>{feed.ready ? 'No changes in it.' : 'Loading the changes…'}</RNText> : (
              <ProposalBatchContext.Provider value={{ conversationId: batchKey, canSend: mayDecide && open, send }}>
                <ProposalBody proposal={row} changes={changes} bare readonlyWords={readonlyWords} />
              </ProposalBatchContext.Provider>
            )}
          </RNView>
        </RNView>
      </ScrollView>
    </>
  );
}

const SHIFT_LOOK = { new: { word: 'New', key: 'green' }, move: { word: 'Moves', key: 'violet' }, retire: { word: 'Retires', key: 'red' }, change: { word: 'Changes', key: 'cyan' } } as const;

function ShiftRow({ shift: s, first, onOpen }: { shift: Shift; first: boolean; onOpen?: () => void }) {
  const Theme = useTheme();
  const look = SHIFT_LOOK[s.kind];
  const color = Theme[look.key];
  const after = looksAfter(s.role);
  const body = (
    <>
      <RoleFace role={s.role} size={34} style={s.kind === 'retire' ? { opacity: 0.5 } : undefined} />
      <RNView style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <RNView style={styles.shiftHead}>
          <RNText style={[styles.roleName, s.kind === 'retire' && styles.struck]} numberOfLines={1}>{s.role.name}</RNText>
          <RNText style={styles.handle} numberOfLines={1}>@{s.role.handle}</RNText>
          <RNView style={[styles.badge, { backgroundColor: color + '1c' }]}>
            <RNText style={[styles.badgeText, { color }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{s.accepted ? `${look.word} · accepted` : look.word}</RNText>
          </RNView>
        </RNView>
        {s.before || s.after ? (
          <RNText style={styles.line}>
            <RNText style={styles.lineLabel}>Reports to  </RNText>
            {s.before ? <RNText style={s.after ? styles.struckDim : undefined}>{s.before}</RNText> : null}
            {s.before && s.after ? <RNText style={styles.lineLabel}>{'  →  '}</RNText> : null}
            {s.after ? <RNText style={{ color: Theme.text, fontWeight: '600' }}>{s.after}</RNText> : null}
            {s.kind === 'retire' ? <RNText style={styles.lineLabel}>{'  ·  its reports move up'}</RNText> : null}
          </RNText>
        ) : null}
        {after ? <RNText style={styles.line} numberOfLines={3}><RNText style={styles.lineLabel}>Looks after  </RNText>{after}</RNText> : null}
        {s.notes.map((n) => <RNText key={n} style={styles.note}>{n}</RNText>)}
      </RNView>
      {onOpen ? <Feather name="chevron-right" size={14} color={Theme.textDim} style={{ marginTop: 10 }} /> : null}
    </>
  );
  return onOpen
    ? <TouchableOpacity style={[styles.shift, !first && styles.rule]} onPress={onOpen} activeOpacity={0.6} testID={`proposal-shift-${s.role.handle}`}>{body}</TouchableOpacity>
    : <RNView style={[styles.shift, !first && styles.rule]} testID={`proposal-shift-${s.role.handle}`}>{body}</RNView>;
}

function LinkLine({ icon, label, value, tone, rule, onPress, testID }: { icon: React.ComponentProps<typeof Feather>['name']; label: string; value: string; tone?: string; rule?: boolean; onPress?: () => void; testID?: string }) {
  const Theme = useTheme();
  const body = (
    <>
      <Feather name={icon} size={13} color={tone ?? Theme.textMuted} style={{ width: 16 }} />
      <RNText style={styles.linkLabel} maxFontSizeMultiplier={CHROME_FONT_CAP}>{label}</RNText>
      <RNText style={[styles.linkValue, tone ? { color: tone } : null]} numberOfLines={1}>{value}</RNText>
      {onPress ? <Feather name="chevron-right" size={14} color={Theme.textDim} /> : null}
    </>
  );
  return onPress
    ? <TouchableOpacity style={[styles.linkRow, rule && styles.rule]} onPress={onPress} activeOpacity={0.6} testID={testID}>{body}</TouchableOpacity>
    : <RNView style={[styles.linkRow, rule && styles.rule]}>{body}</RNView>;
}

const styles = themedStyles((Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.bg },
  content: { padding: Spacing.lg, paddingBottom: 56 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700', color: Theme.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10, marginBottom: Spacing.lg },
  card: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, backgroundColor: Theme.card, overflow: 'hidden' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 11 },
  linkLabel: { width: 86, fontSize: 12.5, color: Theme.textMuted0 },
  linkValue: { flex: 1, fontSize: 14, color: Theme.text },
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight },
  section: { marginTop: 26 },
  list: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, backgroundColor: Theme.card, overflow: 'hidden' },
  shift: { flexDirection: 'row', gap: 12, paddingHorizontal: 12, paddingVertical: 12 },
  shiftHead: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  roleName: { fontSize: 15, fontWeight: '700', color: Theme.text, flexShrink: 1 },
  handle: { fontSize: 12, color: Theme.violet },
  badge: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  line: { fontSize: 13, lineHeight: 19, color: Theme.textSecondary },
  lineLabel: { color: Theme.textMuted0, fontWeight: '400' },
  note: { fontSize: 12.5, lineHeight: 18, color: Theme.textMuted },
  struck: { textDecorationLine: 'line-through', color: Theme.textMuted },
  struckDim: { textDecorationLine: 'line-through', color: Theme.textMuted },
  ledger: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, backgroundColor: Theme.card, paddingHorizontal: 12, paddingVertical: 6 },
  dim: { fontSize: 13, color: Theme.textMuted, paddingVertical: 8 },
}));

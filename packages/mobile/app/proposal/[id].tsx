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
import { themedStyles, useTheme, CHROME_FONT_CAP } from '@/constants/Theme';
import { FactChip, Facts, FactRow, ObjectHeader, ObjectMissing, SectionLabel, objectStyles } from '@/components/objects/ObjectParts';
import { compactAge } from '@codecast/web/lib/threadState';
import { ProposalBatchContext, ProposalBody } from '@/components/org/ProposalCard';
import { RoleFace } from '@/components/org/RoleFace';
import { appAlert } from '@/lib/popups';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { makeCollectionSig } from '@codecast/web/store/wakeSig';
import { findEntityInStore } from '@codecast/web/lib/liveEntities';
import { batchSendWords, takeProposalAnswers } from '@codecast/web/lib/reviewActions';
import { useSyncOrgProposal } from '@codecast/web/hooks/useSyncOrgProposals';
import { useOrgScope } from '@codecast/web/hooks/useSyncOrgTree';
import { useActiveWorkspaceKey } from '@codecast/web/hooks/useWorkspaceCollection';
import { proposalWorkspace } from '@codecast/web/components/org/staffingModel';
import { useProposalChanges, useProposalTree } from '@codecast/web/components/org/proposalHooks';
import { useProposalEntries } from '@codecast/web/components/org/proposalLedgerModel';
import { proposalProgressWords } from '@codecast/web/components/org/proposalSubjects';
import type { OrgProposalListRow } from '@codecast/web/components/org/orgStaffingTypes';
import { looksAfter, structureOf, type Shift } from '@/lib/proposalStructure';
import { ownProfilesOnly } from '@codecast/shared/contracts/orgPersonProfile';

export default function ProposalScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const { id: rawId } = useLocalSearchParams<{ id: string; focus?: string }>();
  const id = rawId?.trim().toLowerCase() ?? '';
  const feed = useSyncOrgProposal(id || null);
  const row = useInboxStore((s) => (id ? findEntityInStore(s, 'proposal', id) : undefined)) as OrgProposalListRow | undefined;
  const changes = useProposalChanges(row?._id);
  // A proposal of another workspace holds the org tree to its own while it is on screen (the web inbox does the
  // same for a seat of another workspace), so its structure and who may decide it read off the right org.
  const ws = row ? proposalWorkspace(row) : null;
  const wsKey = ws ? `${ws.kind}:${ws.id}` : null;
  const activeKey = useActiveWorkspaceKey();
  useOrgScope(wsKey && wsKey !== activeKey ? wsKey : null);
  const tree = useProposalTree(row);
  const entries = useProposalEntries(row, changes);
  const scope = useScopeNames();
  const structure = useMemo(() => (tree && changes.length ? structureOf(tree, changes, scope) : []), [tree, changes, scope]);

  if (!row) return <ObjectMissing what="Proposal" id={id || rawId} loading={!feed.missing} />;

  const me = tree?.people.find((p) => p.is_me);
  // A person decides the profile changes about them; everything else is an
  // admin's. The answers go as one batch, so a non-admin decides here only
  // when every live change is their own (the server's rule, ownProfilesOnly).
  const mayDecide = !!tree && (tree.workspace.kind === 'user' || me?.role === 'admin' || me?.role === 'owner' || ownProfilesOnly(me?.user_id, changes));
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
  // A proposal only about one person's profile is theirs to decide too.
  const live = changes.filter((c: any) => c.status !== 'removed');
  const subjectOf = (c: any): string | undefined => (c.change.kind === 'person_profile' ? (c.change as { user_id?: string }).user_id : undefined);
  const soleSubject = live.length && subjectOf(live[0]) && live.every((c: any) => subjectOf(c) === subjectOf(live[0]))
    ? tree?.people.find((p) => p.user_id === (live[0].change as any).user_id)?.name ?? null
    : null;
  const readonlyWords = !open ? undefined : !tree ? 'Loading who can decide it…' : !mayDecide ? (soleSubject ? `Only ${soleSubject} or a team admin can decide this.` : 'Only a team admin can decide this proposal.') : undefined;

  return (
    <>
      <ObjectHeader type="proposal" shortId={row.short_id} title={row.title} />
      <ScrollView style={objectStyles.container} contentContainerStyle={objectStyles.content} testID="proposal-screen">
        <RNText style={objectStyles.title}>{row.title}</RNText>
        <RNView style={objectStyles.chips}>
          <FactChip icon={status.icon} label={status.label} color={status.color} testID={`proposal-status-${row.status}`} />
          {progress && progress !== 'Withdrawn' ? <FactChip label={progress} color={Theme.textMuted} /> : null}
        </RNView>

        <Facts>
          {author ? (
            <FactRow
              label={row.applied_by_author ? 'Applied by' : 'From'}
              onPress={authorRoute ? () => router.push(authorRoute as never) : undefined}
            >
              {author.name ?? author.title ?? author.short_id ?? 'Someone'}
            </FactRow>
          ) : null}
          {thread && author?.kind !== 'session' ? <FactRow label="Thread" onPress={() => router.push(`/session/${thread}` as never)} testID="proposal-thread">{row.thread?.title || row.thread?.short_id || 'Open'}</FactRow> : null}
          {row.supersedes ? <ProposalLine label="Replaces" shortId={row.supersedes.short_id} /> : null}
          {row.superseded_by ? <ProposalLine label="Replaced by" shortId={row.superseded_by.short_id} tone={Theme.orange} /> : null}
          <FactRow label="Posted">
            <RNText style={styles.value}>
              {new Date(row.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
              <RNText style={styles.dimInline}>{`  ${compactAge(Math.max(0, Date.now() - row.created_at))} ago`}</RNText>
            </RNText>
          </FactRow>
        </Facts>

        {structure.length ? (
          <RNView style={objectStyles.section}>
            <SectionLabel>{open ? 'The org after it' : row.status === 'withdrawn' ? 'What it proposed' : 'What it changed'}</SectionLabel>
            <RNView style={styles.list}>
              {structure.map((s, i) => <ShiftRow key={s.key} shift={s} first={i === 0} withdrawn={row.status === 'withdrawn'} onOpen={s.kind === 'new' && !s.accepted ? undefined : () => router.push(`/org/${s.role.short_id}` as never)} />)}
            </RNView>
          </RNView>
        ) : null}

        <RNView style={objectStyles.section}>
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

type ScopeRow = { id: string; title: string; short_id?: string };
const nameSig = makeCollectionSig((r: { title?: string; short_id?: string }) => `${r.title ?? ''}|${r.short_id ?? ''}`);
const scopeRowsOf = (c: Record<string, any> | undefined): ScopeRow[] => Object.values(c ?? {}).map((r) => ({ id: r._id, title: r.title ?? '', short_id: r.short_id ?? undefined }));
/** The store's projects and plans by name, for a proposed role's scope (the web org chart passes the same rows).
 *  Every workspace's, since a proposal may belong to one the phone is not on; woken by a digest of names only. */
function useScopeNames(): { projects: ScopeRow[]; plans: ScopeRow[] } {
  const sig = useInboxStore((s) => `${nameSig(s.projects ?? {})}|${nameSig(s.plans ?? {})}`);
  return useMemo(() => {
    const s = useInboxStore.getState();
    return { projects: scopeRowsOf(s.projects), plans: scopeRowsOf(s.plans) };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
}

const SHIFT_LOOK = {
  new: { word: 'New', done: 'Added', key: 'green' },
  move: { word: 'Moves', done: 'Moved', key: 'violet' },
  retire: { word: 'Retires', done: 'Retired', key: 'red' },
  change: { word: 'Changes', done: 'Changed', key: 'cyan' },
} as const;

function ShiftRow({ shift: s, first, withdrawn, onOpen }: { shift: Shift; first: boolean; withdrawn?: boolean; onOpen?: () => void }) {
  const Theme = useTheme();
  const look = SHIFT_LOOK[s.kind];
  // A withdrawn proposal changed nothing: what it would have done reads as proposed, never as done or new.
  const color = withdrawn ? Theme.textMuted : Theme[look.key];
  // A changed role is said by what changed (its notes); its whole scope is for a role the proposal adds or moves.
  const after = s.kind === 'change' ? null : looksAfter(s.role);
  const body = (
    <>
      <RoleFace role={s.role} size={34} style={s.kind === 'retire' ? { opacity: 0.5 } : undefined} />
      <RNView style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <RNView style={styles.shiftHead}>
          <RNText style={[styles.roleName, s.kind === 'retire' && styles.struck]} numberOfLines={2}>{s.role.name}</RNText>
          <RNText style={styles.handle} numberOfLines={1}>@{s.role.handle}</RNText>
          <RNView style={[styles.badge, { backgroundColor: color + '1c' }]}>
            <RNText style={[styles.badgeText, { color }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{withdrawn ? 'Proposed' : s.accepted ? look.done : look.word}</RNText>
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

/** Another proposal of the chain, named by its title when the store holds it. */
function ProposalLine({ label, shortId, tone, rule }: { label: string; shortId: string; tone?: string; rule?: boolean }) {
  const router = useRouter();
  const title = useInboxStore((s) => (findEntityInStore(s, 'proposal', shortId) as OrgProposalListRow | undefined)?.title);
  return <FactRow label={label} tone={tone} rule={rule} onPress={() => router.push(`/proposal/${shortId}` as never)}>{title ?? shortId}</FactRow>;
}

const styles = themedStyles((Theme) => StyleSheet.create({
  value: { fontSize: 14, color: Theme.text },
  dimInline: { fontSize: 12.5, color: Theme.textMuted },
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight },
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

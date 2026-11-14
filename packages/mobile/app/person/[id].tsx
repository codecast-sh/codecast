// A person on the phone: who they are, what they are working on right now,
// and the way to reach them. The web addresses a person as /org/@<handle>
// (objectHref) and draws their activity profile at /team/<handle>; both land
// here. The id is a handle or a user id, the two forms personRefOf mints.
import { useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Ionicons } from '@expo/vector-icons';
import { teamFeatureEnabled } from '@codecast/shared/contracts';
import { personRefOf } from '@codecast/shared/entities';
import { isActiveTask } from '@codecast/shared/tasks';
import { useInboxStore, useTrackedStore, sessionsWithPendingSend, pendingSendWakeSig, teamInboxIdsOf, type TaskItem } from '@codecast/web/store/inboxStore';
import { fleetBandFor, fleetCountedSessions, fleetSessionsWakeSig } from '@codecast/web/components/fleetBands';
import { teamMembersOf } from '@codecast/web/lib/activeTeam';
import { filterToWorkspace } from '@codecast/web/lib/workspaceScope';
import { memberDisplayName, memberAvatarUrl } from '@codecast/web/lib/liveEntities';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { compactAge } from '@codecast/web/lib/threadState';
import { ORG_STATE_META, standingLineOf, standingWaits } from '@codecast/web/components/org/orgMeta';
import { ORG_STATE_ORDER, type OrgPerson, type OrgRole, type OrgSession, type OrgTree } from '@codecast/web/components/org/orgTypes';
import { localTimeLine, memberPresenceVisual, presenceLine, type PresenceVisual } from '@codecast/web/components/presence/memberPresence';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme, chipShell, chipText, chipTint, CHROME_FONT_CAP } from '@/constants/Theme';
import { ChatAvatar } from '@/components/chat/MessageRow';
import { RoleFace } from '@/components/org/RoleFace';
import { TaskItemRow, PRIORITY_ORDER } from '@/components/TaskItem';
import { useCallsOn, useLiveRooms } from '@/components/calls/LiveRooms';
import { huddleWith, liveRoomOf, openDmWith } from '@/components/chat/personActions';
import { useActiveTeam } from '@/hooks/useWorkspaceArgs';
import { useSyncOrgTree } from '@/hooks/useSyncOrgTree';
import { solColor } from '@/lib/solColor';
import { ObjectHeader, SectionLabel } from '@/components/objects/ObjectParts';

/** The sessions a person is in the middle of: who needs a human, who is moving, who sleeps on a wake. */
const LIVE_STATES = new Set(['needs_input', 'working', 'dormant']);
const RECENT_LIMIT = 4;
/** The name may grow with Dynamic Type, but not past where three lines hold a full name. */
const NAME_FONT_CAP = 1.5;
/** Roles and live sessions shown before the list folds. */
const ROW_LIMIT = 5;
/** Tasks shown inline, most urgent first; the rest open in the Tasks tab, filtered to them. */
const TASK_LIMIT = 6;
const TASK_STATUS_RANK: Record<string, number> = { in_progress: 0, in_review: 1, open: 2, backlog: 3 };

function sameRef(a: string | null | undefined, ref: string): boolean {
  return !!a && a.toLowerCase() === ref.toLowerCase();
}

export default function PersonScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const ref = String(rawId ?? '').replace(/^@/, '');
  const now = useCoarseNow(30_000);

  const { teamId, activeTeam } = useActiveTeam();
  const roster = useInboxStore(teamMembersOf) as any[];
  const me = useInboxStore((s) => s.currentUser) as any;
  const { tree, ready: treeReady } = useSyncOrgTree();
  const tasks = useInboxStore((s) => s.tasks);
  const callsOn = useCallsOn();
  const liveRooms = useLiveRooms(callsOn);

  // The roster row carries presence and the handle; the viewer's own user doc
  // stands in when the person is you in a personal workspace.
  const member = useMemo(() => {
    const found = roster.find((m) => m && (sameRef(m.github_username, ref) || String(m._id) === ref));
    if (found) return found;
    if (me && (sameRef(me.github_username, ref) || String(me._id) === ref)) return me;
    return null;
  }, [roster, me, ref]);
  const orgPerson: OrgPerson | null = useMemo(() => {
    if (!tree) return null;
    const uid = member ? String(member._id) : ref;
    return tree.people.find((p) => p.user_id === uid) ?? null;
  }, [tree, member, ref]);

  const userId = member ? String(member._id) : orgPerson?.user_id ?? null;
  const isMe = !!userId && !!me && String(me._id) === userId;
  const name = member ? memberDisplayName(member) : orgPerson?.name ?? `@${ref}`;
  const handle = member?.github_username as string | undefined;
  const avatarUrl = member ? memberAvatarUrl(member) : orgPerson?.image;

  const roles = useMemo(() => (tree && userId ? hostedRoles(tree, userId) : []), [tree, userId]);
  const reportsTo = useMemo(() => (tree && orgPerson ? reportsToOf(tree, orgPerson) : null), [tree, orgPerson]);
  // The org tree carries each person's sessions with their work state; where
  // the workspace has no tree (personal, org off) the inbox rows stand in.
  // The tree holds only their first eight, so the inbox rows fill in the rest.
  const storeSessions = useStoreSessionsOf(userId, now);
  const sessions = useMemo(() => mergeSessions(orgPerson?.sessions ?? [], storeSessions), [orgPerson, storeSessions]);
  const { live, recent } = useMemo(() => splitSessions(sessions), [sessions]);
  // Counted from the rows listed, so the chip and the list agree.
  const counts = useMemo(() => tallyStates(sessions), [sessions]);
  // The session they have open right now, when the roster shows it to this
  // viewer (it withholds ids the viewer cannot open) and they are online.
  const viewingId = member && memberPresenceVisual(member) !== 'offline' && member.viewing_conversation_id ? String(member.viewing_conversation_id) : null;
  const viewingTitle = useInboxStore((s: any) => (viewingId ? (s.sessions?.[viewingId]?.title ?? s.conversations?.[viewingId]?.title ?? null) : null)) as string | null;

  const openTasks = useMemo(() => {
    if (!userId) return [] as TaskItem[];
    return filterToWorkspace(Object.values(tasks) as TaskItem[], teamId)
      .filter((t) => String(t.assignee ?? '') === userId && t.status !== 'done' && t.status !== 'dropped' && isActiveTask(t as any))
      .sort((a, b) => (TASK_STATUS_RANK[a.status] ?? 9) - (TASK_STATUS_RANK[b.status] ?? 9)
        || (PRIORITY_ORDER[a.priority ?? 'none'] ?? 9) - (PRIORITY_ORDER[b.priority ?? 'none'] ?? 9)
        || (b.updated_at ?? 0) - (a.updated_at ?? 0));
  }, [tasks, teamId, userId]);

  const chatOn = teamFeatureEnabled(activeTeam as any, 'chat');
  const inRoom = userId ? liveRoomOf(liveRooms, userId) : null;
  const visual: PresenceVisual = member ? memberPresenceVisual(member) : orgPerson?.presence === 'online' ? 'active' : orgPerson?.presence === 'away' ? 'away' : 'offline';
  const presence = inRoom ? `In a huddle${inRoom.redacted ? '' : ` · ${inRoom.label}`}` : member ? presenceLine(member, now) : visual === 'active' ? 'Online' : visual === 'away' ? 'Away' : 'Offline';
  const presenceTone = inRoom || visual === 'active' ? Theme.green : visual === 'idle' ? Theme.accent : visual === 'busy' ? Theme.red : Theme.textDim;
  const localTime = member ? localTimeLine(member.timezone, now) : '';
  const teamRole = (member?.role ?? orgPerson?.role) as string | undefined;

  const personRef = userId ? personRefOf({ _id: userId, github_username: handle }) : ref;
  // Nothing to share until the page names someone.
  const header = !member && !orgPerson
    ? <Stack.Screen options={{ title: `@${ref}` }} />
    : <ObjectHeader type="person" shortId={handle ? `@${handle}` : undefined} refId={personRef} title={name} />;

  if (!member && !orgPerson) {
    // The roster and the tree answer from cache first; only a cold cache spins.
    const settled = roster.length > 0 || (treeReady && !!tree) || !teamId;
    return (
      <>
        {header}
        <RNView style={styles.center}>
          {settled ? (
            <>
              <FontAwesome name="user-o" size={26} color={Theme.textDim} />
              <RNText style={styles.emptyTitle}>No one called @{ref} here</RNText>
              <RNText style={styles.emptyBody}>They may be in another workspace.</RNText>
              <TouchableOpacity style={styles.secondary} onPress={() => router.replace('/(tabs)/chat' as never)}>
                <RNText style={styles.secondaryText}>Team</RNText>
              </TouchableOpacity>
            </>
          ) : (
            <ActivityIndicator size="small" color={Theme.textMuted} />
          )}
        </RNView>
      </>
    );
  }

  const canReach = !isMe && !!userId && !member?.is_bot;

  return (
    <>
      {header}
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <RNView style={styles.hero}>
          <RNView>
            <ChatAvatar author={{ id: userId ?? ref, name, avatarUrl }} size={64} />
            <RNView style={[styles.presenceDot, { backgroundColor: presenceTone }]} />
          </RNView>
          <RNView style={styles.heroBody}>
            <RNText style={styles.name} numberOfLines={3} maxFontSizeMultiplier={NAME_FONT_CAP}>{name}{isMe ? ' (you)' : ''}</RNText>
            <RNView style={styles.metaLine}>
              {handle ? <RNText style={styles.handle}>@{handle}</RNText> : null}
              {teamRole ? <RNText style={styles.dim}>{teamRole}</RNText> : null}
            </RNView>
            <RNView style={styles.metaLine}>
              <RNText style={[styles.presence, { color: presenceTone }]} numberOfLines={1}>{presence}</RNText>
              {localTime ? <RNText style={styles.dim}>· {localTime} local</RNText> : null}
            </RNView>
          </RNView>
        </RNView>

        {canReach && (chatOn || callsOn) && (
          <RNView style={styles.actions}>
            {chatOn && (
              <TouchableOpacity style={[styles.action, styles.actionPrimary]} onPress={() => openDmWith(router, userId!)} testID="person-message">
                <Ionicons name="chatbubble-outline" size={16} color={Theme.bg} />
                <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.actionText, { color: Theme.bg }]}>Message</RNText>
              </TouchableOpacity>
            )}
            {callsOn && (
              <TouchableOpacity style={[styles.action, inRoom && { borderColor: Theme.green }]} onPress={() => huddleWith(router, String(me?._id ?? ''), userId!, inRoom)} testID="person-huddle">
                <Ionicons name={inRoom ? 'headset' : 'headset-outline'} size={16} color={inRoom ? Theme.green : Theme.violet} />
                <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.actionText, { color: inRoom ? Theme.green : Theme.text }]}>{inRoom ? 'Join huddle' : 'Huddle'}</RNText>
              </TouchableOpacity>
            )}
          </RNView>
        )}

        {(roles.length > 0 || reportsTo) && (
          <Section title="Roles" count={roles.length || undefined}>
            <Capped items={roles} limit={ROW_LIMIT} noun="roles" render={(r) => <RoleRow key={r._id} role={r} isMe={isMe} />} />
            {reportsTo && (
              <TouchableOpacity style={styles.row} activeOpacity={0.6} disabled={!reportsTo.route} onPress={() => reportsTo.route && router.push(reportsTo.route as never)}>
                <RNView style={styles.iconSlot}><FontAwesome name="level-up" size={13} color={Theme.textDim} /></RNView>
                <RNText style={styles.rowTitle} numberOfLines={1}>
                  <RNText style={styles.dim}>Reports to </RNText>{reportsTo.label}
                </RNText>
              </TouchableOpacity>
            )}
          </Section>
        )}

        <Section
          title={live.length > 0 || recent.length === 0 ? 'Working on' : 'Recent'}
          trailing={<StateChips counts={counts} isMe={isMe} />}
        >
          {viewingId && (
            <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={() => router.push(`/session/${viewingId}` as never)} testID="person-viewing">
              <RNView style={styles.iconSlot}><Ionicons name="eye-outline" size={15} color={Theme.cyan} /></RNView>
              <RNView style={styles.rowBody}>
                <RNText style={styles.rowTitle} numberOfLines={1}>{viewingTitle || 'A session'}</RNText>
                <RNText style={[styles.dim, { color: Theme.cyan }]}>has it open</RNText>
              </RNView>
              <FontAwesome name="angle-right" size={16} color={Theme.textMuted0} />
            </TouchableOpacity>
          )}
          {live.length === 0 && recent.length === 0 ? (
            viewingId ? null :
            <RNText style={styles.none}>No sessions you can see.</RNText>
          ) : (
            <>
              <Capped items={live} limit={ROW_LIMIT} noun="sessions" render={(s) => <SessionRow key={s._id} session={s} now={now} isMe={isMe} />} />
              {live.length === 0 && recent.map((s) => <SessionRow key={s._id} session={s} now={now} isMe={isMe} />)}
            </>
          )}
        </Section>

        <Section title="Open tasks" count={openTasks.length || undefined}>
          {openTasks.length === 0 ? (
            <RNText style={styles.none}>No open tasks assigned.</RNText>
          ) : (
            <RNView style={styles.taskList}>
              {openTasks.slice(0, TASK_LIMIT).map((t) => (
                <TaskItemRow key={t._id} task={t} onPress={() => router.push(`/task/${t.short_id ?? t._id}` as never)} />
              ))}
              {openTasks.length > TASK_LIMIT && (
                <TouchableOpacity style={styles.more} activeOpacity={0.6} onPress={() => router.push(`/(tabs)/tasks?assignee=${encodeURIComponent(userId!)}` as never)} testID="person-all-tasks">
                  <RNText style={styles.moreText}>All {openTasks.length} open tasks</RNText>
                  <FontAwesome name="angle-right" size={15} color={Theme.accent} />
                </TouchableOpacity>
              )}
            </RNView>
          )}
        </Section>
      </ScrollView>
    </>
  );
}

/** A person's sessions from the inbox rows the store holds (the same rows the
 *  people roster counts, fleetCountedSessions), in the org tree's shape. Gated
 *  on a signature of what the band reads, so heartbeats wake nothing. */
function useStoreSessionsOf(userId: string | null, now: number): OrgSession[] {
  const s = useTrackedStore([
    (st: any) => (userId ? fleetSessionsWakeSig(st.sessions) : ''),
    (st: any) => (userId ? pendingSendWakeSig(st.pendingMessages) : ''),
    (st: any) => (userId ? teamInboxIdsOf(st) : null),
  ]);
  const sig = userId ? fleetSessionsWakeSig(s.sessions) : '';
  return useMemo(() => {
    if (!userId) return [];
    const st = useInboxStore.getState() as any;
    const opts = { queued: st.sessionsWithQueuedMessages ?? new Set<string>(), pendingSendIds: sessionsWithPendingSend(st.pendingMessages, now), now };
    return fleetCountedSessions(st, opts)
      .filter((row) => String(row.user_id ?? '') === userId)
      .map((row): OrgSession => {
        const band = fleetBandFor(row, opts);
        return {
          _id: String(row._id),
          short_id: String((row as any).short_id ?? ''),
          title: row.title ?? '',
          agent_type: String((row as any).agent_type ?? ''),
          state: band === 'running' ? 'working' : band === 'needsYou' ? 'needs_input' : 'done',
          updated_at: row.updated_at ?? 0,
          project_path: (row as any).project_path,
          subagent_count: 0,
          is_anchor: false,
        };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature stands in for the churny collection
  }, [userId, sig, now]);
}

/** The roles this person hosts: the seats whose agents run on their account. */
function hostedRoles(tree: OrgTree, userId: string): OrgRole[] {
  return tree.roles.filter((r) => r.host_user_id === userId && r.status !== 'retired');
}

function reportsToOf(tree: OrgTree, person: OrgPerson): { label: string; route: string | null } | null {
  const id = person.reports_to_user_id;
  if (!id) return null;
  const boss = tree.people.find((p) => p.user_id === id);
  return boss ? { label: boss.name, route: `/person/${encodeURIComponent(boss.user_id)}` } : null;
}

/** The tree's rows (they carry the finer work state) first, then the inbox rows it left out. */
function mergeSessions(tree: OrgSession[], store: OrgSession[]): OrgSession[] {
  const ids = new Set(tree.map((s) => s._id));
  return [...tree, ...store.filter((s) => !ids.has(s._id))];
}

function tallyStates(sessions: OrgSession[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sessions) out[s.state] = (out[s.state] ?? 0) + 1;
  return out;
}

function splitSessions(sessions: OrgSession[]): { live: OrgSession[]; recent: OrgSession[] } {
  const rank = (s: OrgSession) => ORG_STATE_ORDER.indexOf(s.state);
  const sorted = [...sessions].sort((a, b) => rank(a) - rank(b) || b.updated_at - a.updated_at);
  return {
    live: sorted.filter((s) => LIVE_STATES.has(s.state)),
    recent: sorted.filter((s) => !LIVE_STATES.has(s.state)).sort((a, b) => b.updated_at - a.updated_at).slice(0, RECENT_LIMIT),
  };
}

/** The first `limit` rows, and a toggle that unfolds the rest in place. */
function Capped<T>({ items, limit, noun, render }: { items: T[]; limit: number; noun: string; render: (item: T) => ReactNode }) {
  const Theme = useTheme();
  const [open, setOpen] = useState(false);
  // One hidden row is cheaper to show than a toggle that hides it.
  const folds = items.length > limit + 1;
  return (
    <>
      {(folds && !open ? items.slice(0, limit) : items).map(render)}
      {folds && (
        <TouchableOpacity style={styles.more} activeOpacity={0.6} onPress={() => setOpen((o) => !o)}>
          <RNText style={styles.moreText}>{open ? 'Show fewer' : `Show all ${items.length} ${noun}`}</RNText>
          <FontAwesome name={open ? 'angle-up' : 'angle-down'} size={15} color={Theme.accent} />
        </TouchableOpacity>
      )}
    </>
  );
}

function Section({ title, count, trailing, children }: { title: string; count?: number; trailing?: React.ReactNode; children: React.ReactNode }) {
  return (
    <RNView style={styles.section}>
      <RNView style={styles.sectionHead}>
        <SectionLabel right={trailing}>{`${title}${count ? ` · ${count}` : ''}`}</SectionLabel>
      </RNView>
      {children}
    </RNView>
  );
}

/** The org's state word, except that someone else's blocked session waits on them, not on the viewer. */
function stateWord(state: OrgSession['state'], isMe: boolean): string {
  return state === 'needs_input' && !isMe ? 'needs input' : ORG_STATE_META[state].label;
}

function StateChips({ counts, isMe }: { counts: Record<string, number>; isMe: boolean }) {
  const Theme = useTheme();
  return (
    <RNView style={styles.metaLine}>
      {ORG_STATE_ORDER.slice(0, 2).filter((s) => (counts[s] ?? 0) > 0).map((s) => {
        const color = solColor(ORG_STATE_META[s].color, Theme);
        return (
          <RNView key={s} style={[chipShell, chipTint(color)]}>
            <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[chipText, { color }]}>{counts[s]} {stateWord(s, isMe)}</RNText>
          </RNView>
        );
      })}
    </RNView>
  );
}

function SessionRow({ session: s, now, isMe }: { session: OrgSession; now: number; isMe: boolean }) {
  const Theme = useTheme();
  const router = useRouter();
  const color = solColor(ORG_STATE_META[s.state].color, Theme);
  const project = s.project_path?.split('/').filter(Boolean).pop();
  return (
    <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={() => router.push(`/session/${s._id}` as never)}>
      <RNView style={styles.iconSlot}><RNView style={[styles.dot, { backgroundColor: color }]} /></RNView>
      <RNView style={styles.rowBody}>
        <RNText style={styles.rowTitle} numberOfLines={1}>{s.title || 'Untitled'}</RNText>
        <RNText style={styles.dim} numberOfLines={1}>
          <RNText style={{ color }}>{stateWord(s.state, isMe)}</RNText>
          {project ? ` · ${project}` : ''}{s.subagent_count > 0 ? ` · ${s.subagent_count} sub` : ''}
        </RNText>
      </RNView>
      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.age}>{compactAge(now - s.updated_at)}</RNText>
    </TouchableOpacity>
  );
}

function RoleRow({ role: r, isMe }: { role: OrgRole; isMe: boolean }) {
  const Theme = useTheme();
  const router = useRouter();
  const line = standingLineOf(r.standing);
  const color = line ? solColor(line.color, Theme) : Theme.textDim;
  return (
    <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={() => router.push(`/org/${r.short_id}` as never)}>
      <RoleFace role={r} size={30} />
      <RNView style={styles.rowBody}>
        <RNView style={styles.metaLine}>
          <RNText style={styles.rowTitle} numberOfLines={1}>{r.name}</RNText>
          <RNText style={styles.handle} numberOfLines={1}>@{r.handle}</RNText>
          {r.status === 'paused' && <RNText style={[styles.dim, { color: Theme.accent }]}>paused</RNText>}
        </RNView>
        <RNText style={[styles.dim, { marginTop: 2 }]} numberOfLines={1}>
          {line ? <RNText style={{ color }}>{!isMe && standingWaits(r.standing) ? 'needs input' : line.label}{line.text ? ' · ' : ''}</RNText> : null}
          {line?.text ?? (line ? '' : r.standing ? 'Standing by' : 'Not online yet')}
        </RNText>
      </RNView>
      <FontAwesome name="angle-right" size={16} color={Theme.textMuted0} />
    </TouchableOpacity>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.bg },
  content: { paddingBottom: Spacing.xxxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md, paddingHorizontal: Spacing.xxl, backgroundColor: Theme.bg },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: Theme.text, textAlign: 'center' },
  emptyBody: { fontSize: 13, color: Theme.textMuted, textAlign: 'center' },
  secondary: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.border },
  secondaryText: { fontSize: 13, fontWeight: '600', color: Theme.text },
  hero: { flexDirection: 'row', alignItems: 'center', gap: Spacing.lg, paddingHorizontal: Spacing.lg, paddingTop: Spacing.xl, paddingBottom: Spacing.md },
  heroBody: { flex: 1, minWidth: 0, gap: 3 },
  presenceDot: { position: 'absolute', right: 1, bottom: 1, width: 14, height: 14, borderRadius: 7, borderWidth: 2.5, borderColor: Theme.bg },
  name: { fontSize: 22, fontWeight: '700', color: Theme.text },
  metaLine: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  handle: { fontSize: 12, color: Theme.violet },
  presence: { fontSize: 13, fontWeight: '600' },
  dim: { fontSize: 12, color: Theme.textDim },
  actions: { flexDirection: 'row', gap: Spacing.sm, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md },
  action: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 40, paddingVertical: 8, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.border, backgroundColor: Theme.bgAlt },
  actionPrimary: { backgroundColor: Theme.violet, borderColor: Theme.violet },
  actionText: { fontSize: 14, fontWeight: '700' },
  section: { marginTop: Spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight, paddingTop: Spacing.md },
  sectionHead: { paddingHorizontal: Spacing.lg },
  none: { fontSize: 13, color: Theme.textDim, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: Spacing.lg, paddingVertical: 9 },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 14, fontWeight: '600', color: Theme.text, flexShrink: 1 },
  iconSlot: { width: 30, alignItems: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  age: { fontSize: 11, color: Theme.textDim, fontVariant: ['tabular-nums'] },
  taskList: { },
  more: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: Spacing.lg, paddingVertical: 12 },
  moreText: { fontSize: 13, fontWeight: '600', color: Theme.accent },
}));

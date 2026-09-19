// A scope's board on the phone (docs/architecture/scopes-and-feed.md F2, F3):
// who holds the seat, what waits on a person, and everything in the scope as
// one stream, newest first. The paging is web's own (useScopeFeedStream); only
// the rows are drawn here. "workspace" is the root: the whole workspace.
import { useCallback, useMemo } from 'react';
import { ActivityIndicator, FlatList, Image, ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { api } from '@codecast/convex/convex/_generated/api';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme, chipShell, chipText, chipTint, CHROME_FONT_CAP } from '@/constants/Theme';
import { Mono } from '@/constants/fonts';
import { RoleFace } from '@/components/org/RoleFace';
import { useSyncOrgTree } from '@/hooks/useSyncOrgTree';
import { useWorkspaceArgs } from '@/hooks/useWorkspaceArgs';
import { mobileRouteForUrl } from '@/lib/linkRoutes';
import { openLink } from '@/lib/links';
import { solColor } from '@/lib/solColor';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { useScopeFeedStream } from '@codecast/web/hooks/useScopeFeedStream';
import { useScopeSummary, type ScopeRef } from '@codecast/web/hooks/useScopeQueries';
import { compactAge } from '@codecast/web/lib/threadState';
import { FEED_NEUTRAL_TONE, feedStateTone, handsWaiting, roleStanding, scopeQueryRef, scopeSeatOf } from '@codecast/web/lib/scopePage';
import { parentName, standingLineOf } from '@codecast/web/components/org/orgMeta';
import { FEED_KINDS, FEED_KIND_META, type FeedKind, type FeedRow } from '@codecast/web/components/org/scope/scopeTypes';

const KIND_ICON: Record<FeedKind, React.ComponentProps<typeof FontAwesome>['name']> = {
  session: 'terminal',
  task: 'check-square-o',
  plan: 'list-ol',
  doc: 'file-text-o',
  artifact: 'image',
  decision: 'question-circle-o',
  update: 'bullhorn',
  commit: 'code-fork',
  run: 'random',
};

export default function ScopeBoardScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { tree, ready } = useSyncOrgTree();
  const { role, anchor } = scopeSeatOf(tree, id);
  const isRoot = id === 'workspace';

  // An empty scope is the whole workspace (F1), for the root and for a role
  // alike: the server resolves a role's empty scope to nothing, so the page
  // names every project for it. Only that case asks for the project list.
  const whole = !role || (role.scope.project_ids.length === 0 && role.scope.plan_ids.length === 0);
  const workspaceArgs = useWorkspaceArgs();
  const projects = useQuery(api.projects.webList, whole && workspaceArgs !== 'skip' ? workspaceArgs : 'skip') as Array<{ _id: string }> | undefined;
  const scopeRef: ScopeRef | null = useMemo(() => {
    if (!tree || (!role && !isRoot) || (whole && !projects)) return null;
    return scopeQueryRef(role, (projects ?? []).map((p) => String(p._id)), tree.workspace.kind === 'team' ? tree.workspace.id : undefined);
  }, [tree, role, isRoot, whole, projects]);

  const title = role ? `@${role.handle}` : 'Workspace';
  const header = (
    <Stack.Screen
      options={{
        title,
        headerBackTitle: 'Back',
        headerStyle: { backgroundColor: Theme.bgAlt },
        headerTintColor: Theme.text,
        headerTitleStyle: { fontSize: 14, fontFamily: Mono.semiBold, color: Theme.textMuted },
      }}
    />
  );

  if (!scopeRef || !tree) {
    const missing = !!tree && !role && !isRoot;
    return (
      <>
        {header}
        <RNView style={styles.center}>
          {missing ? <RNText style={styles.emptyText}>No role {id} in this workspace.</RNText>
            : !tree && ready ? <RNText style={styles.emptyText}>No org tree for this workspace.</RNText>
            : <ActivityIndicator size="small" color={Theme.textMuted} />}
        </RNView>
      </>
    );
  }

  const name = role ? role.name : anchor?.name || tree.workspace.name || 'Workspace';
  return (
    <>
      {header}
      <Board
        scope={scopeRef}
        head={
          <RNView style={styles.head}>
            <RNView style={styles.headTop}>
              {role ? <RoleFace role={role} size={44} /> : <RNView style={[styles.anchorFace, chipTint(Theme.orange)]}><FontAwesome name="anchor" size={18} color={Theme.orange} /></RNView>}
              <RNView style={{ flex: 1, minWidth: 0 }}>
                <RNText style={styles.name} numberOfLines={1}>{name}</RNText>
                <RNText style={styles.dim} numberOfLines={1}>
                  {role ? `reports to ${parentName(tree, role.reports_to)}` : 'Everything in the workspace, as one scope.'}
                  {role?.status === 'paused' ? ' · paused' : ''}
                </RNText>
              </RNView>
              <TouchableOpacity style={styles.talk} activeOpacity={0.7} onPress={() => router.dismissTo(`/org/${id}` as never)} accessibilityLabel={`Talk to ${name}`}>
                <FontAwesome name="comment-o" size={13} color={Theme.bg} />
                <RNText style={styles.talkText}>Talk</RNText>
              </TouchableOpacity>
            </RNView>
            <SeatLine seat={role ? role.standing : anchor} />
            <Summary scope={scopeRef} waitingFloor={handsWaiting(role, tree, null)} />
          </RNView>
        }
      />
    </>
  );
}

/** The seat's state in role words, and the line its agent pinned. */
function SeatLine({ seat }: { seat: Parameters<typeof standingLineOf>[0] }) {
  const Theme = useTheme();
  const standing = roleStanding(seat?.state);
  const line = standingLineOf(seat);
  if (!standing && !line?.text) return null;
  const color = solColor(standing?.color ?? line?.color, Theme);
  return (
    <RNView style={styles.seatLine}>
      {standing && (
        <RNView style={[chipShell, chipTint(color)]}>
          <RNView style={[styles.dot, { backgroundColor: color }]} />
          <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[chipText, { color }]}>{standing.label}</RNText>
        </RNView>
      )}
      {line?.text ? <RNText style={styles.pinned} numberOfLines={2}>{line.text}</RNText> : null}
    </RNView>
  );
}

/** The board's counts (org.scopeSummary): what is open, and what waits on a person. */
function Summary({ scope, waitingFloor }: { scope: ScopeRef; waitingFloor: number }) {
  const Theme = useTheme();
  const { data } = useScopeSummary(scope);
  const waiting = Math.max(waitingFloor, data?.sessions.needs_input ?? 0);
  const cells: Array<{ label: string; value: number | string; color?: string }> = [
    // The tree's count is a floor known at once; a zero floor says nothing until the summary lands.
    { label: 'waiting on you', value: data || waiting > 0 ? waiting : '·', color: waiting > 0 ? Theme.accent : undefined },
    { label: 'open tasks', value: data ? data.tasks.open : '·' },
    { label: 'open decisions', value: data ? data.decisions.open : '·', color: data && data.decisions.open > 0 ? Theme.accent : undefined },
    { label: data?.plans.length === 1 ? 'plan' : 'plans', value: data ? data.plans.length : '·' },
  ];
  return (
    <RNView style={styles.summary}>
      {cells.map((c) => (
        <RNView key={c.label} style={styles.cell}>
          <RNText style={[styles.cellValue, c.color ? { color: c.color } : null]}>{c.value}</RNText>
          <RNText style={styles.cellLabel} numberOfLines={1}>{c.label}</RNText>
        </RNView>
      ))}
    </RNView>
  );
}

function Board({ scope, head }: { scope: ScopeRef; head: React.ReactElement }) {
  const Theme = useTheme();
  const router = useRouter();
  const now = useCoarseNow(30_000);
  const { kinds, toggleKind, clearKinds, rows, loaded, pending, hasMore, problem, loadMore, loaders } = useScopeFeedStream(scope);

  const open = useCallback((row: FeedRow) => {
    if (row.kind === 'session') { router.push(`/session/${row.id}`); return; }
    const route = mobileRouteForUrl(row.href);
    if (route) router.push(route as never);
    // A page the phone has no screen for (an artifact, a decision) opens on the web.
    else void openLink(/^https?:/i.test(row.href) ? row.href : `https://codecast.sh${row.href}`);
  }, [router]);

  const renderItem = useCallback(({ item: row }: { item: FeedRow }) => {
    const m = FEED_KIND_META[row.kind];
    const kindColor = solColor(m.color, Theme);
    const tone = feedStateTone(row.kind, row.state);
    const stateColor = tone === FEED_NEUTRAL_TONE ? Theme.textMuted : solColor(tone, Theme);
    return (
      <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={() => open(row)}>
        <RNView style={[styles.rail, { backgroundColor: tone === FEED_NEUTRAL_TONE ? Theme.borderLight : stateColor }]} />
        {row.image_url ? (
          <Image source={{ uri: row.image_url }} style={styles.thumb} />
        ) : (
          <RNView style={[styles.kindIcon, { backgroundColor: kindColor + '1f' }]}><FontAwesome name={KIND_ICON[row.kind]} size={12} color={kindColor} /></RNView>
        )}
        <RNView style={{ flex: 1, minWidth: 0 }}>
          <RNView style={styles.titleLine}>
            <RNText style={styles.rowTitle} numberOfLines={1}>{row.title || 'Untitled'}</RNText>
            {row.state ? <RNText style={[styles.state, { color: stateColor, borderColor: stateColor + '73' }]} numberOfLines={1}>{row.state.replace(/_/g, ' ')}</RNText> : null}
          </RNView>
          <RNText style={styles.dim} numberOfLines={1}>
            {row.short_id ?? m.label}
            {row.actor ? ` · ${row.actor.name}${row.actor.is_bot ? ' (agent)' : ''}` : ''}
            {row.preview ? ` · ${row.preview}` : ''}
          </RNText>
        </RNView>
        <RNText style={styles.age}>{compactAge(now - row.updated_at)}</RNText>
      </TouchableOpacity>
    );
  }, [Theme, now, open]);

  return (
    <>
      {loaders}
      <FlatList
        style={styles.container}
        data={rows}
        keyExtractor={(r) => `${r.kind}:${r.id}`}
        renderItem={renderItem}
        onEndReached={loadMore}
        onEndReachedThreshold={0.6}
        contentContainerStyle={{ paddingBottom: Spacing.xxxl }}
        ListHeaderComponent={
          <>
            {head}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.kinds}>
              <TouchableOpacity onPress={clearKinds} style={[styles.kind, kinds.length === 0 && { backgroundColor: Theme.text, borderColor: Theme.text }]}>
                <RNText style={[styles.kindText, kinds.length === 0 && { color: Theme.bg }]}>Everything</RNText>
              </TouchableOpacity>
              {FEED_KINDS.map((k) => {
                const on = kinds.includes(k);
                return (
                  <TouchableOpacity key={k} onPress={() => toggleKind(k)} style={[styles.kind, on && { backgroundColor: Theme.bgHighlight, borderColor: Theme.textMuted }]} accessibilityState={{ selected: on }}>
                    <FontAwesome name={KIND_ICON[k]} size={10} color={on ? Theme.text : Theme.textMuted} />
                    <RNText style={[styles.kindText, on && { color: Theme.text }]}>{FEED_KIND_META[k].plural}</RNText>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </>
        }
        ListEmptyComponent={
          <RNView style={styles.emptyFeed}>
            {!loaded ? (problem ? <RNText style={styles.emptyText}>{problem}</RNText> : <ActivityIndicator size="small" color={Theme.textMuted} />) : (
              <>
                <RNText style={styles.emptyText}>Nothing in this scope yet{kinds.length ? ' for those kinds' : ''}.</RNText>
                <RNText style={styles.dim}>Sessions, tasks, plans, pages, decisions and commits appear here as they move.</RNText>
              </>
            )}
          </RNView>
        }
        ListFooterComponent={rows.length > 0 ? (
          <RNText style={styles.footer}>{problem ?? (hasMore ? (pending ? 'Loading…' : '') : 'That is everything in scope.')}</RNText>
        ) : null}
      />
    </>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xxl, backgroundColor: Theme.bg },
  head: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg, gap: Spacing.md },
  headTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  anchorFace: { width: 44, height: 44, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 19, fontWeight: '700', color: Theme.text },
  dim: { fontSize: 11, color: Theme.textDim, marginTop: 2 },
  talk: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: 12, borderRadius: 8, backgroundColor: Theme.violet },
  talkText: { fontSize: 12.5, fontWeight: '700', color: Theme.bg },
  seatLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  pinned: { flex: 1, fontSize: 12.5, lineHeight: 17, color: Theme.textSecondary },
  summary: { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, borderRadius: 10, backgroundColor: Theme.bgAlt },
  cell: { flex: 1, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 2 },
  cellValue: { fontSize: 17, fontWeight: '700', color: Theme.text, fontVariant: ['tabular-nums'] },
  cellLabel: { fontSize: 9.5, color: Theme.textDim, marginTop: 2 },
  kinds: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md, gap: 6 },
  kind: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 26, paddingHorizontal: 10, borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.border },
  kindText: { fontSize: 11, fontWeight: '600', color: Theme.textMuted },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: Spacing.lg, paddingVertical: 9 },
  rail: { width: 3, alignSelf: 'stretch', borderRadius: 2 },
  kindIcon: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  thumb: { width: 56, height: 38, borderRadius: 7, backgroundColor: Theme.bgAlt },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowTitle: { flexShrink: 1, fontSize: 13, fontWeight: '600', color: Theme.text },
  state: { maxWidth: 110, fontSize: 9.5, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 5, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  age: { fontSize: 10.5, color: Theme.textDim, fontVariant: ['tabular-nums'], alignSelf: 'flex-start', marginTop: 3 },
  emptyFeed: { alignItems: 'center', gap: 4, paddingVertical: 48, paddingHorizontal: Spacing.xxl },
  emptyText: { fontSize: 13, color: Theme.textMuted, textAlign: 'center' },
  footer: { textAlign: 'center', fontSize: 11, color: Theme.textDim, paddingVertical: Spacing.lg },
}));

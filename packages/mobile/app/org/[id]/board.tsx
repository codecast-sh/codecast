// A scope's board on the phone (docs/architecture/scopes-and-feed.md F2, F3,
// F5): who holds the seat, then the briefing a role's first screen carries on
// the web (what needs you, where each project stands in the role's words,
// what it is doing), then everything in the scope as one stream, newest
// first. The paging is web's own (useScopeFeedStream); only
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
import { useRoleBrief, type ScopeRef } from '@codecast/web/hooks/useScopeQueries';
import { useRoleEscalations } from '@codecast/web/hooks/useRoleEscalations';
import { compactAge } from '@codecast/web/lib/threadState';
import { FEED_NEUTRAL_TONE, feedStateTone, roleStanding, scopeQueryRef, scopeSeatOf } from '@codecast/web/lib/scopePage';
import { parentName, standingLineOf } from '@codecast/web/components/org/orgMeta';
import { FEED_KINDS, FEED_KIND_META, type FeedKind, type FeedRow } from '@codecast/web/components/org/scope/scopeTypes';
import type { OrgRole, OrgTree } from '@codecast/web/components/org/orgTypes';
import { escalationFirstLine } from '@codecast/shared/contracts';
import { noWordYet, parseStandingSection, standingLineAgeDays, standingLineFor, standingLineStale } from '@codecast/shared/contracts/briefStanding';
import { EntityPill } from '@/components/EntityPill';

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
  const projects = useQuery(api.projects.webList, whole && workspaceArgs !== 'skip' ? workspaceArgs : 'skip') as Array<{ _id: string; title?: string; short_id?: string }> | undefined;
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
              {role ? <RoleFace role={role} size={44} /> : <RNView style={[styles.anchorFace, chipTint(Theme.orange)]}><FontAwesome name="sitemap" size={18} color={Theme.orange} /></RNView>}
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
            {role && <Briefing role={role} tree={tree} projects={whole ? (projects ?? []).map((p) => ({ id: String(p._id), title: p.title ?? '', short_id: p.short_id })) : role.scope_names.projects} />}
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

/** The briefing (F5.1), the same three blocks as the web's first screen: what
 *  the role put in front of the person, one sentence per project from the
 *  role's brief, and what it is doing. No counts, no lists of hands. */
function Briefing({ role, tree, projects }: { role: OrgRole; tree: OrgTree; projects: Array<{ id: string; title: string; short_id?: string }> }) {
  const Theme = useTheme();
  const router = useRouter();
  const now = useCoarseNow(60_000);
  const escalations = useRoleEscalations(role._id, role.standing?.conversation_id ?? null);
  const { data: brief } = useRoleBrief(role._id);
  const standing = useMemo(() => parseStandingSection(brief?.narrative), [brief?.narrative]);
  const active = role.counts.working ?? 0;
  const current = [...role.sessions].filter((s) => s.state === 'working').sort((a, b) => b.updated_at - a.updated_at)[0]
    ?? [...role.sessions].sort((a, b) => b.updated_at - a.updated_at)[0];
  void tree;
  return (
    <RNView style={styles.briefing} testID="scope-briefing">
      <RNView>
        <RNText style={styles.blockLabel}>Needs you</RNText>
        {escalations.length === 0 ? (
          <RNText style={styles.calm} testID="scope-needs-nothing">Nothing needs you.</RNText>
        ) : escalations.map((e) => (
          <TouchableOpacity key={e.conversation_id} style={styles.escalation} activeOpacity={0.7} onPress={() => router.push(`/session/${e.conversation_id}` as never)} testID={`scope-escalation-${e.conversation_id}`}>
            <FontAwesome name="arrow-up" size={10} color={Theme.violet} style={{ marginTop: 3 }} />
            <RNView style={{ flex: 1, minWidth: 0 }}>
              <RNText style={styles.escalationLine}>{escalationFirstLine(e.line)}</RNText>
              <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
                <EntityPill id={e.conversation_id} type="session" />
                <RNText style={styles.dim}>{compactAge(now - e.at)}</RNText>
              </RNView>
            </RNView>
          </TouchableOpacity>
        ))}
      </RNView>
      <RNView>
        <RNText style={styles.blockLabel}>Where it stands</RNText>
        {projects.length === 0 ? <RNText style={styles.calm}>No project in its scope yet.</RNText> : projects.map((p) => {
          const line = standingLineFor(standing, { title: p.title, short_id: p.short_id });
          const days = line ? standingLineAgeDays(line, now) : null;
          const stale = !!line && standingLineStale(line, now);
          return (
            <RNView key={p.id} style={{ marginBottom: 6 }} testID={`scope-stands-${p.short_id ?? p.id}`}>
              <RNText style={styles.projectTitle}>{p.title}</RNText>
              {line ? (
                <RNText style={styles.standsLine}>
                  {line.text}
                  {stale && days !== null ? <RNText style={{ color: Theme.yellow, fontSize: 11 }}>{`  written ${days} days ago`}</RNText> : null}
                </RNText>
              ) : (
                <RNText style={[styles.standsLine, { color: Theme.textDim, fontStyle: 'italic' }]}>{brief === undefined ? ' ' : noWordYet(role.handle)}</RNText>
              )}
            </RNView>
          );
        })}
      </RNView>
      <RNView>
        <RNText style={styles.blockLabel}>What it is doing</RNText>
        <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }} testID={`scope-doing-${active}`}>
          <RNText style={styles.standsLine}>
            {role.total === 0 ? 'No sessions under it yet.' : active === 0 ? 'No session at work right now.' : `${active} ${active === 1 ? 'session' : 'sessions'} at work`}
            {current ? (active > 0 ? ' · on' : ' · last') : ''}
          </RNText>
          {current ? <EntityPill id={current._id} shortId={current.short_id} type="session" /> : null}
        </RNView>
      </RNView>
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
  briefing: { gap: Spacing.md, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, borderRadius: 10, backgroundColor: Theme.bgAlt, paddingHorizontal: Spacing.md, paddingVertical: Spacing.md },
  blockLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', color: Theme.textDim, marginBottom: 4 },
  calm: { fontSize: 13, color: Theme.textMuted },
  escalation: { flexDirection: 'row', gap: 8, paddingVertical: 4 },
  escalationLine: { fontSize: 12.5, lineHeight: 17, color: Theme.text },
  projectTitle: { fontSize: 12.5, fontWeight: '700', color: Theme.text },
  standsLine: { fontSize: 13, lineHeight: 18, color: Theme.textSecondary },
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

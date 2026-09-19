// The org on the phone (docs/architecture/org-roles.md S3): the same tree
// web draws as a chart, read top to bottom as one list. People are the roots;
// under each hang their own sessions and the roles that report to them, and
// roles nest the same way. A role opens its page, which is the conversation
// with the agent that holds the seat; a session opens the session.
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme, chipShell, chipText, chipTint, CHROME_FONT_CAP } from '@/constants/Theme';
import { Mono } from '@/constants/fonts';
import { ChatAvatar } from '@/components/chat/MessageRow';
import { RoleFace } from '@/components/org/RoleFace';
import { useSyncOrgTree } from '@/hooks/useSyncOrgTree';
import { orgRows, type OrgRow } from '@/lib/orgRows';
import { solColor } from '@/lib/solColor';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { compactAge } from '@codecast/web/lib/threadState';
import { ORG_STATE_META, standingLineOf } from '@codecast/web/components/org/orgMeta';
import { ORG_STATE_ORDER, type StateCounts } from '@codecast/web/components/org/orgTypes';
import { queryProblem } from '@codecast/web/lib/scopePage';

const INDENT = 18;

/** The states worth a chip on a parent's row: who waits on a person, who is moving. */
function CountChips({ counts }: { counts: StateCounts }) {
  const Theme = useTheme();
  return (
    <>
      {ORG_STATE_ORDER.slice(0, 2).filter((s) => counts[s] > 0).map((s) => {
        const color = solColor(ORG_STATE_META[s].color, Theme);
        return (
          <RNView key={s} style={[chipShell, chipTint(color)]}>
            <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[chipText, { color }]}>{counts[s]} {ORG_STATE_META[s].label}</RNText>
          </RNView>
        );
      })}
    </>
  );
}

function Fold({ collapsed, hidden, onPress }: { collapsed: boolean; hidden: number; onPress: () => void }) {
  const Theme = useTheme();
  return (
    <TouchableOpacity onPress={onPress} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={styles.fold} accessibilityLabel={collapsed ? `Unfold, ${hidden} hidden` : 'Fold'}>
      {collapsed && hidden > 0 && <RNText style={styles.foldCount}>{hidden}</RNText>}
      <FontAwesome name={collapsed ? 'angle-right' : 'angle-down'} size={16} color={Theme.textMuted0} />
    </TouchableOpacity>
  );
}

export default function OrgScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const { tree, ready, error, missing, retry } = useSyncOrgTree();
  const now = useCoarseNow(30_000);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<Record<string, []>>({});
  const rows = useMemo(() => (tree ? orgRows(tree, { collapsed, expanded }) : []), [tree, collapsed, expanded]);

  const toggleFold = useCallback((id: string) => {
    setCollapsed((c) => { const n = new Set(c); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);
  const toggleMore = useCallback((id: string) => {
    setExpanded((e) => { if (!(id in e)) return { ...e, [id]: [] }; const { [id]: _drop, ...rest } = e; return rest; });
  }, []);

  const renderItem = useCallback(({ item }: { item: OrgRow }) => {
    const pad = { paddingLeft: Spacing.lg + item.depth * INDENT };
    if (item.kind === 'person') {
      const p = item.person;
      return (
        <RNView style={[styles.row, styles.personRow, pad]}>
          <ChatAvatar author={{ id: p.user_id, name: p.name, avatarUrl: p.image }} size={34} />
          <RNView style={styles.rowBody}>
            <RNText style={styles.personName} numberOfLines={1}>{p.name}{p.is_me ? ' (you)' : ''}</RNText>
            <RNView style={styles.metaLine}>
              <RNText style={styles.dim}>{p.role} · {p.total} session{p.total === 1 ? '' : 's'}</RNText>
              <CountChips counts={p.counts} />
            </RNView>
          </RNView>
          <Fold collapsed={item.collapsed} hidden={item.hidden} onPress={() => toggleFold(item.key)} />
        </RNView>
      );
    }
    if (item.kind === 'role') {
      const r = item.role;
      const line = standingLineOf(r.standing);
      const color = line ? solColor(line.color, Theme) : Theme.textDim;
      return (
        <TouchableOpacity style={[styles.row, pad]} activeOpacity={0.6} onPress={() => router.push(`/org/${r.short_id}` as never)}>
          <RNView style={[styles.rail, { backgroundColor: color }]} />
          <RoleFace role={r} size={30} />
          <RNView style={styles.rowBody}>
            <RNView style={styles.metaLine}>
              <RNText style={styles.roleName} numberOfLines={1}>{r.name}</RNText>
              <RNText style={styles.handle} numberOfLines={1}>@{r.handle}</RNText>
              {r.status === 'paused' && <RNText style={[styles.dim, { color: Theme.accent }]}>paused</RNText>}
            </RNView>
            <RNText style={[styles.standing, { color: line?.text ? Theme.textSecondary : Theme.textDim }]} numberOfLines={1}>
              {line ? <RNText style={{ color }}>{line.label}{line.text ? ' · ' : ''}</RNText> : null}
              {line?.text ?? (line ? '' : r.standing ? 'Standing by.' : 'Not online yet.')}
            </RNText>
            {(item.tenure || r.counts.needs_input > 0 || r.counts.working > 0) && (
              <RNView style={[styles.metaLine, { marginTop: 3 }]}>
                {item.tenure && <RNText style={styles.dim} numberOfLines={1}>{item.tenure}</RNText>}
                <CountChips counts={r.counts} />
              </RNView>
            )}
          </RNView>
          {(item.collapsed || r.total > 0 || item.hidden > 0) && <Fold collapsed={item.collapsed} hidden={item.hidden} onPress={() => toggleFold(item.key)} />}
        </TouchableOpacity>
      );
    }
    if (item.kind === 'anchor') {
      const a = item.anchor;
      const line = standingLineOf(a);
      const color = line ? solColor(line.color, Theme) : Theme.orange;
      return (
        <TouchableOpacity style={[styles.row, pad]} activeOpacity={0.6} onPress={() => router.push('/org/workspace' as never)}>
          <RNView style={[styles.rail, { backgroundColor: color }]} />
          <RNView style={[styles.anchorFace, chipTint(Theme.orange)]}><FontAwesome name="anchor" size={13} color={Theme.orange} /></RNView>
          <RNView style={styles.rowBody}>
            <RNText style={styles.roleName} numberOfLines={1}>{a.name}</RNText>
            <RNText style={[styles.standing, { color: Theme.textDim }]} numberOfLines={1}>
              {line ? <RNText style={{ color }}>{line.label}{line.text ? ' · ' : ''}</RNText> : null}
              {line?.text ?? (line ? '' : 'The workspace agent')}
            </RNText>
          </RNView>
        </TouchableOpacity>
      );
    }
    if (item.kind === 'session') {
      const s = item.session;
      const color = solColor(ORG_STATE_META[s.state].color, Theme);
      return (
        <TouchableOpacity style={[styles.row, styles.sessionRow, pad]} activeOpacity={0.6} onPress={() => router.push(`/session/${s._id}`)}>
          <RNView style={[styles.dot, { backgroundColor: color }]} />
          <RNText style={styles.sessionTitle} numberOfLines={1}>{s.title || 'Untitled'}</RNText>
          <RNText style={styles.dim}>{compactAge(now - s.updated_at)}</RNText>
        </TouchableOpacity>
      );
    }
    // The tree carries a parent's first eight sessions; the rest are in the inbox.
    const tappable = item.loaded > 0 || item.opened;
    return (
      <TouchableOpacity style={[styles.row, styles.sessionRow, pad]} activeOpacity={0.6} disabled={!tappable} onPress={() => toggleMore(item.parentId)}>
        <RNView style={[styles.dot, { backgroundColor: 'transparent', borderWidth: 1, borderColor: Theme.textDim }]} />
        <RNText style={[styles.sessionTitle, { color: Theme.textMuted }]} numberOfLines={1}>
          {item.opened ? (item.remaining > 0 ? `Show fewer · ${item.remaining} more in the inbox` : 'Show fewer') : item.loaded > 0 ? `Show ${item.loaded} more${item.remaining > item.loaded ? ` of ${item.remaining}` : ''}` : `${item.remaining} more in the inbox`}
        </RNText>
      </TouchableOpacity>
    );
  }, [Theme, router, now, toggleFold, toggleMore]);

  const problem = queryProblem(error, missing, 'The org');
  const roleCount = tree?.roles.filter((r) => r.status !== 'retired').length ?? 0;

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Org',
          headerBackTitle: 'Back',
          headerStyle: { backgroundColor: Theme.bgAlt },
          headerTintColor: Theme.text,
          headerTitleStyle: { fontSize: 16, fontFamily: Mono.semiBold, color: Theme.text },
        }}
      />
      {!tree ? (
        <RNView style={styles.empty}>
          {problem ? (
            <>
              <RNText style={styles.emptyText}>{problem}</RNText>
              <TouchableOpacity onPress={retry} style={styles.retry}><RNText style={styles.retryText}>Try again</RNText></TouchableOpacity>
            </>
          ) : ready ? (
            <RNText style={styles.emptyText}>No org tree for this workspace.</RNText>
          ) : (
            <ActivityIndicator size="small" color={Theme.textMuted} />
          )}
        </RNView>
      ) : (
        <FlatList
          style={styles.container}
          data={rows}
          keyExtractor={(r) => r.key}
          renderItem={renderItem}
          refreshControl={<RefreshControl refreshing={false} onRefresh={retry} tintColor={Theme.textMuted} />}
          ListHeaderComponent={
            <RNView style={styles.head}>
              <RNText style={styles.workspace} numberOfLines={1}>{tree.workspace.name || 'Personal'}</RNText>
              <RNText style={styles.dim}>
                {tree.people.length} {tree.people.length === 1 ? 'person' : 'people'} · {roleCount} role{roleCount === 1 ? '' : 's'}
              </RNText>
              {roleCount === 0 && (
                <RNText style={styles.hint}>No roles yet. A role is a standing agent that looks after part of the work; hire one from the org page on the web.</RNText>
              )}
            </RNView>
          }
          contentContainerStyle={{ paddingBottom: Spacing.xxxl }}
        />
      )}
    </>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.bg },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md, padding: Spacing.xxl, backgroundColor: Theme.bg },
  emptyText: { fontSize: 13, color: Theme.textMuted, textAlign: 'center', lineHeight: 19 },
  retry: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.border },
  retryText: { fontSize: 13, fontWeight: '600', color: Theme.text },
  head: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg, paddingBottom: Spacing.sm, gap: 3 },
  workspace: { fontSize: 20, fontWeight: '700', color: Theme.text },
  hint: { marginTop: Spacing.sm, fontSize: 12.5, lineHeight: 18, color: Theme.textMuted },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingRight: Spacing.lg, paddingVertical: 9 },
  personRow: { marginTop: Spacing.md, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight },
  sessionRow: { paddingVertical: 7 },
  rowBody: { flex: 1, minWidth: 0 },
  metaLine: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  personName: { fontSize: 15, fontWeight: '700', color: Theme.text },
  roleName: { fontSize: 14, fontWeight: '600', color: Theme.text, flexShrink: 1 },
  handle: { fontSize: 11, color: Theme.violet },
  standing: { fontSize: 12, marginTop: 2 },
  dim: { fontSize: 11, color: Theme.textDim },
  rail: { width: 3, alignSelf: 'stretch', borderRadius: 2 },
  anchorFace: { width: 30, height: 30, borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 7, height: 7, borderRadius: 3.5, marginLeft: 1 },
  sessionTitle: { flex: 1, fontSize: 13, color: Theme.textSecondary },
  fold: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 6 },
  foldCount: { fontSize: 11, color: Theme.textDim, fontVariant: ['tabular-nums'] },
}));

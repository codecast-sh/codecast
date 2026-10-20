// The phone's search, the twin of web's /search page: one field finds every
// kind of thing (conversations, to-dos, plans, notes, routines, projects,
// goals, roles, people, pages, chat). Both surfaces draw the same search
// (web's hooks/useUniversalSearch), so they agree on what a query finds.
//
// On a phone the kinds are a row of chips with their counts, the filters live
// in a sheet behind one button that counts what narrows, and the results are
// one virtualized list: under All each kind shows a few rows and the way to
// the rest; a kind's own chip lists it in full.
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, SectionList, StyleSheet, View as RNView } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import {
  NO_SEARCH_FILTERS, SEARCH_KIND_CAP, SEARCH_PAGE_SIZE, SEARCH_RANGES, activeFilterCount, useUniversalSearch,
  type SearchFilters, type SearchRange,
} from '@codecast/web/hooks/useUniversalSearch';
import { objectKindLabel, type ObjectHit as ObjectHitRow, type ObjectKind } from '@codecast/web/hooks/useObjectSearch';
import type { SessionSearchRow } from '@codecast/web/lib/instantSessionSearch';
import { useAssistantScope, useModeWords, useSurface } from '@codecast/web/lib/surfaces';
import { memberAvatarUrl, memberDisplayName } from '@codecast/web/lib/liveEntities';
import { CODECAST_BASE_URL } from '@codecast/shared/entities';
import { Text as RNText } from '@/components/Themed';
import { BottomSheet } from '@/components/BottomSheet';
import { ChatAvatar } from '@/components/chat/MessageRow';
import { SessionListSkeleton } from '@/components/SkeletonLoader';
import { useActiveTeamFeature } from '@/lib/teamFeatures';
import { mobileRouteForUrl, openWebPage } from '@/lib/links';
import { CHROME_FONT_CAP, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { SessionHit } from './SessionHit';
import { ObjectHit } from './ObjectHit';
import { MessageSnippet } from './MessageSnippet';

/** What the list shows: everything, conversations, chat, or one kind of object. */
type Tab = 'all' | 'sessions' | 'chat' | ObjectKind;
/** Rows each kind shows under All before its link to the rest. */
const ALL_CAP = 3;
/** Conversations, first under All, show a few more before theirs. */
const SESSION_ALL_CAP = 5;

type Item =
  | { t: 'object'; key: string; hit: ObjectHitRow }
  | { t: 'chat'; key: string; hit: any }
  | { t: 'session'; key: string; row: SessionSearchRow };
type Section = { key: Tab; label: string; count: number | string; more: boolean; note?: string; data: Item[] };

const tap = () => { void Haptics.selectionAsync(); };

/** One kind's chip: its name and how many it found. */
const KindChip = memo(function KindChip({ label, count, active, onPress }: { label: string; count?: number | string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]} hitSlop={{ top: 6, bottom: 6 }} accessibilityRole="tab" accessibilityState={{ selected: active }}>
      <RNText style={[styles.chipText, active && styles.chipTextActive]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{label}</RNText>
      {count != null && count !== 0 && <RNText style={[styles.chipCount, active && styles.chipCountActive]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{count}</RNText>}
    </Pressable>
  );
});

/** A filter as a row of choices, one lit. */
function FilterGroup<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { key: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <RNView style={styles.filterGroup}>
      <RNText style={styles.filterLabel} maxFontSizeMultiplier={CHROME_FONT_CAP}>{label}</RNText>
      <RNView style={styles.filterOptions}>
        {options.map((o) => {
          const on = o.key === value;
          return (
            <Pressable key={o.key} onPress={() => { tap(); onChange(o.key); }} style={[styles.option, on && styles.optionOn]} accessibilityRole="radio" accessibilityState={{ selected: on }}>
              <RNText style={[styles.optionText, on && styles.optionTextOn]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{o.label}</RNText>
            </Pressable>
          );
        })}
      </RNView>
    </RNView>
  );
}

export function SearchResults({ query, onOpenSession }: {
  query: string;
  /** Opens a conversation, at a message when one is named. */
  onOpenSession: (conversationId: string, messageId?: string) => void;
}) {
  const Theme = useTheme();
  const router = useRouter();
  const words = useModeWords();
  // Hosted mode searches in plain words: no team or role scopes, one filter.
  const internals = useSurface('search.internals');
  const { only: scopeOnly } = useAssistantScope();
  const chatOn = useActiveTeamFeature('chat');
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id ?? null);

  const [tab, setTabState] = useState<Tab>('all');
  const [filters, setFilters] = useState<SearchFilters>(NO_SEARCH_FILTERS);
  const [limit, setLimit] = useState(SEARCH_PAGE_SIZE);
  const [sheet, setSheet] = useState(false);
  const listRef = useRef<SectionList<Item, Section>>(null);

  const search = useUniversalSearch(query, filters, {
    limit,
    scopeOnly,
    chatTeamId: chatOn ? activeTeamId : null,
    chatLimit: tab === 'chat' ? 30 : 10,
  });
  const { searchActive, searchData, searchError, sessionRows, objectGroups, chatHits, highlight, totalSessions, remaining } = search;

  const setTab = useCallback((next: Tab) => {
    tap();
    setTabState(next);
    setLimit(SEARCH_PAGE_SIZE);
    // Before the new list lays out, so the jump is never seen.
    listRef.current?.getScrollResponder()?.scrollTo({ y: 0, animated: false });
  }, []);
  const patch = useCallback((p: Partial<SearchFilters>) => { setFilters((f) => ({ ...f, ...p })); setLimit(SEARCH_PAGE_SIZE); }, []);

  const openObject = useCallback((hit: ObjectHitRow) => {
    const route = hit.external ? null : mobileRouteForUrl(hit.href);
    if (route) router.push(route as never);
    // A kind the phone has no screen for yet opens its web page in the sheet.
    else void openWebPage(/^https?:/i.test(hit.href) ? hit.href : `${CODECAST_BASE_URL}${hit.href}`);
  }, [router]);
  const openChat = useCallback((permalink: string) => {
    const route = mobileRouteForUrl(permalink);
    if (route) router.push(route as never);
  }, [router]);

  const countOf = (n: number) => (n >= SEARCH_KIND_CAP ? `${SEARCH_KIND_CAP}+` : n);
  const tabs = useMemo(() => {
    const list: { key: Tab; label: string; count?: number | string }[] = [
      { key: 'all', label: 'All' },
      { key: 'sessions', label: words.conversations, count: totalSessions },
      ...objectGroups.map((g) => ({ key: g.kind as Tab, label: g.label, count: countOf(g.hits.length) })),
      ...(chatHits.length > 0 ? [{ key: 'chat' as Tab, label: 'Chat', count: chatHits.length }] : []),
    ];
    // The kind in view keeps its chip when a new query empties it, so the row never jumps.
    if (!list.some((t) => t.key === tab)) list.push({ key: tab, label: tab === 'chat' ? 'Chat' : objectKindLabel(tab as ObjectKind, words) });
    return list;
  }, [words, totalSessions, objectGroups, chatHits.length, tab]);

  const sections = useMemo(() => {
    const all = tab === 'all';
    const out: Section[] = [];
    // Conversations lead: they are what a search here is most often for.
    if ((all || tab === 'sessions') && sessionRows.length > 0) {
      // The recent tier bounds message matches to a trailing window; titles
      // cover all time. Worth saying only where the range asked reaches past it.
      const windowDays = searchData?.contentWindowDays ?? 30;
      const pastWindow = filters.range === 'all' || filters.range === '90d' || (filters.range === '30d' && windowDays < 30);
      out.push({
        key: 'sessions', label: words.conversations, count: totalSessions, more: all && (sessionRows.length > SESSION_ALL_CAP || remaining > 0),
        note: internals && searchData?.contentTier === 'recent' && pastWindow ? `Messages from the last ${windowDays} days. Older ones match by title.` : undefined,
        data: (all ? sessionRows.slice(0, SESSION_ALL_CAP) : sessionRows).map((row) => ({ t: 'session' as const, key: `session:${row.conversationId}`, row })),
      });
    }
    for (const g of objectGroups) {
      if (!all && tab !== g.kind) continue;
      out.push({
        key: g.kind, label: g.label, count: countOf(g.hits.length), more: all && g.hits.length > ALL_CAP,
        data: (all ? g.hits.slice(0, ALL_CAP) : g.hits).map((hit) => ({ t: 'object' as const, key: `${g.kind}:${hit.key}`, hit })),
      });
    }
    if ((all || tab === 'chat') && chatHits.length > 0) {
      out.push({
        key: 'chat', label: 'Chat', count: chatHits.length, more: all && chatHits.length > ALL_CAP,
        data: (all ? chatHits.slice(0, ALL_CAP) : chatHits).map((hit) => ({ t: 'chat' as const, key: `chat:${hit._id}`, hit })),
      });
    }
    return out;
  }, [tab, objectGroups, chatHits, sessionRows, totalSessions, remaining, words.conversations, searchData, filters.range, internals]);

  const memberById = useMemo(() => {
    const members = ((useInboxStore.getState() as any).teamMembers ?? []) as any[];
    return new Map(members.map((m) => [String(m._id), m]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatHits]);

  const renderItem = useCallback(({ item }: { item: Item }) => {
    if (item.t === 'object') return <ObjectHit hit={item.hit} highlight={highlight} onPress={openObject} />;
    if (item.t === 'session') return <SessionHit row={item.row} highlight={highlight} maxMatches={tab === 'sessions' ? 3 : 2} onOpen={onOpenSession} />;
    const h = item.hit;
    const ext = h.external_author;
    const member = memberById.get(String(h.user_id));
    const name = ext?.name || memberDisplayName(member, 'Someone');
    return (
      <RNView style={styles.chatRow}>
        <MessageSnippet
          content={h.snippet ?? ''}
          timestamp={h.created_at}
          userText
          highlight={highlight}
          onPress={() => openChat(h.permalink)}
          who={(
            <>
              <ChatAvatar author={{ id: String(h.user_id), name, avatarUrl: ext?.avatar_url || memberAvatarUrl(member), slack: ext ? { isBot: !!ext.is_bot } : undefined }} size={16} />
              <RNText style={styles.chatName} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{name}</RNText>
              <RNText style={styles.chatWhere} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{h.channel_kind === 'dm' ? 'direct message' : `#${h.channel_name}`}</RNText>
            </>
          )}
        />
      </RNView>
    );
  }, [highlight, openObject, onOpenSession, openChat, memberById, tab]);

  const renderSectionHeader = useCallback(({ section }: { section: Section }) => {
    // A kind's own chip already names what the list holds.
    if (tab !== 'all' && !section.note) return null;
    return (
      <RNView style={styles.sectionHead}>
        {tab === 'all' && (
          <RNView style={styles.sectionTitleRow}>
            <RNText style={styles.sectionTitle} maxFontSizeMultiplier={CHROME_FONT_CAP}>{section.label}</RNText>
            <RNText style={styles.sectionCount} maxFontSizeMultiplier={CHROME_FONT_CAP}>{section.count}</RNText>
            {section.more && (
              <Pressable onPress={() => setTab(section.key)} hitSlop={10} style={styles.sectionMore} accessibilityRole="button" accessibilityLabel={`All ${section.count} ${section.label}`}>
                <RNText style={styles.sectionMoreText} maxFontSizeMultiplier={CHROME_FONT_CAP}>All {section.count}</RNText>
                <FontAwesome name="angle-right" size={13} color={Theme.textMuted0} />
              </Pressable>
            )}
          </RNView>
        )}
        {!!section.note && <RNText style={styles.sectionNote}>{section.note}</RNText>}
      </RNView>
    );
  }, [tab, setTab, Theme]);

  const narrowed = activeFilterCount(filters);
  const showsSessions = tab === 'all' || tab === 'sessions';
  const waiting = searchActive && !searchData && !searchError;
  const empty = sections.length === 0;

  return (
    <RNView style={styles.fill}>
      <RNView style={styles.bar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled" style={styles.fill}>
          {tabs.map((t) => <KindChip key={t.key} label={t.label} count={t.count} active={t.key === tab} onPress={() => setTab(t.key)} />)}
        </ScrollView>
        <Pressable onPress={() => { tap(); setSheet(true); }} style={[styles.filterBtn, narrowed > 0 && styles.filterBtnOn]} hitSlop={8} accessibilityRole="button" accessibilityLabel={narrowed ? `Filters, ${narrowed} on` : 'Filters'}>
          <FontAwesome name="sliders" size={14} color={narrowed > 0 ? Theme.cyan : Theme.textMuted} />
          {narrowed > 0 && <RNText style={styles.filterBtnCount} maxFontSizeMultiplier={CHROME_FONT_CAP}>{narrowed}</RNText>}
        </Pressable>
      </RNView>

      {search.queryErrors.length > 0 && (
        <RNView style={styles.errors}>
          {search.queryErrors.map((e) => <RNText key={e} style={styles.errorText}>{e}</RNText>)}
        </RNView>
      )}

      <SectionList
        ref={listRef}
        sections={sections}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        initialNumToRender={10}
        windowSize={9}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={showsSessions && waiting && sessionRows.length > 0 ? (
          <RNView style={styles.status}>
            <ActivityIndicator size="small" color={Theme.textMuted0} />
            <RNText style={styles.statusText}>Searching what was said…</RNText>
          </RNView>
        ) : showsSessions && searchError && !searchData && sessionRows.length > 0 ? (
          <RNView style={styles.status}>
            <RNText style={styles.statusText}>Message search timed out, so these matched by name. Try a more specific word.</RNText>
          </RNView>
        ) : null}
        ListEmptyComponent={waiting ? (
          <SessionListSkeleton count={5} />
        ) : (
          <RNView style={styles.empty}>
            <FontAwesome name="search" size={22} color={Theme.textMuted0} />
            <RNText style={styles.emptyTitle}>{searchError && showsSessions ? 'Search timed out' : `Nothing found for "${query.trim()}"`}</RNText>
            <RNText style={styles.emptyHint}>
              {searchError && showsSessions
                ? 'Try a more specific word, or narrow the time.'
                : narrowed > 0 || tab !== 'all' ? 'Try widening the filters, or different words.' : 'Try different words.'}
            </RNText>
            {(narrowed > 0 || tab !== 'all') && (
              <Pressable onPress={() => { setFilters(NO_SEARCH_FILTERS); setTab('all'); }} style={styles.emptyReset} hitSlop={8}>
                <RNText style={styles.emptyResetText}>Search everything</RNText>
              </Pressable>
            )}
          </RNView>
        )}
        ListFooterComponent={tab === 'sessions' && !empty && remaining > 0 ? (
          <Pressable onPress={() => { tap(); setLimit((l) => l + SEARCH_PAGE_SIZE); }} style={({ pressed }) => [styles.moreBtn, pressed && styles.moreBtnPressed]}>
            {search.isLoading ? <ActivityIndicator size="small" color={Theme.textMuted0} /> : <RNText style={styles.moreBtnText}>Show more ({remaining} remaining)</RNText>}
          </Pressable>
        ) : null}
      />

      <BottomSheet visible={sheet} onClose={() => setSheet(false)}>
        <RNView style={styles.sheetHead}>
          <RNText style={styles.sheetTitle}>Filters</RNText>
          {narrowed > 0 && (
            <Pressable onPress={() => { tap(); setFilters(NO_SEARCH_FILTERS); }} hitSlop={10}>
              <RNText style={styles.sheetReset}>Reset</RNText>
            </Pressable>
          )}
        </RNView>
        <FilterGroup<SearchRange> label="Time" value={filters.range} options={SEARCH_RANGES} onChange={(range) => patch({ range })} />
        {internals && (
          <>
            <FilterGroup label={words.conversations} value={filters.mineOnly ? 'mine' : 'all'} options={[{ key: 'all', label: 'Everyone' }, { key: 'mine', label: 'Only mine' }]} onChange={(v) => patch({ mineOnly: v === 'mine' })} />
            <FilterGroup label="Match in" value={filters.userOnly ? 'prompts' : 'all'} options={[{ key: 'all', label: 'Any message' }, { key: 'prompts', label: 'My prompts' }]} onChange={(v) => patch({ userOnly: v === 'prompts' })} />
            <FilterGroup label="Order" value={filters.sort} options={[{ key: 'recent', label: 'Recent' }, { key: 'relevance', label: 'Relevant' }]} onChange={(sort) => patch({ sort })} />
          </>
        )}
      </BottomSheet>
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  fill: { flex: 1 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Theme.bgAlt,
    paddingBottom: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
  },
  chips: { flexDirection: 'row', gap: 6, paddingLeft: Spacing.md, paddingRight: Spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 30,
    paddingHorizontal: 12,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: Theme.borderLight,
    backgroundColor: Theme.bg,
  },
  chipActive: { borderColor: Theme.text, backgroundColor: Theme.text },
  chipText: { fontSize: 13, fontWeight: '500', color: Theme.textMuted },
  chipTextActive: { color: Theme.bg, fontWeight: '600' },
  chipCount: { fontSize: 11, color: Theme.textMuted0, fontVariant: ['tabular-nums'] },
  chipCountActive: { color: Theme.bg, opacity: 0.7 },
  filterBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    height: 30,
    minWidth: 36,
    paddingHorizontal: 10,
    marginRight: Spacing.md,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: Theme.borderLight,
    backgroundColor: Theme.bg,
  },
  filterBtnOn: { borderColor: Theme.cyan, backgroundColor: Theme.cyan + '18' },
  filterBtnCount: { fontSize: 12, fontWeight: '700', color: Theme.cyan },
  errors: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm },
  errorText: { fontSize: 12, color: Theme.red },
  listContent: { paddingBottom: 120 },
  sectionHead: { paddingHorizontal: Spacing.lg, paddingTop: 18, paddingBottom: 4 },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  sectionTitle: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', color: Theme.textMuted },
  sectionCount: { fontSize: 11, color: Theme.textMuted0, fontVariant: ['tabular-nums'] },
  sectionMore: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 'auto' },
  sectionMoreText: { fontSize: 12, color: Theme.textMuted0 },
  sectionNote: { fontSize: 11, lineHeight: 15, color: Theme.textMuted0, marginTop: 2 },
  chatRow: { paddingHorizontal: 6 },
  chatName: { fontSize: 12, fontWeight: '600', color: Theme.text, flexShrink: 1 },
  chatWhere: { fontSize: 11, color: Theme.textMuted0, flexShrink: 1 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: Spacing.lg, paddingTop: Spacing.md },
  statusText: { flex: 1, fontSize: 12, lineHeight: 17, color: Theme.textMuted0 },
  empty: { alignItems: 'center', gap: 6, paddingTop: 72, paddingHorizontal: Spacing.xxl },
  emptyTitle: { fontSize: 15, fontWeight: '600', color: Theme.textMuted, textAlign: 'center', marginTop: 6 },
  emptyHint: { fontSize: 13, color: Theme.textMuted0, textAlign: 'center' },
  emptyReset: { marginTop: 10, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, borderWidth: 1, borderColor: Theme.borderLight },
  emptyResetText: { fontSize: 13, fontWeight: '600', color: Theme.text },
  moreBtn: { alignItems: 'center', justifyContent: 'center', minHeight: 48, marginHorizontal: Spacing.lg, marginTop: Spacing.md, borderRadius: 12, backgroundColor: Theme.bgAlt },
  moreBtnPressed: { backgroundColor: Theme.bgHighlight },
  moreBtnText: { fontSize: 14, fontWeight: '500', color: Theme.textMuted },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
  sheetTitle: { fontSize: 17, fontWeight: '700', color: Theme.text },
  sheetReset: { fontSize: 14, fontWeight: '600', color: Theme.cyan },
  filterGroup: { paddingHorizontal: Spacing.lg, paddingVertical: 10 },
  filterLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', color: Theme.textMuted0, marginBottom: 8 },
  filterOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 18, borderWidth: 1, borderColor: Theme.borderLight, backgroundColor: Theme.bg },
  optionOn: { borderColor: Theme.text, backgroundColor: Theme.text },
  optionText: { fontSize: 14, fontWeight: '500', color: Theme.textMuted },
  optionTextOn: { color: Theme.bg, fontWeight: '600' },
}));

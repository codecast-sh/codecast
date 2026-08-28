import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import {
  Animated,
  Easing,
  FlatList,
  KeyboardAvoidingView,
  LayoutAnimation,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { Text, TextInput } from '@/components/Themed';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  filterNavigatorRows,
  formatTimeAgo,
  matchIndex,
  matchSnippet,
  navigatorHeaderLabels,
  MACHINE_KIND_LABEL,
  type HiddenKind,
  type NavigatorRow,
} from '@codecast/web/lib/messageNavigator';
import { Mono } from '../../constants/fonts';
import { CHROME_FONT_CAP, Spacing, Theme, chipShell, chipText, chipTint } from '../../constants/Theme';

// The mobile form of the web message navigator popover
// (packages/web/components/MessageBrowserPopover.tsx). Rows and filtering come
// from the shared module; this file owns only the sheet chrome, the search and
// chip state, and the inline expansion a long press triggers.

const KIND_ICON: Record<HiddenKind, ComponentProps<typeof FontAwesome>['name']> = {
  schedule: 'clock-o',
  session: 'arrow-right',
  continue: 'refresh',
  chat: 'comment-o',
  teammate: 'users',
};

// Modal animationType="slide" would slide the whole transparent container, so
// the dim backdrop would enter from the bottom edge with the sheet. The sheet
// owns its motion instead: backdrop fades, sheet translates.
const ENTER_BACKDROP_MS = 150;
const ENTER_SHEET_MS = 250;
const EXIT_MS = 180;
const EXPAND_ANIM_MS = 180;

// One motion for every height change inside the sheet (a row expanding, the
// hidden chip revealing rows) so the top edge eases over 180ms instead of
// snapping in one frame.
function animateSheetHeight() {
  LayoutAnimation.configureNext(
    LayoutAnimation.create(EXPAND_ANIM_MS, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity),
  );
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function MessageNavigatorSheet({
  visible,
  onClose,
  rows,
  currentMessageId,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  rows: NavigatorRow[];
  currentMessageId: string | null;
  onSelect: (id: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [search, setSearch] = useState('');
  // Hidden kinds start hidden: the list is first a navigator for the human's
  // own prompts; the chip reveals the machine rows on demand (web semantics).
  const [showHidden, setShowHidden] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const listRef = useRef<FlatList<NavigatorRow>>(null);
  // Height of the list while no query is active. A query narrows the rows
  // per keystroke, and the sheet hugs its rows, so without a floor the top
  // edge would bounce under the finger; the held height keeps the frame
  // still (and the empty state inside it) until the query clears.
  const listHeightRef = useRef(0);
  const searchActive = search.trim().length > 0;

  // The Modal stays visible through the exit animation: `mounted` trails
  // `visible` by one exit so the sheet can slide out instead of vanishing.
  const [mounted, setMounted] = useState(visible);
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  // 0 = in place, 1 = offscreen below (interpolated against the window height).
  const sheetShift = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      const anim = Animated.parallel([
        Animated.timing(backdropOpacity, { toValue: 1, duration: ENTER_BACKDROP_MS, useNativeDriver: true }),
        Animated.timing(sheetShift, { toValue: 0, duration: ENTER_SHEET_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]);
      anim.start();
      return () => anim.stop();
    }
    const anim = Animated.parallel([
      Animated.timing(backdropOpacity, { toValue: 0, duration: EXIT_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
      Animated.timing(sheetShift, { toValue: 1, duration: EXIT_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
    ]);
    anim.start(({ finished }) => {
      if (finished) setMounted(false);
    });
    return () => anim.stop();
  }, [visible, backdropOpacity, sheetShift]);

  // The Modal stays mounted across opens, so search, chip and expansion state
  // would otherwise leak from one visit (or conversation) into the next; the
  // web popover gets the same reset for free by unmounting. Reset once the
  // exit slide has finished so it never shows the list changing.
  useEffect(() => {
    if (mounted) return;
    setSearch('');
    setShowHidden(false);
    setExpandedIds(new Set());
  }, [mounted]);

  const labels = useMemo(() => navigatorHeaderLabels(rows), [rows]);
  // Inverted list: index 0 renders at the bottom, so the newest prompt sits
  // next to the thumb.
  const data = useMemo(
    () => filterNavigatorRows(rows, { search: search.trim(), showHidden }).slice().reverse(),
    [rows, search, showHidden],
  );

  // Ref twins so the open effect and the scroll retry read the latest list
  // without re-running on data churn.
  const dataRef = useRef(data);
  dataRef.current = data;
  const currentIdRef = useRef(currentMessageId);
  currentIdRef.current = currentMessageId;
  const scrollRetryRef = useRef<{ index: number; count: number }>({ index: -1, count: 0 });

  // The inverted list always opens at the newest prompt (index 0). In a long
  // thread the current row — the one that orients the reader — can sit far
  // off screen, so pre-scroll to it before the slide finishes. Skip when it
  // is already within reach of the bottom.
  useEffect(() => {
    if (!visible) return;
    const currentId = currentIdRef.current;
    if (!currentId) return;
    const index = dataRef.current.findIndex((r) => r._id === currentId);
    if (index <= 6) return;
    const frame = requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  const select = useCallback((id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
    onSelect(id);
  }, [onClose, onSelect]);

  const toggleExpanded = useCallback((id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    animateSheetHeight();
    const expanding = !expandedIds.has(id);
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    if (!expanding) return;
    // The inverted list grows an expanding row upward, which can push its
    // header line past the visible top; once the height change settles, pull
    // the row back into view (viewPosition 1 = top edge in an inverted list).
    const item = data.find((r) => r._id === id);
    if (!item) return;
    setTimeout(() => {
      listRef.current?.scrollToItem({ item, viewPosition: 1, animated: true });
    }, EXPAND_ANIM_MS + 20);
  }, [expandedIds, data]);

  const toggleHidden = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    animateSheetHeight();
    setShowHidden((v) => !v);
  }, []);

  const renderItem = useCallback(({ item }: { item: NavigatorRow }) => (
    <NavigatorRowView
      row={item}
      current={item._id === currentMessageId}
      expanded={expandedIds.has(item._id)}
      search={search}
      onPress={select}
      onLongPress={toggleExpanded}
    />
  ), [currentMessageId, expandedIds, search, select, toggleExpanded]);

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      onRequestClose={onClose}
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']}
    >
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* The dim layer is separate from the touch backdrop so it can fade
            without fading the sheet with it. */}
        <Animated.View pointerEvents="none" style={[styles.dim, { opacity: backdropOpacity }]} />
        {/* accessible={false} on both Pressables: a Pressable defaults to
            accessible, which would flatten the whole sheet into one VoiceOver
            element and make the search, chip and rows unreachable. Close stays
            reachable via onRequestClose (two finger scrub / back). */}
        <Pressable style={styles.backdrop} onPress={onClose} accessible={false}>
          <AnimatedPressable
            style={[
              styles.sheet,
              {
                paddingBottom: insets.bottom + 8,
                transform: [{ translateY: sheetShift.interpolate({ inputRange: [0, 1], outputRange: [0, windowHeight] }) }],
              },
            ]}
            onPress={() => {}}
            accessible={false}
          >
            <View style={styles.grabber} />
            <View style={styles.headerRow}>
              <View style={styles.searchInputRow}>
                <FontAwesome name="search" size={14} color={Theme.textMuted0} style={{ marginRight: 8 }} />
                <TextInput
                  style={styles.searchInput}
                  value={search}
                  onChangeText={setSearch}
                  placeholder={labels.placeholder}
                  placeholderTextColor={Theme.textMuted0}
                  returnKeyType="search"
                  autoCorrect={false}
                  autoCapitalize="none"
                  accessibilityLabel="Search messages"
                />
                {search.length > 0 && (
                  <TouchableOpacity onPress={() => setSearch('')} hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }} accessibilityLabel="Clear search">
                    <FontAwesome name="times-circle" size={16} color={Theme.textMuted0} />
                  </TouchableOpacity>
                )}
              </View>
              {labels.hiddenCount > 0 && (
                <TouchableOpacity
                  style={[styles.chip, showHidden ? chipTint(Theme.violet) : styles.chipOff]}
                  onPress={toggleHidden}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityState={{ selected: showHidden }}
                  accessibilityLabel={`${showHidden ? 'Hide' : 'Show'} ${labels.chipLabel}`}
                >
                  <FontAwesome name="bolt" size={10} color={showHidden ? Theme.violet : Theme.textDim} />
                  <Text
                    style={[styles.chipText, showHidden ? styles.chipTextOn : styles.chipTextOff]}
                    maxFontSizeMultiplier={CHROME_FONT_CAP}
                    numberOfLines={1}
                  >
                    {labels.chipLabel}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
            <FlatList
              ref={listRef}
              data={data}
              inverted
              keyExtractor={(r) => r._id}
              renderItem={renderItem}
              extraData={expandedIds}
              onLayout={(e) => {
                if (!searchActive) listHeightRef.current = e.nativeEvent.layout.height;
              }}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              onScrollToIndexFailed={(info) => {
                // A far scrollToIndex (the open pre-scroll above) can point
                // past highestMeasuredFrameIndex. Same recovery as the
                // screen's list: land near the target with an estimated
                // offset, then retry the precise scroll, capped per index.
                const retry = scrollRetryRef.current;
                if (retry.index === info.index) retry.count += 1;
                else scrollRetryRef.current = { index: info.index, count: 1 };
                if (scrollRetryRef.current.count > 3) return;
                listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
                setTimeout(() => {
                  if (info.index >= dataRef.current.length) return;
                  listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.5, animated: false });
                }, 250);
              }}
              // Hug the content: a short list collapses the sheet to its rows
              // (the sheet caps at 78%); shrink lets a long list stay inside
              // the cap and scroll instead of overflowing it.
              style={[styles.list, searchActive && { minHeight: listHeightRef.current }]}
              contentContainerStyle={data.length === 0 ? styles.emptyContainer : undefined}
              ListEmptyComponent={
                <Text style={styles.emptyText}>
                  {rows.length === 0 ? 'No messages' : 'No matching messages'}
                </Text>
              }
            />
          </AnimatedPressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function NavigatorRowView({
  row,
  current,
  expanded,
  search,
  onPress,
  onLongPress,
}: {
  row: NavigatorRow;
  current: boolean;
  expanded: boolean;
  search: string;
  onPress: (id: string) => void;
  onLongPress: (id: string) => void;
}) {
  const hidden = row.kind !== 'user';
  const timeAgo = formatTimeAgo(row.timestamp);
  const ordinalLabel = hidden ? MACHINE_KIND_LABEL[row.kind as HiddenKind] : `#${row.originalIndex + 1}`;
  // While searching, start the clamped body near the first hit and tint the
  // hit, so a row shows why it matched. An expanded row keeps its full text.
  const query = search.trim();
  const body = query && !expanded ? matchSnippet(row.display, query) : row.display;
  const hit = query ? matchIndex(body, query) : -1;
  return (
    <TouchableOpacity
      style={[styles.row, current && styles.rowCurrent, hidden && styles.rowHidden]}
      activeOpacity={0.6}
      onPress={() => onPress(row._id)}
      onLongPress={() => onLongPress(row._id)}
      delayLongPress={300}
      accessibilityRole="button"
      accessibilityLabel={`${ordinalLabel}${row.source ? ` from ${row.source}` : ''}, ${row.display || ordinalLabel}, ${timeAgo}`}
      accessibilityHint={expanded ? 'Long press to collapse' : 'Long press to show full text'}
      accessibilityState={{ selected: current, expanded }}
    >
      <View style={styles.ordinalCol}>
        {hidden ? (
          <FontAwesome name={KIND_ICON[row.kind as HiddenKind]} size={11} color={Theme.violet} />
        ) : (
          <Text
            style={[styles.ordinal, current && styles.ordinalCurrent]}
            maxFontSizeMultiplier={CHROME_FONT_CAP}
          >
            {row.originalIndex + 1}
          </Text>
        )}
      </View>
      <View style={styles.body}>
        {hidden && (
          <Text style={styles.kindLine} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>
            {MACHINE_KIND_LABEL[row.kind as HiddenKind]}
            {row.source ? `  ${row.source}` : ''}
          </Text>
        )}
        {row.display.length > 0 && (
          <Text
            style={[styles.rowText, row.isCmd && styles.rowTextCmd, current && styles.rowTextCurrent]}
            numberOfLines={expanded ? undefined : 2}
          >
            {hit >= 0 ? (
              <>
                {body.slice(0, hit)}
                <Text style={styles.rowTextHit}>{body.slice(hit, hit + query.length)}</Text>
                {body.slice(hit + query.length)}
              </>
            ) : body}
          </Text>
        )}
      </View>
      <View style={styles.metaCol}>
        <Text style={styles.time} maxFontSizeMultiplier={CHROME_FONT_CAP}>{timeAgo}</Text>
        {row.commentCount > 0 && (
          <View style={styles.commentBadge}>
            <FontAwesome name="comment-o" size={9} color={Theme.cyan} />
            <Text style={styles.commentCount} maxFontSizeMultiplier={CHROME_FONT_CAP}>{row.commentCount}</Text>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: {
    flexGrow: 0,
    flexShrink: 1,
  },
  dim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '78%',
    backgroundColor: Theme.cardBg,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 8,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Theme.border,
    opacity: 0.5,
    marginBottom: 10,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    // Scrolled rows clip mid line against the header; the hairline (same
    // token as the row dividers) and the extra padding make the boundary
    // read as a surface edge rather than an accidental crop.
    paddingBottom: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.border + '40',
  },
  searchInputRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Theme.bg,
    borderRadius: 10,
    paddingHorizontal: Spacing.md,
    height: 34,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: Theme.text,
    paddingVertical: 0,
  },
  chip: {
    ...chipShell,
    height: 28,
  },
  chipOff: {
    borderColor: Theme.border + '60',
  },
  chipText: {
    ...chipText,
    fontVariant: ['tabular-nums'],
  },
  chipTextOn: {
    color: Theme.violet,
  },
  chipTextOff: {
    color: Theme.textDim,
    textDecorationLine: 'line-through',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    // Thumb surface: 12 + 18 line height + 12 keeps a single-line row near
    // the 44pt touch guideline (web is denser because it is a pointer surface).
    paddingVertical: 12,
    paddingHorizontal: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.border + '40',
  },
  rowCurrent: {
    backgroundColor: Theme.cyan + '14',
  },
  rowHidden: {
    opacity: 0.7,
  },
  ordinalCol: {
    width: 28,
    alignItems: 'flex-end',
    paddingTop: 2,
  },
  ordinal: {
    fontSize: 11,
    fontWeight: '500',
    color: Theme.blue,
    fontVariant: ['tabular-nums'],
  },
  ordinalCurrent: {
    color: Theme.cyan,
    fontWeight: '700',
  },
  body: {
    flex: 1,
    gap: 2,
  },
  kindLine: {
    fontSize: 10,
    color: Theme.violet,
  },
  rowText: {
    fontSize: 13,
    lineHeight: 18,
    color: Theme.text,
  },
  rowTextCmd: {
    fontFamily: Mono.medium,
    color: Theme.orange,
  },
  rowTextCurrent: {
    color: Theme.cyan,
  },
  rowTextHit: {
    color: Theme.blue,
    fontWeight: '600',
  },
  metaCol: {
    alignItems: 'flex-end',
    gap: 3,
    paddingTop: 2,
  },
  time: {
    fontSize: 10,
    color: Theme.textDim,
    fontVariant: ['tabular-nums'],
  },
  commentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  commentCount: {
    fontSize: 10,
    color: Theme.cyan,
  },
  emptyContainer: {
    flex: 1,
    // The list hugs its content, so an empty list no longer fills the sheet;
    // the floor keeps the empty state a centered block rather than a sliver.
    minHeight: 160,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 13,
    color: Theme.textDim,
    textAlign: 'center',
    paddingVertical: Spacing.xxl,
  },
});

import { useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  LayoutAnimation,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { Text, TextInput } from '@/components/Themed';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  filterNavigatorRows,
  formatTimeAgo,
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
  const [search, setSearch] = useState('');
  // Hidden kinds start hidden: the list is first a navigator for the human's
  // own prompts; the chip reveals the machine rows on demand (web semantics).
  const [showHidden, setShowHidden] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  // The Modal stays mounted across opens, so search, chip and expansion state
  // would otherwise leak from one visit (or conversation) into the next; the
  // web popover gets the same reset for free by unmounting. Reset on close so
  // the exit slide never shows the list changing.
  useEffect(() => {
    if (visible) return;
    setSearch('');
    setShowHidden(false);
    setExpandedIds(new Set());
  }, [visible]);

  const labels = useMemo(() => navigatorHeaderLabels(rows), [rows]);
  // Inverted list: index 0 renders at the bottom, so the newest prompt sits
  // next to the thumb.
  const data = useMemo(
    () => filterNavigatorRows(rows, { search: search.trim(), showHidden }).slice().reverse(),
    [rows, search, showHidden],
  );

  const select = useCallback((id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
    onSelect(id);
  }, [onClose, onSelect]);

  const toggleExpanded = useCallback((id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Ease the row height change so the 2 line clamp opens and closes over
    // 180ms instead of snapping in one frame.
    LayoutAnimation.configureNext(
      LayoutAnimation.create(180, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity),
    );
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleHidden = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShowHidden((v) => !v);
  }, []);

  const renderItem = useCallback(({ item }: { item: NavigatorRow }) => (
    <NavigatorRowView
      row={item}
      current={item._id === currentMessageId}
      expanded={expandedIds.has(item._id)}
      onPress={select}
      onLongPress={toggleExpanded}
    />
  ), [currentMessageId, expandedIds, select, toggleExpanded]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']}
    >
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* accessible={false} on both Pressables: a Pressable defaults to
            accessible, which would flatten the whole sheet into one VoiceOver
            element and make the search, chip and rows unreachable. Close stays
            reachable via onRequestClose (two finger scrub / back). */}
        <Pressable style={styles.backdrop} onPress={onClose} accessible={false}>
          <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 8 }]} onPress={() => {}} accessible={false}>
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
              data={data}
              inverted
              keyExtractor={(r) => r._id}
              renderItem={renderItem}
              extraData={expandedIds}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              style={styles.fill}
              contentContainerStyle={data.length === 0 ? styles.emptyContainer : undefined}
              ListEmptyComponent={
                <Text style={styles.emptyText}>
                  {rows.length === 0 ? 'No messages' : 'No matching messages'}
                </Text>
              }
            />
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function NavigatorRowView({
  row,
  current,
  expanded,
  onPress,
  onLongPress,
}: {
  row: NavigatorRow;
  current: boolean;
  expanded: boolean;
  onPress: (id: string) => void;
  onLongPress: (id: string) => void;
}) {
  const hidden = row.kind !== 'user';
  const timeAgo = formatTimeAgo(row.timestamp);
  const ordinalLabel = hidden ? MACHINE_KIND_LABEL[row.kind as HiddenKind] : `#${row.originalIndex + 1}`;
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
            {row.display}
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
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  sheet: {
    height: '78%',
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
    paddingBottom: Spacing.sm,
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

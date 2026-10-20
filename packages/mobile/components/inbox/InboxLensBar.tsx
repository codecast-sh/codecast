import { useMemo, type ReactNode } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import Feather from '@expo/vector-icons/Feather';
import { labelHexColor } from '@/lib/labelColors';
import { projectColor } from '@/components/sessionFormat';
import { useSurface } from '@codecast/web/lib/surfaces';
import { useInboxPlacement } from '@/hooks/useInboxPlacement';
import {
  useInboxStore, computeChipCounts, convBucketMap, sortLabels, resolveInboxViewMode, type InboxViewMode,
} from '@codecast/web/store/inboxStore';

// The lens names as a segment says them. The two everyday lenses are always
// shown; any other lens picked in the slide-out panel's View joins them while
// it is the one in use, so the switch never hides what the list is showing.
const SEGMENT: Partial<Record<InboxViewMode, string>> = {
  grouped: 'Status',
  recent: 'Recent',
  time: 'Created',
  bucket: 'Label',
  plan: 'Plan',
  project: 'Project',
  goal: 'Goal',
};

/** The labels and projects that can narrow the inbox, with how many rows
 *  each holds, counted the way web's chips count them. Empty labels stay out
 *  unless one is the active filter. */
export function useInboxFilterCounts() {
  const { placed } = useInboxPlacement();
  const buckets = useInboxStore((s) => s.buckets);
  const bucketAssignments = useInboxStore((s) => s.bucketAssignments);
  const activeBucketFilter = useInboxStore((s) => s.activeBucketFilter);
  const bucketByConv = useMemo(() => convBucketMap(bucketAssignments), [bucketAssignments]);
  const { bucketCounts, projectCounts } = useMemo(() => computeChipCounts(placed.sorted, bucketByConv), [placed.sorted, bucketByConv]);
  const labels = useMemo(
    () => sortLabels(buckets).filter((b) => (bucketCounts[b._id] || 0) > 0 || activeBucketFilter === b._id),
    [buckets, bucketCounts, activeBucketFilter],
  );
  return { placed, labels, bucketCounts, projectCounts };
}

/** The bar under the inbox title: how the list is ordered (by status or
 *  most recent first) and which label narrows it, one tap each. Both write
 *  the shared inbox state the slide-out panel and the desktop read.
 *  `stacked` (a conversation's slide-out, which has no filter panel of its
 *  own) puts the order on its own row beside `accessory`, and the labels and
 *  projects on a full-width row under it. */
export function InboxLensBar({ stacked = false, accessory }: { stacked?: boolean; accessory?: ReactNode }) {
  const Theme = useTheme();
  const viewMode = useInboxStore((s) => resolveInboxViewMode(s.clientState?.ui));
  const activeBucketFilter = useInboxStore((s) => s.activeBucketFilter);
  const activeProjectFilter = useInboxStore((s) => s.activeProjectFilter);
  const gitChips = useSurface('gitChips');
  const { labels, bucketCounts, projectCounts } = useInboxFilterCounts();
  const projects = stacked && gitChips ? projectCounts : [];
  const segments: InboxViewMode[] = viewMode === 'grouped' || viewMode === 'recent' ? ['grouped', 'recent'] : ['grouped', 'recent', viewMode];
  const store = useInboxStore.getState;

  const segmentControl = (
    <View style={styles.segments} accessibilityRole="tablist">
      {segments.map((mode) => {
        const selected = mode === viewMode;
        return (
          <TouchableOpacity
            key={mode}
            style={[styles.segment, selected && styles.segmentSelected]}
            onPress={() => {
              if (selected) return;
              void Haptics.selectionAsync();
              store().setInboxViewMode(mode);
            }}
            activeOpacity={0.6}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>{SEGMENT[mode] ?? mode}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  const labelChips = labels.map((b) => {
    const selected = activeBucketFilter === b._id;
    return (
      <Chip
        key={b._id}
        mark={<View style={[styles.chipDot, { backgroundColor: labelHexColor(b.name) }]} />}
        name={b.name}
        count={bucketCounts[b._id] || 0}
        selected={selected}
        onPress={() => store().setActiveBucketFilter(selected ? null : b._id)}
      />
    );
  });
  const projectChips = projects.map(([name, count]) => {
    const selected = activeProjectFilter === name;
    const color = projectColor(name);
    return (
      <Chip
        key={`p:${name}`}
        mark={(
          <View style={[styles.projectMark, { backgroundColor: color + '26' }]}>
            <Text style={[styles.projectInitial, { color }]}>{name.charAt(0).toUpperCase()}</Text>
          </View>
        )}
        name={name}
        count={count}
        selected={selected}
        onPress={() => store().setActiveProjectFilter(selected ? null : name)}
      />
    );
  });
  // A stacked row is led by the glyph of what it holds, so the labels and
  // the projects read apart at a glance.
  const chipRow = (chips: ReactNode[], glyph?: keyof typeof Feather.glyphMap) => chips.length === 0 ? null : (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={stacked ? undefined : styles.chips}
      contentContainerStyle={[styles.chipsContent, stacked && styles.chipsContentStacked]}
    >
      {glyph && <Feather name={glyph} size={14} color={Theme.textMuted0} style={styles.rowGlyph} />}
      {chips}
    </ScrollView>
  );

  if (stacked) {
    return (
      <View style={styles.stack}>
        <View style={styles.stackRow}>
          {segmentControl}
          <View style={{ flex: 1 }} />
          {accessory}
        </View>
        {chipRow(labelChips, 'tag')}
        {chipRow(projectChips, 'folder')}
      </View>
    );
  }
  return (
    <View style={styles.bar}>
      {segmentControl}
      {chipRow(labelChips)}
    </View>
  );
}

function Chip({ mark, name, count, selected, onPress }: { mark: ReactNode; name: string; count: number; selected: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.chip, selected && styles.chipSelected]}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      {mark}
      <Text style={[styles.chipName, selected && styles.chipNameSelected]} numberOfLines={1}>{name}</Text>
      <Text style={styles.chipCount}>{count}</Text>
    </TouchableOpacity>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  stack: {
    gap: Spacing.sm,
    paddingBottom: Spacing.sm,
  },
  stackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.lg,
  },
  segments: {
    flexDirection: 'row',
    padding: 2,
    borderRadius: 9,
    backgroundColor: Theme.bgAlt,
  },
  segment: {
    paddingHorizontal: 10,
    height: 28,
    borderRadius: 7,
    justifyContent: 'center',
  },
  segmentSelected: {
    backgroundColor: Theme.bg,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  },
  segmentText: {
    fontSize: 13,
    color: Theme.textMuted,
  },
  segmentTextSelected: {
    color: Theme.text,
    fontWeight: '600',
  },
  chips: {
    flex: 1,
  },
  chipsContent: {
    gap: 6,
    alignItems: 'center',
    paddingRight: Spacing.lg,
  },
  chipsContentStacked: {
    paddingLeft: Spacing.lg,
  },
  rowGlyph: {
    marginRight: 2,
  },
  projectMark: {
    width: 16,
    height: 16,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  projectInitial: {
    fontSize: 10,
    fontWeight: '700',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    paddingHorizontal: 10,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
  },
  chipSelected: {
    backgroundColor: Theme.bgHighlight,
    borderColor: Theme.textMuted0,
  },
  chipDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  chipName: {
    fontSize: 13,
    color: Theme.text,
    maxWidth: 140,
  },
  chipNameSelected: {
    fontWeight: '600',
  },
  chipCount: {
    fontSize: 12,
    color: Theme.textMuted0,
    fontVariant: ['tabular-nums'],
  },
}));

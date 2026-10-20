import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { Text, TextInput } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { projectColor } from '@/components/SessionItem';
import { labelHexColor } from '@/lib/labelColors';
import { showActionSheet } from '@/lib/actionSheet';
import { setInboxDrawerOpen } from '@/lib/inboxDrawer';
import { useInboxFilterCounts } from '@/components/inbox/InboxLensBar';
import { DrawerHeading as Heading, DrawerRow as Row } from '@/components/nav/DrawerRow';
import { Places } from '@/components/nav/Places';
import { useSurface } from '@codecast/web/lib/surfaces';
import {
  useInboxStore, sortLabels, resolveInboxViewMode, type InboxViewMode,
} from '@codecast/web/store/inboxStore';

/** The inbox lenses, the same names and availability rules as web's
 *  GlobalSessionPanel: by label once a label exists, by plan once a session
 *  carries one. The pick writes the shared inbox_view_mode pref. */
export function inboxViewOptions(hasLabels: boolean, hasPlans: boolean): Array<{ key: InboxViewMode; label: string }> {
  return [
    { key: 'grouped', label: 'By status' },
    { key: 'recent', label: 'By updated' },
    { key: 'time', label: 'By created' },
    ...(hasLabels ? [{ key: 'bucket' as const, label: 'By label' }] : []),
    ...(hasPlans ? [{ key: 'plan' as const, label: 'By plan' }] : []),
  ];
}

// The find field shows once the two lists outgrow a screen.
const FIND_AT = 10;

/** The inbox's slide-out panel: every way to narrow the inbox (all, a label,
 *  a project) as a list with counts, the places that are not tabs, and the
 *  view lens. Picking a filter applies it and slides the inbox back. */
export function InboxDrawer() {
  const Theme = useTheme();
  const gitChips = useSurface('gitChips');
  const { placed, labels, bucketCounts, projectCounts } = useInboxFilterCounts();
  const buckets = useInboxStore((s) => s.buckets);
  const activeBucketFilter = useInboxStore((s) => s.activeBucketFilter);
  const activeProjectFilter = useInboxStore((s) => s.activeProjectFilter);
  const viewMode = useInboxStore((s) => resolveInboxViewMode(s.clientState?.ui));
  const [find, setFind] = useState('');

  const active = useMemo(() => placed.sorted.filter((s) => !s.is_deferred), [placed.sorted]);
  const projects = gitChips ? projectCounts : [];
  const q = find.trim().toLowerCase();
  const shownLabels = q ? labels.filter((b) => b.name.toLowerCase().includes(q)) : labels;
  const shownProjects = q ? projects.filter(([name]) => name.toLowerCase().includes(q)) : projects;
  const viewOptions = inboxViewOptions(sortLabels(buckets).length > 0, active.some((s) => !!(s as any).active_plan));
  const viewLabel = viewOptions.find((o) => o.key === viewMode)?.label ?? 'By status';

  const pick = (apply: () => void) => {
    void Haptics.selectionAsync();
    apply();
    setFind('');
    setInboxDrawerOpen(false);
  };
  const store = () => useInboxStore.getState();

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left']}>
      {labels.length + projects.length >= FIND_AT && (
        <View style={styles.findRow}>
          <Feather name="search" size={15} color={Theme.textMuted0} />
          <TextInput
            style={styles.findInput}
            value={find}
            onChangeText={setFind}
            placeholder="Find a project or label"
            placeholderTextColor={Theme.textMuted0}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
            returnKeyType="done"
          />
        </View>
      )}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        {!q && (
          <Row
            icon={<Feather name="inbox" size={17} color={Theme.text} />}
            name="All sessions"
            count={active.length}
            selected={!activeBucketFilter && !activeProjectFilter}
            onPress={() => pick(() => { store().setActiveBucketFilter(null); store().setActiveProjectFilter(null); })}
          />
        )}
        {!q && <Places onLeave={() => setInboxDrawerOpen(false)} />}
        {shownLabels.length > 0 && <Heading>Labels</Heading>}
        {shownLabels.map((b) => {
          const selected = activeBucketFilter === b._id;
          return (
            <Row
              key={b._id}
              icon={<Feather name="tag" size={16} color={labelHexColor(b.name)} />}
              name={b.name}
              count={bucketCounts[b._id] || 0}
              selected={selected}
              onPress={() => pick(() => store().setActiveBucketFilter(selected ? null : b._id))}
            />
          );
        })}
        {shownProjects.length > 0 && <Heading>Projects</Heading>}
        {shownProjects.map(([name, count]) => {
          const selected = activeProjectFilter === name;
          const color = projectColor(name);
          return (
            <Row
              key={name}
              icon={(
                <View style={[styles.projectMark, { backgroundColor: color + '26' }]}>
                  <Text style={[styles.projectInitial, { color }]}>{name.charAt(0).toUpperCase()}</Text>
                </View>
              )}
              name={name}
              count={count}
              selected={selected}
              onPress={() => pick(() => store().setActiveProjectFilter(selected ? null : name))}
            />
          );
        })}
        {q && shownLabels.length + shownProjects.length === 0 && (
          <Text style={styles.noMatch}>No project or label matches</Text>
        )}
      </ScrollView>
      <View style={styles.footer}>
        <Row
          icon={<Feather name="layers" size={16} color={Theme.textMuted} />}
          name="View"
          detail={viewLabel}
          onPress={() => showActionSheet('View', viewOptions.map((o) => ({
            label: o.label,
            selected: o.key === viewMode,
            onPress: () => pick(() => store().setInboxViewMode(o.key)),
          })))}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Theme.bgAlt,
  },
  findRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: Spacing.md,
    marginTop: Spacing.md,
    marginBottom: Spacing.xs,
    paddingHorizontal: 12,
    height: 40,
    borderRadius: 12,
    backgroundColor: Theme.bg,
  },
  findInput: {
    flex: 1,
    fontSize: 15,
    color: Theme.text,
    paddingVertical: 0,
  },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.sm,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.lg,
  },
  projectMark: {
    width: 24,
    height: 24,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  projectInitial: {
    fontSize: 13,
    fontWeight: '700',
  },
  noMatch: {
    fontSize: 14,
    color: Theme.textMuted0,
    paddingHorizontal: 12,
    paddingTop: 18,
  },
  footer: {
    paddingHorizontal: Spacing.sm,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.borderLight,
  },
}));

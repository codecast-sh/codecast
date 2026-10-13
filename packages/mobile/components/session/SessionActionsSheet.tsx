// A session's "…" sheet. The few actions people reach for on a phone are
// tiles across the top (images, search, share, copy, huddle); everything else
// is a short grouped list under them, with setting the session aside last.
// One sheet, no "More…" step: a group that has nothing to offer is left out.
import { useRef, type ComponentProps } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/Themed';
import { BottomSheet } from '@/components/BottomSheet';
import { themedStyles, useTheme } from '@/constants/Theme';

type IconName = ComponentProps<typeof Feather>['name'];

export type SessionTile = {
  key: string;
  label: string;
  icon: IconName;
  onPress: () => void;
  /** A count on the tile's corner (images, people in a huddle). */
  count?: number;
  /** Something live behind the tile: a huddle people are in. */
  live?: boolean;
};

export type SessionRow = {
  key: string;
  label: string;
  icon: IconName;
  onPress: () => void;
  /** The row's current value, right-aligned (the agent a session runs on). */
  value?: string;
  /** The row's state is on: a favorite, collapsed messages. */
  on?: boolean;
  destructive?: boolean;
};

export function SessionActionsSheet({ visible, onClose, tiles, groups }: {
  visible: boolean;
  onClose: () => void;
  tiles: SessionTile[];
  groups: SessionRow[][];
}) {
  const Theme = useTheme();
  const { height } = useWindowDimensions();
  // An action that opens its own modal (rename, the gallery, a picker) can
  // only present once this sheet has finished leaving, so it runs from the
  // sheet's dismissal on iOS; Android has no such rule.
  const pending = useRef<(() => void) | null>(null);
  const run = (fn: () => void) => {
    void Haptics.selectionAsync().catch(() => {});
    if (Platform.OS === 'ios') pending.current = fn;
    onClose();
    if (Platform.OS !== 'ios') fn();
  };
  const onDismiss = () => {
    const fn = pending.current;
    pending.current = null;
    fn?.();
  };
  const filled = groups.filter((g) => g.length > 0);

  return (
    <BottomSheet visible={visible} onClose={onClose} onDismiss={onDismiss}>
      <ScrollView style={{ maxHeight: height * 0.72 }} bounces={false} showsVerticalScrollIndicator={false}>
        {tiles.length > 0 && (
          <View style={styles.tiles}>
            {tiles.map((t) => (
              <Pressable
                key={t.key}
                onPress={() => run(t.onPress)}
                accessibilityRole="button"
                accessibilityLabel={t.count ? `${t.label}, ${t.count}` : t.label}
                style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
              >
                <View>
                  <Feather name={t.icon} size={20} color={t.live ? Theme.green : Theme.text} />
                  {t.count ? (
                    <View style={[styles.count, t.live && { backgroundColor: Theme.green }]}>
                      <Text style={styles.countText}>{t.count > 99 ? '99+' : t.count}</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={[styles.tileLabel, t.live && { color: Theme.green }]} numberOfLines={1}>{t.label}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {filled.map((group, gi) => (
          <View key={gi} style={styles.group}>
            {group.map((r, ri) => {
              const color = r.destructive ? Theme.red : Theme.text;
              return (
                <Pressable
                  key={r.key}
                  onPress={() => run(r.onPress)}
                  accessibilityRole="button"
                  accessibilityState={r.on === undefined ? undefined : { checked: r.on }}
                  style={({ pressed }) => [styles.row, ri > 0 && styles.rowRule, pressed && styles.pressed]}
                >
                  <Feather name={r.icon} size={17} color={r.on ? Theme.yellow : r.destructive ? Theme.red : Theme.textMuted} />
                  <Text style={[styles.rowLabel, { color }]} numberOfLines={1}>{r.label}</Text>
                  {r.value ? <Text style={styles.rowValue} numberOfLines={1}>{r.value}</Text> : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  tiles: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  tile: {
    flex: 1,
    alignItems: 'center',
    gap: 7,
    paddingTop: 14,
    paddingBottom: 10,
    borderRadius: 12,
    backgroundColor: Theme.bg,
  },
  tileLabel: { fontSize: 11.5, color: Theme.textMuted },
  count: {
    position: 'absolute',
    top: -6,
    right: -12,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Theme.blue,
  },
  countText: { fontSize: 10, fontWeight: '700', color: '#fff' },
  group: { borderRadius: 12, backgroundColor: Theme.bg, overflow: 'hidden', marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingHorizontal: 14 },
  rowRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight },
  rowLabel: { flex: 1, fontSize: 15 },
  rowValue: { fontSize: 13, color: Theme.textMuted0, maxWidth: 140 },
  pressed: { backgroundColor: Theme.bgHighlight },
}));

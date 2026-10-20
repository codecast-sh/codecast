import type { ReactNode } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Text } from '@/components/Themed';
import { themedStyles } from '@/constants/Theme';

/** A slide-out panel's section heading. */
export function DrawerHeading({ children }: { children: string }) {
  return <Text style={styles.heading} accessibilityRole="header">{children}</Text>;
}

/** One row of a slide-out panel: an icon, a name, and a count or a value. */
export function DrawerRow({ icon, name, count, detail, trailing, selected, onPress }: {
  icon: ReactNode;
  name: string;
  count?: number;
  detail?: string;
  trailing?: ReactNode;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.row, selected && styles.rowSelected]}
      onPress={onPress}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
    >
      <View style={styles.rowIcon}>{icon}</View>
      <Text style={[styles.rowName, selected && styles.rowNameSelected]} numberOfLines={1}>{name}</Text>
      {trailing}
      {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
      {count !== undefined ? <Text style={styles.rowCount}>{count}</Text> : null}
    </TouchableOpacity>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  heading: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: Theme.textMuted0,
    paddingHorizontal: 12,
    paddingTop: 22,
    paddingBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 48,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  rowSelected: {
    backgroundColor: Theme.bgHighlight,
  },
  rowIcon: {
    width: 26,
    alignItems: 'center',
  },
  rowName: {
    flex: 1,
    fontSize: 16,
    color: Theme.text,
  },
  rowNameSelected: {
    fontWeight: '600',
  },
  rowDetail: {
    fontSize: 14,
    color: Theme.textMuted,
  },
  rowCount: {
    fontSize: 14,
    color: Theme.textMuted0,
    fontVariant: ['tabular-nums'],
    minWidth: 24,
    textAlign: 'right',
  },
}));

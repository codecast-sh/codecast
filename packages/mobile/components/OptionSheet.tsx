import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { FontAwesome } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { BottomSheet } from '@/components/BottomSheet';
import { Text } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';

export type SheetOption = {
  key: string;
  label: string;
  hint?: string;
  /** Drawn weaker: offline, or a suggestion rather than a real pick. */
  dim?: boolean;
  leading?: ReactNode;
};

// A one-pick list in a bottom sheet: a row per option, the current one
// checked, and a tap picks and closes.
export function OptionSheet({
  visible,
  onClose,
  title,
  options,
  selectedKey,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  options: SheetOption[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const Theme = useTheme();
  const { height } = useWindowDimensions();
  const pick = (key: string) => {
    Haptics.selectionAsync();
    onClose();
    onSelect(key);
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={styles.title}>{title}</Text>
      <ScrollView style={{ maxHeight: height * 0.5 }}>
        {options.map((o) => {
          const active = o.key === selectedKey;
          return (
            <TouchableOpacity key={o.key} style={styles.row} activeOpacity={0.6} onPress={() => pick(o.key)}>
              {o.leading}
              <View style={[styles.rowText, o.dim && !active && styles.dim]}>
                <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>{o.label}</Text>
                {!!o.hint && <Text style={styles.hint} numberOfLines={1}>{o.hint}</Text>}
              </View>
              {active && <FontAwesome name="check" size={13} color={Theme.cyan} />}
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  title: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: Theme.textDim,
    marginTop: 6,
    marginBottom: 8,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  rowText: { flex: 1, minWidth: 0 },
  dim: { opacity: 0.5 },
  label: { fontSize: 15, fontWeight: '500', color: Theme.text },
  labelActive: { color: Theme.cyan, fontWeight: '600' },
  hint: { fontSize: 12, color: Theme.textMuted, marginTop: 1 },
}));

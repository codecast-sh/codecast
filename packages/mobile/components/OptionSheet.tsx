import { useEffect, useState, type ReactNode } from 'react';
import { Keyboard, ScrollView, StyleSheet, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { FontAwesome } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheet } from '@/components/BottomSheet';
import { Text, TextInput } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';

export type SheetOption = {
  key: string;
  label: string;
  hint?: string;
  /** Drawn weaker: offline, or a suggestion rather than a real recent. */
  dim?: boolean;
  leading?: ReactNode;
};

// A one-pick list in a bottom sheet. With `query` it grows a search field
// above the list; filtering is the caller's, so the sheet only draws what it
// is handed.
export function OptionSheet({
  visible,
  onClose,
  title,
  options,
  selectedKey,
  onSelect,
  query,
  onQueryChange,
  placeholder,
  emptyText,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  options: SheetOption[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  query?: string;
  onQueryChange?: (q: string) => void;
  placeholder?: string;
  emptyText?: string;
}) {
  const Theme = useTheme();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // The list takes what the screen has left above the keyboard, so a search
  // sheet never rides off the top while typing.
  const [keyboard, setKeyboard] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', (e) => setKeyboard(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboard(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const listMax = keyboard ? height - keyboard - insets.top - (onQueryChange ? 150 : 100) : height * 0.5;
  const pick = (key: string) => {
    Haptics.selectionAsync();
    onClose();
    onSelect(key);
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={styles.title}>{title}</Text>
      {onQueryChange && (
        <View style={styles.searchBox}>
          <FontAwesome name="search" size={13} color={Theme.textMuted0} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={onQueryChange}
            placeholder={placeholder}
            placeholderTextColor={Theme.textMuted0}
            autoFocus
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="done"
            onSubmitEditing={() => { if (options[0]) pick(options[0].key); }}
          />
        </View>
      )}
      <ScrollView style={{ maxHeight: listMax }} keyboardShouldPersistTaps="handled">
        {options.length === 0 && emptyText ? <Text style={styles.empty}>{emptyText}</Text> : null}
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
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    marginBottom: 6,
  },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 10, color: Theme.text },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  rowText: { flex: 1, minWidth: 0 },
  dim: { opacity: 0.5 },
  label: { fontSize: 15, fontWeight: '500', color: Theme.text },
  labelActive: { color: Theme.cyan, fontWeight: '600' },
  hint: { fontSize: 12, color: Theme.textMuted, marginTop: 1 },
  empty: { fontSize: 13, color: Theme.textMuted0, paddingVertical: 12 },
}));

import { ActionSheetIOS, Alert, Platform } from 'react-native';

export type SheetItem = {
  label: string;
  onPress: () => void;
  /** Renders a check before the label: the current pick in a picker sheet. */
  selected?: boolean;
  destructive?: boolean;
};

/** One menu of choices: the native action sheet on iOS, an alert elsewhere.
 *  Cancel is appended, so callers list only real choices. */
export function showActionSheet(title: string | undefined, items: SheetItem[]) {
  const labels = items.map((i) => (i.selected ? `✓ ${i.label}` : i.label));
  if (Platform.OS === 'ios') {
    const destructiveButtonIndex = items.flatMap((i, n) => (i.destructive ? [n] : []));
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [...labels, 'Cancel'], cancelButtonIndex: labels.length, destructiveButtonIndex, title },
      (index) => { if (index < items.length) items[index].onPress(); },
    );
    return;
  }
  Alert.alert(title ?? '', undefined, [
    ...items.map((i, n) => ({ text: labels[n], style: i.destructive ? 'destructive' as const : 'default' as const, onPress: i.onPress })),
    { text: 'Cancel', style: 'cancel' as const },
  ]);
}

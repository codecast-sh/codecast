import { Modal, Pressable, StyleSheet, View as RNView } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Text as RNText, TextInput } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';
import { Mono } from '@/constants/fonts';
import { create } from 'zustand';
import { copyToClipboard } from '@/lib/clipboard';

const useSelectText = create<{ text: string | null }>(() => ({ text: null }));

/** Opens the app's one Select text page on this text (a message as it reads). */
export function openSelectText(text: string) {
  // The menu that asked is still animating away; iOS will not present a page
  // over a sheet mid-dismissal, so open once it has gone.
  setTimeout(() => useSelectText.setState({ text }), 350);
}

/** Mounted once at the root: the page openSelectText shows. */
export function SelectTextHost() {
  const text = useSelectText((s) => s.text);
  return <SelectTextSheet text={text} onClose={() => useSelectText.setState({ text: null })} />;
}

/**
 * A page of text to pick a range out of, with the system's selection handles.
 * It is a read-only text view, not <Text selectable>: on iOS a selectable Text
 * offers only Copy for the whole block. Open with text; null closes it.
 */
export function SelectTextSheet({ text, onClose, textStyle }: {
  text: string | null;
  onClose: () => void;
  textStyle?: any;
}) {
  useTheme();
  return (
    <Modal visible={text !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <RNView style={styles.sheet}>
        <RNView style={styles.header}>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button">
            <RNText style={styles.action}>Done</RNText>
          </Pressable>
          <RNText style={styles.title}>Select text</RNText>
          <Pressable
            onPress={() => { if (text) { void copyToClipboard(text); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); onClose(); } }}
            hitSlop={10}
            accessibilityRole="button"
          >
            <RNText style={[styles.action, styles.actionStrong]}>Copy all</RNText>
          </Pressable>
        </RNView>
        <TextInput
          value={text ?? ''}
          editable={false}
          multiline
          scrollEnabled
          style={[styles.body, textStyle]}
          accessibilityLabel="Text to select"
        />
      </RNView>
    </Modal>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  sheet: { flex: 1, backgroundColor: Theme.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, height: 52, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.border },
  title: { fontSize: 15, fontFamily: Mono.semiBold, color: Theme.text },
  action: { fontSize: 15, color: Theme.textMuted },
  actionStrong: { color: Theme.accent ?? Theme.text, fontFamily: Mono.semiBold },
  body: { flex: 1, padding: 14, fontSize: 15, lineHeight: 24, color: Theme.text },
}));

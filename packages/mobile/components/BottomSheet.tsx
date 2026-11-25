import { useContext, useEffect, useRef, type ReactNode } from 'react';
import { NavigationContext } from '@react-navigation/native';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { themedStyles } from '@/constants/Theme';

// The slide-up sheet shell: dimmed backdrop that closes on tap, a rounded card
// with a grabber, safe-area padding, and keyboard avoidance so a sheet holding
// a text field rides above the keyboard. Content is the caller's. A sheet
// closes when its screen loses focus: a Modal draws above every screen, so a
// link or a notification that pushes another screen would otherwise land
// under it.
export function BottomSheet({
  visible,
  onClose,
  onDismiss,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  /** iOS: the sheet has finished sliding away, so another modal can open. */
  onDismiss?: () => void;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const nav = useContext(NavigationContext);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => (nav && visible ? nav.addListener('blur', () => close.current()) : undefined), [nav, visible]);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      onDismiss={onDismiss}
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']}
    >
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={onClose} accessible={false}>
          {/* Catches taps so they don't close the sheet, but is no element of its
              own: VoiceOver and UI tests reach each row inside. */}
          <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]} onPress={() => {}} accessible={false}>
            <View style={styles.grabber} />
            {children}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Closes a sheet, then runs what the pick opens. On iOS anything presented
 *  (a modal, the in-app browser) can only appear once the sheet has finished
 *  leaving, so the work waits for the sheet's dismissal; Android has no such
 *  rule. Pass `onDismiss` to the BottomSheet. */
export function useRunAfterDismiss(onClose: () => void) {
  const pending = useRef<(() => void) | null>(null);
  const run = (fn: () => void) => {
    if (Platform.OS === 'ios') pending.current = fn;
    onClose();
    if (Platform.OS !== 'ios') fn();
  };
  const onDismiss = () => {
    const fn = pending.current;
    pending.current = null;
    fn?.();
  };
  return { run, onDismiss };
}

const styles = themedStyles((Theme) => StyleSheet.create({
  fill: { flex: 1 },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  sheet: {
    backgroundColor: Theme.cardBg,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
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
}));

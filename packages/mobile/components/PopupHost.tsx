import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import {
  Animated, BackHandler, Easing, KeyboardAvoidingView, PanResponder, Platform, Pressable, StyleSheet,
  View, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { Text, TextInput } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { optionalNative } from '@/lib/optionalNative';
import { closePopup, orderedButtons, outsideTap, usePopups, type AlertButton, type Popup } from '@/lib/popups';

// A popup is drawn in its own window above everything, a modal screen or an
// open sheet included, the way a system alert is. A binary without the screens
// module draws it over the app's root instead.
const FullWindowOverlay: ComponentType<{ children: ReactNode }> | null = Platform.OS === 'ios'
  ? optionalNative('RNSModule', () => require('react-native-screens').FullWindowOverlay)
  : null;

/** Mounted once at the root: the popup at the head of lib/popups' queue. */
export function PopupHost() {
  const head = usePopups((s) => s.queue[0]);
  if (!head) return null;
  const body = <PopupView key={head.id} popup={head} />;
  return FullWindowOverlay ? <FullWindowOverlay>{body}</FullWindowOverlay> : body;
}

function PopupView({ popup }: { popup: Popup & { id: number } }) {
  const shown = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  const leaving = useRef(false);
  const sheet = popup.kind === 'sheet';

  useEffect(() => {
    if (popup.kind === 'alert' && popup.buttons.some((b) => b.style === 'destructive')) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    }
    Animated.timing(shown, {
      toValue: 1,
      duration: sheet ? 260 : 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one animation per popup
  }, []);

  /** Animate out, then take it down and run `then`. */
  const leave = (then?: () => void) => {
    if (leaving.current) return;
    leaving.current = true;
    Animated.timing(shown, { toValue: 0, duration: 160, easing: Easing.in(Easing.cubic), useNativeDriver: true })
      .start(() => closePopup(popup.id, then));
  };

  const tapOutside = () => {
    const t = outsideTap(popup);
    if (t.close) leave(t.run);
  };

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { tapOutside(); return true; });
    return () => sub.remove();
  });

  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => g.dy > 8 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_e, g) => drag.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_e, g) => {
      if (g.dy > 80 || g.vy > 1) tapOutside();
      else Animated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
    },
  })).current;

  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: shown }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={tapOutside} accessibilityLabel="Close" />
      </Animated.View>
      {popup.kind === 'sheet' ? (
        <View style={styles.sheetSlot} pointerEvents="box-none">
          <Animated.View
            {...pan.panHandlers}
            style={{
              transform: [
                { translateY: Animated.add(shown.interpolate({ inputRange: [0, 1], outputRange: [420, 0] }), drag) },
              ],
            }}
          >
            <SheetBody popup={popup} leave={leave} />
          </Animated.View>
        </View>
      ) : (
        <KeyboardAvoidingView
          style={styles.dialogSlot}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          pointerEvents="box-none"
        >
          <Animated.View
            style={{
              opacity: shown,
              transform: [{ scale: shown.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }],
            }}
          >
            {popup.kind === 'alert'
              ? <DialogBody title={popup.title} message={popup.message} buttons={popup.buttons} leave={leave} />
              : <PromptBody popup={popup} leave={leave} />}
          </Animated.View>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}

function SheetBody({ popup, leave }: { popup: Extract<Popup, { kind: 'sheet' }>; leave: (then?: () => void) => void }) {
  const Theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  return (
    <View style={[styles.sheetWrap, { paddingBottom: Math.max(insets.bottom, Spacing.md) }]}>
      <View style={styles.card}>
        <View style={styles.grabber} />
        {popup.title ? <Text style={styles.sheetTitle} numberOfLines={2}>{popup.title}</Text> : null}
        <Animated.ScrollView style={{ maxHeight: height * 0.6 }} bounces={false}>
          {popup.items.map((item, i) => (
            <Pressable
              key={`${i}:${item.label}`}
              onPress={() => {
                Haptics.selectionAsync().catch(() => {});
                leave(item.onPress);
              }}
              style={({ pressed }) => [styles.row, i > 0 && styles.rowRule, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityState={{ selected: !!item.selected }}
            >
              {item.icon ? (
                <Feather name={item.icon} size={18} color={item.destructive ? Theme.red : item.selected ? Theme.cyan : Theme.textMuted} style={styles.rowIcon} />
              ) : null}
              <Text
                style={[styles.rowLabel, item.destructive && { color: Theme.red }, item.selected && styles.rowSelected]}
                numberOfLines={1}
              >
                {item.label}
              </Text>
              {item.selected ? <Feather name="check" size={16} color={Theme.cyan} /> : null}
            </Pressable>
          ))}
        </Animated.ScrollView>
      </View>
      <Pressable
        onPress={() => leave(popup.onCancel)}
        style={({ pressed }) => [styles.card, styles.cancel, pressed && styles.pressed]}
        accessibilityRole="button"
      >
        <Text style={styles.cancelLabel}>Cancel</Text>
      </Pressable>
    </View>
  );
}

function DialogBody({ title, message, buttons, leave, children, disabled }: {
  title: string;
  message?: string;
  buttons: AlertButton[];
  leave: (then?: () => void) => void;
  children?: ReactNode;
  /** Which buttons cannot be pressed yet (a prompt's confirm with nothing typed). */
  disabled?: (b: AlertButton) => boolean;
}) {
  const { width } = useWindowDimensions();
  const ordered = orderedButtons(buttons);
  // Two buttons sit side by side; more, or long labels, stack.
  const across = ordered.length <= 2 && ordered.every((b) => b.text.length <= 14);
  const strongest = ordered[ordered.length - 1];
  return (
    <View style={[styles.card, styles.dialog, { width: Math.min(340, width - 48) }]} accessibilityViewIsModal>
      <Text style={styles.dialogTitle}>{title}</Text>
      {message ? <Text style={styles.dialogMessage}>{message}</Text> : null}
      {children}
      <View style={[styles.buttons, across ? styles.buttonsAcross : styles.buttonsStacked]}>
        {(across ? ordered : [...ordered].reverse()).map((b, i) => {
          const off = disabled?.(b) ?? false;
          const tone = b.style === 'destructive' ? 'danger' : b.style === 'cancel' || (b !== strongest) ? 'plain' : 'primary';
          return (
            <Pressable
              key={`${i}:${b.text}`}
              disabled={off}
              onPress={() => leave(b.onPress)}
              style={({ pressed }) => [
                styles.button,
                across && styles.buttonAcross,
                tone === 'primary' && styles.buttonPrimary,
                tone === 'danger' && styles.buttonDanger,
                tone === 'plain' && styles.buttonPlain,
                (pressed || off) && styles.pressed,
              ]}
              accessibilityRole="button"
            >
              <Text
                style={[
                  styles.buttonLabel,
                  tone === 'primary' && styles.buttonLabelPrimary,
                  tone === 'danger' && styles.buttonLabelDanger,
                ]}
                numberOfLines={1}
              >
                {b.text}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function PromptBody({ popup, leave }: { popup: Extract<Popup, { kind: 'prompt' }>; leave: (then?: () => void) => void }) {
  const Theme = useTheme();
  const [text, setText] = useState(popup.defaultValue ?? '');
  const ready = popup.accepts ? popup.accepts(text) : text.trim().length > 0;
  const confirm: AlertButton = {
    text: popup.confirm,
    style: popup.destructive ? 'destructive' : 'default',
    onPress: () => popup.onSubmit(text),
  };
  return (
    <DialogBody
      title={popup.title}
      message={popup.message}
      buttons={[{ text: 'Cancel', style: 'cancel' }, confirm]}
      leave={leave}
      disabled={(b) => b === confirm && !ready}
    >
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={popup.placeholder}
        placeholderTextColor={Theme.textMuted0}
        autoFocus
        autoCorrect={false}
        autoCapitalize={popup.accepts ? 'characters' : 'sentences'}
        returnKeyType="done"
        onSubmitEditing={() => { if (ready) leave(confirm.onPress); }}
        style={styles.field}
      />
    </DialogBody>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  backdrop: { backgroundColor: 'rgba(0, 0, 0, 0.42)' },
  sheetSlot: { flex: 1, justifyContent: 'flex-end' },
  dialogSlot: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: {
    backgroundColor: Theme.cardBg,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    overflow: 'hidden',
  },
  sheetWrap: { paddingHorizontal: Spacing.sm + 2, gap: Spacing.sm },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Theme.border,
    opacity: 0.6,
    marginTop: 8,
    marginBottom: 4,
  },
  sheetTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: Theme.textMuted,
    textAlign: 'center',
    paddingHorizontal: Spacing.xl,
    paddingTop: 6,
    paddingBottom: 12,
  },
  row: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.xl,
  },
  rowRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight },
  rowIcon: { width: 22, textAlign: 'center' },
  rowLabel: { flex: 1, fontSize: 16, fontWeight: '500', color: Theme.text },
  rowSelected: { color: Theme.cyan, fontWeight: '600' },
  pressed: { opacity: 0.55 },
  cancel: { minHeight: 56, alignItems: 'center', justifyContent: 'center' },
  cancelLabel: { fontSize: 16, fontWeight: '700', color: Theme.text },
  dialog: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.xl, paddingBottom: Spacing.lg },
  dialogTitle: { fontSize: 17, fontWeight: '700', color: Theme.text },
  dialogMessage: { fontSize: 14, lineHeight: 20, color: Theme.textMuted, marginTop: Spacing.sm },
  field: {
    marginTop: Spacing.lg,
    height: 44,
    borderRadius: 10,
    paddingHorizontal: Spacing.md,
    fontSize: 15,
    color: Theme.text,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
  },
  buttons: { marginTop: Spacing.xl, gap: Spacing.sm },
  buttonsAcross: { flexDirection: 'row' },
  buttonsStacked: { flexDirection: 'column' },
  button: { height: 44, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.md },
  buttonAcross: { flex: 1 },
  buttonPrimary: { backgroundColor: Theme.text },
  buttonDanger: { backgroundColor: Theme.red },
  buttonPlain: { backgroundColor: Theme.bgAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.border },
  buttonLabel: { fontSize: 15, fontWeight: '600', color: Theme.text },
  buttonLabelPrimary: { color: Theme.bg },
  buttonLabelDanger: { color: '#fff' },
}));

// The composer's dictation buttons, beside send: a mic and the small chevron
// that picks the language; while recording, Cancel and Finish in their place.
// The behavior is lib/dictation (the shared controller); this only draws it.
//
// - Hidden unless the person turned dictation on (Settings › Voice).
// - A team whose BAA does not cover OpenAI gets a dimmed mic; a tap says why.
// - A start that failed says why at once (lib/dictation), then shows the
//   struck-through mic (tinted where there is colour); a tap says it again,
//   and can retry.
//
// While the microphone is listening a small dot fades in and out left of ✕,
// so a box already full of words still says the mic is on (still under
// Reduce Motion; not shown while starting or finishing).
//
// Every target is 44pt and none overlaps another, send's included: the row is
// 90pt wide in every state (blocked included) and ends in the gap before send, whose left slop
// beside it is 0 (DICTATE_SEND_SLOP). Idle: mic [2,46], chevron [46,90].
// Recording: the dot's slot [0,10] (no target; ✕ reaches over it),
// ✕ [2,46], ✓ [46,90]. Send's own target then starts at 90.
//
// ✕ and ✓ never outweigh send: beside a filled send (the session and chat
// composers) they are quiet circles like attach; beside a bare send glyph
// (the task comment box) they are bare glyphs too (`look="bare"`).
import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, StyleSheet, TouchableOpacity, View as RNView, ActivityIndicator } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { DICTATION_LANGUAGES } from '@codecast/shared/contracts/dictation';
import { MOBILE_SESSION_STYLE as S } from '@codecast/shared/render/mobileSessionStyle';
import { themedStyles, useTheme } from '@/constants/Theme';
import { mixColor } from '@/lib/solColor';
import { appAlert, showActionSheet } from '@/lib/popups';
import { explainDictationFailure, type PhoneDictation } from '@/lib/dictation';
import { setDictationLanguage, useDictationLanguage } from '@/lib/dictationLanguage';

// 32pt buttons like attach and send, with hitSlop to a 44pt target. The first
// button sits 10pt into the row (the live dot's slot) and reaches 8pt left of
// itself and 4pt right.
const FIRST_SLOP = { top: 6, bottom: 6, left: 8, right: 4 };
const FINISH_SLOP = { top: 6, bottom: 6, left: 4, right: 8 };
/** The send button's hitSlop beside these controls: nothing to the left. */
export const DICTATE_SEND_SLOP = { top: 12, bottom: 12, left: 0, right: 12 };

export function DictateControls({ dictation, look = 'quiet' }: { dictation: PhoneDictation; look?: 'quiet' | 'bare' }) {
  const Theme = useTheme();
  const language = useDictationLanguage();
  const { shown, blocked, state } = dictation;
  if (!shown) return null;

  if (state.phase !== 'idle') {
    // The spinner goes where the press was: on ✓ for a Finish, on Send (its
    // composer draws it) for a send waiting on the last words.
    const finishing = state.phase === 'finishing' && !dictation.sendWaiting;
    return (
      <RNView style={[styles.row, styles.recording]}>
        <RNView style={styles.liveSlot} pointerEvents="none">
          {state.phase === 'listening' && <LiveDot color={Theme.red} />}
        </RNView>
        <TouchableOpacity
          style={[look === 'bare' ? styles.bare : styles.quiet, styles.cancel]}
          onPress={dictation.cancel}
          activeOpacity={0.6}
          hitSlop={FIRST_SLOP}
          accessibilityRole="button"
          accessibilityLabel="Cancel dictation"
        >
          <Feather name="x" size={17} color={Theme.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity
          style={look === 'bare' ? styles.bare : styles.quiet}
          onPress={() => void dictation.finish()}
          activeOpacity={0.6}
          hitSlop={FINISH_SLOP}
          disabled={finishing}
          accessibilityRole="button"
          accessibilityLabel="Finish dictation"
          accessibilityState={{ busy: finishing, disabled: finishing }}
        >
          {finishing ? (
            <ActivityIndicator size="small" color={Theme.textMuted} />
          ) : (
            <Feather name="check" size={17} color={Theme.textMuted} />
          )}
        </TouchableOpacity>
      </RNView>
    );
  }

  const failed = !blocked && !!state.error;
  // Blocked stays pressable: a disabled touchable (RN reads
  // accessibilityState.disabled as disabled) would swallow the tap that says why.
  // The reason is a sentence ("AI features are off for Acme: no BAA with
  // OpenAI yet."), longer than the one-line notice bar: a dialog shows it whole.
  // Not "off": the person's own switch is on; the team is what stops it.
  const explainBlocked = () => appAlert("Dictation isn't available", blocked!);
  const pressMic = () => {
    if (blocked) return explainBlocked();
    if (failed) return explainDictationFailure(state.error!, dictation.start);
    dictation.start();
  };
  const openSettings = () => {
    if (blocked) return explainBlocked();
    showActionSheet(
      'Dictation settings',
      DICTATION_LANGUAGES.map((l) => ({
        label: l.label,
        selected: l.code === language,
        onPress: () => setDictationLanguage(l.code),
      })),
    );
  };

  return (
    <RNView style={[styles.row, !!blocked && styles.dim]}>
      <TouchableOpacity
        style={[styles.mic, failed && { backgroundColor: mixColor(Theme.red, 16, Theme.bg) }]}
        onPress={pressMic}
        activeOpacity={0.6}
        hitSlop={FIRST_SLOP}
        accessibilityRole="button"
        accessibilityLabel="Dictate"
        accessibilityHint={blocked ?? state.error ?? undefined}
      >
        {/* The struck-through mic says "failed" without colour (the grayscale tablet). */}
        <Feather name={failed ? 'mic-off' : 'mic'} size={17} color={failed ? Theme.red : Theme.textMuted} />
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.chevron}
        onPress={openSettings}
        activeOpacity={0.6}
        hitSlop={{ top: 6, bottom: 6, left: 0, right: 0 }}
        accessibilityRole="button"
        accessibilityLabel="Dictation settings"
        accessibilityHint={blocked ?? undefined}
        accessibilityValue={{ text: DICTATION_LANGUAGES.find((l) => l.code === language)?.label ?? 'Auto' }}
      >
        <Feather name="chevron-down" size={13} color={Theme.textMuted0} />
      </TouchableOpacity>
    </RNView>
  );
}

/** The microphone is on: a dot that slowly fades in and out, still when the
 *  person asked iOS to reduce motion. A shape, so it reads without colour. */
function LiveDot({ color }: { color: string }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    let live = true;
    let pulse: Animated.CompositeAnimation | null = null;
    const apply = (reduce: boolean) => {
      if (!live) return;
      pulse?.stop();
      pulse = null;
      opacity.setValue(1);
      if (reduce) return;
      pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0.25, duration: 900, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 1, duration: 900, useNativeDriver: true }),
        ]),
      );
      pulse.start();
    };
    AccessibilityInfo.isReduceMotionEnabled().then(apply, () => apply(false));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', apply);
    return () => {
      live = false;
      pulse?.stop();
      sub.remove();
    };
  }, [opacity]);
  return (
    <Animated.View
      style={[styles.liveDot, { backgroundColor: color, opacity }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel="Microphone on"
    />
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  // The same 90pt in every state, so nothing beside it moves.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Recording, ✓ and the gap after it end where the idle chevron's box does.
  recording: {
    marginRight: 8,
  },
  mic: {
    ...S.imageButton,
    borderRadius: 16,
    marginLeft: 10,
  },
  // Recording: the live dot's 10pt, matching the idle mic's margin.
  liveSlot: {
    width: 10,
    height: 32,
    justifyContent: 'center',
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  // Blocked: both dimmed, both still say why on a tap.
  dim: {
    opacity: 0.4,
  },
  // The chevron's box is its whole 44pt target, running toward send; the
  // glyph sits in its middle.
  chevron: {
    width: 44,
    height: 32,
    marginLeft: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // ✕ and ✓ are quiet, like attach: send stays the one primary button.
  quiet: {
    ...S.imageButton,
    borderRadius: 16,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  // Beside a bare send glyph: the same 32pt box, no fill or ring.
  bare: {
    ...S.imageButton,
  },
  cancel: {
    marginRight: 8,
  },
}));

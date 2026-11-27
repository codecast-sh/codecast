// The composer's dictation buttons, beside send: a mic and the small chevron
// that picks the language; while recording, Cancel and Finish in their place.
// The behavior is lib/dictation (the shared controller); this only draws it.
//
// - Hidden unless the person turned dictation on (Settings › Voice).
// - A team whose BAA does not cover OpenAI gets a dimmed mic; a tap says why.
// - A start that failed shows the struck-through mic (tinted where there is
//   colour); a tap says why, and can retry.
//
// Every target is 44pt and none overlaps another, send's included: the row is
// 80pt wide in both states and ends in the gap before send, whose left slop
// beside it is 0 (DICTATE_SEND_SLOP). Idle: mic [-8,36], chevron [36,80].
// Recording: ✕ [-8,36], ✓ [36,80]. Send's own target then starts at 80.
import { StyleSheet, TouchableOpacity, View as RNView, ActivityIndicator } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { DICTATION_LANGUAGES } from '@codecast/shared/contracts';
import { MOBILE_SESSION_STYLE as S } from '@codecast/shared/render/mobileSessionStyle';
import { themedStyles, useTheme } from '@/constants/Theme';
import { mixColor } from '@/lib/solColor';
import { appAlert, showActionSheet } from '@/lib/popups';
import { showNotice } from '@/lib/undoBar';
import type { PhoneDictation } from '@/lib/dictation';
import { setDictationLanguage, useDictationLanguage } from '@/lib/dictationLanguage';

// 32pt buttons like attach and send, with hitSlop to a 44pt target. The first
// button reaches 8pt left (a neighbour there keeps 8pt clear: the suggestion
// chip's margin, the task box's gap) and 4pt right.
const FIRST_SLOP = { top: 6, bottom: 6, left: 8, right: 4 };
const FINISH_SLOP = { top: 6, bottom: 6, left: 4, right: 8 };
/** The send button's hitSlop beside these controls: nothing to the left. */
export const DICTATE_SEND_SLOP = { top: 12, bottom: 12, left: 0, right: 12 };

export function DictateControls({ dictation }: { dictation: PhoneDictation }) {
  const Theme = useTheme();
  const language = useDictationLanguage();
  const { shown, blocked, state } = dictation;
  if (!shown) return null;

  if (state.phase !== 'idle') {
    const finishing = state.phase === 'finishing';
    return (
      <RNView style={[styles.row, styles.recording]}>
        <TouchableOpacity
          style={styles.cancel}
          onPress={dictation.cancel}
          activeOpacity={0.6}
          hitSlop={FIRST_SLOP}
          accessibilityRole="button"
          accessibilityLabel="Cancel dictation"
        >
          <Feather name="x" size={17} color={Theme.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.finish, { backgroundColor: mixColor(Theme.text, 85, Theme.bg) }]}
          onPress={() => void dictation.finish()}
          activeOpacity={0.7}
          hitSlop={FINISH_SLOP}
          disabled={finishing}
          accessibilityRole="button"
          accessibilityLabel="Finish dictation"
          accessibilityState={{ busy: finishing, disabled: finishing }}
        >
          {finishing ? (
            <ActivityIndicator size="small" color={Theme.bg} />
          ) : (
            <Feather name="check" size={16} color={Theme.bg} />
          )}
        </TouchableOpacity>
      </RNView>
    );
  }

  const failed = !!state.error;
  const pressMic = () => {
    if (blocked) return showNotice(blocked);
    if (failed) {
      return appAlert("Dictation didn't start", state.error!, [
        { text: 'OK', style: 'cancel' },
        { text: 'Try again', onPress: dictation.start },
      ]);
    }
    dictation.start();
  };
  const openLanguages = () =>
    showActionSheet(
      'Dictation language',
      DICTATION_LANGUAGES.map((l) => ({
        label: l.label,
        selected: l.code === language,
        onPress: () => setDictationLanguage(l.code),
      })),
    );

  return (
    <RNView style={styles.row}>
      <TouchableOpacity
        style={[styles.mic, failed && !blocked && { backgroundColor: mixColor(Theme.red, 16, Theme.bg) }, !!blocked && styles.dim]}
        onPress={pressMic}
        activeOpacity={0.6}
        hitSlop={FIRST_SLOP}
        accessibilityRole="button"
        accessibilityLabel="Dictate"
        accessibilityHint={blocked ?? state.error ?? undefined}
        accessibilityState={blocked ? { disabled: true } : undefined}
      >
        {/* The struck-through mic says "failed" without colour (the grayscale tablet). */}
        <Feather name={failed && !blocked ? 'mic-off' : 'mic'} size={17} color={failed && !blocked ? Theme.red : Theme.textMuted} />
      </TouchableOpacity>
      {blocked ? null : (
        <TouchableOpacity
          style={styles.chevron}
          onPress={openLanguages}
          activeOpacity={0.6}
          hitSlop={{ top: 6, bottom: 6, left: 0, right: 0 }}
          accessibilityRole="button"
          accessibilityLabel="Dictation settings"
          accessibilityValue={{ text: DICTATION_LANGUAGES.find((l) => l.code === language)?.label ?? 'Auto' }}
        >
          <Feather name="chevron-down" size={13} color={Theme.textMuted0} />
        </TouchableOpacity>
      )}
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
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
  },
  // Blocked has no chevron: the mic keeps its slop clear of send.
  dim: {
    opacity: 0.4,
    marginRight: 8,
  },
  // The chevron's box is its whole 44pt target, running toward send; the
  // glyph sits against the mic.
  chevron: {
    width: 44,
    height: 32,
    marginLeft: 4,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  cancel: {
    ...S.imageButton,
    borderRadius: 16,
    marginRight: 8,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  finish: {
    ...S.imageButton,
    borderRadius: 16,
  },
}));

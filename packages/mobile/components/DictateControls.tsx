// The composer's dictation buttons, beside send: a mic and the small chevron
// that picks the language; while recording, Cancel and Finish in their place.
// The behavior is lib/dictation (the shared controller); this only draws it.
//
// - Hidden unless the person turned dictation on (Settings › Voice).
// - A team whose BAA does not cover OpenAI gets a dimmed mic; a tap says why.
// - A start that failed leaves the mic tinted; a tap says why, and can retry.
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

// 32pt buttons like attach and send, with hitSlop to a 44pt target.
const SLOP = { top: 6, bottom: 6, left: 6, right: 6 };

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
          hitSlop={SLOP}
          accessibilityRole="button"
          accessibilityLabel="Cancel dictation"
        >
          <Feather name="x" size={17} color={Theme.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.finish, { backgroundColor: mixColor(Theme.text, 85, Theme.bg) }]}
          onPress={() => void dictation.finish()}
          activeOpacity={0.7}
          hitSlop={SLOP}
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
        hitSlop={{ ...SLOP, right: 0 }}
        accessibilityRole="button"
        accessibilityLabel="Dictate"
        accessibilityHint={blocked ?? state.error ?? undefined}
        accessibilityState={blocked ? { disabled: true } : undefined}
      >
        <Feather name="mic" size={17} color={failed && !blocked ? Theme.red : Theme.textMuted} />
      </TouchableOpacity>
      {blocked ? null : (
        <TouchableOpacity
          style={styles.chevron}
          onPress={openLanguages}
          activeOpacity={0.6}
          hitSlop={{ top: 6, bottom: 6, left: 0, right: 8 }}
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
  // Idle, the chevron's wide box is the gap before send.
  recording: {
    marginRight: 6,
  },
  mic: {
    ...S.imageButton,
    borderRadius: 16,
  },
  dim: {
    opacity: 0.4,
  },
  // The chevron's box runs wide toward send so its target reaches 44pt; the
  // glyph sits against the mic.
  chevron: {
    width: 36,
    height: 32,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  cancel: {
    ...S.imageButton,
    borderRadius: 16,
    marginRight: 6,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  finish: {
    ...S.imageButton,
    borderRadius: 16,
  },
}));

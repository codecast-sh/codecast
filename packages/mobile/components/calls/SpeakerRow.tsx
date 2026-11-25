// The voices of a recording under its player: one chip per voice in the order
// they first speak, with its color, who it is and how much of the talking it
// did. A voice match's name is a guess until a person says so: drawn quieter
// with a question mark, and the check beside it confirms it in one tap.
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { shareLabel, type SpeakerChip } from '@codecast/shared/contracts';
import { Text as RNText } from '@/components/Themed';
import { BorderRadius, FontSize, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { speakerTint } from './speakerTint';

export function SpeakerRow({
  chips,
  onOpen,
  onConfirm,
}: {
  chips: SpeakerChip[];
  onOpen: (key: string) => void;
  onConfirm: (key: string) => void;
}) {
  const Theme = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {chips.map((c) => {
        const tint = speakerTint(Theme, c.key);
        return (
          <RNView key={c.key} style={[styles.chip, c.suggested && styles.chipSuggested, { borderColor: tint }]}>
            <TouchableOpacity
              style={styles.open}
              onPress={() => onOpen(c.key)}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel={`${c.suggested ? `Maybe ${c.name}` : c.name}, ${shareLabel(c.share)} of the talking. Change who this is`}
            >
              <RNView style={[styles.dot, { backgroundColor: tint }]} />
              <RNText style={[styles.name, c.suggested && styles.nameSuggested]} numberOfLines={1}>
                {c.suggested ? `${c.name}?` : c.name}
              </RNText>
              <RNText style={styles.share}>{shareLabel(c.share)}</RNText>
            </TouchableOpacity>
            {c.suggested ? (
              <TouchableOpacity
                style={styles.confirm}
                onPress={() => onConfirm(c.key)}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
                activeOpacity={0.6}
                accessibilityRole="button"
                accessibilityLabel={`Confirm ${c.name}`}
              >
                <FontAwesome name="check" size={12} color={Theme.green} />
              </TouchableOpacity>
            ) : null}
          </RNView>
        );
      })}
    </ScrollView>
  );
}

const styles = themedStyles((Theme) =>
  StyleSheet.create({
    row: { gap: Spacing.sm, paddingHorizontal: Spacing.lg },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: BorderRadius.pill,
      borderWidth: 1,
      backgroundColor: Theme.bgAlt,
    },
    chipSuggested: { borderStyle: 'dashed' },
    open: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7, paddingLeft: 10, paddingRight: 10 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    name: { fontSize: FontSize.sm, fontWeight: '600', color: Theme.text, maxWidth: 140 },
    nameSuggested: { fontWeight: '400', fontStyle: 'italic', color: Theme.textMuted },
    share: { fontSize: FontSize.xs, color: Theme.textMuted0, fontVariant: ['tabular-nums'] },
    confirm: {
      width: 26,
      height: 26,
      borderRadius: 13,
      marginRight: 4,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: Theme.bgHighlight,
    },
  }),
);

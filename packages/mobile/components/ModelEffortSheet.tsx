import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { themedStyles, useTheme } from '@/constants/Theme';
import { Text } from '@/components/Themed';
import { FontAwesome } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { BottomSheet } from '@/components/BottomSheet';
import type { ModelOption } from '@codecast/shared/contracts';
import { Theme } from '../constants/Theme';

// The model/effort bottom sheet, shared by the session-header switcher chip
// (live + blank rails) and the new-session sheet's launch picker. It renders a
// rail it is handed and reports one selection at a time; deciding what the rail
// contains and what a pick means stays with the caller.
export function ModelEffortSheet({
  visible,
  onClose,
  models,
  efforts,
  modelKey,
  // null = the "default" stop (no effort pinned).
  effortKey,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  models: ModelOption[];
  efforts: string[];
  modelKey: string;
  effortKey: string | null;
  onSelect: (sel: { model?: string; effort?: string }) => void;
}) {
  const Theme = useTheme();

  const pick = (sel: { model?: string; effort?: string }) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
    onSelect(sel);
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={styles.sectionLabel}>Model</Text>
      {models.map((m) => {
        const active = m.key === modelKey;
        return (
          <TouchableOpacity
            key={m.key}
            style={styles.modelRow}
            activeOpacity={0.6}
            onPress={() => { if (!active) pick({ model: m.key }); else onClose(); }}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.modelLabel, active && styles.modelLabelActive]}>{m.label}</Text>
              {!!m.hint && <Text style={styles.modelHint}>{m.hint}</Text>}
            </View>
            {active && <FontAwesome name="check" size={13} color={Theme.cyan} />}
          </TouchableOpacity>
        );
      })}
      {/* A rail whose only stop is "default" is no choice at all — opencode
          has no effort flag, so its launch rail is exactly that. */}
      {efforts.some((e) => e !== 'default') && (
        <>
          <View style={styles.divider} />
          <Text style={styles.sectionLabel}>Effort</Text>
          <View style={styles.effortRow}>
            {efforts.map((level) => {
              const active = level === 'default' ? !effortKey : level === effortKey;
              return (
                <TouchableOpacity
                  key={level}
                  style={[styles.effortPill, active && styles.effortPillActive]}
                  activeOpacity={0.6}
                  onPress={() => { if (!active) pick({ effort: level }); else onClose(); }}
                >
                  <Text style={[styles.effortPillText, active && styles.effortPillTextActive]}>{level}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </>
      )}
    </BottomSheet>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  sectionLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: Theme.textDim,
    marginTop: 6,
    marginBottom: 4,
  },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
  },
  modelLabel: {
    fontSize: 15,
    fontWeight: '500',
    color: Theme.text,
  },
  modelLabelActive: {
    color: Theme.cyan,
    fontWeight: '600',
  },
  modelHint: {
    fontSize: 12,
    color: Theme.textMuted,
    marginTop: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Theme.border,
    opacity: 0.5,
    marginVertical: 8,
  },
  effortRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  effortPill: {
    flexGrow: 1,
    flexBasis: '22%',
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Theme.border + '60',
  },
  effortPillActive: {
    borderColor: Theme.cyan,
    backgroundColor: Theme.cyan + '14',
  },
  effortPillText: {
    fontSize: 13,
    fontWeight: '500',
    color: Theme.textMuted,
  },
  effortPillTextActive: {
    color: Theme.cyan,
    fontWeight: '600',
  },
}));

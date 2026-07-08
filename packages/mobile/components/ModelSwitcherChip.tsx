import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather, FontAwesome } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AGENT_MODEL_CONFIG, modelAgentKey, type ModelOption } from '@codecast/shared/contracts';
import { useInboxStore, isConvexId } from '@codecast/web/store/inboxStore';
import { commitModelChange, modelOptionKey, effortGlyph } from '@codecast/web/lib/modelSwitch';
import { useModelCommandWatch } from '@codecast/web/hooks/useModelCommandWatch';
import { Theme, chipShell, chipText, chipTint, CHROME_FONT_CAP } from '../constants/Theme';

// Session-header model/effort chip + bottom-sheet switcher — the mobile
// counterpart of the web's HeaderModelControl / LaunchModelPill. Same two
// rails via the shared commitModelChange (blank session → reconfigureSession
// relaunch flags; live claude session → set_model drives the /model picker),
// same pending-command supervision via useModelCommandWatch. Read-only
// contexts (teammates' sessions, agents without a rail) render a static chip.
export function ModelSwitcherChip({
  conversationId,
  agentType,
  model,
  effort,
  messageCount,
  canEdit,
  showToast,
}: {
  conversationId: string;
  agentType: string | undefined;
  model: string | undefined;
  effort: string | undefined | null;
  messageCount: number | undefined;
  canEdit: boolean;
  showToast: (msg: string) => void;
}) {
  const [sheetVisible, setSheetVisible] = useState(false);
  const insets = useSafeAreaInsets();
  useModelCommandWatch(conversationId, showToast);
  const busy = useInboxStore((s) => s.pendingModelCommand?.convId === conversationId);

  const blank = (messageCount ?? 0) === 0;
  const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];
  const interactive = !!cfg && canEdit && (blank || (cfg.midSession && isConvexId(conversationId)));

  const modelKey = modelOptionKey(model, agentType);
  const opt = cfg?.models.find((m) => m.key === modelKey);
  // Known models get their picker label ("Opus"); custom/unknown ids fall
  // back to the raw id minus the claude- prefix.
  const label = model
    ? (opt && opt.key !== 'default' ? opt.label : model.replace(/^claude-/, ''))
    : 'Model';
  const glyph = effortGlyph(effort);

  if (!model && !interactive) return null;

  const chip = (
    <View style={[styles.chip, busy && { opacity: 0.5 }]}>
      <Feather name="cpu" size={10} color={Theme.cyan} />
      <Text style={styles.chipText} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{label}</Text>
      {!!glyph && <Text style={styles.chipGlyph}>{glyph}</Text>}
      {interactive && <Feather name="chevron-down" size={9} color={Theme.cyan} style={{ opacity: 0.7 }} />}
    </View>
  );

  if (!interactive) return chip;

  const commit = (sel: { model?: string; effort?: string }) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSheetVisible(false);
    void commitModelChange({
      conversationId,
      agentType,
      current: { model: model ?? null, effort: effort ?? null },
      sel,
      blank,
      notify: showToast,
    });
  };

  // Launch rail: hide picker-only models (Sonnet 1M) and offer the "default"
  // effort stop (= no pin, the agent's saved default wins). Live rail mirrors
  // the /model picker: all models, no session-scoped default stop.
  const models = cfg.models.filter((m: ModelOption) => (blank ? !m.midSessionOnly : true));
  const efforts = [...(blank ? ['default'] : []), ...cfg.efforts];

  return (
    <>
      <Pressable onPress={() => { if (!busy) setSheetVisible(true); }} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
        {chip}
      </Pressable>
      <Modal
        visible={sheetVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setSheetVisible(false)}
        supportedOrientations={['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']}
      >
        <Pressable style={styles.backdrop} onPress={() => setSheetVisible(false)}>
          <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]} onPress={() => {}}>
            <View style={styles.grabber} />
            <Text style={styles.sectionLabel}>Model</Text>
            {models.map((m: ModelOption) => {
              const active = m.key === modelKey;
              return (
                <TouchableOpacity
                  key={m.key}
                  style={styles.modelRow}
                  activeOpacity={0.6}
                  onPress={() => { if (!active) commit({ model: m.key }); else setSheetVisible(false); }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.modelLabel, active && styles.modelLabelActive]}>{m.label}</Text>
                    {!!m.hint && <Text style={styles.modelHint}>{m.hint}</Text>}
                  </View>
                  {active && <FontAwesome name="check" size={13} color={Theme.cyan} />}
                </TouchableOpacity>
              );
            })}
            <View style={styles.divider} />
            <Text style={styles.sectionLabel}>Effort</Text>
            <View style={styles.effortRow}>
              {efforts.map((level) => {
                const active = level === 'default' ? !effort : level === effort;
                return (
                  <TouchableOpacity
                    key={level}
                    style={[styles.effortPill, active && styles.effortPillActive]}
                    activeOpacity={0.6}
                    onPress={() => { if (!active) commit({ effort: level }); else setSheetVisible(false); }}
                  >
                    <Text style={[styles.effortPillText, active && styles.effortPillTextActive]}>{level}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  // The session header's shared chip shell, cyan-tinted.
  chip: {
    ...chipShell,
    ...chipTint(Theme.cyan),
  },
  chipText: {
    ...chipText,
    color: Theme.cyan,
  },
  chipGlyph: {
    fontSize: 10,
    color: Theme.cyan,
    opacity: 0.8,
  },
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
    gap: 8,
    marginTop: 4,
  },
  effortPill: {
    flex: 1,
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
});

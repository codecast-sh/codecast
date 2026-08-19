import {
  useState } from 'react';
import { Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Text } from '@/components/Themed';
import { Feather } from '@expo/vector-icons';
import { AGENT_MODEL_CONFIG, launchRailOptions, modelAgentKey } from '@codecast/shared/contracts';
import { commitModelChange, modelOptionKey, effortGlyph } from '@codecast/web/lib/modelSwitch';
import { ModelEffortSheet } from '@/components/ModelEffortSheet';
import { Theme, chipShell, chipText, chipTint, CHROME_FONT_CAP } from '../constants/Theme';

// Session-header model/effort chip + bottom-sheet switcher — the mobile
// counterpart of the web's HeaderModelControl / LaunchModelPill. Same two
// rails via the shared commitModelChange (blank session → reconfigureSession
// relaunch flags; live claude session → `/model` / `/effort` sent as ordinary
// messages). Read-only contexts (teammates' sessions, agents without a rail)
// render a static chip.
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

  const blank = (messageCount ?? 0) === 0;
  const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];
  const interactive = !!cfg && canEdit && (blank || cfg.midSession);

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
    <View style={styles.chip}>
      <Feather name="cpu" size={10} color={Theme.cyan} />
      <Text style={styles.chipText} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{label}</Text>
      {!!glyph && <Text style={styles.chipGlyph}>{glyph}</Text>}
      {interactive && <Feather name="chevron-down" size={9} color={Theme.cyan} style={{ opacity: 0.7 }} />}
    </View>
  );

  if (!interactive) return chip;

  const commit = (sel: { model?: string; effort?: string }) => {
    void commitModelChange({
      conversationId,
      agentType,
      current: { model: model ?? null, effort: effort ?? null },
      sel,
      blank,
      notify: showToast,
    });
  };

  // Blank session: the launch rail (effort gains the "default" stop) — one
  // definition shared with the new-session sheet. A live session: all models,
  // no default stop.
  const rail = blank ? launchRailOptions(cfg) : { models: cfg.models, efforts: [...cfg.efforts] };

  return (
    <>
      <Pressable onPress={() => setSheetVisible(true)} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
        {chip}
      </Pressable>
      <ModelEffortSheet
        visible={sheetVisible}
        onClose={() => setSheetVisible(false)}
        models={rail.models}
        efforts={rail.efforts}
        modelKey={modelKey}
        effortKey={effort ?? null}
        onSelect={commit}
      />
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
});

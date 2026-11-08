import { useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import type { PermissionOutcome } from '@codecast/shared/contracts/commandRun';
import { Text } from '@/components/Themed';
import { useTheme } from '@/constants/Theme';

// A permission ask's answer in the transcript (shared/contracts/commandRun.ts
// permissionRecord): one line with what was asked and where the step stands,
// as on the web (components/conversation/PermissionAsk). A step that failed
// keeps its output a tap away; the command itself never shows.
export function PermissionRecordLine({ question, outcome, output }: { question: string; outcome: PermissionOutcome; output?: string }) {
  const Theme = useTheme();
  const [open, setOpen] = useState(false);
  const look: Record<PermissionOutcome, { label: string; color: string; icon: keyof typeof Feather.glyphMap }> = {
    running: { label: 'Running…', color: Theme.textMuted, icon: 'loader' },
    done: { label: 'Done', color: Theme.green, icon: 'check' },
    failed: { label: "Didn't go through", color: Theme.red, icon: 'alert-triangle' },
    declined: { label: 'Not allowed', color: Theme.textDim, icon: 'slash' },
  };
  const o = look[outcome];
  const why = outcome === 'failed' && !!output?.trim();
  return (
    <View style={{ marginVertical: 6, gap: 6 }}>
      <Pressable
        disabled={!why}
        onPress={() => setOpen((v) => !v)}
        accessibilityRole={why ? 'button' : undefined}
        accessibilityLabel={`${question} ${o.label}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: Theme.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: Theme.bgAlt }}
      >
        <View style={{ width: 24, height: 24, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: Theme.bgHighlight }}>
          {outcome === 'running' ? <ActivityIndicator size="small" color={o.color} /> : <Feather name={o.icon} size={13} color={o.color} />}
        </View>
        <Text style={{ flex: 1, fontSize: 13, color: outcome === 'declined' ? Theme.textDim : Theme.textMuted }} numberOfLines={1}>{question}</Text>
        <Text style={{ fontSize: 12, color: o.color, textDecorationLine: why ? 'underline' : 'none' }}>{o.label}</Text>
      </Pressable>
      {why && open ? (
        <View style={{ borderWidth: 1, borderColor: Theme.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 }}>
          <Text style={{ fontSize: 11, color: Theme.textMuted }} numberOfLines={30}>{output!.trim()}</Text>
        </View>
      ) : null}
    </View>
  );
}

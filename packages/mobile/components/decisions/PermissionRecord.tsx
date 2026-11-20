import { useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { permissionStatus, runMachine, type PermissionOutcome, type RunMachine } from '@codecast/shared/contracts/commandRun';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { Text } from '@/components/Themed';
import { useTheme } from '@/constants/Theme';

// A permission ask's answer in the transcript (shared/contracts/commandRun.ts
// permissionRecord): one line with what was asked and where the step stands,
// as on the web (components/conversation/PermissionAsk). A step that failed
// keeps its output a tap away; the command itself never shows.
export function PermissionRecordLine({ question, outcome, output, machine = null, queued = false }: { question: string; outcome: PermissionOutcome; output?: string; machine?: RunMachine | null; queued?: boolean }) {
  const Theme = useTheme();
  const [open, setOpen] = useState(false);
  const look: Record<PermissionOutcome, { color: string; icon: keyof typeof Feather.glyphMap }> = {
    running: { color: Theme.textMuted, icon: 'loader' },
    done: { color: Theme.green, icon: 'check' },
    failed: { color: Theme.red, icon: 'alert-triangle' },
    declined: { color: Theme.textDim, icon: 'slash' },
  };
  const { label, waiting } = permissionStatus(outcome, machine, queued);
  const o = { ...look[outcome], label, ...(waiting ? { color: Theme.yellow, icon: 'clock' as const } : {}) };
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
          {outcome === 'running' && !waiting ? <ActivityIndicator size="small" color={o.color} /> : <Feather name={o.icon} size={13} color={o.color} />}
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

/** Where a permission ask runs and whether it waits there, read from the store (runMachine): the machine when it is not the session's own. */
export function useRunPlace(decisionId: string | undefined): { machine: RunMachine | null; queued: boolean } {
  const key = useInboxStore((s) => {
    const d = decisionId ? (s.sessionDecisions as Record<string, any>)[decisionId] : undefined;
    if (!d?.run) return '';
    const cid = String(d.conversation_id);
    const own = (s.sessions as any)[cid]?.owner_device_id ?? (s.conversations as any)[cid]?.owner_device_id;
    const m = runMachine(d.run, own, (s as any).machineRoster, Date.now());
    return `${m ? `${m.name}\u0000${m.offline ? 1 : 0}` : ''}\u0001${d.run.state === 'queued' ? 1 : 0}`;
  });
  const [place, q] = key.split('\u0001');
  const [name, off] = (place ?? '').split('\u0000');
  return { machine: name ? { name, offline: off === '1' } : null, queued: q === '1' };
}

/** A permission answer's record, with where it ran. */
export function PermissionAnswerLine({ decisionId, ...record }: { decisionId?: string; question: string; outcome: PermissionOutcome; output?: string }) {
  const place = useRunPlace(decisionId);
  return <PermissionRecordLine {...record} {...place} />;
}

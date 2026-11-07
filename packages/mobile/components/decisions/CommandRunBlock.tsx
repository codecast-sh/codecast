import { View } from 'react-native';
import { commandLine, type CommandRun } from '@codecast/shared/contracts/commandRun';
import { Text } from '@/components/Themed';
import { useTheme } from '@/constants/Theme';

// The command a `cast decide --run` card runs (shared/contracts/commandRun.ts):
// exactly what Run executes, then how it went. The web's CommandRunView, on the phone.
export function CommandRunBlock({ run, compact = false }: { run: CommandRun; compact?: boolean }) {
  const Theme = useTheme();
  const state: Record<CommandRun['state'], [string, string] | null> = {
    waiting: null,
    queued: ['Sent to the machine', Theme.textDim],
    running: ['Running', Theme.yellow],
    done: ['Ran', Theme.green],
    failed: ['Failed', Theme.red],
    skipped: ['Not run', Theme.textDim],
  };
  const s = state[run.state];
  const exit = run.exit_code !== undefined && run.state !== 'done' ? ` · exit ${run.exit_code}` : '';
  return (
    <View style={{ gap: 6, marginTop: 6 }}>
      <View style={{ borderWidth: 1, borderColor: Theme.border, backgroundColor: Theme.bgAlt, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8 }}>
        <Text style={{ fontSize: 12, color: Theme.text }} numberOfLines={compact ? 3 : undefined}>
          <Text style={{ color: Theme.textDim }}>$ </Text>
          {commandLine(run.argv)}
        </Text>
      </View>
      {s ? <Text style={{ fontSize: 12, color: s[1] }}>{s[0]}{exit}</Text> : null}
      {run.output && !compact ? (
        <View style={{ borderWidth: 1, borderColor: Theme.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8 }}>
          <Text style={{ fontSize: 11, color: Theme.textMuted }} numberOfLines={40}>{run.output}</Text>
        </View>
      ) : null}
    </View>
  );
}

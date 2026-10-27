// Workflow events: the mobile twin of web's WorkflowEventBlock.

import { StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Text as RNText } from '@/components/Themed';
import { Theme, themedStyles, useTheme } from '@/constants/Theme';
import { useInboxStore, isConvexId } from '@codecast/web/store/inboxStore';
import { useWorkflowRun } from '@codecast/web/hooks/useSyncWorkflows';

// The server posts workflow lifecycle anchors as JSON message content
// (convex/workflow_runs.ts). Fork/resume can round-trip them without the
// workflow_event subtype, so detect by content shape, matching web.
export function parseWorkflowEventContent(content: string | undefined): Record<string, any> | null {
  if (!content || !content.startsWith('{"__wf"')) return null;
  try { return JSON.parse(content); } catch { return null; }
}

const WF_NODE_COLORS: Record<string, string> = {
  agent: Theme.green,
  command: Theme.accent,
  human: Theme.magenta,
  prompt: Theme.violet,
};

function WorkflowGateCard({ event }: { event: Record<string, any> }) {
  const Theme = useTheme();
  const runId = typeof event.run_id === 'string' ? event.run_id : null;
  const run = useWorkflowRun(runId && isConvexId(runId) ? runId : null) as { _id: string; status: string } | null | undefined;
  const choices = (event.choices ?? []) as Array<{ key: string; label: string }>;
  const waiting = run?.status === 'paused';

  // Local-first (store respondToGate): the run reads as running on the press,
  // so the choices fold away without waiting on the server.
  const choose = (key: string) => {
    if (!run || !waiting) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    useInboxStore.getState().respondToGate(run._id, key);
  };

  return (
    <RNView style={styles.wfGateCard}>
      <RNView style={styles.wfGateHeader}>
        <FontAwesome name="question-circle" size={12} color={Theme.magenta} />
        <RNText style={styles.wfGateHeaderText}>HUMAN GATE</RNText>
        <RNText style={[styles.wfGateStatus, { color: waiting ? Theme.magenta : Theme.green }]}>
          {waiting ? 'waiting…' : 'responded'}
        </RNText>
      </RNView>
      {!!event.prompt && <RNText style={styles.wfGatePrompt}>{event.prompt}</RNText>}
      {waiting && choices.length > 0 && (
        <RNView style={styles.wfGateChoices}>
          {choices.map((c) => (
            <TouchableOpacity
              key={c.key}
              style={styles.wfGateChoice}
              onPress={() => choose(c.key)}
              activeOpacity={0.7}
            >
              <RNText style={styles.wfGateChoiceKey}>[{c.key}]</RNText>
              <RNText style={styles.wfGateChoiceLabel}>{String(c.label ?? '').replace(/^\[.\]\s*/, '')}</RNText>
            </TouchableOpacity>
          ))}
        </RNView>
      )}
    </RNView>
  );
}

export function WorkflowEventBlock({ event }: { event: Record<string, any> }) {
  const Theme = useTheme();
  const router = useRouter();
  const wf = event.__wf as string;

  if (wf === 'started') {
    return (
      <RNView style={styles.wfStartedRow}>
        <FontAwesome name="bolt" size={11} color={Theme.violet} />
        <RNText style={styles.wfStartedText} numberOfLines={2}>
          Workflow started{event.goal ? ` — ${event.goal}` : ''}
        </RNText>
      </RNView>
    );
  }

  if (wf === 'node_start' || wf === 'node_done' || wf === 'node_failed') {
    const color = WF_NODE_COLORS[event.node_type as string] || WF_NODE_COLORS.agent;
    const label = event.node_label || event.node_id;
    return (
      <RNView style={styles.wfNodeRow}>
        {wf === 'node_done' && <FontAwesome name="check" size={10} color={Theme.greenBright} />}
        {wf === 'node_failed' && <FontAwesome name="times" size={10} color={Theme.red} />}
        {wf === 'node_start' && <RNView style={styles.wfNodePulse} />}
        <RNView style={[styles.wfNodeTypeBadge, { backgroundColor: color + '20', borderColor: color + '50' }]}>
          <RNText style={[styles.wfNodeTypeText, { color }]}>{event.node_type || 'agent'}</RNText>
        </RNView>
        <RNText style={styles.wfNodeLabel} numberOfLines={1}>{label}</RNText>
        {!!event.session_id && (
          <TouchableOpacity onPress={() => router.push(`/session/${event.session_id}`)} hitSlop={8}>
            <RNText style={styles.wfNodeLink}>view</RNText>
          </TouchableOpacity>
        )}
      </RNView>
    );
  }

  if (wf === 'workflow_run') {
    return (
      <RNView style={styles.wfRunCard}>
        <FontAwesome name="sitemap" size={12} color={Theme.violet} />
        <RNView style={{ flex: 1, minWidth: 0 }}>
          <RNText style={styles.wfRunName} numberOfLines={1}>{event.name || 'Workflow run'}</RNText>
          {!!event.external_run_id && (
            <RNText style={styles.wfRunId} numberOfLines={1}>{event.external_run_id}</RNText>
          )}
        </RNView>
      </RNView>
    );
  }

  if (wf === 'gate') return <WorkflowGateCard event={event} />;

  return null;
}

const styles = themedStyles((Theme) => StyleSheet.create({
  wfStartedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.violet + '40',
    backgroundColor: Theme.violet + '14',
    marginVertical: 4,
  },
  wfStartedText: {
    flex: 1,
    fontSize: 12,
    color: Theme.textMuted,
  },
  wfNodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 2,
  },
  wfNodePulse: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Theme.accent,
  },
  wfNodeTypeBadge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  wfNodeTypeText: {
    fontSize: 9,
    fontWeight: '600',
  },
  wfNodeLabel: {
    flex: 1,
    fontSize: 12,
    color: Theme.textSecondary,
  },
  wfNodeLink: {
    fontSize: 10,
    fontWeight: '600',
    color: Theme.cyan,
    textDecorationLine: 'underline',
  },
  wfRunCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.violet + '40',
    backgroundColor: Theme.violet + '0d',
    marginVertical: 4,
  },
  wfRunName: {
    fontSize: 12,
    fontWeight: '600',
    color: Theme.text,
  },
  wfRunId: {
    fontSize: 10,
    fontFamily: 'JetBrainsMono-Regular',
    color: Theme.textDim,
    marginTop: 1,
  },
  wfGateCard: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.magenta + '55',
    backgroundColor: Theme.magenta + '0d',
    marginVertical: 4,
    overflow: 'hidden',
  },
  wfGateHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.magenta + '30',
  },
  wfGateHeaderText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
    color: Theme.magenta,
  },
  wfGateStatus: {
    marginLeft: 'auto',
    fontSize: 10,
    fontWeight: '600',
  },
  wfGatePrompt: {
    fontSize: 13,
    color: Theme.text,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  wfGateChoices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 10,
    paddingBottom: 10,
  },
  wfGateChoice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border + '60',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  wfGateChoiceKey: {
    fontSize: 11,
    fontFamily: 'JetBrainsMono-Regular',
    color: Theme.magenta,
  },
  wfGateChoiceLabel: {
    fontSize: 12,
    color: Theme.text,
  },
}));

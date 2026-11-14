// Above the composer: "Open terminal", when a waiting send is stuck on
// something only the pane shows (lib/terminal/terminalOffer.ts). Its own
// component, so the machine lookup and the timers re-render this row only,
// not the session screen around it.
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View as RNView } from 'react-native';
import { api } from '@codecast/convex/convex/_generated/api';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { OpenTerminalButton } from '@/components/HeldSendRow';
import { MACHINE_QUIET_MS, sessionTerminalOffer, type PendingLike } from '@/lib/terminal/terminalOffer';

export function TerminalOfferBar({ conversationId, isLive, agentBusy, pending, onOpen, onReachable }: {
  conversationId: string;
  isLive: boolean;
  agentBusy: boolean;
  pending: PendingLike | null | undefined;
  onOpen: () => void;
  /** Whether the pane's machine is one this person can relay from, each time that answer changes. */
  onReachable?: (mine: boolean) => void;
}) {
  // Only a pane on one of this person's machines can be relayed, and a
  // machine gone quiet (asleep, offline) cannot answer: it offers nothing.
  const machine = useQueryNoThrow(api.devices.getConversationMachine, { conversation_id: conversationId } as any).data as
    | { is_mine?: boolean; last_seen?: number }
    | null
    | undefined;
  const mine = !!machine?.is_mine;
  useEffect(() => {
    onReachable?.(mine);
  }, [mine, onReachable]);
  const [tick, setTick] = useState(0);
  const quietAt = machine?.last_seen ? machine.last_seen + MACHINE_QUIET_MS : 0;
  const prompt = useMemo(
    () => sessionTerminalOffer({ reachable: !!machine?.is_mine && Date.now() < quietAt, isLive, agentBusy, pending, now: Date.now() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick re-reads the clock
    [machine?.is_mine, quietAt, isLive, agentBusy, pending, tick],
  );
  // One re-render at the next moment the answer can change on its own: a
  // waiting send turning stuck, or the machine going quiet.
  const wakeAt = Math.min(prompt.nextAt ?? Infinity, prompt.offer && quietAt ? quietAt + 1 : Infinity);
  useEffect(() => {
    if (!Number.isFinite(wakeAt)) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(0, wakeAt - Date.now()));
    return () => clearTimeout(t);
  }, [wakeAt]);
  if (!prompt.offer) return null;
  return (
    <RNView style={styles.row}>
      <OpenTerminalButton onPress={onOpen} />
    </RNView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 12, paddingTop: 4, paddingBottom: 2 },
});

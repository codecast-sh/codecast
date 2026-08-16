import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View as RNView } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import { Theme, Spacing } from '@/constants/Theme';

// "Samvit is typing…" above the composer — the same contract as the web
// indicator: one subscription for the whole channel, the client filters to the
// scope it is looking at (floor vs one thread) and OWNS expiry, because a
// Convex query never re-runs from time passing.

const TYPING_TTL_MS = 8_000;

export function TypingRow({
  channelId,
  threadRootId,
  viewerId,
  nameOf,
}: {
  channelId: string | undefined;
  /** Present on the thread screen: only that thread's typists show. */
  threadRootId?: string;
  viewerId: string;
  nameOf: (userId: string) => string;
}) {
  const rows = useQuery(
    api.chatTyping.list,
    channelId ? { channel_id: channelId as Id<'chat_channels'> } : 'skip',
  );
  // The local ticker that retires stale rows; without it the last row of a
  // stopped typist would stand until the next server change.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!rows?.length) return;
    const t = setInterval(() => setTick((n) => n + 1), 2_000);
    return () => clearInterval(t);
  }, [rows?.length]);

  const names = useMemo(() => {
    void tick;
    const scope = threadRootId ?? '';
    const cutoff = Date.now() - TYPING_TTL_MS;
    const ids = (rows ?? [])
      .filter((r) => r.thread_key === scope && r.updated_at > cutoff && String(r.user_id) !== viewerId)
      .map((r) => String(r.user_id));
    return Array.from(new Set(ids)).map(nameOf).filter(Boolean);
  }, [rows, threadRootId, viewerId, nameOf, tick]);

  if (names.length === 0) return null;
  const label =
    names.length === 1 ? `${names[0]} is typing…`
    : names.length === 2 ? `${names[0]} and ${names[1]} are typing…`
    : 'Several people are typing…';
  return (
    <RNView style={styles.row}>
      <RNText style={styles.text}>{label}</RNText>
    </RNView>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: Spacing.md, paddingBottom: 2 },
  text: { fontSize: 10.5, fontStyle: 'italic', color: Theme.textMuted0 },
});

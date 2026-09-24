type PendingRow = { _id: string; _clientId?: string; _isLocalQueue?: boolean; _isSettled?: boolean; timestamp?: number };
type Coverage = { access: string; coverage?: { kind: string; commandIds: string[] }; delivery?: { settled: string[]; failed: string[] } };

export async function reconcilePendingMessageCoverage(options: {
  pending: Record<string, PendingRow[]>;
  query: (conversationId: string, commandIds: string[]) => Promise<Coverage>;
  settle: (conversationId: string, commandIds: string[]) => void;
  fail?: (conversationId: string, commandIds: string[]) => void;
  isCurrent: () => boolean;
}) {
  const entries = Object.entries(options.pending).sort((a, b) =>
    Math.max(...b[1].map(m => m.timestamp ?? 0), 0) - Math.max(...a[1].map(m => m.timestamp ?? 0), 0));
  for (const [conversationId, rows] of entries) {
    if (!/^[a-z0-9]{32}$/.test(conversationId)) continue;
    const ids = [...new Set(rows.filter(row => !row._isLocalQueue && !row._isSettled).map(row => row._clientId ?? row._id))]
      .filter(id => id.length > 0 && id.length <= 160 && id === id.trim());
    for (let offset = 0; offset < ids.length; offset += 64) {
      if (!options.isCurrent()) return;
      const requested = ids.slice(offset, offset + 64);
      const result = await options.query(conversationId, requested);
      if (!options.isCurrent()) return;
      if (result.access !== "granted" || result.coverage?.kind !== "command-ids") continue;
      const confirmed = [...new Set([...result.coverage.commandIds, ...(result.delivery?.settled ?? [])])]
        .filter(id => requested.includes(id));
      if (confirmed.length) options.settle(conversationId, confirmed);
      const failed = result.delivery?.failed.filter(id => requested.includes(id) && !confirmed.includes(id));
      if (failed?.length) options.fail?.(conversationId, failed);
    }
  }
}

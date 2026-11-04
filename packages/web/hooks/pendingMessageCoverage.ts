type PendingRow = { _id: string; _clientId?: string; _isLocalQueue?: boolean; _isQueued?: boolean; _isSettled?: boolean; timestamp?: number; images?: Array<{ uploading?: boolean } | null | undefined> };
type Coverage = { access: string; coverage?: { kind: string; commandIds: string[] }; delivery?: { settled: string[]; failed: string[]; cancelled?: string[]; unknown?: string[] } };

// How long a send may stay unknown to the server before it reads as lost. A
// dispatched send reaches the server within seconds, and one that cannot yet
// (offline, a parked create) waits in the outbox, which `stillQueued` checks.
export const LOST_SEND_GRACE_MS = 2 * 60 * 1000;

export async function reconcilePendingMessageCoverage(options: {
  pending: Record<string, PendingRow[]>;
  query: (conversationId: string, commandIds: string[]) => Promise<Coverage>;
  settle: (conversationId: string, commandIds: string[]) => void;
  fail?: (conversationId: string, commandIds: string[]) => void;
  // Cancelled outright: no echo will come for these.
  drop?: (conversationId: string, commandIds: string[]) => void;
  // The conversation itself no longer exists: none of its sends can ever settle.
  gone?: (conversationId: string) => void;
  // Whether any window's outbox still holds a send with this client id.
  // Read once per pass, and only when the server reports an unknown send.
  stillQueued?: () => Promise<(clientId: string) => boolean>;
  now?: () => number;
  isCurrent: () => boolean;
}) {
  let queued: ((clientId: string) => boolean) | null = null;
  const now = options.now ?? Date.now;
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
      if (result.access === "missing") { options.gone?.(conversationId); break; }
      if (result.access !== "granted" || result.coverage?.kind !== "command-ids") continue;
      const confirmed = [...new Set([...result.coverage.commandIds, ...(result.delivery?.settled ?? [])])]
        .filter(id => requested.includes(id));
      if (confirmed.length) options.settle(conversationId, confirmed);
      const cancelled = result.delivery?.cancelled?.filter(id => requested.includes(id) && !result.coverage!.commandIds.includes(id));
      if (cancelled?.length) options.drop?.(conversationId, cancelled);
      const failed = result.delivery?.failed.filter(id => requested.includes(id) && !confirmed.includes(id)) ?? [];
      // Never received, past the grace, in no outbox: the send was lost on
      // the way, and the person must see it failed (and retry) rather than
      // read "sending" forever. A queued or still-uploading send has not been
      // dispatched yet, so it is not lost.
      const unknown = (result.delivery?.unknown ?? []).filter(id => requested.includes(id) && !confirmed.includes(id) && !failed.includes(id))
        .filter(id => {
          const row = rows.find(r => (r._clientId ?? r._id) === id);
          return !!row && !row._isQueued && !row.images?.some(image => image?.uploading)
            && row.timestamp != null && now() - row.timestamp >= LOST_SEND_GRACE_MS;
        });
      if (unknown.length && options.stillQueued) {
        queued ??= await options.stillQueued();
        if (!options.isCurrent()) return;
        failed.push(...unknown.filter(id => !queued!(id)));
      }
      if (failed.length) options.fail?.(conversationId, failed);
    }
  }
}

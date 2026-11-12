/** A failed folder fetch is not retried on its own for `retryMs`, so the
 *  resume, repair and delivery paths that all land on one folder share an
 *  attempt; an explicit restart forgets the conversation's failures. */
export function folderFetchGate(retryMs: number, now: () => number = Date.now) {
  const failures = new Map<string, { at: number; reason: string }>();
  return {
    blocked: (key: string) => {
      const f = failures.get(key);
      return f && now() - f.at < retryMs ? f.reason : undefined;
    },
    reason: (key: string) => failures.get(key)?.reason,
    fail: (key: string, reason: string) => { failures.set(key, { at: now(), reason }); },
    clear: (key: string) => failures.delete(key),
    forgetConversation: (conversationId: string) => {
      for (const key of failures.keys()) if (key.startsWith(`${conversationId}\0`)) failures.delete(key);
    },
  };
}

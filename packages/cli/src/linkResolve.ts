// Resolve "which conversation is the CURRENT session" for `cast link` with no
// argument. Local first: the daemon's session→conversation map is written at
// session discovery, while the server-side session_id binding rides the
// daemon's retry queue — so a just-started or just-resumed session can miss on
// the server for its first minute. The short retry rides out the daemon
// discovering a brand-new JSONL.
export interface ResolveCurrentConversationDeps {
  readLocalMap: () => Record<string, string>;
  resolveOnServer: (sessionId: string) => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  delayMs?: number;
}

export async function resolveCurrentConversationId(
  sessionId: string,
  deps: ResolveCurrentConversationDeps,
): Promise<string | null> {
  const attempts = deps.attempts ?? 3;
  const delayMs = deps.delayMs ?? 1500;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(delayMs);
    const local = deps.readLocalMap()[sessionId];
    if (local) return local;
    const remote = await deps.resolveOnServer(sessionId);
    if (remote) return remote;
  }
  return null;
}

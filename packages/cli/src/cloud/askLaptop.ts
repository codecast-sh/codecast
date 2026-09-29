/**
 * Waiting on a laptop's answer to a request from the cloud host (or another
 * shell): the request is a daemon_commands row, and the answer lands on it
 * (cloud.commandOutcome). Shared by `cast browser sync` and `cast sync`.
 */

export interface CommandOutcome { executed_at: number | null; result: string | null; error: string | null }

export interface AwaitDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
}

/** The answered row, or null once `deadline` passes without one. */
export async function awaitCommandOutcome(
  query: (commandId: string) => Promise<CommandOutcome | null>,
  commandId: string,
  deadline: number,
  deps: AwaitDeps = {},
): Promise<CommandOutcome | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  for (;;) {
    const row = await query(commandId);
    if (row?.executed_at) return row;
    if (now() >= deadline) return null;
    await sleep(deps.pollMs ?? 2_000);
  }
}

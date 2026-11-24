// What `cast flow run` says when it could not make a change's worktree (flowCommand.ts).
/**
 * Why `cast ws acquire --json` left no worktree to run in, in words. A
 * worktree whose contract failed prints its JSON and exits 2: the failed
 * checks are the reason, and the worktree stays, broken, until it is healed.
 */
export function acquireFailureLine(worktree: string, out: string, err: string): string {
  const last = out.trim().split("\n").pop() ?? "";
  let ws: { state?: string; contract?: { failures?: Array<{ name: string; reason?: string }>; warnings?: Array<{ name: string; reason?: string }> } | null } | null = null;
  try {
    ws = last.startsWith("{") ? JSON.parse(last) : null;
  } catch {}
  if (ws?.state === "broken") {
    const checks = ws.contract?.failures?.length ? ws.contract.failures : ws.contract?.warnings ?? [];
    const why = checks.map((c) => `${c.name}${c.reason ? `: ${c.reason}` : ""}`).join("; ");
    return `The worktree ${worktree} for the change is broken${why ? ` (${why})` : ""}. Repair it with cast ws heal ${worktree}, or remove it with cast ws destroy ${worktree}, then run this again.`;
  }
  return `Could not make the worktree for the change: ${(err || out).trim().split("\n").pop()}`;
}

/**
 * A child `cast` as flowCommand's cast() reports it. A spawn that never started (no such binary on PATH, or a
 * compiled CLI's own path) has no exit status and no output, only `error`: its reason is the line, not an empty
 * one (ct-98253).
 */
export function castResult(r: { status: number | null; stdout?: string | null; stderr?: string | null; error?: Error }): { code: number; out: string; err: string } {
  return { code: r.status ?? 1, out: r.stdout ?? "", err: [r.stderr, r.error?.message].filter(Boolean).join("\n") };
}

// Spawning one tmux pane, with the liveness check every spawner in the tests
// and the bench needs.
//
// This is a LEAF: node builtins plus tmux.js, nothing else. `cast bench` reaches
// it through bench/fixture.ts in the human's own CLI process, so a heavy import
// here (daemon.js, bun:sqlite) or an import with a side effect
// (isolatedTmuxServer.ts, which redirects TMUX_TMPDIR) would land in a real CLI
// run. messagingHarness.ts re-exports both functions with the isolation guard
// applied, which is what the test suites use.

import { execSync } from "node:child_process";
import { tmuxRun as defaultTmuxRun } from "../tmux.js";

/** Wrap a value in single quotes for a `bash -c` body. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface SpawnTmuxPaneOptions {
  session: string;
  cwd: string;
  /** bash -c body run inside the pane. */
  body: string;
  env?: NodeJS.ProcessEnv;
  /** tmux runner. The bench fixture drives its own private socket. */
  run?: typeof defaultTmuxRun;
  /** Spawn attempts. 1 means the caller verifies liveness itself. */
  attempts?: number;
  /** Called once `new-session` returned 0, before the liveness probe. */
  onCreated?: () => void;
}

/**
 * `tmux new-session -d`, verified alive.
 *
 * Up to 3 attempts by default: under heavy load the inner bash dies before
 * reaching the agent (tmux PTY setup race), so "alive 250ms later" is verified
 * before the spawn is called a success — sleep first, or a session that died
 * right after exec looks healthy.
 */
export function spawnTmuxPane(opts: SpawnTmuxPaneOptions): void {
  const tmuxRun = opts.run ?? defaultTmuxRun;
  const attempts = opts.attempts ?? 3;
  const alive = (): boolean => tmuxRun(["has-session", "-t", opts.session]).status === 0;
  let lastErr = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    const r = tmuxRun([
      "new-session", "-d", "-s", opts.session,
      "-x", "200", "-y", "50",
      "-c", opts.cwd,
      "bash", "-c", opts.body,
    ], opts.env ? { env: opts.env } : undefined);
    if (r.status !== 0) {
      lastErr = `tmux new-session failed (status ${r.status}): ${r.stderr ?? ""} ${r.stdout ?? ""}`;
      if (attempts > 1) tmuxRun(["kill-session", "-t", opts.session]);
      continue;
    }
    opts.onCreated?.();
    if (attempts === 1) return;
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (alive()) return;
      execSync("sleep 0.05");
    }
    lastErr = "tmux session died within 1s of spawn";
    tmuxRun(["kill-session", "-t", opts.session]);
  }
  throw new Error(`tmux pane spawn failed after ${attempts} attempts: ${lastErr}`);
}

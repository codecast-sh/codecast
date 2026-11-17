// The run's paths and environment for the harness's sibling modules
// (prompt-dry-run-*.ts). prompt-dry-run.ts sets them once, after it has parsed
// argv and built the child env and before the broker starts; every reader runs
// after that.
export type HarnessContext = {
  runDir: string;
  /** Beside the run dir, where the agent cannot write: the fake's world, the record, live-read copies. */
  harnessDir: string;
  /** An empty directory the broker and the real CLI run in. */
  brokerCwdDefault: string;
  guardDir: string;
  agentGuardDir: string;
  serveDir?: string;
  agentCwd?: string;
  fakeBin?: string;
  fakeSeed?: string;
  /** Where the fake (--fake) keeps its world, tree and seed: the one place its process may write. */
  fakeDir: string;
  /** The child env; the broker copies it when it starts. */
  env: Record<string, string>;
  realEnvHome: string;
  RUN_TAG: string;
};

let current: HarnessContext | null = null;

export function setContext(c: HarnessContext): void {
  current = c;
}

export function ctx(): HarnessContext {
  if (!current) throw new Error("prompt-dry-run: the harness context was read before it was set");
  return current;
}

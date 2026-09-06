// Runs a trigger's `--precheck` shell command and reports what it did.
//
// The gate exists so a trigger that should act only when something changed
// ("has main moved?", "is the queue non-empty?") can answer that in a shell
// command instead of spending a whole agent session on it. Exit 0 means run;
// anything else, a timeout included, means skip this firing.
//
// Three rules the daemon depends on:
//   • It never blocks the loop. spawn() is asynchronous end to end, and the
//     timeout is a timer, not a wait.
//   • The command runs in its own process group, so a precheck that starts
//     children ("git fetch | grep") is fully stopped on timeout rather than
//     leaving the children orphaned past the kill.
//   • It carries no agent env markers. A precheck runs under the daemon, whose
//     env may still hold whatever shell bootstrapped it — and a leaked
//     CLAUDE_CODE_CHILD_SESSION makes any `claude` the precheck itself invokes
//     start with transcript saving off (see agentEnv.ts).

import { spawn } from "./proc.js";
import {
  TRIGGER_PRECHECK_OUTPUT_CHARS,
  TRIGGER_PRECHECK_TIMEOUT_MS,
  type TriggerPrecheckResult,
} from "@codecast/shared/contracts";
import { scrubAgentEnv } from "./agentEnv.js";

/** Grace between "stop" and "stop for real" after a timeout. */
const SIGKILL_DELAY_MS = 2_000;

/** Keep the TAIL: a command that fails loudly says why in its last lines. */
function appendTail(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length <= TRIGGER_PRECHECK_OUTPUT_CHARS
    ? next
    : next.slice(-TRIGGER_PRECHECK_OUTPUT_CHARS);
}

export function runTriggerPrecheck(opts: {
  command: string;
  cwd: string;
  timeoutMs?: number;
}): Promise<TriggerPrecheckResult> {
  const timeoutMs = opts.timeoutMs ?? TRIGGER_PRECHECK_TIMEOUT_MS;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (fields: Partial<TriggerPrecheckResult>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        command: opts.command,
        timedOut,
        durationMs: Date.now() - startedAt,
        output: output || undefined,
        ...fields,
      });
    };

    let child;
    try {
      child = spawn(opts.command, {
        cwd: opts.cwd,
        shell: true,
        // Own process group, so the timeout kill reaches the whole pipeline.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: scrubAgentEnv({ ...process.env }),
      });
    } catch (err) {
      settle({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      if (!pid) {
        child.kill("SIGTERM");
        return;
      }
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      killTimer = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* the group is already gone */
        }
      }, SIGKILL_DELAY_MS);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output = appendTail(output, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      output = appendTail(output, chunk);
    });
    child.on("error", (err: Error) => settle({ error: err.message }));
    child.on("close", (code: number | null) => {
      // A timed-out command's exit status is the signal that killed it, which
      // says nothing about the check — leave exitCode absent so `timedOut` is
      // the only thing read.
      settle(timedOut || typeof code !== "number" ? {} : { exitCode: code });
    });
  });
}

/**
 * Setup runner: executes manifest.setup.{install,generate,migrate} commands
 * sequentially in the worktree, with env injection and full-output capture.
 *
 * Each phase is a list of shell command strings. They run via `bash -c`, so
 * pipes, redirects, and shell builtins work as in a normal terminal. Output
 * streams live to the caller (so users see progress) AND is captured to a
 * per-run log file in `.codecast/logs/setup-<ts>.log`.
 *
 * The first non-zero exit aborts the run. Subsequent phases are not started.
 * The caller's error includes the failing phase + command for triage.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspaceManifest } from "./types.js";

export type SetupPhase = "install" | "generate" | "migrate";

const PHASE_ORDER: readonly SetupPhase[] = ["install", "generate", "migrate"];

export interface RunSetupOptions {
  /** Extra env vars to merge with process.env. Already-set keys are replaced. */
  env?: NodeJS.ProcessEnv;
  /**
   * Stream destination. Defaults to process.stdout/stderr. Pass null to
   * suppress live output (log file still captures everything).
   */
  stream?: NodeJS.WritableStream | null;
  /**
   * Skip specific phases (e.g., to re-run only generate+migrate during heal).
   */
  skipPhases?: SetupPhase[];
  /** Override the log directory. Default `${worktreePath}/.codecast/logs`. */
  logDir?: string;
}

export interface SetupResult {
  /** All commands that ran successfully (in order). */
  ran: Array<{ phase: SetupPhase; command: string; durationMs: number }>;
  /** Absolute path to the captured log file. */
  logPath: string;
}

export class SetupError extends Error {
  constructor(
    message: string,
    public readonly phase: SetupPhase,
    public readonly command: string,
    public readonly exitCode: number | null,
    public readonly logPath: string,
  ) {
    super(message);
    this.name = "SetupError";
  }
}

/** Run setup commands. Returns on success; throws SetupError on first failure. */
export async function runSetup(
  manifest: WorkspaceManifest,
  worktreePath: string,
  opts: RunSetupOptions = {},
): Promise<SetupResult> {
  const logDir = opts.logDir ?? path.join(worktreePath, ".codecast", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(logDir, `setup-${ts}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: "w" });

  const env = { ...process.env, ...(opts.env ?? {}) };
  const skip = new Set(opts.skipPhases ?? []);
  const stream = opts.stream === undefined ? process.stdout : opts.stream;
  const errStream = opts.stream === undefined ? process.stderr : opts.stream;
  const ran: SetupResult["ran"] = [];

  // Header in log
  logStream.write(`=== workspace setup @ ${new Date().toISOString()} ===\n`);
  logStream.write(`cwd: ${worktreePath}\n`);
  logStream.write(`detected: ${manifest.detected ?? "(none)"}\n\n`);

  try {
    for (const phase of PHASE_ORDER) {
      if (skip.has(phase)) {
        logStream.write(`--- ${phase}: SKIPPED (per options) ---\n\n`);
        continue;
      }
      const commands = manifest.setup[phase];
      if (commands.length === 0) {
        logStream.write(`--- ${phase}: nothing to run ---\n\n`);
        continue;
      }
      for (const command of commands) {
        logStream.write(`--- ${phase}: ${command} ---\n`);
        const start = Date.now();
        const { exitCode } = await execCommand(command, worktreePath, env, [
          logStream,
          stream,
          errStream,
        ]);
        const durationMs = Date.now() - start;
        if (exitCode !== 0) {
          logStream.write(`\n--- ${phase}: FAILED with exit ${exitCode} ---\n`);
          throw new SetupError(
            `setup '${phase}' failed: \`${command}\` exited ${exitCode}. See ${logPath}.`,
            phase,
            command,
            exitCode,
            logPath,
          );
        }
        logStream.write(`\n--- ${phase}: ok (${durationMs}ms) ---\n\n`);
        ran.push({ phase, command, durationMs });
      }
    }
    logStream.write(`=== setup complete ===\n`);
    return { ran, logPath };
  } finally {
    await new Promise<void>((resolve) => {
      logStream.end(() => resolve());
    });
  }
}

/**
 * Spawn a shell command, fan output to multiple streams, return exit code.
 * We do NOT throw here on non-zero — caller decides.
 */
function execCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  streams: Array<NodeJS.WritableStream | null | undefined>,
): Promise<{ exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const writeAll = (chunk: Buffer) => {
      for (const s of streams) {
        if (s) {
          try {
            s.write(chunk);
          } catch {
            /* ignore */
          }
        }
      }
    };
    child.stdout?.on("data", writeAll);
    child.stderr?.on("data", writeAll);
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code }));
  });
}

/**
 * Start a long lived helper as its own on-demand launchd job rather than as a
 * child of whichever agent shell needed it.
 *
 * Every agent runs under the codecast daemon's launchd job, which macOS clamps
 * to utility QoS (priority 20), and a child inherits the clamp; no call inside
 * the process lifts it. A helper that serves every session then queues behind
 * a thousand processes at the same priority: the bridge host got 4% of a core
 * at load 150 (2026-10-01), and a typecheck watcher got two CPU minutes in an
 * hour at load 300 (2026-10-02). An Interactive job runs at 37.
 */

import * as fs from "node:fs";
import { spawn, spawnSync } from "./proc.js";

/** The environment a launchd job keeps: where cast's state lives and how to find tools, no credentials. */
const JOB_ENV = /^(HOME|PATH|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_[A-Z]+|CODECAST_[A-Z0-9_]+|CAST_[A-Z0-9_]+|BUN_[A-Z0-9_]+)$/;
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/;

/** The variable a job's process finds its own label in, so it can unload itself on the way out. */
export const LAUNCHD_LABEL_ENV = "CAST_LAUNCHD_LABEL";

const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** An on-demand launchd job: started now, never at login, never restarted by launchd. */
export function launchdJobPlistXml(label: string, argv: string[], env: Record<string, string>, logPath: string): string {
  const strings = (xs: string[]) => xs.map((x) => `    <string>${xmlText(x)}</string>`).join("\n");
  const vars = Object.entries(env)
    .map(([k, v]) => `    <key>${xmlText(k)}</key>\n    <string>${xmlText(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlText(label)}</string>
  <key>ProgramArguments</key>
  <array>
${strings(argv)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xmlText(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlText(logPath)}</string>
</dict>
</plist>
`;
}

/**
 * Start `argv` as the launchd job `label`, its plist written to `plistPath`.
 * A running job is left alone; a loaded job whose process exited is reloaded
 * from the plist just written, since the program may have moved since it was
 * loaded (another checkout, a new binary). False when launchd cannot take it
 * (not macOS, no GUI domain over SSH, a launchctl failure); the caller falls
 * back to a detached child.
 */
export function startLaunchdJob(job: { label: string; argv: string[]; plistPath: string; logPath: string }): boolean {
  if (process.platform !== "darwin") return false;
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  const service = `gui/${uid}/${job.label}`;
  const env: Record<string, string> = { [LAUNCHD_LABEL_ENV]: job.label };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && JOB_ENV.test(k) && !SECRET_ENV.test(k) && k !== LAUNCHD_LABEL_ENV) env[k] = v;
  try {
    fs.writeFileSync(job.plistPath, launchdJobPlistXml(job.label, job.argv, env, job.logPath), { mode: 0o600 });
  } catch {
    return false;
  }
  const launchctl = (...a: string[]) => spawnSync("/bin/launchctl", a, { encoding: "utf8", timeout: 10_000 }).status === 0;
  const running = spawnSync("/bin/launchctl", ["print", service], { encoding: "utf8", timeout: 10_000 });
  if (running.status === 0) {
    if (/\bstate = running\b/.test(running.stdout)) return true;
    launchctl("bootout", service);
  }
  return launchctl("bootstrap", `gui/${uid}`, job.plistPath) || launchctl("kickstart", service);
}

/**
 * Unload this process's own launchd job, if it runs as one, so short lived
 * jobs (one per worktree and project) do not pile up in launchd. Call it on
 * the way out: launchd ends the process when the job goes.
 */
export function unloadOwnLaunchdJob(): void {
  const label = process.env[LAUNCHD_LABEL_ENV];
  const uid = process.getuid?.();
  if (!label || uid === undefined) return;
  try {
    spawn("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], { detached: true, stdio: "ignore" }).unref();
  } catch {}
}

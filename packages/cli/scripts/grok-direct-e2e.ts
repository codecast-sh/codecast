#!/usr/bin/env bun
// Real end-to-end check of Grok on the direct backend against the real `grok`:
//
//   bun packages/cli/scripts/grok-direct-e2e.ts [--keep]
//
// Drives ClaudeSdkBackend (the daemon's side) with host processes started from
// this checkout as launchd jobs, as the daemon starts them, through a short
// conversation: a session made in grok's own CLI is loaded (the switch from a
// terminal), a turn, a message sent while a turn runs, an interrupt, a daemon
// that reattaches, a host killed and resumed. Then it checks grok wrote every
// prompt to the session's updates.jsonl, the file the daemon syncs.
//
// Isolation: a private GROK_HOME, so the session lands outside ~/.grok and the
// running daemon never syncs it, with auth.json linked to the real login so a
// token refresh updates the one copy instead of forking a second grant. It does
// not touch the running daemon. Everything it made is removed unless --keep.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { ClaudeSdkBackend, type ClaudeSdkBackendDeps } from "../src/claudeSdk/backend.js";
import { readHostState } from "../src/claudeSdk/client.js";
import type { SdkActivity } from "../src/claudeSdk/protocol.js";

const keep = process.argv.includes("--keep");
const grok = spawnSync("/bin/sh", ["-lc", "command -v grok"], { encoding: "utf8" }).stdout.trim();
if (!grok) throw new Error("grok is not installed");
const realAuth = path.join(os.homedir(), ".grok", "auth.json");
if (!fs.existsSync(realAuth)) throw new Error("grok is not signed in (no ~/.grok/auth.json)");

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-direct-e2e-")));
const grokHome = path.join(scratch, "grok-home");
const hostDir = path.join(scratch, "hosts");
const cwd = path.join(scratch, "project");
for (const d of [grokHome, hostDir, cwd]) fs.mkdirSync(d, { recursive: true });
fs.symlinkSync(realAuth, path.join(grokHome, "auth.json"));
fs.writeFileSync(path.join(cwd, "AGENTS.md"), "When asked for the project marker, reply with exactly MARKER-4410 and nothing else.\n");
// The host inherits this process's env, as a launchd job inherits the daemon's.
process.env.GROK_HOME = grokHome;

const activity: SdkActivity[] = [];
const results: string[] = [];
const log = (line: string) => console.log(`  ${line}`);
const deps: ClaudeSdkBackendDeps = {
  log: (l) => { if (process.env.E2E_VERBOSE) log(l); },
  castArgv: () => [process.execPath, path.join(import.meta.dir, "..", "src", "main.ts")],
  shellPrefix: () => "",
  activity: (_c, _s, a) => activity.push(a),
  permission: async () => ({ behavior: "allow" }),
  turnError: (_c, _s, e) => { results.push(`error:${e.kind}`); log(`turn error ${e.kind}: ${e.message}`); },
  stopped: (_c, _s, why) => log(`host gone: ${why}`),
  tooOld: () => {},
  transcriptHas: async () => false,
  mayResume: async () => true,
  resumeAccount: async (_c, saved) => saved,
  resumeModelEffort: () => ({ model: [], effort: [] }),
  transcriptExists: () => true,
  sessionChanged: (_c, prev, next) => log(`session moved ${prev.slice(0, 8)} -> ${next.slice(0, 8)}`),
};
const conv = "e2e-conversation";
const turnEnds = () => activity.filter((a) => a.turnCompletedAt).length;
const until = async <T>(what: string, fn: () => T | undefined | null | false, ms = 180_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};
const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
const t = () => Date.now();

// 1. A session made by grok's own CLI, as a terminal session would be.
let t0 = t();
const made = spawnSync(grok, ["-p", "Reply with exactly the word ready.", "--permission-mode", "bypassPermissions", "--output-format", "json"], { cwd, env: process.env, encoding: "utf8", timeout: 180_000 });
const sessionId = (() => {
  try { return JSON.parse(made.stdout).session_id ?? JSON.parse(made.stdout).sessionId; } catch { return null; }
})() ?? (() => {
  const root = path.join(grokHome, "sessions");
  for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) for (const s of fs.readdirSync(path.join(root, d))) return s;
  return null;
})();
check("grok CLI made a session", !!sessionId, `${t() - t0}ms ${sessionId ?? made.stderr.slice(0, 300)}`);
if (!sessionId) process.exit(1);
const updates = () => {
  const root = path.join(grokHome, "sessions");
  for (const d of fs.readdirSync(root)) {
    const f = path.join(root, d, sessionId, "updates.jsonl");
    if (fs.existsSync(f)) return fs.readFileSync(f, "utf8");
  }
  return "";
};

const backend = new ClaudeSdkBackend(deps, hostDir);
const spec = {
  agent: "grok" as const,
  conversationId: conv,
  sessionId,
  resume: true,
  cwd,
  executable: grok,
  args: ["--permission-mode", "bypassPermissions"],
  env: {},
};

try {
  // 2. The switch: load it in a direct host.
  t0 = t();
  await backend.start(conv, spec);
  check("direct host loaded the CLI session", backend.isRunning(conv), `${t() - t0}ms`);
  check("lands idle at a session boundary", !!activity.find((a) => a.sessionBoundary));

  // 3. A turn that reads the project's AGENTS.md.
  t0 = t();
  await backend.deliver(conv, "m1", "What is the project marker?");
  await until("first turn", () => turnEnds() >= 1);
  check("a turn runs and ends idle with a stamp", activity.at(-1)?.status === "idle", `${t() - t0}ms`);
  check("thinking was reported first", activity.some((a) => a.status === "thinking"));

  // 4. A message sent while a turn runs: grok runs it as the next turn.
  const before = turnEnds();
  await backend.deliver(conv, "m2", "Run the shell command `sleep 6 && echo slow-done`, then reply SLOW.");
  await until("working", () => activity.at(-1)?.status === "working" || activity.at(-1)?.status === "thinking");
  await new Promise((r) => setTimeout(r, 1500));
  await backend.deliver(conv, "m3", "Then reply with exactly the word NEXT.");
  await until("both turns", () => turnEnds() >= before + 2, 240_000);
  check("a mid-turn message runs as the next turn", updates().includes("NEXT"));

  // 5. Interrupt a running turn.
  await backend.deliver(conv, "m4", "Run the shell command `sleep 40`, then reply DONE.");
  await until("tool running", () => activity.at(-1)?.status === "working", 120_000);
  t0 = t();
  const interrupted = await backend.interrupt(conv);
  check("interrupt ends the turn", interrupted && activity.at(-1)?.status === "idle", `${t() - t0}ms`);

  // 6. The daemon restarts: a new backend reattaches to the live host.
  const pid = readHostState(sessionId, hostDir)?.pid;
  backend.detachAll();
  const backend2 = new ClaudeSdkBackend(deps, hostDir);
  const attached = await backend2.reattachAll();
  check("a restarted daemon reattaches to the same host", attached.includes(conv) && readHostState(sessionId, hostDir)?.pid === pid);
  const ends2 = turnEnds();
  await backend2.deliver(conv, "m5", "Reply with exactly the word AFTER.");
  await until("turn after reattach", () => turnEnds() > ends2);
  check("a turn runs after the reattach", updates().includes("AFTER"));

  // 7. The host is killed; the next message resumes the session in a new host.
  if (pid) process.kill(pid, "SIGKILL");
  await until("host gone", () => !backend2.isRunning(conv), 30_000);
  const ends3 = turnEnds();
  t0 = t();
  await backend2.deliver(conv, "m6", "Reply with exactly the word RESUMED.");
  await until("resumed turn", () => turnEnds() > ends3);
  check("a killed host resumes on the next message", updates().includes("RESUMED") && readHostState(sessionId, hostDir)?.pid !== pid, `${t() - t0}ms`);

  // 8. Every prompt is in the session's own transcript, the file the daemon syncs.
  const u = updates();
  for (const word of ["project marker", "slow-done", "NEXT", "sleep 40", "AFTER", "RESUMED"]) check(`transcript holds "${word}"`, u.includes(word));
  check("the AGENTS.md marker was read", u.includes("MARKER-4410"));
  check("no turn failed", !results.some((r) => r.startsWith("error")), results.join(","));

  await backend2.stop(conv, { forget: true });
  check("stop leaves no host", !readHostState(sessionId, hostDir));
} finally {
  if (!keep) fs.rmSync(scratch, { recursive: true, force: true });
  else console.log(`kept ${scratch}`);
}
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);

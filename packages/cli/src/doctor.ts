// `cast doctor` — the product's built-in health check and end-to-end sync
// self-test. This replaces the manual morning ritual (spawn a real Claude in
// tmux, open Chrome, screenshot the web UI) with a single command that proves
// the same things using the daemon's REAL production paths:
//
//   up path    stub transcript append → JSONL watcher → sync → Convex
//   down path  pending message (same mutation the web UI uses) → daemon
//              subscription → deliverMessage → session-registry resolution →
//              tmux inject → stub echoes into its transcript → watcher →
//              Convex, where the doctor observes the echo via /cli/export
//
// The stand-in agent is a tiny node script in a tmux pane. It is discovered by
// the daemon exactly like a real agent: it writes the same session-registry
// file the SessionStart hook writes, its pane shows the ❯ prompt the pane
// classifier keys on, and node is already an accepted agent process (codex and
// gemini run under node). No Claude tokens, no browser, no backend changes.
//
// Every leg has a timeout, cleanup always runs (tmux session, scratch dir,
// transcript, registry file, and the server-side conversation via
// delete-by-path), and failures print the daemon.log lines for this run's
// session so the evidence ships with the report.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cliFetch } from "./cliHttp.js";
import { fetchExport } from "./jsonlGenerator.js";
import { claudeProjectDirName } from "./projectPathResolver.js";
import { isProjectAllowedToSync, isPathExcluded } from "./syncScope.js";
import { c, fmt } from "./colors.js";
import type { Config } from "./config/types.js";
import { getMachineKey, hardwareId } from "./machineKey.js";
import { deviceId } from "./remote/device.js";

// ── deps handed in by index.ts ───────────────────────────────────────────────
// The CLI entrypoint owns config decryption and the daemon state-file helpers;
// doctor takes them as values so it stays a leaf module (no daemon import — the
// daemon is a separate bundle entrypoint).

export interface DoctorDeps {
  config: Config;
  siteUrl: string;
  apiToken: string;
  version: string;
  configDir: string;
  getDaemonPid: () => number | null;
  getLaunchdStatus: () => { configured: boolean; state: string | null; pid: number | null } | null;
  readDaemonState: () => {
    connected?: boolean;
    lastSyncTime?: number;
    lastHeartbeatTick?: number;
    lastWatchdogCheck?: number;
    authExpired?: boolean;
  } | null;
  getStuckSyncs: () => Array<{ sessionId: string; unsyncedBytes: number; lastSyncedAt: number }>;
}

export interface DoctorOptions {
  e2e: boolean;
  json: boolean;
  /** Keep the scratch dir, transcript, and server conversation for debugging. */
  keep: boolean;
  /** Override the scratch project dir (must be syncable under the current config). */
  projectDir?: string;
}

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail" | "skip";
  detail: string;
  /** Milliseconds, for e2e legs. */
  elapsedMs?: number;
}

export interface DoctorReport {
  ok: boolean;
  runId: string;
  checks: DoctorCheck[];
  conversationId?: string;
  cleanup: string[];
  /** daemon.log lines matched to a failed run — the debugging evidence. */
  evidence?: string[];
}

const HEARTBEAT_FRESH_MS = 2 * 60 * 1000; // event-loop monitor ticks every 30s
const MAPPING_TIMEOUT_MS = 45_000;
const BOOTSTRAP_TIMEOUT_MS = 30_000;
const ROUNDTRIP_TIMEOUT_MS = 90_000;
const POLL_MS = 750;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── the stand-in agent ────────────────────────────────────────────────────────
// Constant source, parameterized entirely via argv, written into the scratch
// dir at run time. CommonJS + zero dependencies so any node/bun on PATH runs it.
//
// Pane contract with the daemon (see classifyTmuxLiveState / verifyTmuxSubmitAfterPaste):
//   - a visible ❯ marks the pane "idle" so injection proceeds
//   - a ● line after a reply marks the submit "processing" so the paste verifier
//     concludes cleanly instead of re-pasting
//   - readline in terminal mode gives the pre-paste clear sequence (Escape,
//     C-a, C-k) the same semantics it has against a real agent's input box
export const STUB_SOURCE = `// codecast doctor stub agent - minimal stand-in for a coding agent.
// argv: sessionId jsonlPath registryPath
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { randomUUID } = require("crypto");

const [sessionId, jsonlPath, registryPath] = process.argv.slice(2);
if (!sessionId || !jsonlPath || !registryPath) {
  console.error("usage: stub.cjs <sessionId> <jsonlPath> <registryPath>");
  process.exit(2);
}

const cwd = process.cwd();
const line = (o) => JSON.stringify(o) + "\\n";
const now = () => new Date().toISOString();
const entry = (extra) => ({ uuid: randomUUID(), sessionId, cwd, timestamp: now(), ...extra });
const appendUser = (text) =>
  fs.appendFileSync(jsonlPath, line(entry({ type: "user", message: { role: "user", content: text } })));
const appendAssistant = (text) =>
  fs.appendFileSync(jsonlPath, line(entry({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } })));

// Register like the SessionStart hook does, so the daemon's findSessionProcess
// resolves this process (and its tmux pane) for message delivery.
let tty = "";
try { tty = execSync("ps -o tty= -p " + process.pid).toString().trim(); } catch {}
fs.mkdirSync(path.dirname(registryPath), { recursive: true });
fs.writeFileSync(registryPath, JSON.stringify({ pid: process.pid, tty, ts: Math.floor(Date.now() / 1000), term: "tmux" }));

// Bootstrap the conversation: one user + one assistant turn.
fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
const bootToken = process.env.DOCTOR_BOOT_TOKEN || "boot";
appendUser("codecast doctor self-test: say " + bootToken + " back");
appendAssistant(bootToken);

process.stdout.write("codecast doctor stub agent (session " + sessionId.slice(0, 8) + ")\\n\\u276F ");

const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout, terminal: true });
rl.on("line", (raw) => {
  // Strip escape sequences (bracketed-paste markers) and control bytes the
  // paste can carry; what remains is the message as the daemon sent it.
  const text = String(raw)
    .replace(/\\x1b\\[[0-9;]*[A-Za-z~]/g, "")
    .replace(/[\\x00-\\x08\\x0b-\\x1f]/g, "")
    .trim();
  if (!text) { process.stdout.write("\\u276F "); return; }
  appendUser(text);
  const m = text.match(/pong-[a-z0-9]+/i);
  const reply = m ? m[0] : "echo: " + text;
  appendAssistant(reply);
  process.stdout.write("\\u25CF " + reply + "\\n\\u276F ");
});
process.on("SIGTERM", () => process.exit(0));
process.on("SIGHUP", () => process.exit(0));
`;

// ── small helpers ─────────────────────────────────────────────────────────────

function hasBin(name: string): boolean {
  const r = spawnSync("which", [name], { encoding: "utf-8" });
  return r.status === 0 && !!r.stdout.trim();
}

/** node preferred (matches how the npm-installed CLI runs); bun as fallback. */
export function resolveStubRuntime(): string | null {
  if (hasBin("node")) return "node";
  if (hasBin("bun")) return "bun";
  const base = path.basename(process.execPath).toLowerCase();
  if (base.includes("node") || base.includes("bun")) return process.execPath;
  return null;
}

/**
 * Where the self-test transcript's project dir lives. Must pass the SAME
 * scope rules the daemon's sync loop applies, or the transcript sits unsynced
 * forever and the doctor reports a false failure.
 */
export function pickDoctorProjectDir(config: Config, runId: string, override?: string): string | null {
  const candidates = override
    ? [override]
    : [
        path.join(os.homedir(), ".codecast", "doctor", `e2e-${runId}`),
        ...(config.sync_projects ?? []).map((root) => path.join(root, ".codecast-doctor", `e2e-${runId}`)),
      ];
  for (const candidate of candidates) {
    if (isProjectAllowedToSync(candidate, config) && !isPathExcluded(candidate, config.excluded_paths)) {
      return candidate;
    }
  }
  return null;
}

/** Scan exported messages for a token; role narrows which side must carry it. */
export function exportHasToken(
  messages: Array<{ role: string; content: string }>,
  token: string,
  role?: "user" | "assistant",
): boolean {
  return messages.some((m) => (!role || m.role === role) && typeof m.content === "string" && m.content.includes(token));
}

async function doctorPost(siteUrl: string, apiToken: string, urlPath: string, body: Record<string, unknown>): Promise<any> {
  const response = await cliFetch(`${siteUrl}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: apiToken, ...body }),
  });
  const text = await response.text();
  let result: any;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  if (result?.error) throw new Error(String(result.error));
  return result;
}

function readConversationMapping(configDir: string, sessionId: string): string | null {
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(configDir, "conversations.json"), "utf-8"));
    return typeof cache[sessionId] === "string" ? cache[sessionId] : null;
  } catch {
    return null;
  }
}

/** daemon.log lines relevant to this run — the evidence block for failures. */
function daemonLogEvidence(configDir: string, sessionId: string, conversationId: string | undefined, sinceMs: number): string[] {
  try {
    const raw = fs.readFileSync(path.join(configDir, "daemon.log"), "utf-8");
    const lines = raw.split("\n").slice(-2000);
    const sessionKey = sessionId.slice(0, 8);
    const convKey = conversationId?.slice(0, 12);
    const generic = /deliverMessage|Injected|pending message|Subscription|Force-resuming/i;
    const matched = lines.filter((l) => l.includes(sessionKey) || (convKey && l.includes(convKey)) || generic.test(l));
    // Timestamps in daemon.log lead each line as an ISO string; keep it simple
    // and take the tail — sinceMs guards against a totally silent daemon where
    // generic matches would otherwise surface hours-old noise.
    const cutoff = new Date(sinceMs - 5_000).toISOString().slice(0, 16);
    const recent = matched.filter((l) => l.slice(0, 16) >= cutoff);
    return (recent.length > 0 ? recent : matched).slice(-15);
  } catch {
    return [];
  }
}

function tmuxRunQuiet(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("tmux", args, { encoding: "utf-8", timeout: 10_000 });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function formatAgo(ts: number | undefined): string {
  if (!ts || ts <= 0) return "never";
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

// ── the doctor ────────────────────────────────────────────────────────────────

export async function runDoctor(deps: DoctorDeps, opts: DoctorOptions): Promise<DoctorReport> {
  const runId = randomBytes(3).toString("hex");
  const checks: DoctorCheck[] = [];
  const cleanup: string[] = [];
  const say = (line: string) => {
    if (!opts.json) console.log(line);
  };
  const record = (check: DoctorCheck) => {
    checks.push(check);
    const glyph =
      check.status === "pass" ? fmt.success("✓") :
      check.status === "warn" ? fmt.warning("!") :
      check.status === "skip" ? fmt.muted("-") : fmt.error("✗");
    const timing = check.elapsedMs !== undefined ? fmt.muted(`  ${(check.elapsedMs / 1000).toFixed(1)}s`) : "";
    say(`  ${glyph} ${check.name.padEnd(22)} ${check.detail}${timing}`);
  };

  say("");
  say(fmt.muted(`  Codecast Doctor  (run ${runId}, v${deps.version})`));
  say("");

  // ── passive health ──
  const state = deps.readDaemonState();
  if (state?.authExpired) {
    record({ name: "auth", status: "fail", detail: "expired — run `cast auth`" });
  } else {
    record({ name: "auth", status: "pass", detail: "authenticated" });
  }

  try {
    const mk = getMachineKey();
    const binding = hardwareId()
      ? "hardware-bound"
      : "no hardware id, clone detection disabled";
    record({
      name: "device",
      status: "pass",
      detail: `${deviceId()} (${binding})${mk.previousSecret ? " — key was rotated after a hardware clone" : ""}`,
    });
  } catch (e: any) {
    record({ name: "device", status: "warn", detail: `machine key unreadable: ${e?.message ?? e}` });
  }

  const pid = deps.getDaemonPid();
  const launchd = deps.getLaunchdStatus();
  if (!pid) {
    record({
      name: "daemon",
      status: "fail",
      detail: `not running${launchd?.configured ? ` (launchd state: ${launchd.state ?? "unknown"})` : ""} — run \`cast start\``,
    });
  } else {
    const tick = state?.lastHeartbeatTick || state?.lastWatchdogCheck || 0;
    const stale = tick > 0 && Date.now() - tick > HEARTBEAT_FRESH_MS;
    record({
      name: "daemon",
      status: stale ? "fail" : "pass",
      detail: `running (pid ${pid}${launchd?.pid === pid ? ", launchd-managed" : ""}), heartbeat ${formatAgo(tick)}${stale ? " — event loop looks wedged, run `cast restart`" : ""}`,
    });
  }

  const connected = !!pid && (state?.connected ?? false);
  record({
    name: "convex",
    status: connected ? "pass" : "fail",
    detail: connected
      ? `connected (last sync ${formatAgo(state?.lastSyncTime)})`
      : `disconnected${pid ? " — check network / `cast restart`" : ""}`,
  });

  const stuck = deps.getStuckSyncs();
  let retryDepth = 0;
  try {
    const retry = JSON.parse(fs.readFileSync(path.join(deps.configDir, "retry-queue.json"), "utf-8"));
    retryDepth = Array.isArray(retry) ? retry.length : 0;
  } catch {}
  const backlogBad = stuck.length > 0;
  record({
    name: "sync backlog",
    status: backlogBad ? "warn" : "pass",
    detail: backlogBad
      ? `${stuck.length} stuck session(s), ${retryDepth} retry item(s) — see \`cast health\``
      : retryDepth > 0
        ? `${retryDepth} retry item(s) draining`
        : "clear",
  });

  const tmuxAvailable = hasBin("tmux");
  const runtime = resolveStubRuntime();

  // ── active end-to-end round-trip ──
  const evidence: string[] = [];
  let e2eConversationId: string | undefined;
  const hardFail = checks.some((ch) => ch.status === "fail");
  if (!opts.e2e) {
    record({ name: "end-to-end", status: "skip", detail: "skipped (--no-e2e)" });
  } else if (hardFail) {
    record({ name: "end-to-end", status: "skip", detail: "skipped — fix the failures above first" });
  } else if (!tmuxAvailable || !runtime) {
    record({ name: "end-to-end", status: "skip", detail: !tmuxAvailable ? "tmux not installed" : "no node/bun on PATH" });
  } else {
    e2eConversationId = await runE2E(deps, opts, runId, record, cleanup, say, evidence);
  }

  const ok = !checks.some((ch) => ch.status === "fail");
  say("");
  say(ok
    ? `  ${fmt.success("✓ codecast is healthy")}${opts.e2e && checks.some(ch => ch.name.startsWith("echo")) ? fmt.muted(" — full sync loop verified") : ""}`
    : `  ${fmt.error("✗ problems found")} ${fmt.muted("— details above")}`);
  say("");

  return { ok, runId, checks, conversationId: e2eConversationId, cleanup, evidence: evidence.length > 0 ? evidence : undefined };
}

/** Returns the test conversation's id once one was created (even on failure). */
async function runE2E(
  deps: DoctorDeps,
  opts: DoctorOptions,
  runId: string,
  record: (check: DoctorCheck) => void,
  cleanup: string[],
  say: (line: string) => void,
  evidence: string[],
): Promise<string | undefined> {
  const sessionId = randomUUID();
  const tokenA = `boot-${randomBytes(4).toString("hex")}`;
  const tokenB = `pong-${randomBytes(4).toString("hex")}`;
  const tmuxName = `codecast-doctor-${runId}`;
  const runtime = resolveStubRuntime()!;

  const scratchDir = pickDoctorProjectDir(deps.config, runId, opts.projectDir);
  if (!scratchDir) {
    record({
      name: "end-to-end",
      status: "fail",
      detail: "no syncable scratch dir — sync_mode is 'selected' and no allowed root accepts a test dir (`cast sync-settings`)",
    });
    return;
  }

  say("");
  say(fmt.muted("  End-to-end sync round-trip"));

  fs.mkdirSync(scratchDir, { recursive: true });
  const realScratch = fs.realpathSync(scratchDir);
  const jsonlPath = path.join(os.homedir(), ".claude", "projects", claudeProjectDirName(realScratch), `${sessionId}.jsonl`);
  const registryPath = path.join(deps.configDir, "session-registry", `${sessionId}.json`);
  const stubPath = path.join(realScratch, "stub.cjs");
  fs.writeFileSync(stubPath, STUB_SOURCE);

  let conversationId: string | undefined;
  const startedAt = Date.now();

  try {
    // Launch the stand-in agent. -x/-y match the daemon's own window sizing so
    // the pane classifier sees a realistic layout.
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const shellCmd = `DOCTOR_BOOT_TOKEN=${q(tokenA)} exec ${q(runtime)} ${q(stubPath)} ${q(sessionId)} ${q(jsonlPath)} ${q(registryPath)}`;
    const launched = tmuxRunQuiet(["new-session", "-d", "-s", tmuxName, "-x", "220", "-y", "50", "-c", realScratch, shellCmd]);
    if (!launched.ok) {
      record({ name: "stub agent", status: "fail", detail: `tmux launch failed: ${(launched.stderr || launched.stdout).trim().slice(0, 120)}` });
      return;
    }

    // Leg 1: watcher picks up the new transcript and creates the conversation.
    let legStart = Date.now();
    while (!conversationId && Date.now() - legStart < MAPPING_TIMEOUT_MS) {
      await sleep(POLL_MS);
      conversationId = readConversationMapping(deps.configDir, sessionId) ?? undefined;
    }
    if (!conversationId) {
      if (!fs.existsSync(jsonlPath)) {
        record({ name: "conversation", status: "fail", detail: `stub never wrote its transcript (${jsonlPath}) — check the pane: tmux attach -t ${tmuxName}` });
      } else {
        record({
          name: "conversation",
          status: "fail",
          detail: `transcript written but no conversation after ${MAPPING_TIMEOUT_MS / 1000}s — JSONL watcher or Convex write path is down (CLI → server sync broken)`,
        });
        printEvidence(deps, sessionId, conversationId, startedAt, say, evidence);
      }
      return;
    }
    record({ name: "conversation", status: "pass", detail: `created ${fmt.id(conversationId.slice(0, 12))}… (watcher → Convex)`, elapsedMs: Date.now() - legStart });

    // Leg 2: bootstrap content is readable back from the server.
    legStart = Date.now();
    let bootstrapSeen = false;
    while (!bootstrapSeen && Date.now() - legStart < BOOTSTRAP_TIMEOUT_MS) {
      try {
        const exported = await fetchExport(deps.siteUrl, deps.apiToken, conversationId);
        bootstrapSeen = exportHasToken(exported.messages, tokenA);
      } catch {
        // conversation may not be queryable for a beat right after creation
      }
      if (!bootstrapSeen) await sleep(POLL_MS);
    }
    if (!bootstrapSeen) {
      record({ name: "bootstrap synced", status: "fail", detail: `conversation exists but bootstrap token never appeared in export (message sync broken)` });
      printEvidence(deps, sessionId, conversationId, startedAt, say, evidence);
      return conversationId;
    }
    record({ name: "bootstrap synced", status: "pass", detail: "transcript content readable from server", elapsedMs: Date.now() - legStart });

    // Leg 3+4: send through the SAME pending-message path the web UI uses,
    // then watch for the stub's echo to come back through the sync loop.
    legStart = Date.now();
    await doctorPost(deps.siteUrl, deps.apiToken, "/cli/messages/send", {
      to: conversationId,
      body: `codecast doctor ${runId}: reply with ${tokenB}`,
    });

    let echoed = false;
    let injected = false;
    while (!echoed && Date.now() - legStart < ROUNDTRIP_TIMEOUT_MS) {
      await sleep(POLL_MS);
      if (!injected && fs.existsSync(jsonlPath)) {
        injected = fs.readFileSync(jsonlPath, "utf-8").includes(tokenB);
        if (injected) {
          record({ name: "message delivered", status: "pass", detail: "server → daemon → tmux inject landed in the pane", elapsedMs: Date.now() - legStart });
        }
      }
      if (injected) {
        try {
          const exported = await fetchExport(deps.siteUrl, deps.apiToken, conversationId);
          echoed = exportHasToken(exported.messages, tokenB, "assistant");
        } catch {}
      }
    }

    if (!injected) {
      record({
        name: "message delivered",
        status: "fail",
        detail: `pending message never reached the stub's pane after ${ROUNDTRIP_TIMEOUT_MS / 1000}s (server → daemon → tmux inject broken)`,
      });
      printEvidence(deps, sessionId, conversationId, startedAt, say, evidence);
      return conversationId;
    }
    if (!echoed) {
      record({ name: "echo round-tripped", status: "fail", detail: "reply reached the transcript but never synced back to the server" });
      printEvidence(deps, sessionId, conversationId, startedAt, say, evidence);
      return conversationId;
    }
    record({ name: "echo round-tripped", status: "pass", detail: "agent reply visible from the server (full loop)", elapsedMs: Date.now() - legStart });
    return conversationId;
  } finally {
    if (opts.keep) {
      cleanup.push(`kept: tmux ${tmuxName}, ${realScratch}, ${jsonlPath}`);
      say(fmt.muted(`  (kept artifacts: tmux ${tmuxName}, ${realScratch})`));
    } else {
      tmuxRunQuiet(["kill-session", "-t", tmuxName]);
      for (const target of [registryPath, jsonlPath, stubPath]) {
        try { fs.rmSync(target, { force: true }); } catch {}
      }
      try { fs.rmSync(realScratch, { recursive: true, force: true }); } catch {}
      try {
        const projDir = path.dirname(jsonlPath);
        if (fs.existsSync(projDir) && fs.readdirSync(projDir).length === 0) fs.rmdirSync(projDir);
      } catch {}
      // The scratch path is unique to this run, so a prefix delete can only hit
      // the self-test conversation. Verify the delete actually matched — a
      // zero-count "success" means the test conversation was left behind, which
      // is exactly the silent-cleanup-failure mode this check exists to catch.
      try {
        const result = await doctorPost(deps.siteUrl, deps.apiToken, "/cli/conversations/delete-by-path", { path_prefix: realScratch });
        if (conversationId && !(result?.conversationsDeleted > 0)) {
          record({ name: "cleanup", status: "warn", detail: `server delete matched nothing — test conversation ${conversationId.slice(0, 12)}… left behind` });
        }
        cleanup.push(`server conversation deleted (${result?.conversationsDeleted ?? 0})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        record({ name: "cleanup", status: "warn", detail: `server delete failed: ${msg.slice(0, 100)}` });
        cleanup.push(`server cleanup failed: ${msg}`);
      }
      cleanup.push("local artifacts removed");
    }
  }
}

function printEvidence(
  deps: DoctorDeps,
  sessionId: string,
  conversationId: string | undefined,
  sinceMs: number,
  say: (line: string) => void,
  sink: string[],
): void {
  const lines = daemonLogEvidence(deps.configDir, sessionId, conversationId, sinceMs);
  sink.push(...lines);
  if (lines.length === 0) {
    say(fmt.muted(`      no matching daemon.log lines — is the daemon logging? (${path.join(deps.configDir, "daemon.log")})`));
    return;
  }
  say(fmt.muted("      daemon.log evidence:"));
  for (const line of lines) {
    say(`      ${c.dim}${line.slice(0, 160)}${c.reset}`);
  }
}

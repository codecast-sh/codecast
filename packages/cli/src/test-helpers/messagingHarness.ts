// Test harness for the message-delivery pipeline.
//
// Spawns a real tmux session running the fake-claude shim, so tests can
// exercise the daemon's `tryStartedTmux` / `injectViaTmux` paths against
// real tmux (paste-buffer semantics, send-keys, capture-pane) and a real
// JSONL file appearing under ~/.claude/projects/<encoded-cwd>/.
//
// What this is NOT: a full daemon-process harness. The daemon also has
// Convex subscriptions, file watchers, and IPC that aren't exercised here.
// Those need a Convex test backend, which is tracked as follow-up work.
// This harness covers the speedup PR's risk surface (the inject pipeline).

// FIRST import, and it must stay first: it moves this process's tmux clients
// onto a private server before daemon.js snapshots the environment. See
// isolatedTmuxServer.ts.
import { assertIsolatedTmux } from "./isolatedTmuxServer.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import type * as net from "node:net";
import { execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { AGENT_CLIENTS, type AgentClientId } from "@codecast/shared/contracts";
import { writeShimScript, cleanupShimScript, type ShimOptions } from "./fakeClaudeShim.js";
import { tmuxRun } from "../tmux.js";
import { injectViaTmux, classifyLivePaneFor, type TmuxLiveState } from "../daemon.js";
import { parseTranscriptFor } from "../parser.js";
import { claudeProjectDirName } from "../projectPathResolver.js";
import { assembleOpencodeSession } from "../opencodeStorage.js";
import { TEST_SCRATCH_DIRNAME } from "../syncScope.js";

export interface HarnessOptions extends ShimOptions {
  /** Working directory the shim runs in. Default: a temp dir. */
  cwd?: string;
  /** Extra PATH entries (beyond the shim dir + system PATH). */
  pathPrefix?: string[];
  /** Tmux session prefix. Default: "cc-claude-test". */
  tmuxPrefix?: string;
  /** A bash -c body to exec instead of the fake claude shim (the bench runs the
   *  doctor's node stub this way, because the daemon only treats agent binaries
   *  and node/bun/deno as live agents). */
  command?: string;
  /** Transcript path override; the default encodes cwd with "/" to "-". */
  jsonlPath?: string;
}

export interface Harness {
  tmuxSession: string;
  /** null when `command` replaced the fake claude shim. */
  shimPath: string | null;
  cwd: string;
  sessionId: string;
  jsonlPath: string;
  capturePane(): string;
  paneHasPrompt(): boolean;
  /** Exit code for a retained dead pane, or null while the pane is alive/gone. */
  paneExitCode(): number | null;
  tearDown(): void;
}

const ACTIVE_SESSIONS = new Set<string>();

/** Wrap a value in single quotes for a `bash -c` body. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * `tmux new-session -d` with the liveness check every pane spawn in this file
 * needs. Up to 3 attempts: under heavy load the inner bash dies before reaching
 * the agent (tmux PTY setup race), so "alive 250ms later" is verified before
 * the spawn is called a success — sleep first, or a session that died right
 * after exec looks healthy.
 */
export function spawnTmuxPane(opts: {
  session: string;
  cwd: string;
  /** bash -c body run inside the pane. */
  body: string;
  env?: NodeJS.ProcessEnv;
}): void {
  assertIsolatedTmux();
  const alive = (): boolean => tmuxRun(["has-session", "-t", opts.session]).status === 0;
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = tmuxRun([
      "new-session", "-d", "-s", opts.session,
      "-x", "200", "-y", "50",
      "-c", opts.cwd,
      "bash", "-c", opts.body,
    ], opts.env ? { env: opts.env } : undefined);
    if (r.status !== 0) {
      lastErr = `tmux new-session failed (status ${r.status}): ${r.stderr ?? ""} ${r.stdout ?? ""}`;
      tmuxRun(["kill-session", "-t", opts.session]);
      continue;
    }
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (alive()) return;
      execSync("sleep 0.05");
    }
    lastErr = "tmux session died within 1s of spawn";
    tmuxRun(["kill-session", "-t", opts.session]);
  }
  throw new Error(`tmux pane spawn failed after 3 attempts: ${lastErr}`);
}

export function spawnHarness(opts: HarnessOptions = {}): Harness {
  const tmuxPrefix = opts.tmuxPrefix ?? "cc-claude-test";
  const tmuxSession = `${tmuxPrefix}-${randomUUID().slice(0, 8)}`;
  const cwd = opts.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "codecast-test-cwd-"));
  recordPaneCwd(cwd);
  const sessionId = opts.sessionId ?? randomUUID();
  const shimPath = opts.command ? null : writeShimScript({ ...opts, sessionId });
  const exitStatusPath = opts.fatal && shimPath ? `${shimPath}.exit` : null;

  // The shim writes its transcript under $HOME/.claude/projects, exactly where
  // real claude would. Give it a HOME of its own so a test run never creates or
  // deletes a directory inside the human's ~/.claude.
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-test-home-"));

  // The shim must be discoverable as `claude` on PATH so an invocation of
  // `claude` lands on it. We do this by symlinking (or copying) it to a
  // dedicated dir whose name is `claude`-friendly and prepending to PATH.
  const env: Record<string, string> = {
    ...process.env,
    HOME: homeDir,
    PATH: [...(shimPath ? [path.dirname(shimPath)] : []), ...(opts.pathPrefix ?? []), process.env.PATH ?? ""].join(":"),
    FAKE_CLAUDE_SESSION_ID: sessionId,
  };

  // Spawn tmux session in the target cwd, executing the shim.
  // Use bash -c (NOT -lc) to skip login-shell init files — saves 1–3s startup.
  // Pass the shim path explicitly so a missing PATH hop (sometimes seen under
  // bun:test's spawnSync env handling) doesn't silently produce an empty pane.
  // Fatal-mode intentionally exits before the normal liveness probe. Retain
  // that pane so the test can prove the shim ran and inspect its real status;
  // unrelated bash/tmux startup failures still make the session disappear.
  let shimCommand: string;
  if (opts.command) shimCommand = opts.command;
  else if (exitStatusPath) shimCommand = `tmux set-option -p remain-on-exit on && { ${shellQuote(shimPath!)}; status=$?; printf '%s' "$status" > ${shellQuote(exitStatusPath)}; exit "$status"; }`;
  else shimCommand = `exec ${shellQuote(shimPath!)}`;
  // HOME goes in the BODY, not in the tmux client's environment: a pane
  // inherits the tmux SERVER's environment, and the server outlives any one
  // client, so `env` here reaches tmux and stops there. Set in the body it
  // reaches the shim, which is what decides where the transcript is written.
  spawnTmuxPane({
    session: tmuxSession,
    cwd,
    body: `export HOME=${shellQuote(homeDir)}; FAKE_CLAUDE_SESSION_ID=${shellQuote(sessionId)} ${shimCommand}`,
    env,
  });
  ACTIVE_SESSIONS.add(tmuxSession);

  const projectDirName = cwd.replace(/\//g, "-");
  const jsonlPath = opts.jsonlPath ?? path.join(homeDir, ".claude", "projects", projectDirName, `${sessionId}.jsonl`);

  return {
    tmuxSession,
    shimPath,
    cwd,
    sessionId,
    jsonlPath,
    capturePane(): string {
      return tmuxRun(["capture-pane", "-p", "-J", "-t", tmuxSession, "-S", "-50"]).stdout;
    },
    paneHasPrompt(): boolean {
      const content = this.capturePane();
      return /❯|⏵/.test(content);
    },
    paneExitCode(): number | null {
      const state = tmuxRun([
        "display-message", "-p", "-t", tmuxSession,
        "#{pane_dead}:#{pane_dead_status}",
      ]);
      if (state.status !== 0) return null;
      const [dead, rawCode] = state.stdout.trim().split(":");
      const recordedCode = exitStatusPath && fs.existsSync(exitStatusPath)
        ? fs.readFileSync(exitStatusPath, "utf-8")
        : rawCode;
      const code = Number.parseInt(recordedCode ?? "", 10);
      return dead === "1" && Number.isInteger(code) ? code : null;
    },
    tearDown(): void {
      tmuxRun(["kill-session", "-t", tmuxSession]);
      ACTIVE_SESSIONS.delete(tmuxSession);
      if (exitStatusPath) fs.rmSync(exitStatusPath, { force: true });
      if (shimPath) cleanupShimScript(shimPath);
      // The transcript lives inside the temp home, so this takes it too.
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
      // Only remove cwd if we created it (matches /tmp prefix).
      if (cwd.startsWith(os.tmpdir())) {
        try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
      }
    },
  };
}

/**
 * Polls until `predicate()` returns true, or `timeoutMs` elapses.
 * Returns the elapsed milliseconds for latency assertions.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const intervalMs = opts.intervalMs ?? 100;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return Date.now() - start;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms${opts.label ? `: ${opts.label}` : ""}`);
}

/**
 * Sweeps any tmux sessions left over by previous test runs (matching the
 * `cc-claude-test-*` pattern). Safe to call from beforeAll.
 */
export function sweepStaleSessions(prefix = "cc-claude-test"): void {
  // tmuxRun is wedge-proofed (timeout + SIGKILL): a tmux client that busy-loops
  // after its server dies ignores SIGTERM and spins at 100% CPU forever, so a
  // single bad tmux interaction during `bun test` would orphan a process that
  // outlives the run.
  const out = tmuxRun(["list-sessions", "-F", "#{session_name}"]).stdout;
  for (const name of out.split("\n").map((s: string) => s.trim()).filter(Boolean)) {
    if (name.startsWith(prefix)) {
      tmuxRun(["kill-session", "-t", name]);
    }
  }
}

/**
 * Reads JSONL messages from disk, filtering to user/assistant rows.
 * Returns parsed objects in file order.
 */
export function readJsonlMessages(jsonlPath: string): Array<{ type: string; text?: string; raw: any }> {
  if (!fs.existsSync(jsonlPath)) return [];
  const lines = fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
  const out: Array<{ type: string; text?: string; raw: any }> = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "user") {
        const content = obj.message?.content;
        const text = typeof content === "string" ? content :
          Array.isArray(content) ? content.map((c: any) => c.text ?? "").join("") : "";
        out.push({ type: "user", text, raw: obj });
      } else if (obj.type === "assistant") {
        const content = obj.message?.content;
        const text = Array.isArray(content) ? content.map((c: any) => c.text ?? "").join("") : "";
        out.push({ type: "assistant", text, raw: obj });
      }
    } catch {}
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cold-boot injection matrix (ct-49536)
//
// The shim above proves the inject state machine against a pane we wrote. The
// matrix below proves it against the REAL TUIs: each supported client spawned
// cold in a real tmux pane, driven by the same `injectViaTmux` the daemon
// calls, asserted on the client's own transcript. Every per-client fact the
// matrix needs — binary, resume command, bracketed-paste capability, pane
// classification — is read from AGENT_CLIENTS or the daemon, so a registry
// change moves the matrix with it.
//
// Two things make it hermetic and free:
//  - Every client's model endpoint points at `startFakeModelEndpoint()`, a
//    local server that ACCEPTS the request and never answers. The turn starts
//    and hangs, which is a deterministic busy pane (the type-ahead window) at
//    zero API cost; `reject()` then answers 400 so the turn ends fast and any
//    queued message submits. Never close the socket instead: a refused
//    connection sends the client into minutes of retry backoff.
//  - Every pane runs in a cwd under the shared scratch marker, so the daemon's
//    isProjectAllowedToSync refuses to sync these transcripts into the inbox,
//    and each client keeps its state under a temp home (CODEX_HOME, GROK_HOME,
//    XDG_* for opencode) that tearDown removes. Claude is the exception: a
//    fresh HOME re-runs its onboarding wizard, so it uses the real one and the
//    scratch cwd keeps its transcript out of sync.
// ---------------------------------------------------------------------------

export type MatrixClientId = "claude" | "codex" | "grok" | "opencode";
export const MATRIX_CLIENTS: readonly MatrixClientId[] = ["claude", "codex", "grok", "opencode"];

/** Is this binary on PATH? The matrix self-skips per client so a runner with no
 *  agent installed (every CI runner today) stays green. */
export function hasBinary(name: string): boolean {
  const r = spawnSync("which", [name], { encoding: "utf8" });
  return r.status === 0 && !!r.stdout.trim();
}

export function matrixClientAvailable(id: MatrixClientId): boolean {
  return hasBinary("tmux") && hasBinary(AGENT_CLIENTS[id].binary);
}

export interface FakeModelEndpoint {
  /** Base URL every matrix client's model calls are pointed at. */
  url: string;
  /** How many model requests the clients have made. */
  requests(): number;
  /** Requests still held open — the client-agnostic "a turn is running right
   *  now" signal. An interrupted turn aborts its request, so this drops to 0
   *  the moment something cancels the turn. */
  inFlight(): number;
  /** Answer every held and future request with a non-retryable 400, ending the
   *  hanging turn within a second. */
  reject(): void;
  close(): void;
}

/** A model endpoint that holds every request open until `reject()`. See the
 *  matrix header for why holding beats closing. */
export async function startFakeModelEndpoint(): Promise<FakeModelEndpoint> {
  const held = new Set<http.ServerResponse>();
  const sockets = new Set<net.Socket>();
  let mode: "stall" | "reject" = "stall";
  let seen = 0;
  const answer = (res: http.ServerResponse): void => {
    if (res.writableEnded) return;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "codecast injection matrix: endpoint closed" },
    }));
  };
  const server = http.createServer((req, res) => {
    seen++;
    req.resume(); // drain the body; some clients wait for the write to complete
    if (mode === "reject") { answer(res); return; }
    held.add(res);
    res.on("close", () => held.delete(res));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => seen,
    inFlight: () => held.size,
    reject: () => {
      mode = "reject";
      for (const res of [...held]) answer(res);
      held.clear();
    },
    close: () => {
      mode = "reject";
      for (const res of [...held]) answer(res);
      held.clear();
      for (const socket of [...sockets]) socket.destroy();
      server.close();
    },
  };
}

interface PaneContext {
  cwd: string;
  /** Per-pane state root (CODEX_HOME / GROK_HOME / XDG_*). Unused by claude. */
  homeDir: string;
  endpointUrl: string;
  /** The session id we asked for, for clients that accept one at launch. */
  launchSessionId: string;
}

interface ClientRecipe {
  /** Writes the client's config under `homeDir` and returns how to launch it. */
  launch(ctx: PaneContext): { env: Record<string, string>; command: string };
  /** How to bring the same session back up, or null while no id is known yet. */
  resume(ctx: PaneContext, sessionId: string | null): string | null;
  /** The client's own id for this pane, once its transcript exists. */
  sessionId(ctx: PaneContext): string | null;
  /** Raw transcripts this pane produced, oldest first. Resuming can start a new
   *  file (codex writes one rollout per resume), so this is a list. */
  transcripts(ctx: PaneContext): string[];
}

// Every cwd a pane in this process has run in, real client or shim, in both
// spellings: a client's `pwd` reports the path tmux was given, while realpath
// resolves macOS's /var -> /private/var symlink, and the two produce different
// transcript directory names. Checking only one lets a leak pass unseen.
const PANE_CWDS: string[] = [];

function recordPaneCwd(cwd: string): void {
  PANE_CWDS.push(cwd);
  const real = fs.realpathSync(cwd);
  if (real !== cwd) PANE_CWDS.push(real);
}

/**
 * Assert that nothing this process ran wrote a transcript into the human's
 * ~/.claude/projects. Checked per cwd rather than by diffing the directory,
 * because a diff cannot tell this run's writes from those of another test run
 * sharing the machine.
 */
export function assertRealClaudeHomeUntouched(): void {
  const projects = path.join(os.homedir(), ".claude", "projects");
  const leaked = PANE_CWDS
    .map((cwd) => path.join(projects, claudeProjectDirName(cwd)))
    .filter((dir) => fs.existsSync(dir));
  if (leaked.length > 0) {
    throw new Error(`test panes wrote into the real ~/.claude/projects:\n${leaked.join("\n")}`);
  }
  console.log(`[matrix] real ~/.claude/projects untouched: ${PANE_CWDS.length} pane cwds checked, none present`);
}

/** Files under `dir` matching `match`, oldest first by mtime. */
function filesByMtime(dir: string, match: (p: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (match(p)) out.push(p);
    }
  };
  walk(dir);
  return out.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

function readIfExists(p: string): string | null {
  try { return fs.readFileSync(p, "utf-8"); } catch { return null; }
}

/**
 * Make `homeDir` a HOME claude will boot in without asking anything, so a test
 * never has to run it against the human's real ~/.claude.
 *
 * A blank home asks three questions before it will show a composer — the
 * onboarding wizard, the workspace-trust dialog for `projectCwd`, and the
 * bypass-permissions warning — and the injection pre-flight answers the last
 * two with Escape, which is "No, exit" on both: claude quits, the pane dies,
 * and the failure looks like a delivery bug. So all three answers are seeded
 * here, under the keys the real home records them in. No credential is written:
 * a test points claude at its own endpoint with ANTHROPIC_AUTH_TOKEN.
 */
export function seedClaudeHome(homeDir: string, projectCwd: string): void {
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true,
    theme: "dark",
    autoUpdates: false,
    installMethod: "native",
    numStartups: 5,
    firstStartTime: "2026-01-01T00:00:00.000Z",
    projects: { [fs.realpathSync(projectCwd)]: { hasTrustDialogAccepted: true, allowedTools: [] } },
  }, null, 2));
  fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({
    skipDangerousModePermissionPrompt: true,
    skipAutoPermissionPrompt: true,
    env: { DISABLE_AUTOUPDATER: "1" },
  }, null, 2));
}

const CLIENT_RECIPES: Record<MatrixClientId, ClientRecipe> = {
  // claude runs under a HOME of its own, so its transcripts land in the temp
  // home this pane owns and the real ~/.claude/projects is never written to or
  // deleted from. A blank home asks three questions before it will show a
  // composer — the onboarding wizard, the workspace-trust dialog, and the
  // bypass-permissions warning — and the injection pre-flight answers the last
  // two with Escape, which is "No, exit" on both. So all three answers are
  // seeded, under the same keys the real home records them in. No credential is
  // copied in: the pane talks to the fake endpoint, and ANTHROPIC_AUTH_TOKEN is
  // what points it there. (ANTHROPIC_API_KEY would instead park it on a "Do you
  // want to use this API key?" dialog before the composer ever appears.)
  claude: {
    launch: (ctx) => {
      seedClaudeHome(ctx.homeDir, ctx.cwd);
      return {
        env: {
          HOME: ctx.homeDir,
          ANTHROPIC_BASE_URL: ctx.endpointUrl,
          ANTHROPIC_AUTH_TOKEN: "codecast-injection-matrix",
        },
        // --bare skips hooks/plugins/auto-memory so the pane is this test's alone.
        command: `${AGENT_CLIENTS.claude.binary} --bare --permission-mode=bypassPermissions --dangerously-skip-permissions --session-id=${ctx.launchSessionId}`,
      };
    },
    resume: (ctx) =>
      `${AGENT_CLIENTS.claude.resumeCmd(ctx.launchSessionId)} --bare --permission-mode=bypassPermissions --dangerously-skip-permissions`,
    sessionId: (ctx) => ctx.launchSessionId,
    transcripts: (ctx) =>
      filesByMtime(claudeProjectDir(ctx), (p) => p.endsWith(".jsonl"))
        .map(readIfExists)
        .filter((c): c is string => c !== null),
  },

  // CODEX_HOME carries auth, config AND sessions, so a temp one is fully
  // hermetic. The [projects] trust entry matters: an untrusted directory parks
  // codex on a numbered "Do you trust the contents of this directory?" menu.
  codex: {
    launch: (ctx) => {
      const real = fs.realpathSync(ctx.cwd);
      fs.mkdirSync(ctx.homeDir, { recursive: true });
      fs.writeFileSync(path.join(ctx.homeDir, "config.toml"), [
        `model = "matrix"`,
        `model_provider = "matrix"`,
        `approval_policy = "never"`,
        `sandbox_mode = "danger-full-access"`,
        ``,
        `[model_providers.matrix]`,
        `name = "matrix"`,
        `base_url = "${ctx.endpointUrl}/v1"`,
        `env_key = "CODECAST_MATRIX_KEY"`,
        `wire_api = "responses"`,
        `request_max_retries = 0`,
        `stream_max_retries = 0`,
        ``,
        `[projects."${ctx.cwd}"]`,
        `trust_level = "trusted"`,
        ``,
        `[projects."${real}"]`,
        `trust_level = "trusted"`,
        ``,
      ].join("\n"));
      return {
        env: { CODEX_HOME: ctx.homeDir, CODECAST_MATRIX_KEY: "codecast-injection-matrix" },
        command: AGENT_CLIENTS.codex.binary,
      };
    },
    resume: (_ctx, sessionId) => (sessionId ? AGENT_CLIENTS.codex.resumeCmd(sessionId) : null),
    sessionId: (ctx) => {
      for (const file of filesByMtime(path.join(ctx.homeDir, "sessions"), (p) => p.endsWith(".jsonl"))) {
        const first = readIfExists(file)?.split("\n", 1)[0];
        if (!first) continue;
        try {
          const meta = JSON.parse(first);
          const id = meta?.payload?.session_id;
          if (typeof id === "string") return id;
        } catch {}
      }
      return null;
    },
    transcripts: (ctx) =>
      filesByMtime(path.join(ctx.homeDir, "sessions"), (p) => p.endsWith(".jsonl"))
        .map(readIfExists)
        .filter((c): c is string => c !== null),
  },

  // GROK_HOME isolates config, auth and sessions. The custom [model.matrix]
  // entry carries its own api_key, so the pane never touches the real login.
  // The clipboard env vars are load-bearing: grok reads the host clipboard on
  // paste, and a machine holding an image attaches it to the injected message.
  grok: {
    launch: (ctx) => {
      fs.mkdirSync(ctx.homeDir, { recursive: true });
      fs.writeFileSync(path.join(ctx.homeDir, "config.toml"), [
        `[cli]`,
        `show_tips = false`,
        `auto_update = false`,
        ``,
        `[privacy]`,
        `privacy_banner_acked = "2026-01-01T00:00:00Z"`,
        ``,
        // GROK_HOME does not cover grok's compatibility scan: it reads the real
        // ~/.claude and ~/.cursor for MCP servers, hooks, rules and skills. One
        // slow MCP server there keeps the pane spinning for the whole test, so
        // the message rides the type-ahead queue and never submits.
        `[compat.claude]`,
        `agents = false`,
        `hooks = false`,
        `mcps = false`,
        `rules = false`,
        `skills = false`,
        ``,
        `[compat.cursor]`,
        `agents = false`,
        `hooks = false`,
        `mcps = false`,
        `rules = false`,
        `skills = false`,
        ``,
        `[ui]`,
        `permission_mode = "always-approve"`,
        `screen_mode = "fullscreen"`,
        ``,
        `[models]`,
        `default = "matrix"`,
        ``,
        `[model.matrix]`,
        `model = "matrix"`,
        `base_url = "${ctx.endpointUrl}/v1"`,
        `api_key = "codecast-injection-matrix"`,
        `api_backend = "chat_completions"`,
        `max_retries = 0`,
        ``,
      ].join("\n"));
      return {
        env: {
          GROK_HOME: ctx.homeDir,
          GROK_CLIPBOARD_NO_OSC: "1",
          GROK_CLIPBOARD_NO_DATA_CONTROL: "1",
        },
        command: `${AGENT_CLIENTS.grok.binary} --always-approve --session-id ${ctx.launchSessionId}`,
      };
    },
    resume: (ctx) => `${AGENT_CLIENTS.grok.resumeCmd(ctx.launchSessionId)} --always-approve`,
    sessionId: (ctx) => ctx.launchSessionId,
    // ~/.grok/sessions/<url-encoded cwd>/<uuid>/updates.jsonl — matched by the
    // session id rather than by re-deriving grok's encoding of the cwd.
    transcripts: (ctx) =>
      filesByMtime(
        path.join(ctx.homeDir, "sessions"),
        (p) => p.endsWith(`${path.sep}${ctx.launchSessionId}${path.sep}updates.jsonl`),
      ).map(readIfExists).filter((c): c is string => c !== null),
  },

  // opencode keeps every session in one SQLite store under XDG_DATA_HOME, so a
  // temp XDG root gives this pane its own database. The provider block points
  // an openai-compatible model at the fake endpoint with an inline key, so no
  // real credential is read.
  opencode: {
    launch: (ctx) => {
      const configDir = path.join(ctx.homeDir, "config", "opencode");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        provider: {
          matrix: {
            npm: "@ai-sdk/openai-compatible",
            name: "matrix",
            options: { baseURL: `${ctx.endpointUrl}/v1`, apiKey: "codecast-injection-matrix" },
            models: { "matrix-model": { name: "matrix-model" } },
          },
        },
        model: "matrix/matrix-model",
        autoupdate: false,
        permission: { edit: "allow", bash: "allow", webfetch: "allow" },
      }, null, 2));
      return {
        env: {
          XDG_DATA_HOME: path.join(ctx.homeDir, "data"),
          XDG_CONFIG_HOME: path.join(ctx.homeDir, "config"),
          XDG_CACHE_HOME: path.join(ctx.homeDir, "cache"),
          XDG_STATE_HOME: path.join(ctx.homeDir, "state"),
        },
        command: AGENT_CLIENTS.opencode.binary,
      };
    },
    resume: (_ctx, sessionId) => (sessionId ? AGENT_CLIENTS.opencode.resumeCmd(sessionId) : null),
    sessionId: (ctx) => opencodeSessionIds(ctx).at(-1) ?? null,
    // One assembled export per session in this pane's cwd — the same read
    // boundary the daemon's opencode watcher uses, so the parser below sees
    // exactly what sync would see.
    transcripts: (ctx) =>
      opencodeSessionIds(ctx)
        .map((id) => assembleOpencodeSession(id, opencodeMatrixDbPath(ctx)))
        .filter((c): c is string => c !== null),
  },
};

/** Inside the pane's own HOME, never the real one. */
function claudeProjectDir(ctx: PaneContext): string {
  return path.join(ctx.homeDir, ".claude", "projects", claudeProjectDirName(fs.realpathSync(ctx.cwd)));
}

function opencodeMatrixDbPath(ctx: PaneContext): string {
  return path.join(ctx.homeDir, "data", "opencode", "opencode.db");
}

/** opencode mints its own `ses_*` ids, so the pane is identified by its cwd. */
function opencodeSessionIds(ctx: PaneContext): string[] {
  const dbPath = opencodeMatrixDbPath(ctx);
  if (!fs.existsSync(dbPath)) return [];
  let db: Database;
  try { db = new Database(dbPath, { readonly: true }); } catch { return []; }
  try {
    const real = fs.realpathSync(ctx.cwd);
    return db.query<{ id: string }, [string, string]>(
      "SELECT id FROM session WHERE directory IN (?, ?) ORDER BY time_created",
    ).all(ctx.cwd, real).map((r) => r.id);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export interface ClientPane {
  client: MatrixClientId;
  tmuxSession: string;
  target: string;
  cwd: string;
  /** ms from `tmux new-session` returning to now — the cold-boot clock. */
  ageMs(): number;
  capture(): string;
  /** The daemon's own pane classification for this client. */
  liveState(): TmuxLiveState;
  /** Every user message this pane's client recorded, oldest first. */
  userMessages(): string[];
  /** The client's session id, once it has minted one. */
  sessionId(): string | null;
  /** Kill the pane and bring the same session back through the registry's
   *  resume command. */
  resume(): void;
  tearDown(): void;
}

export const MATRIX_TMUX_PREFIX = "cc-matrix-test";

export function spawnClientPane(client: MatrixClientId, opts: { endpointUrl: string }): ClientPane {
  const recipe = CLIENT_RECIPES[client];
  const scratchRoot = path.join(os.tmpdir(), TEST_SCRATCH_DIRNAME);
  fs.mkdirSync(scratchRoot, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(scratchRoot, `matrix-${client}-`));
  recordPaneCwd(cwd);
  const homeDir = fs.mkdtempSync(path.join(scratchRoot, `matrixhome-${client}-`));
  const ctx: PaneContext = {
    cwd,
    homeDir,
    endpointUrl: opts.endpointUrl,
    launchSessionId: randomUUID().toLowerCase(),
  };
  const tmuxSession = `${MATRIX_TMUX_PREFIX}-${client}-${randomUUID().slice(0, 8)}`;
  const target = `${tmuxSession}:0.0`;

  // Reset on every (re)launch, so a resumed pane reports its own boot clock.
  let spawnedAt = Date.now();
  const start = (command: string): void => {
    const { env } = recipe.launch(ctx);
    const exports = Object.entries(env)
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join(" ");
    spawnedAt = Date.now();
    spawnTmuxPane({ session: tmuxSession, cwd, body: `cd ${shellQuote(cwd)} && exec env ${exports} ${command}` });
  };

  start(recipe.launch(ctx).command);
  ACTIVE_SESSIONS.add(tmuxSession);

  const pane: ClientPane = {
    client,
    tmuxSession,
    target,
    cwd,
    ageMs: () => Date.now() - spawnedAt,
    capture: () => tmuxRun(["capture-pane", "-p", "-J", "-t", target, "-S", "-50"]).stdout,
    liveState: () => classifyLivePaneFor(client as AgentClientId, pane.capture()),
    sessionId: () => recipe.sessionId(ctx),
    userMessages: () =>
      recipe.transcripts(ctx)
        .flatMap((content) => parseTranscriptFor(client as AgentClientId, content))
        .filter((m) => m.role === "user")
        .map((m) => m.content),
    resume: () => {
      const command = recipe.resume(ctx, recipe.sessionId(ctx));
      if (!command) throw new Error(`${client}: no session id to resume yet`);
      tmuxRun(["kill-session", "-t", tmuxSession]);
      start(command);
    },
    tearDown: () => {
      tmuxRun(["kill-session", "-t", tmuxSession]);
      ACTIVE_SESSIONS.delete(tmuxSession);
      // Every client keeps its state under one of these two: the pane's cwd and
      // the temp home its recipe configured. Nothing to clean anywhere else.
      for (const dir of [cwd, homeDir]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    },
  };
  return pane;
}

/**
 * Inject the way the daemon delivers: retry the transient pre-flight failures
 * (`AGENT_UNKNOWN_STATE`, `AGENT_NOT_READY`) until the pane classifies, the
 * way deliverMessage's backoff does. A cold TUI can take 15s+ to render, well
 * past ensureTmuxReady's own 8s stuck budget, so a single call would fail on
 * boot latency rather than on anything about injection.
 *
 * Returns the cold-boot delivery clock: how long the message took from the
 * first attempt, and how many attempts it cost.
 */
export async function deliverToPane(
  pane: ClientPane,
  content: string,
  opts: { budgetMs?: number } = {},
): Promise<{ elapsedMs: number; attempts: number }> {
  const budgetMs = opts.budgetMs ?? 60_000;
  const started = Date.now();
  let attempts = 0;
  let lastErr: unknown = null;
  while (Date.now() - started < budgetMs) {
    attempts++;
    try {
      await injectViaTmux(pane.target, content, pane.client as AgentClientId);
      return { elapsedMs: Date.now() - started, attempts };
    } catch (err) {
      lastErr = err;
      // "No agent process in the pane" is a normal reading of a pane whose
      // client has not finished exec'ing yet — the daemon sees it during a
      // cold boot too. Only a tmux session that has actually gone away is
      // terminal here; everything else gets the next attempt.
      if (tmuxRun(["has-session", "-t", pane.tmuxSession]).status !== 0) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  throw new Error(
    `deliver to ${pane.client} failed after ${attempts} attempts in ${Date.now() - started}ms: ` +
    `${lastErr instanceof Error ? lastErr.message : String(lastErr)}\npane: ${pane.capture()}`,
  );
}

/**
 * Wait for the client to record `payload` as a user message. A guardrail suite
 * is only useful if its failures are diagnosable, so the timeout carries the
 * pane and everything the client did record — "waitFor timeout" alone cannot
 * tell a lost paste from an unsubmitted composer.
 */
export async function waitForRecorded(
  pane: ClientPane,
  payload: string,
  opts: { timeoutMs?: number } = {},
): Promise<number> {
  try {
    return await waitFor(() => pane.userMessages().some((m) => m.trimEnd() === payload), {
      timeoutMs: opts.timeoutMs ?? 45_000,
    });
  } catch {
    throw new Error(
      `${pane.client} never recorded the payload ${JSON.stringify(payload)}\n` +
      `recorded: ${JSON.stringify(pane.userMessages())}\n` +
      `session id: ${pane.sessionId()}\npane state: ${pane.liveState()}\npane:\n${pane.capture()}`,
    );
  }
}

/** Single greppable line per matrix measurement, so a run's numbers can be
 *  collected with `bun test … | grep '\[matrix\]'`. */
export function logMatrix(client: string, scenario: string, fields: Record<string, string | number>): void {
  const rendered = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`[matrix] client=${client} case=${scenario} ${rendered}`);
}

#!/usr/bin/env bun
/**
 * An isolated end-to-end rig for `cast browser` against the real, unpacked
 * extension. It never touches the human's Chrome or the live bridge host
 * (127.0.0.1:41729, ~/.codecast/browser/bridge.json).
 *
 * What `up` builds, all under /tmp/cast-browser-rig/<name>/ (name "default"
 * unless --name is given, so several workers can run rigs side by side):
 *
 *   home/            a throwaway HOME; CODECAST_DIR=home/.codecast holds the
 *                    rig's bridge.json, token, tab state and host log
 *   profile/         Chrome for Testing's --user-data-dir
 *   ab/              AGENT_BROWSER_SOCKET_DIR, the engine daemons' sockets
 *   chrome-forward   CODECAST_CHROMIUM points here: any Chrome launch or
 *                    extension wake the CLI attempts opens its URL in the rig
 *                    Chrome (over the rig Chrome's CDP port) instead of the
 *                    human's Chrome
 *   env              the variables below, as `export` lines for `source`
 *   state.json       ports and pids, read by every other subcommand
 *
 * The bridge host runs from checkout source on a free port, Chrome for
 * Testing loads packages/browser-extension unpacked, and the extension is
 * paired the product way (the options page opened with a one-time code in its
 * fragment, then the Pair click; `--legacy-pair` hands it the shared token
 * the way cast did before per-profile keys), and `up` returns once the host reports the
 * extension connected. Developer mode is turned on in the rig profile, since
 * Chrome disables an unpacked extension that reloads without it.
 *
 * Refuses to run when the rig directory overlaps the real home, so no rig
 * process can reach the human's ~/.codecast and `down` deletes only /tmp.
 *
 * Usage (from the repo root):
 *
 *   bun packages/cli/scripts/browser-rig.ts up [--fixtures] [--headed] [--name <n>]
 *   bun packages/cli/scripts/browser-rig.ts up --extension git:HEAD --legacy-pair   # the last released extension, paired the old way
 *   bun packages/cli/scripts/browser-rig.ts exec [--name <n>] [--session <id>] -- open http://...
 *   bun packages/cli/scripts/browser-rig.ts exec -- snapshot -i
 *   bun packages/cli/scripts/browser-rig.ts reload-ext      # pick up edits to packages/browser-extension
 *   bun packages/cli/scripts/browser-rig.ts restart-host    # pick up edits to the bridge host source
 *   bun packages/cli/scripts/browser-rig.ts restart-chrome  # quit and relaunch the rig Chrome (same profile)
 *   bun packages/cli/scripts/browser-rig.ts add-profile     # a second Chrome profile on the same bridge (own user-data-dir), paired with its own code
 *   bun packages/cli/scripts/browser-rig.ts restart-host --build 1.0.0   # a host stamped as an old build, for the upgrade swap
 *   bun packages/cli/scripts/browser-rig.ts status
 *   bun packages/cli/scripts/browser-rig.ts down
 *
 * `exec` runs `bun packages/cli/src/main.ts browser <args>` with the rig env
 * (a leading "browser" is optional). Its session is rig-<name>, exported as
 * both CAST_SESSION_ID (the browser owner key) and CODECAST_SESSION_ID (the
 * CLI's session id), with the calling agent's own ids cleared; --session
 * picks another, to act as a second agent.
 * Instead of exec you can `source /tmp/cast-browser-rig/<name>/env` in a
 * subshell and call the CLI yourself; never source it in a shell you use for
 * other cast commands, since it swaps HOME.
 *
 * --fixtures serves packages/cli/scripts/browser-rig-fixtures/ on two
 * loopback ports, two origins ($CAST_RIG_FIXTURES and $CAST_RIG_FIXTURES_B):
 * index.html, login.html (POST /login sets a session cookie and redirects to
 * the welcome page), popup.html (window.open, same and cross origin),
 * delete-list.html (identical "Delete" buttons), challenge.html (a fake
 * Cloudflare "Just a moment..." page, served 403 with cf-mitigated:
 * challenge), cookies.html (Set-Cookie HttpOnly/Lax/Strict plus a script
 * cookie), iframe.html (the other origin's login in an iframe), churn.html
 * (window.churn(ms) and window.cycle(on, off): heavy DOM mutation, for
 * snapshot settling) and mouse.html (records every mousemove in
 * window.__moves, for human-like input). In the pages, {{ORIGIN}} and {{OTHER_ORIGIN}} are replaced per request.
 *
 * --headed shows the rig Chrome's window; the default is headless, so nothing
 * appears on the human's screen.
 *
 * Refused by exec because they act on the human's Chrome by process or app
 * name, whatever the env: `show`, `login`, `chrome restart`.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BRIDGE_DEFAULT_PORT, BRIDGE_EXTENSION_ID } from "../src/browser/bridge/protocol.ts";
import { enableDeveloperMode, extensionContext, extensionInfo, findTestChrome, freePort, pairExtension, reloadUnpacked, seedExtensionToken, sleep, waitForCdp } from "./lib/chromeRig.ts";

const REPO = path.resolve(import.meta.dir, "../../..");
const CLI_ENTRY = path.join(REPO, "packages/cli/src/main.ts");
const DEFAULT_EXT_DIR = path.join(REPO, "packages/browser-extension");
const FIXTURES_DIR = path.join(import.meta.dir, "browser-rig-fixtures");
const RIG_ROOT = process.env.CAST_RIG_ROOT || "/tmp/cast-browser-rig";
// Generous: a bun parsing the whole CLI from source took over two minutes to
// bind at load 700. CAST_RIG_WAIT_S overrides both budgets.
const WAIT_S = Number(process.env.CAST_RIG_WAIT_S) || 0;
const HOST_START_MS = (WAIT_S || 300) * 1000;
const CONNECT_MS = (WAIT_S || 120) * 1000;

/**
 * Harness variables that would name the calling agent instead of the rig's
 * session: the browser owner key (owner.ts OWNER_HARNESS_ENV) and the CLI's
 * session id (sessionIdentity.ts sessionIdFromEnv). Cleared first; the rig's
 * own CAST_SESSION_ID and CODECAST_SESSION_ID are set after.
 */
const SESSION_ENV_TO_CLEAR = [
  "CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID", "CLAUDE_CODE_BRIDGE_SESSION_ID", "CODECAST_SESSION_ID",
  "GROK_SESSION_ID", "CODECAST_CONVERSATION_ID", "CODECAST_MANAGED_SESSION", "TMUX_PANE", "CAST_BROWSER_LEGACY", "XDG_RUNTIME_DIR", "CODEX_THREAD_ID",
];

interface RigState {
  name: string;
  dir: string;
  bridgePort: number;
  cdpPort: number;
  chromePid: number;
  hostPid: number;
  fixturesPid?: number;
  fixtures?: [string, string];
  headed: boolean;
  chrome: string;
  /** A second Chrome profile (`add-profile`): its own user-data-dir and CDP port, the same extension and bridge. */
  chrome2Pid?: number;
  cdpPort2?: number;
  /** The unpacked extension the rig Chromes load (`up --extension`); this worktree's packages/browser-extension when unset. */
  extDir?: string;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const dashdash = argv.indexOf("--");
const own = dashdash >= 0 ? argv.slice(0, dashdash) : argv;
const rest = dashdash >= 0 ? argv.slice(dashdash + 1) : [];
const sub = own[0];
const flag = (name: string) => own.includes(`--${name}`);
const option = (name: string) => {
  const i = own.indexOf(`--${name}`);
  return i >= 0 ? own[i + 1] : undefined;
};
const rigName = option("name") ?? "default";
if (!/^[A-Za-z0-9_-]{1,24}$/.test(rigName)) die(`rig name must be 1-24 letters, digits, - or _ (got "${rigName}")`);
const rigDir = path.join(RIG_ROOT, rigName);
const paths = {
  home: path.join(rigDir, "home"),
  castDir: path.join(rigDir, "home", ".codecast"),
  profile: path.join(rigDir, "profile"),
  profile2: path.join(rigDir, "profile2"),
  sockets: path.join(rigDir, "ab"),
  forward: path.join(rigDir, "chrome-forward"),
  env: path.join(rigDir, "env"),
  state: path.join(rigDir, "state.json"),
  logs: path.join(rigDir, "logs"),
  bridgeJson: path.join(rigDir, "home", ".codecast", "browser", "bridge.json"),
};

class RigError extends Error {}

// Every process the rig starts runs under paths.home, and `down` deletes
// rigDir. A rig dir that is, holds or sits inside the real home would point
// the rig's host, token and Chrome at the human's own ~/.codecast, or delete
// their files on `down`, so it is refused before anything starts.
{
  const realHome = path.resolve(os.userInfo().homedir);
  const dir = path.resolve(rigDir);
  const within = (a: string, b: string) => a === b || a.startsWith(b + path.sep);
  if (within(dir, realHome) || within(realHome, dir)) {
    console.error(`browser-rig: refusing to run: the rig directory ${dir} overlaps the real home ${realHome}; set CAST_RIG_ROOT outside it`);
    process.exit(1);
  }
}

/** Fail the subcommand; the dispatcher prints it, and a failed `up` tears down what it started. */
function die(msg: string): never {
  throw new RigError(msg);
}

// ---------------------------------------------------------------------------
// State and env
// ---------------------------------------------------------------------------

function readState(): RigState | null {
  try {
    return JSON.parse(fs.readFileSync(paths.state, "utf-8")) as RigState;
  } catch {
    return null;
  }
}

function requireState(): RigState {
  return readState() ?? die(`rig "${rigName}" is not up (no ${paths.state}); run \`bun packages/cli/scripts/browser-rig.ts up${rigName === "default" ? "" : ` --name ${rigName}`}\``);
}

function writeState(s: RigState): void {
  fs.writeFileSync(paths.state, JSON.stringify(s, null, 2));
}

function readBridgeJson(): { port: number; token: string; hostPid?: number; extensionConnected?: boolean } | null {
  try {
    return JSON.parse(fs.readFileSync(paths.bridgeJson, "utf-8"));
  } catch {
    return null;
  }
}

/** The variables that point a cast process at the rig. */
function rigVars(s: Pick<RigState, "bridgePort" | "fixtures">, session = `rig-${rigName}`): Record<string, string> {
  return {
    HOME: paths.home,
    CODECAST_DIR: paths.castDir,
    CAST_BRIDGE_PORT: String(s.bridgePort),
    AGENT_BROWSER_SOCKET_DIR: paths.sockets,
    CODECAST_CHROMIUM: paths.forward,
    CAST_SESSION_ID: session,
    CODECAST_SESSION_ID: session,
    CAST_RIG_DIR: rigDir,
    ...(s.fixtures ? { CAST_RIG_FIXTURES: s.fixtures[0], CAST_RIG_FIXTURES_B: s.fixtures[1] } : {}),
  };
}

function rigEnv(s: Pick<RigState, "bridgePort" | "fixtures">, session?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of SESSION_ENV_TO_CLEAR) delete env[k];
  return { ...env, ...rigVars(s, session) };
}

function writeEnvFile(s: RigState): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const lines = [
    `# browser rig "${rigName}": source in a subshell, never in a shell you use for other cast commands`,
    `unset ${SESSION_ENV_TO_CLEAR.join(" ")}`,
    ...Object.entries(rigVars(s)).map(([k, v]) => `export ${k}=${q(v)}`),
    `alias cast-rig=${q(`bun ${CLI_ENTRY}`)}`,
    "",
  ];
  fs.writeFileSync(paths.env, lines.join("\n"));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM the process group (each rig child leads its own), then SIGKILL what is left. */
async function stop(pid: number | undefined, waitMs = 5_000): Promise<void> {
  if (!alive(pid)) return;
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid!, sig);
    } catch {
      try {
        process.kill(pid!, sig);
      } catch {}
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + waitMs;
  while (alive(pid) && Date.now() < deadline) await sleep(100);
  if (alive(pid)) signal("SIGKILL");
}

function spawnDetached(cmd: string, args: string[], env: NodeJS.ProcessEnv, logName: string): number {
  fs.mkdirSync(paths.logs, { recursive: true });
  const log = fs.openSync(path.join(paths.logs, logName), "a");
  const child = spawn(cmd, args, { env, detached: true, stdio: ["ignore", log, log], cwd: REPO });
  child.unref();
  fs.closeSync(log);
  if (!child.pid) die(`could not start ${cmd}`);
  return child.pid;
}

/** Does OUR host (the rig token) answer on the rig port? */
async function hostProbe(port: number): Promise<"alive" | "impostor" | "down" | "busy"> {
  const { probeHost } = await import("../src/browser/bridge/host.ts");
  const b = readBridgeJson();
  if (!b?.token) return "down";
  return probeHost({ port, token: b.token }, 3_000);
}

async function startHost(s: Pick<RigState, "bridgePort" | "fixtures">, onSpawn?: (pid: number) => void, env: Record<string, string> = {}): Promise<number> {
  const pid = spawnDetached("bun", [CLI_ENTRY, "browser", "bridge-host"], { ...rigEnv(s), ...env }, "bridge-host.log");
  onSpawn?.(pid);
  const deadline = Date.now() + HOST_START_MS;
  for (;;) {
    const p = await hostProbe(s.bridgePort);
    if (p === "alive") return readBridgeJson()?.hostPid ?? pid;
    if (p === "impostor") die(`something else answers on 127.0.0.1:${s.bridgePort} and cannot prove the rig token`);
    if (!alive(pid) && p === "down") die(`bridge host exited at start; see ${path.join(paths.logs, "bridge-host.log")}`);
    if (Date.now() > deadline) die(`bridge host did not answer on ${s.bridgePort} within ${HOST_START_MS / 1000}s`);
    await sleep(300);
  }
}

/** The host's own view: is the extension connected? */
async function extensionConnected(port: number): Promise<boolean> {
  const b = readBridgeJson();
  if (!b?.token) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status?token=${encodeURIComponent(b.token)}`, { signal: AbortSignal.timeout(3_000) });
    return res.ok && ((await res.json()) as { extensionConnected?: boolean }).extensionConnected === true;
  } catch {
    return false;
  }
}

/** The extension's own account of its connection (options page → worker "status"), for error messages. */
async function extensionSays(cdpPort: number): Promise<string> {
  try {
    const ext = await extensionContext(cdpPort);
    try {
      return JSON.stringify(await Promise.race([ext.eval(`chrome.runtime.sendMessage({ op: "status" })`), sleep(10_000).then(() => "no answer in 10s")]));
    } finally {
      await ext.close();
      ext.cdp.close();
    }
  } catch (err) {
    return `unreadable: ${(err as Error).message}`;
  }
}

async function waitConnected(port: number, timeoutMs = CONNECT_MS, nudge?: () => Promise<void>, cdpPort?: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let nudgedAt = 0;
  while (Date.now() < deadline) {
    if (await extensionConnected(port)) return;
    // The worker retries at 1, 2 and 5 s, then every 30 s; a nudge saves the wait.
    if (nudge && Date.now() - nudgedAt > 3_000) {
      nudgedAt = Date.now();
      await nudge().catch(() => {});
    }
    await sleep(300);
  }
  const says = cdpPort ? `; the extension says ${(await extensionSays(cdpPort)).slice(0, 600)}` : "";
  die(`the extension did not report connected to 127.0.0.1:${port} within ${timeoutMs / 1000}s${says}; host log: ${path.join(paths.logs, "bridge-host.log")}`);
}

/** Ask the extension's worker to reconnect now, through its options page in the rig Chrome. */
async function nudgeExtension(cdpPort: number): Promise<void> {
  const ext = await extensionContext(cdpPort);
  try {
    await ext.eval(`chrome.runtime.sendMessage({ op: "reconnect" }).then(() => true, () => false)`);
  } finally {
    await ext.close();
    ext.cdp.close();
  }
}

function chromeArgs(s: { cdpPort: number; headed: boolean; extDir?: string }, userDataDir = paths.profile): string[] {
  const extDir = s.extDir ?? DEFAULT_EXT_DIR;
  return [
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${extDir}`,
    `--disable-extensions-except=${extDir}`,
    `--remote-debugging-port=${s.cdpPort}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--use-mock-keychain",
    "--password-store=basic",
    "--window-size=1280,900",
    // The switches real setups pass (realChrome.ts REAL_CHROME_LAUNCH_ARGS), and
    // renderers of background tabs kept off the efficiency cores (smoke.mjs).
    "--disable-renderer-backgrounding",
    "--silent-debugger-extension-api",
    "--disable-features=MacAllowBackgroundingRenderProcesses,DisableLoadExtensionCommandLineSwitch",
    ...(s.headed ? [] : ["--headless=new"]),
    "about:blank",
  ];
}

/**
 * CODECAST_CHROMIUM for the rig: the CLI starts "Chrome" with switches and
 * one URL when it launches the human's Chrome or wakes the extension. This
 * opens that URL as a tab in the rig Chrome instead, and logs the call.
 */
function writeForwarder(cdpPort: number): void {
  const script = `#!/bin/sh
# browser-rig: stands in for the human's Chrome (CODECAST_CHROMIUM). Opens the
# URL argument in the rig Chrome over its CDP port; switches are ignored.
echo "$(date -u +%FT%TZ) $*" >> ${JSON.stringify(path.join(paths.logs, "chrome-forward.log"))}
url=""
for a in "$@"; do case "$a" in -*) ;; *) url="$a" ;; esac; done
[ -n "$url" ] || exit 0
exec /usr/bin/curl -s -o /dev/null -X PUT "http://127.0.0.1:${cdpPort}/json/new?$url"
`;
  fs.writeFileSync(paths.forward, script, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** `serve-fixtures <portA> <portB>`: the detached fixture server `up --fixtures` starts. */
function serveFixtures(portA: number, portB: number): void {
  const origin = (p: number) => `http://127.0.0.1:${p}`;
  for (const [port, other] of [[portA, portB], [portB, portA]]) {
    Bun.serve({
      port,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        const fill = (html: string, extra: Record<string, string> = {}) =>
          Object.entries({ ORIGIN: origin(port), OTHER_ORIGIN: origin(other), ...extra }).reduce((h, [k, v]) => h.replaceAll(`{{${k}}}`, v), html);
        const page = (name: string) => fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
        const html = (body: string, init: ResponseInit = {}) => {
          const headers = new Headers(init.headers);
          headers.set("content-type", "text/html; charset=utf-8");
          return new Response(body, { ...init, headers });
        };
        if (url.pathname === "/login" && req.method === "POST") {
          const form = await req.formData();
          const user = String(form.get("email") ?? "");
          const headers = new Headers({ location: `/welcome.html?user=${encodeURIComponent(user)}` });
          headers.append("set-cookie", `rig_auth=${encodeURIComponent(user)}; Path=/; HttpOnly; SameSite=Lax`);
          return new Response(null, { status: 303, headers });
        }
        if (url.pathname === "/welcome.html") {
          const user = url.searchParams.get("user") ?? /rig_auth=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? "nobody";
          return html(fill(page("welcome.html"), { USER: Bun.escapeHTML(decodeURIComponent(user)) }));
        }
        if (url.pathname === "/challenge.html") {
          return html(fill(page("challenge.html")), { status: 403, headers: { "cf-mitigated": "challenge", server: "cloudflare", "cf-ray": "8f0000000000rig0-SJC" } });
        }
        if (url.pathname === "/cookies.html") {
          const headers = new Headers();
          headers.append("set-cookie", "rig_session=s3cr3t; Path=/; HttpOnly");
          headers.append("set-cookie", "rig_pref=dark; Path=/; Max-Age=86400; SameSite=Lax");
          headers.append("set-cookie", "rig_strict=1; Path=/; SameSite=Strict");
          return html(fill(page("cookies.html")), { headers });
        }
        if (url.pathname === "/healthz") return new Response("ok");
        const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (!/^[a-z0-9-]+\.html$/.test(name) || !fs.existsSync(path.join(FIXTURES_DIR, name))) return new Response("not found", { status: 404 });
        return html(fill(page(name)));
      },
    });
  }
  console.log(`fixtures on ${origin(portA)} and ${origin(portB)}`);
}

async function startFixtures(s: Pick<RigState, "bridgePort">): Promise<{ pid: number; urls: [string, string] }> {
  const a = await freePort();
  let b = await freePort();
  while (b === a) b = await freePort();
  const pid = spawnDetached("bun", [import.meta.path, "serve-fixtures", String(a), String(b)], rigEnv(s), "fixtures.log");
  const urls: [string, string] = [`http://127.0.0.1:${a}`, `http://127.0.0.1:${b}`];
  // Waits as long as the server process lives: bun's start alone can take
  // minutes on a loaded machine. A server that exited fails at once.
  const deadline = Date.now() + HOST_START_MS;
  for (const u of urls) {
    for (;;) {
      const ok = await fetch(`${u}/healthz`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.ok, () => false);
      if (ok) break;
      if (!alive(pid)) die(`fixture server exited; see ${path.join(paths.logs, "fixtures.log")}`);
      if (Date.now() > deadline) die(`fixture server did not answer on ${u} within ${HOST_START_MS / 1000}s`);
      await sleep(200);
    }
  }
  return { pid, urls };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function up(): Promise<void> {
  const existing = readState();
  if (existing && (alive(existing.chromePid) || alive(existing.hostPid))) {
    die(`rig "${rigName}" is already up (env: ${paths.env}); run \`down\` first`);
  }
  if (existing || fs.existsSync(rigDir)) await teardown(existing, { quiet: true });
  for (const d of [paths.castDir, paths.profile, paths.sockets, paths.logs]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });

  let bridgePort = await freePort();
  while (bridgePort === BRIDGE_DEFAULT_PORT) bridgePort = await freePort();
  const cdpPort = await freePort();
  const headed = flag("headed");
  writeForwarder(cdpPort);

  // The token and port, written into the rig's own bridge.json by the same
  // code the CLI uses. CODECAST_DIR is read per call, so setting it here
  // points ensureBridgeConfig at the rig and nowhere else.
  process.env.CODECAST_DIR = paths.castDir;
  process.env.CAST_BRIDGE_PORT = String(bridgePort);
  const { ensureBridgeConfig } = await import("../src/browser/bridge/host.ts");
  const config = ensureBridgeConfig();
  if (config.port !== bridgePort || !paths.bridgeJson.startsWith(rigDir)) die("bridge config did not land in the rig directory");

  const chrome = findTestChrome();
  const extDir = resolveExtensionDir(option("extension"));
  const state: RigState = { name: rigName, dir: rigDir, bridgePort, cdpPort, chromePid: 0, hostPid: 0, headed, chrome, ...(extDir ? { extDir } : {}) };
  writeState(state);
  if (flag("fixtures")) {
    const fixtures = await startFixtures({ bridgePort });
    Object.assign(state, { fixturesPid: fixtures.pid, fixtures: fixtures.urls });
    writeState(state);
  }
  const base = { bridgePort, fixtures: state.fixtures };
  console.error(`starting the bridge host from source on 127.0.0.1:${bridgePort}…`);
  state.hostPid = await startHost(base, (pid) => writeState({ ...state, hostPid: pid }));
  writeState(state);

  console.error(`starting ${path.basename(chrome)} (${headed ? "headed" : "headless"}) with the unpacked extension…`);
  state.chromePid = spawnDetached(chrome, chromeArgs({ cdpPort, headed, extDir }), rigEnv(base), "chrome.log");
  writeState(state);
  await waitForCdp(cdpPort);
  await enableDeveloperMode(cdpPort);

  await pairRigChrome(cdpPort, bridgePort, config.token);
  await waitConnected(bridgePort, CONNECT_MS, () => nudgeExtension(cdpPort), cdpPort);

  const envText = writeEnvFile(state);
  console.log(`rig "${rigName}" is up: bridge 127.0.0.1:${bridgePort} (host pid ${state.hostPid}), Chrome pid ${state.chromePid}, extension ${extDir ?? DEFAULT_EXT_DIR} connected`);
  if (state.fixtures) console.log(`fixtures: ${state.fixtures[0]}  ${state.fixtures[1]}`);
  console.log(`\n# env (also in ${paths.env}):\n${envText}`);
  console.log(`# drive it:  bun packages/cli/scripts/browser-rig.ts exec${rigName === "default" ? "" : ` --name ${rigName}`} -- open ${state.fixtures ? state.fixtures[0] + "/" : "https://example.com"}`);
}

/**
 * `--extension <dir>` loads another unpacked extension, e.g. an older release
 * to check a new host against what the Store still serves. `git:<rev>` (say
 * `git:HEAD`) unpacks that revision's packages/browser-extension into the rig
 * directory first. Kept in state.json, so restart-chrome and add-profile load
 * the same one.
 */
function resolveExtensionDir(arg: string | undefined): string | undefined {
  if (!arg) return undefined;
  if (arg.startsWith("git:")) {
    const rev = arg.slice(4) || "HEAD";
    const out = path.join(rigDir, "extension");
    fs.mkdirSync(out, { recursive: true });
    const archive = spawnSync("git", ["archive", rev, "packages/browser-extension"], { cwd: REPO, maxBuffer: 256 * 1024 * 1024 });
    if (archive.status !== 0) die(`git archive ${rev} packages/browser-extension failed: ${archive.stderr}`);
    const untar = spawnSync("tar", ["-x", "-C", out, "--strip-components", "2"], { input: archive.stdout });
    if (untar.status !== 0) die(`could not unpack the ${rev} extension: ${untar.stderr}`);
    return out;
  }
  const dir = path.resolve(arg);
  if (!fs.existsSync(path.join(dir, "manifest.json"))) die(`--extension ${arg}: no manifest.json in ${dir}`);
  return dir;
}

/**
 * Pair one rig Chrome the product way: a one-time code minted into the rig's
 * pairing file (what `extension setup` does), offered on the options page and
 * clicked. `--legacy-pair` pairs with the shared token instead, the way cast
 * did before per-profile keys, so the migration can be watched.
 */
async function pairRigChrome(cdpPort: number, bridgePort: number, token: string): Promise<void> {
  const legacy = flag("legacy-pair");
  // The code goes into the rig's pairing file, never the real home's.
  process.env.CODECAST_DIR = paths.castDir;
  const { mintPairingCode } = await import("../src/browser/bridge/pairing.ts");
  const ext = await extensionContext(cdpPort);
  try {
    if (ext.extId !== BRIDGE_EXTENSION_ID) die(`the extension loaded as ${ext.extId}, not ${BRIDGE_EXTENSION_ID}; is the manifest key intact?`);
    const pairing = legacy ? { token, port: bridgePort } : { code: mintPairingCode(null), port: bridgePort };
    const paired = await pairExtension(ext, pairing, rigDir);
    if (!paired.stored) {
      if (!legacy) die(`the pairing page did not take the code (${JSON.stringify(paired)})`);
      console.error(`the pairing page did not store the token (${JSON.stringify(paired)}); writing it into extension storage instead`);
      if (!(await seedExtensionToken(ext, { token, port: bridgePort }))) die("pairing failed both through the pairing page and by writing extension storage");
    }
  } finally {
    await ext.close();
    ext.cdp.close();
  }
}

/** The host's connected profiles, as `extension status` reads them. */
async function connectedProfiles(port: number): Promise<Array<{ id: string; default: boolean; legacy: boolean }>> {
  const b = readBridgeJson();
  if (!b?.token) return [];
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status?token=${encodeURIComponent(b.token)}`, { signal: AbortSignal.timeout(3_000) });
    return ((await res.json()) as { profiles?: Array<{ id: string; default: boolean; legacy: boolean }> }).profiles ?? [];
  } catch {
    return [];
  }
}

/**
 * A second Chrome profile against the same rig bridge: Chrome for Testing on
 * its own user-data-dir and CDP port, loading the same unpacked extension,
 * paired with its own code (or `--legacy-pair`). Returns once the host lists
 * one more profile.
 */
async function addProfile(): Promise<void> {
  const s = requireState();
  if (alive(s.chrome2Pid)) die(`rig "${rigName}" already has a second profile (Chrome pid ${s.chrome2Pid})`);
  const before = (await connectedProfiles(s.bridgePort)).length;
  fs.mkdirSync(paths.profile2, { recursive: true, mode: 0o700 });
  const cdpPort2 = await freePort();
  const chrome2Pid = spawnDetached(s.chrome, chromeArgs({ cdpPort: cdpPort2, headed: s.headed }, paths.profile2), rigEnv(s), "chrome2.log");
  writeState({ ...s, chrome2Pid, cdpPort2 });
  await waitForCdp(cdpPort2);
  await enableDeveloperMode(cdpPort2);
  const token = readBridgeJson()?.token;
  if (!token) die("the rig has no bridge token");
  await pairRigChrome(cdpPort2, s.bridgePort, token);
  const deadline = Date.now() + CONNECT_MS;
  while ((await connectedProfiles(s.bridgePort)).length <= before) {
    if (Date.now() > deadline) die(`the second profile did not connect within ${CONNECT_MS / 1000}s; the extension says ${(await extensionSays(cdpPort2)).slice(0, 600)}`);
    await nudgeExtension(cdpPort2).catch(() => {});
    await sleep(1_000);
  }
  console.log(`second profile up: Chrome pid ${chrome2Pid}, CDP ${cdpPort2}; connected profiles: ${JSON.stringify(await connectedProfiles(s.bridgePort))}`);
}

const REFUSED: Array<[string[], string]> = [
  [["show"], "raises a window by process on the human's screen"],
  [["login"], "raises a window by process on the human's screen"],
  [["chrome", "restart"], "quits the human's Google Chrome by app name"],
];

async function exec(): Promise<void> {
  const s = requireState();
  if (!rest.length) die("nothing to run: `exec -- <browser verb> [args]`");
  const args = rest[0] === "browser" ? rest.slice(1) : rest;
  for (const [verb, why] of REFUSED) {
    if (verb.every((w, i) => args[i] === w)) die(`\`browser ${verb.join(" ")}\` is refused in the rig: it ${why}`);
  }
  // `--cli <main.ts>` runs another CLI build against the rig, e.g. an older
  // checkout's, the way a session mid-turn keeps its CLI across a release.
  const cli = option("cli") ? path.resolve(option("cli")!) : CLI_ENTRY;
  const child = spawn("bun", [cli, "browser", ...args], { env: rigEnv(s, option("session")), stdio: "inherit", cwd: process.cwd() });
  const code: number = await new Promise((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  process.exit(code);
}

async function reloadExt(): Promise<void> {
  const s = requireState();
  const b = readBridgeJson();
  // The product path first: the host asks the extension to reload itself
  // (what `cast browser extension reload` does). A disconnected extension
  // cannot hear that, so Chrome reloads it from chrome://extensions instead,
  // which also hands back a load error from a broken edit.
  await enableDeveloperMode(s.cdpPort);
  const viaHost = b?.token && (await extensionConnected(s.bridgePort))
    ? await fetch(`http://127.0.0.1:${s.bridgePort}/reload?token=${encodeURIComponent(b.token)}`, { method: "POST", signal: AbortSignal.timeout(15_000) }).then((r) => r.ok, () => false)
    : false;
  if (viaHost) {
    // Let the old socket drop before asking, or the old connection reads as up.
    const gone = Date.now() + 5_000;
    while (Date.now() < gone && (await extensionConnected(s.bridgePort))) await sleep(150);
  } else {
    const loadError = await reloadUnpacked(s.cdpPort, BRIDGE_EXTENSION_ID);
    if (loadError) die(`Chrome could not load ${s.extDir ?? DEFAULT_EXT_DIR}: ${loadError}`);
  }
  try {
    await waitConnected(s.bridgePort, CONNECT_MS, () => nudgeExtension(s.cdpPort));
  } catch (err) {
    const info = await extensionInfo(s.cdpPort, BRIDGE_EXTENSION_ID).catch((e) => `unreadable: ${(e as Error).message}`);
    die(`${(err as Error).message}; Chrome says ${JSON.stringify(info)}`);
  }
  console.log(`extension reloaded from ${s.extDir ?? DEFAULT_EXT_DIR} ${viaHost ? "(asked through the host)" : "(from chrome://extensions)"} and reconnected`);
}

/**
 * Does the CLI source the host would run still load? A sibling's half-saved
 * file (an import of an export that does not exist yet) kills a fresh host at
 * start; bundling the entry finds that in a second, while the running host
 * is still up, and names the file and import.
 */
function sourceLoadError(): string | null {
  const out = path.join(rigDir, "preflight");
  const r = spawnSync("bun", ["build", CLI_ENTRY, "--target=bun", "--outdir", out], { cwd: REPO, encoding: "utf-8" });
  fs.rmSync(out, { recursive: true, force: true });
  return r.status === 0 ? null : `${r.stderr || r.stdout}`.trim().split("\n").slice(-12).join("\n");
}

async function restartHost(): Promise<void> {
  const s = requireState();
  const loadError = sourceLoadError();
  if (loadError) die(`the CLI source does not load, so a new host would die at start; the running host (pid ${readBridgeJson()?.hostPid ?? s.hostPid}) was left up.\n${loadError}`);
  const pid = readBridgeJson()?.hostPid ?? s.hostPid;
  await stop(pid);
  await stopStrayHosts(s.bridgePort);
  const gone = Date.now() + 5_000;
  while (Date.now() < gone && (await hostProbe(s.bridgePort)) !== "down") await sleep(150);
  // `--build <stamp>` starts the host under another build stamp (hostBuild.ts), e.g. an old one a newer CLI should replace.
  const build = option("build");
  const hostPid = await startHost(s, (pid) => writeState({ ...s, hostPid: pid }), build ? { CAST_BRIDGE_BUILD: build } : {});
  writeState({ ...s, hostPid });
  await waitConnected(s.bridgePort, CONNECT_MS, () => nudgeExtension(s.cdpPort), s.cdpPort);
  console.log(`bridge host restarted from source (pid ${hostPid}${build ? `, build ${build}` : ""}) and the extension reconnected`);
}

/**
 * Quit the rig Chrome and start it again on the same profile, port and
 * extension: the extension's pairing survives in the profile, so it finds the
 * host again on its own. For chaos runs (scripts/browser-stress/soak.ts).
 */
async function restartChrome(): Promise<void> {
  const s = requireState();
  await stop(s.chromePid);
  const chromePid = spawnDetached(s.chrome, chromeArgs(s), rigEnv(s), "chrome.log");
  writeState({ ...s, chromePid });
  await waitForCdp(s.cdpPort, CONNECT_MS);
  await waitConnected(s.bridgePort, CONNECT_MS, () => nudgeExtension(s.cdpPort), s.cdpPort);
  console.log(`rig Chrome restarted (pid ${chromePid}) and the extension reconnected`);
}

async function status(): Promise<void> {
  const s = requireState();
  const probe = await hostProbe(s.bridgePort);
  console.log(JSON.stringify({
    name: s.name,
    dir: s.dir,
    env: paths.env,
    bridge: `127.0.0.1:${s.bridgePort}`,
    host: probe,
    extensionConnected: probe === "alive" ? await extensionConnected(s.bridgePort) : false,
    chrome: alive(s.chromePid) ? `pid ${s.chromePid}` : "down",
    ...(s.chrome2Pid ? { chrome2: alive(s.chrome2Pid) ? `pid ${s.chrome2Pid}, CDP ${s.cdpPort2}` : "down" } : {}),
    profiles: probe === "alive" ? await connectedProfiles(s.bridgePort) : [],
    fixtures: s.fixtures ?? null,
  }, null, 2));
}

/** A host the CLI itself respawned for the rig (ensureBridgeHost): by port, or as a launchd job named for the port. */
async function stopStrayHosts(port: number): Promise<void> {
  const { bridgeHostPidsOnPort } = await import("../src/browser/bridge/host.ts");
  for (const pid of bridgeHostPidsOnPort(port)) await stop(pid);
  const label = `gui/${process.getuid?.()}/sh.codecast.bridge-host.${port}`;
  if (spawnSync("/bin/launchctl", ["print", label], { stdio: "ignore" }).status === 0) {
    spawnSync("/bin/launchctl", ["bootout", label], { stdio: "ignore" });
  }
}

async function teardown(s: RigState | null, opts: { quiet?: boolean } = {}): Promise<void> {
  if (s) {
    await stop(s.chromePid);
    await stop(s.chrome2Pid);
    await stop(readBridgeJson()?.hostPid);
    await stop(s.hostPid);
    await stop(s.fixturesPid);
    if (s.bridgePort !== BRIDGE_DEFAULT_PORT) await stopStrayHosts(s.bridgePort);
  }
  // Engine daemons the CLI started under the rig's socket dir.
  try {
    for (const name of fs.readdirSync(paths.sockets)) {
      if (!name.endsWith(".pid")) continue;
      const pid = parseInt(fs.readFileSync(path.join(paths.sockets, name), "utf-8").trim(), 10);
      if (pid > 0) await stop(pid, 2_000);
    }
  } catch {}
  // Chrome keeps writing its profile for a moment after it exits.
  for (let i = 0; i < 5 && fs.existsSync(rigDir); i++) {
    try {
      fs.rmSync(rigDir, { recursive: true, force: true });
    } catch {
      await sleep(500);
    }
  }
  if (!opts.quiet) console.log(fs.existsSync(rigDir) ? `rig "${rigName}" stopped; could not remove ${rigDir}` : `rig "${rigName}" is down and ${rigDir} removed`);
}

async function down(): Promise<void> {
  const s = readState();
  if (!s && !fs.existsSync(rigDir)) {
    console.log(`rig "${rigName}" is not up`);
    return;
  }
  await teardown(s);
}

async function main(): Promise<void> {
  switch (sub) {
    case "up":
      return up();
    case "exec":
      return exec();
    case "reload-ext":
      return reloadExt();
    case "restart-host":
      return restartHost();
    case "restart-chrome":
      return restartChrome();
    case "add-profile":
      return addProfile();
    case "status":
      return status();
    case "down":
      return down();
    case "serve-fixtures":
      return serveFixtures(parseInt(own[1], 10), parseInt(own[2], 10));
    default:
      console.error("usage: browser-rig.ts up [--fixtures] [--headed] [--legacy-pair] [--extension <dir|git:rev>] [--name <n>] | add-profile [--legacy-pair] | exec [--name <n>] [--session <id>] [--cli <main.ts>] -- <verb> [args] | reload-ext | restart-host [--build <stamp>] | restart-chrome | status | down");
      process.exit(sub ? 1 : 0);
  }
}

try {
  await main();
} catch (err) {
  console.error(`browser-rig: ${err instanceof RigError ? err.message : (err as Error)?.stack ?? err}`);
  if (sub === "up") {
    console.error(`browser-rig: tearing down the half-built rig (logs were in ${paths.logs})`);
    await teardown(readState(), { quiet: true });
  }
  process.exit(1);
}

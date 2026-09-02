/**
 * Reap engine browsers nobody is driving any more.
 *
 * The engine keeps one daemon and one Chrome per session and never closes
 * either on its own; a session that ends without `cast browser stop` leaves
 * both running for good. One night of agents and their tests left 217 Chrome
 * processes and a load average of 400 on the development machine. Nothing in
 * the engine will ever know that a codecast session has ended, so this has to
 * be ours: every session start looks for browsers whose owner is gone and
 * closes them, the way `killStrayChrome` guards the built-in driver.
 *
 * Ownership is read back out of the session key the engine was given (see
 * engineSession()): `env-<id>` names a harness session id that a live agent
 * process still carries in its environment, `pane-%N` a tmux pane. A key that
 * names neither (tests, `default`) is judged by idleness instead — the daemon
 * files carry the time of its last action.
 *
 * A session's tab lives in the shared managed browser, so reaping closes that
 * tab (by the target id the daemon recorded) and then the daemon. Also cleaned:
 * the daemon files a closed session leaves behind, and the whole-profile copies
 * in the system tmp dir that older engine runs made (2.4G each) once no Chrome
 * is using them.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "../proc.js";
import {
  engineHome, engineSession, engineStateDir, findEngine, isRealSession, managedPort, REAL_SESSION_SUFFIX, runEngine,
  type EngineOptions,
} from "./engine.js";
import { CdpConnection, type CdpEndpoint } from "./cdp.js";
import { bridgeEndpointIfConfigured, engineBrowserFor } from "./bridge/real.js";

/** How long a browser with an unknowable owner may sit untouched. */
export const ENGINE_IDLE_MS = 2 * 60 * 60 * 1000;
/** Startup-path reaps are throttled to this; `stop --all` and tests force. */
const THROTTLE_MS = 5 * 60 * 1000;

export interface EngineSessionInfo {
  key: string;
  pid: number | null;
  running: boolean;
  /** Newest mtime across the session's daemon files. */
  lastSeen: number;
}

/** Every session the engine has files for, running or not. */
export function listEngineSessions(stateDir = engineStateDir()): EngineSessionInfo[] {
  const byKey = new Map<string, EngineSessionInfo>();
  let names: string[];
  try {
    names = fs.readdirSync(stateDir);
  } catch {
    return [];
  }
  for (const name of names) {
    const m = /^(.+)\.(pid|config|target|sock|stream|version|engine)$/.exec(name);
    if (!m) continue;
    const key = m[1];
    const info = byKey.get(key) ?? { key, pid: null, running: false, lastSeen: 0 };
    const full = path.join(stateDir, name);
    try {
      info.lastSeen = Math.max(info.lastSeen, fs.statSync(full).mtimeMs);
    } catch {
      /* raced with a removal */
    }
    if (m[2] === "pid") {
      const pid = parseInt(fs.readFileSync(full, "utf-8").trim(), 10);
      if (pid > 0) {
        info.pid = pid;
        info.running = isAlive(pid);
      }
    }
    byKey.set(key, info);
  }
  return [...byKey.values()];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * How to tell whether the agent behind a session key is still around.
 *
 * Two independent signals, either of which proves life: the daemon's session
 * registry (`~/.codecast/session-registry/<id>.json`, written by the
 * SessionStart hook with the agent's pid) names a pid that is alive, or the
 * agent's transcript (`~/.claude/projects/<slug>/<id>.jsonl`) was written
 * recently — an agent doing anything at all appends to it. Neither signal is
 * trusted to prove DEATH: registry entries go stale when a session is resumed
 * under a new pid (seen 2026-08-15, and it cost a live agent its tab), so a
 * session that shows no sign of life is merely "unknown" and falls to the idle
 * rule. Tmux panes are checked against `tmux list-panes`.
 */
export interface LiveOwners {
  session(id: string): OwnerState;
  panes: Set<string> | null;
}

export type OwnerState = "alive" | "dead" | "unknown";

export function sessionRegistryDir(): string {
  return path.join(process.env.CODECAST_DIR || path.join(os.homedir(), ".codecast"), "session-registry");
}

/** Newest mtime of a transcript for this session id under any project, or 0. */
export function transcriptMtime(id: string, projectsDir = path.join(os.homedir(), ".claude", "projects")): number {
  let newest = 0;
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      try {
        newest = Math.max(newest, fs.statSync(path.join(projectsDir, dir, `${id}.jsonl`)).mtimeMs);
      } catch {
        /* not this project */
      }
    }
  } catch {
    /* no transcripts here */
  }
  return newest;
}

/** A transcript written within this window means the agent is at work. */
export const TRANSCRIPT_FRESH_MS = 30 * 60 * 1000;

export function scanLiveOwners(opts: { registryDir?: string; projectsDir?: string; now?: number } = {}): LiveOwners {
  const registryDir = opts.registryDir ?? sessionRegistryDir();
  const now = opts.now ?? Date.now();
  let panes: Set<string> | null = null;
  try {
    const t = spawnSync("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf-8", timeout: 5_000 });
    if (t.status === 0) {
      panes = new Set();
      for (const line of ((t.stdout as string) ?? "").split("\n")) if (line.trim()) panes.add(line.trim());
    }
  } catch {
    /* no tmux: panes stay unknowable */
  }
  return {
    panes,
    session(id: string): OwnerState {
      try {
        const reg = JSON.parse(fs.readFileSync(path.join(registryDir, `${id}.json`), "utf-8"));
        const pid = Number(reg?.pid);
        if (pid > 0 && isAlive(pid)) return "alive";
      } catch {
        /* no registry entry */
      }
      if (now - transcriptMtime(id, opts.projectsDir) < TRANSCRIPT_FRESH_MS) return "alive";
      return "unknown";
    },
  };
}

/**
 * Is the agent behind this session key still around? Mirrors engineSession():
 * the key is ownerKey() with `:` and other punctuation turned into `-`, so
 * `env:<uuid>` reads back as `env-<uuid>` and `pane:%12` as `pane--12`.
 */
export function ownerState(key: string, live: LiveOwners): OwnerState {
  // A real-mode session is the same agent under a suffixed key (engine.ts).
  if (isRealSession(key)) key = key.slice(0, -REAL_SESSION_SUFFIX.length);
  const env = /^(?:env|session)-(.+)$/.exec(key);
  if (env) return live.session(env[1]);
  const pane = /^pane-(.+)$/.exec(key);
  if (pane) {
    if (!live.panes) return "unknown";
    const flat = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "-");
    for (const p of live.panes) if (flat(p) === pane[1]) return "alive";
    return "dead";
  }
  return "unknown";
}

export interface ReapReport {
  closed: string[];
  killed: number;
  cleaned: string[];
  tmpDirsRemoved: number;
  skipped: boolean;
}

export interface ReapOptions {
  /** Ignore the throttle stamp. */
  force?: boolean;
  /** Never touch this session (the caller's own). */
  keep?: string | null;
  now?: number;
  idleMs?: number;
  live?: LiveOwners;
  stateDir?: string;
  /** Close a session's tab and daemon; injectable for tests. */
  closeSession?: (key: string) => boolean;
}

function stampPath(): string {
  return path.join(engineHome(), "reap.stamp");
}

/** The tab a session's daemon is pinned to, from the file it keeps. */
export function sessionTargetId(key: string, stateDir = engineStateDir()): string | null {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(stateDir, `${key}.target`), "utf-8"));
    return typeof t?.targetId === "string" ? t.targetId : null;
  } catch {
    return null;
  }
}

/**
 * Where a session's tab lives, for a raw CDP call: the bridge for a `-real`
 * key (the human's Chrome), the managed browser for any other. Null when that
 * browser was never set up, so there is nothing to close.
 */
export function sessionEndpoint(key: string): CdpEndpoint | null {
  return isRealSession(key) ? bridgeEndpointIfConfigured() : managedPort();
}

/** The engine options that reach a session's browser, or null when a real
 *  session's bridge was never configured (its daemon can still be closed). */
function engineOptionsFor(key: string): (EngineOptions & { session: string }) | null {
  try {
    return engineBrowserFor(key);
  } catch {
    return null;
  }
}

/** Close a tab by target id, over CDP. Best effort. */
export function closeTargetLater(targetId: string, endpoint: CdpEndpoint | null): void {
  if (!endpoint) return;
  void CdpConnection.fromPort(endpoint, 3_000)
    .then(async (conn) => {
      try {
        await conn.send("Target.closeTarget", { targetId }, undefined, 3_000);
      } finally {
        conn.close();
      }
    })
    .catch(() => {
      /* the browser or the tab is already gone */
    });
}

/**
 * Close one session's tab in the shared browser and detach its daemon. `close`
 * on an attached daemon only disconnects, so the tab is closed explicitly first
 * — through the daemon when it is alive (it knows its tab), by target id when
 * it is not.
 */
export function closeSessionTab(key: string): boolean {
  const target = sessionTargetId(key);
  const binary = findEngine();
  const browser = engineOptionsFor(key);
  let ok = false;
  if (binary && browser) {
    const env = { ...process.env, AGENT_BROWSER_SESSION: key };
    const closedTab = runEngine(["tab", "close"], { ...browser, timeoutMs: 15_000 });
    if (closedTab.status !== 0 && target) closeTargetLater(target, sessionEndpoint(key));
    const res = spawnSync(binary, ["close"], { encoding: "utf-8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"], env });
    ok = res.status === 0;
  } else if (target) {
    closeTargetLater(target, sessionEndpoint(key));
  }
  return ok;
}

/** Chrome browser processes (not helpers) whose user-data-dir matches. */
function chromePids(userDataDirs: Set<string>): Array<{ pid: number; dir: string }> {
  const out: Array<{ pid: number; dir: string }> = [];
  try {
    const ps = spawnSync("ps", ["ax", "-o", "pid=,command="], { encoding: "utf-8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
    for (const line of ((ps.stdout as string) ?? "").split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m || /\s--type=/.test(m[2])) continue;
      const dir = /--user-data-dir=(\S+)/.exec(m[2])?.[1];
      if (dir && userDataDirs.has(dir)) out.push({ pid: parseInt(m[1], 10), dir });
    }
  } catch {
    /* ps unavailable */
  }
  return out;
}

/**
 * Close every engine browser whose owner is gone (or, when the owner cannot be
 * known, that has been idle past `idleMs`), then sweep the debris. Safe to call
 * on every start: it is throttled, and it never touches `keep`.
 */
export function reapEngineOrphans(opts: ReapOptions = {}): ReapReport {
  const report: ReapReport = { closed: [], killed: 0, cleaned: [], tmpDirsRemoved: 0, skipped: false };
  const now = opts.now ?? Date.now();
  if (!opts.force) {
    try {
      if (now - fs.statSync(stampPath()).mtimeMs < THROTTLE_MS) {
        report.skipped = true;
        return report;
      }
    } catch {
      /* no stamp yet */
    }
  }
  try {
    fs.mkdirSync(engineHome(), { recursive: true });
    fs.writeFileSync(stampPath(), String(now));
  } catch {
    /* unwritable home: reap anyway */
  }

  const stateDir = opts.stateDir ?? engineStateDir();
  const idleMs = opts.idleMs ?? ENGINE_IDLE_MS;
  const keep = opts.keep === undefined ? engineSession() : opts.keep;
  const sessions = listEngineSessions(stateDir);
  const live = opts.live ?? scanLiveOwners();
  const close = opts.closeSession ?? closeSessionTab;

  const gone = new Set<string>();
  for (const s of sessions) {
    if (s.key === keep) continue;
    const owner = ownerState(s.key, live);
    const idle = now - s.lastSeen > idleMs;
    const doomed = owner === "dead" || (owner === "unknown" && idle);
    if (!doomed) continue;
    if (s.running) {
      close(s.key);
      report.closed.push(s.key);
      if (s.pid && isAlive(s.pid)) {
        try {
          process.kill(s.pid, "SIGKILL");
          report.killed++;
        } catch {
          /* already gone */
        }
      }
    } else {
      // The daemon died but its tab may still be open in the shared browser.
      const target = sessionTargetId(s.key, stateDir);
      if (target) closeTargetLater(target, sessionEndpoint(s.key));
    }
    gone.add(s.key);
  }

  // Daemon files for sessions that are gone.
  for (const key of gone) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(stateDir).filter((n) => n.startsWith(`${key}.`));
    } catch {
      /* raced */
    }
    for (const n of names) fs.rmSync(path.join(stateDir, n), { force: true });
    fs.rmSync(path.join(engineHome(), "sessions", key), { recursive: true, force: true });
    report.cleaned.push(key);
  }

  // Whole-profile copies that older engine runs left in the tmp dir (2.4G
  // each), once no Chrome is using them. Browsers themselves are never killed
  // here: this reaps tabs and per-session daemons, nothing more.
  try {
    const tmp = os.tmpdir();
    const copies = fs.readdirSync(tmp).filter((n) => n.startsWith("agent-browser-profile-")).map((n) => path.join(tmp, n));
    if (copies.length) {
      const inUse = new Set(chromePids(new Set(copies)).map((c) => c.dir));
      for (const dir of copies) {
        if (inUse.has(dir)) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        report.tmpDirsRemoved++;
      }
    }
  } catch {
    /* tmp unreadable */
  }
  return report;
}

/** One line for the human, or null when there was nothing to do. */
export function describeReap(r: ReapReport): string | null {
  const parts: string[] = [];
  const n = r.closed.length;
  if (n) parts.push(`closed ${n} abandoned tab${n === 1 ? "" : "s"}${r.killed ? ` (${r.killed} daemons by force)` : ""}`);
  if (r.tmpDirsRemoved) parts.push(`removed ${r.tmpDirsRemoved} stale profile cop${r.tmpDirsRemoved === 1 ? "y" : "ies"}`);
  return parts.length ? parts.join(", ") : null;
}

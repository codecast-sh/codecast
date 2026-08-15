/**
 * agent-browser as the driving engine.
 *
 * `cast browser` began as its own CDP driver. Partway through it became clear
 * that Vercel Labs' agent-browser (Apache-2.0, Rust, one daemon per machine)
 * had independently reached every design decision we had — accessibility-tree
 * snapshots with stable element refs, a persistent daemon so a short command is
 * cheap, per-session tab pinning, batched steps, and a read-only copy of the
 * real Chrome profile so agents inherit the human's logins. It also carries a
 * long tail we would never fund: React introspection, Web Vitals, HAR capture,
 * accessibility audits, CPU profiles, video, and cloud browser providers.
 *
 * So the generic half moves to them and we keep the half only codecast can do:
 * screenshots that land inline in the conversation, the CLAUDE.md snippet that
 * teaches agents the command exists, and ownership tied to real codecast
 * sessions. This module is the seam between the two.
 *
 * Two properties are load-bearing:
 *
 * 1. **The agent never sees agent-browser.** Our verbs stay the vocabulary in
 *    CLAUDE.md, so the engine can be upgraded, pinned or swapped without
 *    rewriting the prose every agent on the machine has already read.
 *
 * 2. **Each codecast session gets its own isolated browser session**, by
 *    passing `ownerKey()` through as `AGENT_BROWSER_SESSION`. That replaces the
 *    tab-ownership bookkeeping we used to keep, and is stronger than it was: a
 *    convention could be walked through with an explicit tab id, whereas
 *    separate sessions genuinely cannot see each other's tabs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "../proc.js";
import { browserHome } from "./profile.js";
import { ownerKey } from "./owner.js";

/** Pinned: agent-browser is pre-1.0, so an unpinned upgrade can move the CLI
 *  surface under us. Bump deliberately, with the parity tests re-run. */
export const ENGINE_VERSION = "0.34.0";
export const ENGINE_PACKAGE = "agent-browser";

/** Where we install our own copy when the machine has none. */
export function engineHome(): string {
  return path.join(browserHome(), "engine");
}

/**
 * Find the engine binary.
 *
 * Checked in order of "closest to what the user chose": an explicit override,
 * then anything already on PATH (a global npm or Homebrew install they manage
 * themselves), then this repo's node_modules, then our managed copy. The
 * compiled `cast` binary has no node_modules of its own, which is why a managed
 * install has to exist at all.
 */
export function findEngine(): string | null {
  const candidates: string[] = [];
  if (process.env.CAST_BROWSER_ENGINE) candidates.push(process.env.CAST_BROWSER_ENGINE);

  const onPath = spawnSync("which", [ENGINE_PACKAGE], { encoding: "utf-8" });
  if (onPath.status === 0 && onPath.stdout.trim()) candidates.push(onPath.stdout.trim());

  // Relative to this module, for a source or npm install.
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    candidates.push(path.resolve(here, "../../node_modules/.bin", ENGINE_PACKAGE));
    candidates.push(path.resolve(here, "../../../../node_modules/.bin", ENGINE_PACKAGE));
  } catch {
    /* import.meta.url is unavailable in some bundles */
  }

  candidates.push(path.join(engineHome(), "node_modules", ".bin", ENGINE_PACKAGE));

  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* unreadable path */
    }
  }
  return null;
}

export interface InstallResult {
  binary: string;
  installed: boolean;
}

/**
 * Make sure an engine exists, installing a private copy if not.
 *
 * Installed under `~/.codecast/browser/engine` rather than globally: `npm i -g`
 * needs write access to a directory the user may not own, and silently changing
 * a machine-wide binary is not ours to do. A local prefix is self-contained and
 * removable with one `rm -rf`.
 */
export function ensureEngine(opts: { quiet?: boolean } = {}): InstallResult {
  const existing = findEngine();
  if (existing) return { binary: existing, installed: false };

  const home = engineHome();
  fs.mkdirSync(home, { recursive: true });
  if (!opts.quiet) {
    process.stderr.write(`  installing the browser engine (${ENGINE_PACKAGE}@${ENGINE_VERSION}), one time…\n`);
  }
  const res = spawnSync(
    "npm",
    ["install", `${ENGINE_PACKAGE}@${ENGINE_VERSION}`, "--prefix", home, "--no-save", "--silent"],
    { encoding: "utf-8", stdio: opts.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "ignore", "inherit"] },
  );
  if (res.status !== 0) {
    throw new Error(
      `could not install the browser engine.\n` +
        `  Install it yourself with:  npm install -g ${ENGINE_PACKAGE}\n` +
        `  or point cast at an existing copy:  CAST_BROWSER_ENGINE=/path/to/${ENGINE_PACKAGE}`,
    );
  }
  const found = findEngine();
  if (!found) throw new Error(`the browser engine installed but could not be found under ${home}`);
  return { binary: found, installed: true };
}

export interface EngineRun {
  status: number;
  stdout: string;
  stderr: string;
}

export interface EngineOptions {
  /** Chrome profile directory to inherit logins from ("Default", "Profile 7"). */
  profile?: string | null;
  /** Run without a visible window. */
  headless?: boolean;
  /** Override the session key; defaults to this codecast session. */
  session?: string | null;
  timeoutMs?: number;
  /** Stream output straight through instead of capturing it. */
  inherit?: boolean;
}

/**
 * The session key this codecast session drives under.
 *
 * `ownerKey()` is stable across the many short-lived processes one agent runs
 * and distinct between agents, which is exactly what an isolated browser
 * session needs. Falling back to a shared default is deliberate: a human at a
 * terminal has one obvious intent and should not be handed a private browser
 * they then cannot see.
 */
export function engineSession(detectSessionId?: () => string | null): string {
  const key = ownerKey(detectSessionId);
  if (!key) return "default";
  // Session names end up in paths and process listings, so keep them plain.
  return key.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60);
}

/** Run the engine with codecast's session and profile applied. */
export function runEngine(args: string[], opts: EngineOptions = {}): EngineRun {
  const binary = findEngine();
  if (!binary) {
    throw new Error(
      `the browser engine is not installed — run \`cast browser start\` once, or install it with ` +
        `\`npm install -g ${ENGINE_PACKAGE}\``,
    );
  }

  const full = [...args];
  if (opts.profile) full.push("--profile", opts.profile);
  if (opts.headless) full.push("--headless");

  const res = spawnSync(binary, full, {
    encoding: "utf-8",
    timeout: opts.timeoutMs ?? 120_000,
    stdio: opts.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // The isolation that replaces our tab-ownership bookkeeping.
      AGENT_BROWSER_SESSION: opts.session ?? engineSession(),
    },
  });

  return {
    status: res.status ?? 1,
    stdout: (res.stdout as string) ?? "",
    stderr: (res.stderr as string) ?? "",
  };
}

/**
 * Run the engine asking for JSON, and parse it.
 *
 * The engine wraps every response as `{success, data}`. Returning `data`
 * directly keeps that envelope out of the rest of the codebase, so if it ever
 * changes shape only this function moves.
 */
export function runEngineJson<T = any>(args: string[], opts: EngineOptions = {}): T {
  const res = runEngine([...args, "--json"], opts);
  const text = res.stdout.trim();
  if (!text) {
    throw new Error(res.stderr.trim() || `the browser engine returned nothing (exit ${res.status})`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: usually a human-readable error the engine printed before it
    // got as far as formatting a response. Pass it through rather than
    // reporting a parse failure the reader can do nothing with.
    throw new Error(text.split("\n")[0] || `the browser engine returned unparseable output`);
  }
  if (parsed && parsed.success === false) {
    throw new Error(parsed.error?.message || parsed.error || "the browser engine reported a failure");
  }
  return (parsed?.data ?? parsed) as T;
}

/** Version string of the installed engine, for `status`. */
export function engineVersion(): string | null {
  const binary = findEngine();
  if (!binary) return null;
  const res = spawnSync(binary, ["--version"], { encoding: "utf-8", timeout: 15_000 });
  if (res.status !== 0) return null;
  return ((res.stdout as string) ?? "").trim().replace(/^agent-browser\s+/, "") || null;
}

// ---------------------------------------------------------------------------
// Raw CDP access to the engine's browser
// ---------------------------------------------------------------------------

/**
 * The engine drives over its own daemon, but the Chrome underneath is an
 * ordinary browser with an ordinary debugging port — so anything that needs the
 * protocol directly can still have it.
 *
 * This matters more than it looks. Several codecast features cannot be
 * expressed as CLI verbs at all: streaming `Page.startScreencast` frames to a
 * web pane, raising a specific tab with `Page.bringToFront`, or driving the
 * user's real Chrome through the extension bridge's `CdpClient`. Without a way
 * back down to CDP, adopting the engine would have meant abandoning them.
 *
 * The port is not on the command line — the engine launches Chrome with
 * `--remote-debugging-port=0`, so Chrome picks a free one and writes it to
 * `DevToolsActivePort` in its user-data-dir. Rather than guess which directory
 * belongs to which session from its name, we ask the engine for a target id it
 * owns and then find the port whose target list contains it. That mapping stays
 * correct even if the engine renames its directories.
 */
export interface EngineCdp {
  port: number;
  webSocketDebuggerUrl: string;
  /** Target ids this session owns, active one first. */
  targetIds: string[];
}

interface EngineTab {
  tabId: string;
  targetId: string;
  active?: boolean;
  title?: string;
  url?: string;
}

/** Tabs this session owns, as the engine reports them. */
export function engineTabs(opts: EngineOptions = {}): EngineTab[] {
  try {
    const data = runEngineJson<{ tabs?: EngineTab[] }>(["tab", "list"], opts);
    return data?.tabs ?? [];
  } catch {
    return [];
  }
}

/** Every debugging port a Chrome on this machine is currently listening on. */
function candidatePorts(): number[] {
  const ports = new Set<number>();
  try {
    const out = spawnSync("bash", ["-lc", `ps ax -o command= | grep -o -- '--user-data-dir=[^ ]*' | sort -u`], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    for (const line of ((out.stdout as string) ?? "").split("\n")) {
      const dir = line.replace("--user-data-dir=", "").trim();
      if (!dir) continue;
      try {
        const first = fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf-8").split("\n")[0];
        const port = parseInt(first, 10);
        if (port > 0) ports.add(port);
      } catch {
        /* not every profile has a live port */
      }
    }
  } catch {
    /* ps unavailable */
  }
  return [...ports];
}

/**
 * Find the CDP endpoint backing this session, or null if it has no browser.
 *
 * Matched by target id rather than by directory name, so it survives the engine
 * changing how it names things.
 */
export async function engineCdpEndpoint(opts: EngineOptions = {}): Promise<EngineCdp | null> {
  const tabs = engineTabs(opts);
  if (!tabs.length) return null;
  const owned = new Set(tabs.map((t) => t.targetId).filter(Boolean));
  if (!owned.size) return null;

  for (const port of candidatePorts()) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) continue;
      const list = (await res.json()) as Array<{ id: string }>;
      if (!list.some((t) => owned.has(t.id))) continue;

      const ver = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
      const body = (await ver.json()) as { webSocketDebuggerUrl?: string };
      if (!body.webSocketDebuggerUrl) continue;
      return {
        port,
        webSocketDebuggerUrl: body.webSocketDebuggerUrl,
        targetIds: [
          ...tabs.filter((t) => t.active).map((t) => t.targetId),
          ...tabs.filter((t) => !t.active).map((t) => t.targetId),
        ].filter(Boolean),
      };
    } catch {
      /* a port that went away between listing and probing */
    }
  }
  return null;
}

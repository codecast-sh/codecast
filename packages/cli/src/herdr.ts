// herdr (herdr.dev) is a terminal multiplexer that knows which panes hold coding
// agents. codecast uses it two ways: `cast herd` mirrors the daemon's tmux
// sessions into a herdr session of their own, and the daemon delivers messages
// to agents a person started inside herdr (TERM_PROGRAM=herdr).
//
// Everything goes through herdr's socket API: newline-delimited JSON on a Unix
// socket, one request per connection. That keeps the daemon's loop free of
// child processes, which its loop-budget guard forbids on hot paths.

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { ACTIVE_AGENT_STATUSES } from "@codecast/shared/contracts";
import { execFileAsync, findOnPath, TOOL_PATH } from "./proc.js";

/** The herdr session `cast herd` owns. Separate from the person's default
 *  session, so mirroring never rearranges a layout they built by hand. */
export const HERD_SESSION = "codecast";

/** The authority name codecast reports agent state and metadata under. */
export const HERDR_SOURCE = "codecast";

/** Pane token naming the codecast session a mirrored pane shows. */
export const HERD_SESSION_TOKEN = "codecast_session";
/** Workspace token naming the project directory a mirrored workspace groups. */
export const HERD_PROJECT_TOKEN = "codecast_project";

export type HerdrAgentState = "idle" | "working" | "blocked" | "unknown";

export function herdrConfigDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "herdr");
}

/** The API socket of a named session, or of the default one. */
export function herdrSocketPath(session?: string): string {
  const dir = herdrConfigDir();
  return !session || session === "default"
    ? path.join(dir, "herdr.sock")
    : path.join(dir, "sessions", session, "herdr.sock");
}

/** Every herdr API socket on this machine, default session first. A socket
 *  file can outlive its server; callers treat a refused connection as absent. */
export async function herdrSocketPaths(): Promise<string[]> {
  const dir = herdrConfigDir();
  const out: string[] = [];
  const exists = (p: string) => fs.promises.access(p).then(() => true, () => false);
  if (await exists(path.join(dir, "herdr.sock"))) out.push(path.join(dir, "herdr.sock"));
  const names = await fs.promises.readdir(path.join(dir, "sessions")).catch(() => [] as string[]);
  for (const name of names) {
    const sock = path.join(dir, "sessions", name, "herdr.sock");
    if (await exists(sock)) out.push(sock);
  }
  return out;
}

export class HerdrError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export async function herdrRequest<T = Record<string, unknown>>(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 3000,
): Promise<T> {
  // No socket file, no server. Checked first because a connect that fails
  // with ENOENT can surface in bun as an uncaught error despite the listener.
  if (!(await fs.promises.access(socketPath).then(() => true, () => false))) {
    throw new HerdrError("unreachable", `no herdr server at ${socketPath}`);
  }
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    const done = (err: Error | null, value?: T) => {
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(value as T);
    };
    const timer = setTimeout(() => done(new HerdrError("timeout", `herdr ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify({ id: "cast", method, params }) + "\n"));
    sock.on("error", (err) => done(new HerdrError("unreachable", `herdr socket ${socketPath}: ${err.message}`)));
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const msg = JSON.parse(buf.slice(0, nl)) as { result?: T; error?: { code?: string; message?: string } };
        if (msg.error) done(new HerdrError(msg.error.code ?? "error", msg.error.message ?? `herdr ${method} failed`));
        else done(null, msg.result);
      } catch (err) {
        done(err as Error);
      }
    });
  });
}

export type HerdrPane = {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  agent?: string | null;
  agent_status?: string;
  title?: string | null;
  label?: string | null;
  tokens?: Record<string, string>;
};
export type HerdrWorkspace = { workspace_id: string; label?: string | null; tokens?: Record<string, string> };
export type HerdrTab = { tab_id: string; workspace_id: string; label?: string | null; pane_count?: number };
export type HerdrSnapshot = { workspaces: HerdrWorkspace[]; tabs: HerdrTab[]; panes: HerdrPane[] };

export async function herdrSnapshot(socketPath: string, timeoutMs?: number): Promise<HerdrSnapshot> {
  const r = await herdrRequest<{ snapshot: HerdrSnapshot }>(socketPath, "session.snapshot", {}, timeoutMs);
  return r.snapshot;
}

/** Whether a herdr server is serving this socket. A snapshot rather than a
 *  ping: a starting server accepts connections seconds before it can answer. */
export async function herdrAlive(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  return herdrSnapshot(socketPath, timeoutMs).then(() => true, () => false);
}

/** The herdr state that best describes a codecast agent status. herdr turns an
 *  `idle` the person has not looked at into its own "done" badge. */
export function herdrStateFor(status: string | undefined): HerdrAgentState {
  if (!status) return "unknown";
  if (status === "permission_blocked") return "blocked";
  if (ACTIVE_AGENT_STATUSES.has(status)) return "working";
  return "idle";
}

/** herdr's "done" is its own reading of an unseen idle, so it equals idle here. */
export function sameHerdrState(reported: string | undefined, wanted: HerdrAgentState): boolean {
  return reported === wanted || (wanted === "idle" && reported === "done");
}

// ── The herdr pane holding a process ────────────────────────────────────────

type ProcessInfo = { shell_pid?: number; foreground_processes?: Array<{ pid: number }> };

/** The herdr pane a terminal belongs to, across every running herdr session:
 *  the one whose shell or foreground job is a process on `tty`. */
export async function findHerdrPaneForTty(tty: string): Promise<{ socketPath: string; paneId: string } | null> {
  const { stdout } = await execFileAsync("ps", ["-o", "pid=", "-t", tty.replace(/^\/dev\//, "")], { encoding: "utf-8", timeout: 15_000 });
  const wanted = new Set(String(stdout).split("\n").map((l) => Number.parseInt(l.trim(), 10)).filter((n) => n > 0));
  if (wanted.size === 0) return null;
  for (const socketPath of await herdrSocketPaths()) {
    const snap = await herdrSnapshot(socketPath).catch(() => null);
    if (!snap) continue;
    for (const pane of snap.panes) {
      const info = await herdrRequest<{ process_info: ProcessInfo }>(socketPath, "pane.process_info", { pane_id: pane.pane_id })
        .then((r) => r.process_info, () => null);
      if (!info) continue;
      const hit = (info.foreground_processes ?? []).some((p) => wanted.has(p.pid)) || (info.shell_pid !== undefined && wanted.has(info.shell_pid));
      if (hit) return { socketPath, paneId: pane.pane_id };
    }
  }
  return null;
}

// ── The binary ──────────────────────────────────────────────────────────────

/** Found by walking PATH rather than spawning `which`, which fails outright
 *  on a machine short of processes and would read as "not installed". */
export function herdrBin(): string | null {
  return findOnPath("herdr", TOOL_PATH);
}

export const HERDR_INSTALL_HINT =
  process.platform === "darwin"
    ? "Install it with: brew install herdr  (or: curl -fsSL https://herdr.dev/install.sh | sh)"
    : "Install it with: curl -fsSL https://herdr.dev/install.sh | sh";

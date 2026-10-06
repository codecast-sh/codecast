import { execSync, execFileSync, spawnSync, execFileAsync, TOOL_PATH, installCommandFor, installHintFor } from "./proc.js";
import { snapshotProcessTable, snapshotProcessTableAsync, tmuxServerRows, type ProcRow } from "./processTable.js";

const ENRICHED_PATH = TOOL_PATH;

let _hasTmux: boolean | null = null;
// A negative answer is re-checked, so an install after boot is noticed; a
// positive one is final. Without the negative cache a tmuxless machine paid
// a 2s execSync on every heartbeat, command poll and /term/sessions request.
// Only a real absence (ENOENT, a non zero exit) is cached: `tmux -V` took
// 2979ms once under load (daemon.log 2026-08-31), and caching that timeout
// as "not installed" through the boot window would refuse every resume and
// WebSocket hello for a minute while the fleet reconnects.
let _hasTmuxCheckedAt = 0;
const HAS_TMUX_RECHECK_MS = 60_000;

// ── Starting a session never replaces a live server ──────────────────────────
// A tmux client whose command may start the server (new-session, start-server)
// answers a refused connect by unlinking the socket and starting a NEW server.
// A server too loaded to accept reads exactly like a dead one, so at load 970
// on 2026-10-06 one `new-session` replaced the socket of the server holding 87
// working agents; they became unreachable and the stale-generation sweep then
// killed them all. So every such command runs with -N (never start) first, and
// starts a server only when none can be holding the socket.
const TMUX_SERVER_STARTERS = new Set(["new-session", "new", "start-server", "start"]);
export function startsTmuxServer(args: string[]): boolean {
  return TMUX_SERVER_STARTERS.has(args[0] ?? "");
}

export class TmuxServerBusyError extends Error {
  constructor() {
    super("TMUX_SERVER_BUSY: the tmux server is not accepting connections; not starting another over it");
    this.name = "TmuxServerBusyError";
  }
}

/** What a failed `-N` attempt says: no socket file ("absent"), a socket nobody
 *  accepts on ("refused"), a tmux older than -N ("unsupported"), or a failure
 *  of the command itself ("other"). */
export function tmuxNoStartFailure(stderr: string): "absent" | "refused" | "unsupported" | "other" {
  if (/error connecting to .+ \(No such file or directory\)|no server running on /i.test(stderr)) return "absent";
  if (/error connecting to .+ \(Connection refused\)/i.test(stderr)) return "refused";
  if (/(unknown|illegal|invalid) option|^usage: tmux/im.test(stderr)) return "unsupported";
  return "other";
}

/** Whether a refused socket still has its server. Only the default socket can
 *  be read off the process table; a private one (TMUX_TMPDIR) keeps the plain
 *  start. An empty table is a ps that failed, which is no proof of absence. */
export function refusedTmuxServerIsLive(procs: ProcRow[], env: Record<string, string | undefined> = process.env): boolean {
  if (env.TMUX_TMPDIR) return false;
  return procs.length === 0 || tmuxServerRows(procs, process.getuid?.()).length > 0;
}

const stderrOf = (err: unknown): string => {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : "";
};

/** Run a server-starting tmux command through `run`, which throws with
 *  `.stderr` on failure. Throws TmuxServerBusyError instead of replacing a
 *  live server's socket. */
export function startTmuxGuardedSync<T>(
  args: string[],
  run: (args: string[]) => T,
  serverIsLive: () => boolean = () => refusedTmuxServerIsLive(snapshotProcessTable()),
): T {
  try {
    return run(["-N", ...args]);
  } catch (err) {
    const failure = tmuxNoStartFailure(stderrOf(err));
    if (failure === "other") throw err;
    if (failure === "refused" && serverIsLive()) throw new TmuxServerBusyError();
    return run(args);
  }
}

export async function startTmuxGuarded<T>(
  args: string[],
  run: (args: string[]) => Promise<T>,
  serverIsLive: () => Promise<boolean> = async () => refusedTmuxServerIsLive(await snapshotProcessTableAsync()),
): Promise<T> {
  try {
    return await run(["-N", ...args]);
  } catch (err) {
    const failure = tmuxNoStartFailure(stderrOf(err));
    if (failure === "other") throw err;
    if (failure === "refused" && await serverIsLive()) throw new TmuxServerBusyError();
    return run(args);
  }
}

// A tmux client whose server dies mid-protocol wedges in a 100% CPU loop and
// ignores SIGTERM, so a Node `execSync` without a timeout leaves a zombie that
// outlives the parent process (and a default-SIGTERM timeout never reaps it).
// Always go through this wrapper for shell-form tmux calls.
export const DEFAULT_TMUX_TIMEOUT_MS = 5000;
export function tmuxExecSync(args: string[], opts?: { timeout?: number; encoding?: "utf-8"; stdio?: "ignore" | ["ignore", "pipe", "ignore"] }): string {
  const stdio = opts?.stdio ?? (opts?.encoding ? ["ignore", "pipe", "ignore"] as const : "ignore");
  const exec = (argv: string[], io: unknown) => execFileSync("tmux", argv, {
    timeout: opts?.timeout ?? DEFAULT_TMUX_TIMEOUT_MS,
    killSignal: "SIGKILL",
    encoding: opts?.encoding,
    stdio: io as any,
    env: { ...process.env, PATH: ENRICHED_PATH },
  });
  // The guard reads the refusal off stderr, so a starter always pipes it.
  const result = startsTmuxServer(args)
    ? startTmuxGuardedSync(args, (argv) => exec(argv, ["ignore", "pipe", "pipe"]))
    : exec(args, stdio);
  return typeof result === "string" ? result : "";
}

// Like tmuxExecSync but NEVER throws on a non-zero exit and hands back the exit
// status, so callers can probe state (has-session) or read a pane without a
// try/catch. Same wedge-proofing: a hard timeout + SIGKILL guarantees that a
// tmux client which busy-loops after its server dies is reaped instead of
// spinning at 100% CPU forever. On a timeout, spawnSync returns status:null —
// which every caller here already treats as "dead / not-ready / empty", the
// safe fallback. Route ALL raw spawnSync("tmux", …) reads through this.
export function tmuxRun(args: string[], opts?: { timeout?: number; env?: Record<string, string | undefined> }): { status: number | null; stdout: string; stderr: string } {
  const run = (argv: string[]) => {
    const r = spawnSync("tmux", argv, {
      timeout: opts?.timeout ?? DEFAULT_TMUX_TIMEOUT_MS,
      killSignal: "SIGKILL",
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: ENRICHED_PATH, ...opts?.env },
    });
    return {
      status: r.status,
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : "",
    };
  };
  if (!startsTmuxServer(args)) return run(args);
  try {
    return startTmuxGuardedSync(args, (argv) => throwOnFailure(run(argv)));
  } catch (err) {
    return failedRunResult(err);
  }
}

// The guard speaks the throwing dialect; tmuxRun and tmuxRunAsync never throw.
// A failed result is thrown as itself and handed back unchanged.
function throwOnFailure<T extends { status: number | null }>(result: T): T {
  if (result.status !== 0) throw result;
  return result;
}
function failedRunResult(err: unknown): TmuxRunResult {
  if (err && typeof err === "object" && "status" in err && "stdout" in err) return err as TmuxRunResult;
  return { status: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
}

export type TmuxRunResult = { status: number | null; stdout: string; stderr: string; code?: string; signal?: string | null; killed?: boolean };

export function isTmuxSessionMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; status?: unknown; signal?: unknown; killed?: unknown; stderr?: unknown };
  if (e.killed || e.signal || typeof e.code === "string") return false;
  if (e.code !== 1 && e.status !== 1) return false;
  return typeof e.stderr === "string" &&
    /can't find session|no such session|session not found|no server running on |error connecting to .+ \(No such file or directory\)/i.test(e.stderr);
}

// The promise twin of tmuxRun for callers on the daemon's event loop (the
// loopback HTTP and WebSocket paths): same contract, never throws, status
// null on a timeout kill. Node hands a non zero exit back as an error whose
// `code` is the exit status; a kill carries a signal and no numeric code.
export async function tmuxRunAsync(args: string[], opts?: { timeout?: number; env?: Record<string, string | undefined> }): Promise<TmuxRunResult> {
  if (!startsTmuxServer(args)) return tmuxRunAsyncRaw(args, opts);
  try {
    return await startTmuxGuarded(args, async (argv) => throwOnFailure(await tmuxRunAsyncRaw(argv, opts)));
  } catch (err) {
    return failedRunResult(err);
  }
}

async function tmuxRunAsyncRaw(args: string[], opts?: { timeout?: number; env?: Record<string, string | undefined> }): Promise<TmuxRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("tmux", args, {
      timeout: opts?.timeout ?? DEFAULT_TMUX_TIMEOUT_MS,
      killSignal: "SIGKILL",
      encoding: "utf-8",
      env: { ...process.env, PATH: ENRICHED_PATH, ...opts?.env },
    });
    return { status: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown; signal?: string | null; killed?: boolean };
    return {
      status: typeof e.code === "number" ? e.code : null,
      ...(typeof e.code === "string" ? { code: e.code } : {}),
      ...(e.signal !== undefined ? { signal: e.signal } : {}),
      ...(e.killed !== undefined ? { killed: e.killed } : {}),
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : "",
    };
  }
}

// ── Finding the pane an agent lives in ────────────────────────────────────────
// The daemon stamps every pane it starts or resumes with `@codecast_session_id`
// (setTmuxSessionOption), and that pane is the one the web session attaches to —
// the header tmux pill, the read-only split, and message injection all address
// it. So the stamp is how anything else finds "the pane for this session".
//
// Every stamp, both times and the name in ONE tmux call: identifying a pane
// costs one exec, not one show-options per pane.
//
// The separator must be PRINTABLE. tmux sanitizes control characters in all
// format output — a tab comes back as `_`, which silently welds the
// fields into one unparseable string (and then nothing ever matches). The name
// goes LAST because it is the only field a human names, so anything unexpected
// in it can be re-joined instead of shifting the fields.
const PANE_FIELD_SEP = "|";
const PANE_LIST_FIELDS = [
  "#{@codecast_session_id}",
  "#{session_created}",
  "#{session_activity}",
  "#{@codecast_conversation_id}",
  "#{@codecast_agent_type}",
  "#{@codecast_project_path}",
  "#{session_name}",
];
const PANE_LIST_FORMAT = PANE_LIST_FIELDS.join(PANE_FIELD_SEP);

export type CodecastPane = {
  tmux: string;
  /** From @codecast_session_id, when the pane carries it. */
  sessionId: string | null;
  /** tmux #{session_created}, unix seconds. 0 when tmux didn't report one. */
  createdSec: number;
  /** tmux #{session_activity}: the last output or input, unix seconds. 0 when unknown. */
  activitySec: number;
  conversationId: string | null;
  agentType: string | null;
  projectPath: string | null;
};

/** A user option's value, or null when it is unset. A tmux too old to expand
 *  `#{@opt}` hands the placeholder back verbatim, which is "unset" too: read as
 *  a value, a pane could be mistaken for another session's. */
function optionValue(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  return v && !v.includes("#{") ? v : null;
}

/** Parse `tmux list-sessions -F PANE_LIST_FORMAT` output. Unset user options
 *  expand to the empty string, and an ancient tmux that doesn't expand `#{@opt}`
 *  at all just yields no stamp — so a pane goes unmatched rather than
 *  misidentified. */
export function parseCodecastPaneRows(stdout: string): CodecastPane[] {
  const fixed = PANE_LIST_FIELDS.length - 1;
  const panes: CodecastPane[] = [];
  for (const row of stdout.split("\n")) {
    if (!row.trim()) continue;
    const fields = row.split(PANE_FIELD_SEP);
    // Re-join: a separator inside the name is the name's, not a new field.
    const tmux = fields.slice(fixed).join(PANE_FIELD_SEP).trim();
    if (!tmux) continue;
    const [sessionId, created, activity, conversationId, agentType, projectPath] = fields;
    panes.push({
      tmux,
      sessionId: optionValue(sessionId),
      createdSec: Number.parseInt((created ?? "").trim(), 10) || 0,
      activitySec: Number.parseInt((activity ?? "").trim(), 10) || 0,
      conversationId: optionValue(conversationId),
      agentType: optionValue(agentType),
      projectPath: optionValue(projectPath),
    });
  }
  return panes;
}

/**
 * The pane running `sessionId`, or null.
 *
 * The stamp wins. The name is only a fallback for a pane that predates the
 * stamp (or a tmux too old to expand it), and then only for an UNSTAMPED pane —
 * one stamped for another session is another session's, whatever it is called.
 *
 * `newerThanSec` is how a restart avoids attaching to the pane it just asked the
 * daemon to kill: the resume builds a NEW pane under the same name, so "same
 * name, created before I asked" means the old one is still standing there.
 */
export function pickPaneForSession(
  panes: CodecastPane[],
  sessionId: string,
  nameSuffix: string,
  newerThanSec?: number,
): string | null {
  const fresh = (p: CodecastPane) =>
    newerThanSec === undefined || (p.createdSec > 0 && p.createdSec >= newerThanSec);
  const stamped = panes.filter((p) => p.sessionId === sessionId);
  const named = panes.filter(
    (p) => !p.sessionId && p.tmux.includes("-resume-") && p.tmux.endsWith(nameSuffix),
  );
  return (stamped.find(fresh) ?? named.find(fresh) ?? null)?.tmux ?? null;
}

/** One tmux call: every pane this machine has, name + codecast stamps. */
export function listCodecastPanes(): CodecastPane[] {
  const r = tmuxRun(["list-sessions", "-F", PANE_LIST_FORMAT]);
  // status !== 0 covers "no server running", which is simply no panes.
  if (r.status !== 0) return [];
  return parseCodecastPaneRows(r.stdout);
}

/** listCodecastPanes for callers on the daemon's event loop. */
export async function listCodecastPanesAsync(): Promise<CodecastPane[]> {
  const r = await tmuxRunAsync(["list-sessions", "-F", PANE_LIST_FORMAT]);
  if (r.status !== 0) return [];
  return parseCodecastPaneRows(r.stdout);
}

export function hasTmux(): boolean {
  if (_hasTmux === true) return true;
  if (_hasTmux === false && Date.now() - _hasTmuxCheckedAt < HAS_TMUX_RECHECK_MS) return false;
  _hasTmuxCheckedAt = Date.now();
  try {
    execSync("tmux -V", { stdio: "ignore", timeout: 2000, env: { ...process.env, PATH: ENRICHED_PATH } });
    _hasTmux = true;
  } catch (err) {
    const e = err as { killed?: boolean; signal?: string | null };
    if (e.killed || e.signal) return false; // a timeout kill says nothing about the install
    _hasTmux = false;
  }
  return _hasTmux;
}

export function resetTmuxCache(): void {
  _hasTmux = null;
  _hasTmuxCheckedAt = 0;
}

export function tryInstallTmux(): boolean {
  const cmd = installCommandFor("tmux");
  if (!cmd) return false;

  console.log(`Installing tmux: ${cmd}`);
  const result = spawnSync("sh", ["-c", cmd], {
    stdio: "inherit",
    timeout: 120_000,
    env: { ...process.env, PATH: ENRICHED_PATH },
  });

  if (result.status === 0) {
    resetTmuxCache();
    if (hasTmux()) {
      console.log("tmux installed successfully.");
      return true;
    }
  }
  return false;
}

export function ensureTmux(): boolean {
  if (hasTmux()) return true;

  console.log("tmux is required but not installed.");

  console.log(installHintFor("tmux"));

  return false;
}

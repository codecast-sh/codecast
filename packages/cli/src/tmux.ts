import { execSync, execFileSync, spawnSync, execFileAsync } from "./proc.js";

const ENRICHED_PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":");

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

// A tmux client whose server dies mid-protocol wedges in a 100% CPU loop and
// ignores SIGTERM, so a Node `execSync` without a timeout leaves a zombie that
// outlives the parent process (and a default-SIGTERM timeout never reaps it).
// Always go through this wrapper for shell-form tmux calls.
export const DEFAULT_TMUX_TIMEOUT_MS = 5000;
export function tmuxExecSync(args: string[], opts?: { timeout?: number; encoding?: "utf-8"; stdio?: "ignore" | ["ignore", "pipe", "ignore"] }): string {
  const stdio = opts?.stdio ?? (opts?.encoding ? ["ignore", "pipe", "ignore"] as const : "ignore");
  const result = execFileSync("tmux", args, {
    timeout: opts?.timeout ?? DEFAULT_TMUX_TIMEOUT_MS,
    killSignal: "SIGKILL",
    encoding: opts?.encoding,
    stdio: stdio as any,
    env: { ...process.env, PATH: ENRICHED_PATH },
  });
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
  const r = spawnSync("tmux", args, {
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
}

export type TmuxRunResult = { status: number | null; stdout: string; stderr: string };

// The promise twin of tmuxRun for callers on the daemon's event loop (the
// loopback HTTP and WebSocket paths): same contract, never throws, status
// null on a timeout kill. Node hands a non zero exit back as an error whose
// `code` is the exit status; a kill carries a signal and no numeric code.
export async function tmuxRunAsync(args: string[], opts?: { timeout?: number; env?: Record<string, string | undefined> }): Promise<TmuxRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("tmux", args, {
      timeout: opts?.timeout ?? DEFAULT_TMUX_TIMEOUT_MS,
      killSignal: "SIGKILL",
      encoding: "utf-8",
      env: { ...process.env, PATH: ENRICHED_PATH, ...opts?.env },
    });
    return { status: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      status: typeof e.code === "number" ? e.code : null,
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
// Stamp + creation time + name in ONE tmux call: identifying a pane costs one
// exec, not one show-options per pane.
//
// The separator must be PRINTABLE. tmux sanitizes control characters in all
// format output — a tab comes back as `_`, which silently welds the three
// fields into one unparseable string (and then nothing ever matches). The name
// goes LAST because it is the only field a human names, so anything unexpected
// in it can be re-joined instead of shifting the fields.
const PANE_FIELD_SEP = "|";
const PANE_LIST_FORMAT = `#{@codecast_session_id}${PANE_FIELD_SEP}#{session_created}${PANE_FIELD_SEP}#{session_name}`;

export type CodecastPane = {
  tmux: string;
  /** From @codecast_session_id, when the pane carries it. */
  sessionId: string | null;
  /** tmux #{session_created}, unix seconds. 0 when tmux didn't report one. */
  createdSec: number;
};

/** Parse `tmux list-sessions -F PANE_LIST_FORMAT` output. Unset user options
 *  expand to the empty string, and an ancient tmux that doesn't expand `#{@opt}`
 *  at all just yields no stamp — so a pane goes unmatched rather than
 *  misidentified. */
export function parseCodecastPaneRows(stdout: string): CodecastPane[] {
  const panes: CodecastPane[] = [];
  for (const row of stdout.split("\n")) {
    if (!row.trim()) continue;
    const [sessionId, created, ...rest] = row.split(PANE_FIELD_SEP);
    // Re-join: a separator inside the name is the name's, not a new field.
    const tmux = rest.join(PANE_FIELD_SEP).trim();
    if (!tmux) continue;
    // A tmux too old to expand `#{@opt}` hands the placeholder back verbatim.
    // That is "no stamp", not a session id — read it as one, and a pane could be
    // mistaken for another session's.
    const stamp = (sessionId ?? "").trim();
    panes.push({
      tmux,
      sessionId: stamp && !stamp.includes("#{") ? stamp : null,
      createdSec: Number.parseInt((created ?? "").trim(), 10) || 0,
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

function installCommand(): string | null {
  if (process.platform === "darwin") {
    try {
      execSync("command -v brew", { stdio: "ignore", timeout: 2000 });
      return "brew install tmux";
    } catch {
      return null;
    }
  }
  if (process.platform === "linux") {
    for (const [bin, cmd] of [
      ["apt-get", "sudo apt-get install -y tmux"],
      ["dnf", "sudo dnf install -y tmux"],
      ["yum", "sudo yum install -y tmux"],
      ["pacman", "sudo pacman -S --noconfirm tmux"],
      ["apk", "sudo apk add tmux"],
    ] as const) {
      try {
        execSync(`command -v ${bin}`, { stdio: "ignore", timeout: 2000 });
        return cmd;
      } catch {}
    }
  }
  return null;
}

export function tryInstallTmux(): boolean {
  const cmd = installCommand();
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

  const cmd = installCommand();
  if (cmd) {
    console.log(`Install it with: ${cmd}`);
  } else if (process.platform === "darwin") {
    console.log("Install Homebrew (https://brew.sh) then run: brew install tmux");
  } else {
    console.log("Install tmux using your system package manager.");
  }

  return false;
}

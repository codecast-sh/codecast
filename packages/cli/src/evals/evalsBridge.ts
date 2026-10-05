// The daemon's side of the Evals UI (docs/architecture/evals-ui.md, 3.5): one
// child process, `bun <checkout>/packages/evals/src/index.ts api --stdio`,
// that answers the /evals/* routes over line-delimited JSON. The daemon
// computes nothing itself and carries no eval code, so the release binary
// keeps its promise (the repo-root `evals` script): every verdict comes from
// the checkout's own eval tool.
//
// The child runs code from a checkout on disk, so nothing is executed until
// that checkout is proven to be a codecast checkout this user owns. The
// pointer is EVALS_HOME/checkout.json, which every `./evals` run rewrites;
// CODECAST_EVALS_REPO_ROOT overrides it for development.
//
// Everything here is async: the daemon's loop serves delivery, tmux injection
// and the heartbeat, and the loop budget guard forbids a sync spawn or read on
// a request path.

import * as fsp from "fs/promises";
import { homedir } from "os";
import * as path from "path";
import type { ChildProcessWithoutNullStreams } from "child_process";
import type {
  EvalsBridgeRequest,
  EvalsBridgeResponse,
  EvalsErrorBody,
  EvalsUnavailableReason,
} from "@codecast/shared/contracts/evalsApi";
import { agentSpawnPath } from "../agentSpawnPath.js";
import { execFileAsync, spawn } from "../proc.js";

/** The first three lines of the repo-root `evals` script. A directory whose
 *  `evals` does not start with them is not a codecast checkout. */
export const EVALS_SCRIPT_HEADER = [
  "#!/bin/sh",
  "# ./evals: codecast's eval home (packages/evals). Never mounted under `cast`,",
  "# so the CLI's boot path and release binaries carry no eval code.",
] as const;

/** The child's entry, relative to the checkout root. */
export const EVALS_ENTRY = path.join("packages", "evals", "src", "index.ts");

/** The `api` command the child runs. A checkout at a commit from before it
 *  (a review or agent worktree that ran ./evals) has the entry but answers
 *  `api --stdio` with its help and exit 1, so it is refused up front. */
export const EVALS_API_COMMAND = path.join("packages", "evals", "src", "commands", "api.ts");

const IDLE_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 120_000;
const CRASH_BACKOFF_MS = 5_000;
const REFUSAL_MEMO_MS = 30_000;
const KNOWN_ROOTS = 4;
const STDERR_LINES = 40;
/** One stderr line past this is cut: the ring is for reading, not for holding a dump. */
const STDERR_LINE_MAX = 4096;
/** The largest answer the bridge forwards. Every answer is parsed and re-encoded
 *  on the daemon's loop, so a bigger one is refused rather than stalling delivery;
 *  the child caps its own big reads (diffs and run files at 2 MiB) well below it. */
export const ANSWER_MAX = 32 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;

export type EvalsReply = { status: number; body: unknown };

export interface EvalsBridgeDeps {
  /** EVALS_HOME, resolved the way packages/evals/src/paths.ts evalsHome() does. */
  evalsHome: () => string;
  /** CODECAST_EVALS_REPO_ROOT: names the checkout directly, in place of checkout.json. */
  repoRootOverride: () => string | undefined;
  uid: () => number;
  /** The argv the child runs as, for a checkout that passed validation. */
  command: (root: string) => { cmd: string; args: string[] };
  env: () => NodeJS.ProcessEnv;
  idleMs: number;
  requestTimeoutMs: number;
  /** After a crash, requests inside this window get the crash back instead of a fresh exec. */
  crashBackoffMs: number;
  /** While a fallback serves, a refused pointer is not checked again (git spawn included) inside this window. */
  refusalMemoMs: number;
  /** The largest answer line forwarded; a longer one is refused by its id. */
  answerMax: number;
  log: (msg: string) => void;
}

/** EVALS_HOME as packages/evals/src/paths.ts evalsHome() resolves it. The
 *  daemon cannot import the eval tool, so a test holds the two together. */
export function evalsHomeDir(): string {
  return process.env.CODECAST_EVALS_HOME || path.join(homedir(), ".local", "share", "codecast", "evals");
}

const defaultDeps: EvalsBridgeDeps = {
  evalsHome: evalsHomeDir,
  repoRootOverride: () => process.env.CODECAST_EVALS_REPO_ROOT || undefined,
  uid: () => process.getuid?.() ?? -1,
  command: (root) => ({ cmd: "bun", args: [path.join(root, EVALS_ENTRY), "api", "--stdio"] }),
  // launchd hands the daemon a bare PATH; bun, git and tmux live elsewhere.
  env: () => ({ ...process.env, PATH: agentSpawnPath() }),
  idleMs: IDLE_MS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  crashBackoffMs: CRASH_BACKOFF_MS,
  refusalMemoMs: REFUSAL_MEMO_MS,
  answerMax: ANSWER_MAX,
  log: () => {},
};

export type CheckoutRefusal = { ok: false; reason: EvalsUnavailableReason; error: string };
/** `main` is the main checkout of the git repo `root` belongs to (itself, for a main checkout). */
export type CheckoutCheck = { ok: true; root: string; main: string | null } | CheckoutRefusal;

const refuse = (reason: EvalsUnavailableReason, error: string): CheckoutCheck => ({ ok: false, reason, error });

/** The checkout root the pointer names, before any validation, or null when nothing names one. */
async function pointedRoot(deps: EvalsBridgeDeps): Promise<string | null> {
  const override = deps.repoRootOverride();
  if (override) return override;
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(deps.evalsHome(), "checkout.json"), "utf8"));
    return typeof parsed?.root === "string" && parsed.root ? parsed.root : null;
  } catch {
    return null;
  }
}

/**
 * Prove the pointer names a codecast checkout this user owns: the realpath is
 * a directory owned by our uid, its `evals` script starts with the known
 * header, git calls it the top level, and the child's entry and api command
 * exist. Runs
 * before any exec; git is the only thing it spawns, never checkout code.
 */
export async function validateEvalsCheckout(deps: EvalsBridgeDeps = defaultDeps, named?: string | null): Promise<CheckoutCheck> {
  if (named === undefined) named = await pointedRoot(deps);
  if (!named) return refuse("no-checkout", "no codecast checkout has run ./evals on this machine");
  let root: string;
  try {
    root = await fsp.realpath(named);
  } catch {
    return refuse("no-checkout", `the checkout ${named} that last ran ./evals is gone`);
  }
  const stat = await fsp.stat(root).catch(() => null);
  if (!stat?.isDirectory()) return refuse("no-checkout", `${root} is not a directory`);
  if (stat.uid !== deps.uid()) return refuse("checkout-not-owned", `${root} belongs to another user`);

  const script = await fsp.readFile(path.join(root, "evals"), "utf8").catch(() => null);
  const head = script?.split("\n").slice(0, EVALS_SCRIPT_HEADER.length);
  if (!head || EVALS_SCRIPT_HEADER.some((line, i) => head[i] !== line)) {
    return refuse("checkout-bad-header", `${root}/evals is not codecast's evals script`);
  }

  // One git call: the top level, then the repo's common dir, whose parent is
  // the main checkout when this is a worktree of it.
  const [top, common] = await execFileAsync("git", ["-C", root, "rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", timeout: 15_000, env: deps.env() })
    .then(async ({ stdout }): Promise<[string, string]> => {
      const [t = "", c = ""] = stdout.split("\n");
      return [await fsp.realpath(t.trim()), c.trim()];
    })
    .catch((): [null, string] => [null, ""]);
  if (top !== root) return refuse("checkout-not-toplevel", `${root} is not the top of a git checkout`);
  const main = path.basename(common) === ".git" ? await fsp.realpath(path.dirname(common)).catch(() => null) : null;

  const entry = await fsp.stat(path.join(root, EVALS_ENTRY)).catch(() => null);
  if (!entry?.isFile()) return refuse("checkout-no-entry", `${root} has no ${EVALS_ENTRY}`);
  const api = await fsp.stat(path.join(root, EVALS_API_COMMAND)).catch(() => null);
  if (!api?.isFile()) {
    return refuse("checkout-no-entry", `${root} last ran ./evals, and its eval tool predates the api command (no ${EVALS_API_COMMAND}); run ./evals from a current checkout`);
  }
  return { ok: true, root, main };
}

interface Pending {
  /** The request's method and path, for the words of an error about it. */
  what: string;
  resolve: (reply: EvalsReply) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Child {
  proc: ChildProcessWithoutNullStreams;
  root: string;
  pending: Map<number, Pending>;
  stderr: string[];
  /** Set once the child is gone, whatever the cause; a dead child answers nothing more. */
  dead: boolean;
  /** Set when we ended it (idle, stop, a moved pointer), so its exit is not a crash. */
  ending: boolean;
}

export interface EvalsBridge {
  /** Forward one request to the child, starting it if needed. Never rejects. */
  request(req: Omit<EvalsBridgeRequest, "id">): Promise<EvalsReply>;
  /** End the child, if one runs. The daemon calls this on shutdown. */
  stop(): void;
  /** The running child's pid, or null. */
  pid(): number | null;
}

const errorReply = (status: number, body: EvalsErrorBody): EvalsReply => ({ status, body });

/**
 * Split a stream into lines. Each byte is scanned once: a partial line waits
 * as a list of pieces and only the new chunk is searched for its newline, so
 * a large answer costs its length, not its length squared, on the daemon's
 * loop. Pieces stay bytes until the line is whole, so a character split
 * across two chunks is decoded intact. A line longer than `max` bytes keeps
 * only its first `max` and arrives with `over` set.
 */
export function lineReader(onLine: (line: string, over: boolean) => void, max = Infinity): (chunk: Buffer | string) => void {
  let held: Buffer[] = [];
  let size = 0;
  let over = false;
  const take = (part: Buffer) => {
    if (size + part.length > max) {
      over = true;
      part = part.subarray(0, max - size);
    }
    if (!part.length) return;
    held.push(part);
    size += part.length;
  };
  return (chunk) => {
    let buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (let at = buf.indexOf(10); at !== -1; at = buf.indexOf(10)) {
      take(buf.subarray(0, at));
      const line = held.length === 1 ? held[0]!.toString("utf8") : Buffer.concat(held, size).toString("utf8");
      const cut = over;
      held = [];
      size = 0;
      over = false;
      onLine(line, cut);
      buf = buf.subarray(at + 1);
    }
    take(buf);
  };
}

export function createEvalsBridge(overrides: Partial<EvalsBridgeDeps> = {}): EvalsBridge {
  const deps: EvalsBridgeDeps = { ...defaultDeps, ...overrides };
  let child: Child | null = null;
  let lastCrash: { at: number; root: string; reply: EvalsReply } | null = null;
  /** Roots to serve when the pointer cannot, best first: the newest roots that
   *  passed validation, each followed by its repo's main checkout. Every
   *  checkout that runs ./evals takes the pointer, a review, agent or line
   *  worktree at an old commit included, and such a worktree is often
   *  destroyed afterwards; the area then falls back here rather than closing. */
  let known: string[] = [];
  const remember = (ok: { root: string; main: string | null }) => {
    known = [...new Set([ok.root, ...(ok.main ? [ok.main] : []), ...known])].slice(0, KNOWN_ROOTS);
  };
  /** The pointer's last refusal while a fallback served, so polls against an
   *  old worktree's pointer do not spawn git for it on every request. */
  let refused: { named: string | null; check: CheckoutRefusal; at: number } | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let nextId = 1;

  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  function end(c: Child, why: string): void {
    if (c.dead || c.ending) return;
    c.ending = true;
    deps.log(`[EVALS] ending child ${c.proc.pid}: ${why}`);
    c.proc.kill("SIGTERM");
    setTimeout(() => {
      if (!c.dead) c.proc.kill("SIGKILL");
    }, KILL_GRACE_MS).unref?.();
  }

  function armIdle(c: Child): void {
    clearIdle();
    if (c.pending.size > 0 || c.dead) return;
    idleTimer = setTimeout(() => {
      if (child === c && c.pending.size === 0) end(c, `idle ${Math.round(deps.idleMs / 1000)}s`);
    }, deps.idleMs);
    idleTimer.unref?.();
  }

  /** The child is gone: answer everything it still owed, once. */
  function bury(c: Child, reply: EvalsReply): void {
    if (c.dead) return;
    c.dead = true;
    if (child === c) child = null;
    for (const p of c.pending.values()) {
      clearTimeout(p.timer);
      p.resolve(reply);
    }
    c.pending.clear();
  }

  function spawnChild(root: string): Child | EvalsReply {
    const { cmd, args } = deps.command(root);
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(cmd, args, { cwd: root, env: deps.env(), stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      return spawnFailure(cmd, err);
    }
    const c: Child = { proc, root, pending: new Map(), stderr: [], dead: false, ending: false };
    const keep = (line: string) => {
      c.stderr.push(line);
      if (c.stderr.length > STDERR_LINES) c.stderr.splice(0, c.stderr.length - STDERR_LINES);
    };
    proc.stderr.on("data", lineReader(keep, STDERR_LINE_MAX));
    const answer = (id: number, reply: EvalsReply) => {
      const p = c.pending.get(id)!;
      c.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(reply);
      if (child === c) armIdle(c);
    };
    proc.stdout.on(
      "data",
      lineReader((line, over) => {
        if (!line.trim()) return;
        if (over) {
          // Never parsed: the child writes the id first, so the head names whose answer it was.
          const id = Number(/^\{"id":(\d+)/.exec(line.slice(0, 64))?.[1]);
          const p = c.pending.get(id);
          if (!p) return keep(`stdout: an answer over ${deps.answerMax} bytes for no pending request`);
          return answer(id, errorReply(500, { error: `the evals process answered ${p.what} with more than ${Math.round(deps.answerMax / 1024 / 1024)} MiB, too large to forward` }));
        }
        let msg: Partial<EvalsBridgeResponse> | null = null;
        try {
          msg = JSON.parse(line);
        } catch {}
        if (typeof msg?.id !== "number" || !c.pending.has(msg.id) || typeof msg.status !== "number") return keep(`stdout: ${line.slice(0, 400)}`);
        answer(msg.id, { status: msg.status, body: msg.body ?? null });
      }, deps.answerMax),
    );
    // A child that exits closes its stdin under us; the exit handler answers.
    proc.stdin.on("error", () => {});

    deps.log(`[EVALS] child ${proc.pid ?? "?"} starting in ${root}`);
    // A missing bun arrives as an async "error"; anything already written is
    // then answered by bury, so the child is usable the moment spawn returns.
    proc.once("error", (err) => {
      const failure = spawnFailure(cmd, err);
      if (failure.status === 502) lastCrash = { at: Date.now(), root, reply: failure };
      bury(c, failure);
    });
    proc.once("exit", (code, signal) => {
      if (c.dead) return;
      if (c.ending) return bury(c, errorReply(503, { error: "the evals process was stopped" }));
      const how = signal ?? `exit ${code}`;
      const reply = errorReply(502, { error: `the evals process crashed (${how})`, reason: "child-crashed", stderr: [...c.stderr] });
      deps.log(`[EVALS] child ${proc.pid} crashed (${how}): ${c.stderr.slice(-3).join(" | ")}`);
      lastCrash = { at: Date.now(), root, reply };
      bury(c, reply);
    });
    return c;
  }

  function spawnFailure(cmd: string, err: unknown): EvalsReply {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return errorReply(503, { error: `${cmd} is not on PATH, and the evals process runs under bun`, reason: "no-bun" });
    }
    return errorReply(502, { error: `the evals process would not start: ${err instanceof Error ? err.message : String(err)}`, reason: "child-crashed", stderr: [] });
  }

  const live = (c: Child | null): c is Child => !!c && !c.dead && !c.ending;

  /**
   * The running child for the checkout the pointer names now, starting one
   * when needed. Only one resolution runs at a time and every caller that
   * arrives meanwhile shares it, so two requests can never both decide the
   * pointer moved, or both start a child. The child can still die, or be
   * stopped, during the awaits (a crash, idle, stop()), so after each await
   * this reads the child it captured, never the shared slot.
   */
  async function resolveChild(): Promise<Child | EvalsReply> {
    const c = child;
    // A cheap read: the pointer moves when ./evals runs from another checkout.
    const named = await pointedRoot(deps);
    const real = named ? await fsp.realpath(named).catch(() => null) : null;
    if (live(c) && real === c.root) return c;
    // The running child's own checkout is what the pointer names, and it can no longer serve (a destroyed worktree).
    const ownRoot = live(c) && named !== null && (named === c.root || real === c.root);
    const fallbacks = known.filter((r) => r !== named && r !== real);
    const canFallBack = (live(c) && !ownRoot) || fallbacks.length > 0;
    const memo = canFallBack && refused && refused.named === named && Date.now() - refused.at < deps.refusalMemoMs ? refused.check : null;
    let check: CheckoutCheck = memo ?? (await validateEvalsCheckout(deps, named));
    if (!check.ok) {
      const why = check;
      let serving = live(c) && !ownRoot ? c.root : null;
      if (live(c) && ownRoot) {
        end(c, why.error);
        known = known.filter((r) => r !== c.root);
      }
      for (const root of serving ? [] : fallbacks) {
        const prior = await validateEvalsCheckout(deps, root);
        if (prior.ok) {
          check = prior;
          serving = prior.root;
          break;
        }
      }
      if (serving && !memo) {
        if (refused?.check.error !== why.error) deps.log(`[EVALS] ${why.error}; serving ${serving}`);
        refused = { named, check: why, at: Date.now() };
      }
      if (live(c) && !ownRoot) return c;
    }
    if (!check.ok) return errorReply(503, { error: check.error, reason: check.reason });
    remember(check);
    if (live(c)) {
      if (c.root === check.root) return c;
      end(c, `checkout moved to ${check.root}`);
    }
    if (lastCrash && lastCrash.root === check.root && Date.now() - lastCrash.at < deps.crashBackoffMs) return lastCrash.reply;
    const started = spawnChild(check.root);
    if (!("status" in started)) child = started;
    return started;
  }

  let resolving: Promise<Child | EvalsReply> | null = null;

  function ensureChild(): Promise<Child | EvalsReply> {
    resolving ??= resolveChild()
      .catch((err: unknown) => errorReply(500, { error: `the evals bridge failed: ${err instanceof Error ? err.message : String(err)}` }))
      .finally(() => {
        resolving = null;
      });
    return resolving;
  }

  return {
    async request(req) {
      clearIdle();
      const got = await ensureChild();
      if ("status" in got) {
        // An error reply sends nothing to the child, so nothing else re-arms its idle end.
        if (child) armIdle(child);
        return got;
      }
      const c = got;
      const id = nextId++;
      return new Promise<EvalsReply>((resolve) => {
        const timer = setTimeout(() => {
          c.pending.delete(id);
          resolve(errorReply(504, { error: `the evals process did not answer ${req.method} ${req.path} in ${Math.round(deps.requestTimeoutMs / 1000)}s` }));
          if (child === c) armIdle(c);
        }, deps.requestTimeoutMs);
        timer.unref?.();
        c.pending.set(id, { what: `${req.method} ${req.path}`, resolve, timer });
        const line: EvalsBridgeRequest = { id, ...req };
        c.proc.stdin.write(`${JSON.stringify(line)}\n`);
      });
    },
    stop() {
      clearIdle();
      if (child) end(child, "stop");
      child = null;
    },
    pid() {
      return child && !child.dead ? (child.proc.pid ?? null) : null;
    },
  };
}

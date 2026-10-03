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

const IDLE_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 120_000;
const CRASH_BACKOFF_MS = 5_000;
const STDERR_LINES = 40;
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
  log: () => {},
};

export type CheckoutCheck = { ok: true; root: string } | { ok: false; reason: EvalsUnavailableReason; error: string };

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
 * header, git calls it the top level, and the child's entry exists. Runs
 * before any exec; git is the only thing it spawns, never checkout code.
 */
export async function validateEvalsCheckout(deps: EvalsBridgeDeps = defaultDeps): Promise<CheckoutCheck> {
  const named = await pointedRoot(deps);
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

  const top = await execFileAsync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 15_000, env: deps.env() })
    .then(async ({ stdout }) => fsp.realpath(stdout.trim()))
    .catch(() => null);
  if (top !== root) return refuse("checkout-not-toplevel", `${root} is not the top of a git checkout`);

  const entry = await fsp.stat(path.join(root, EVALS_ENTRY)).catch(() => null);
  if (!entry?.isFile()) return refuse("checkout-no-entry", `${root} has no ${EVALS_ENTRY}`);
  return { ok: true, root };
}

interface Pending {
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

/** Split a stream into lines, holding a partial last line until its newline arrives. */
function lineReader(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let carry = "";
  return (chunk) => {
    const parts = (carry + chunk.toString()).split("\n");
    carry = parts.pop() ?? "";
    for (const line of parts) onLine(line);
  };
}

export function createEvalsBridge(overrides: Partial<EvalsBridgeDeps> = {}): EvalsBridge {
  const deps: EvalsBridgeDeps = { ...defaultDeps, ...overrides };
  let child: Child | null = null;
  let lastCrash: { at: number; root: string; reply: EvalsReply } | null = null;
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
    proc.stderr.on("data", lineReader(keep));
    proc.stdout.on(
      "data",
      lineReader((line) => {
        if (!line.trim()) return;
        let msg: Partial<EvalsBridgeResponse> | null = null;
        try {
          msg = JSON.parse(line);
        } catch {}
        const p = typeof msg?.id === "number" ? c.pending.get(msg.id) : undefined;
        if (!p || typeof msg?.status !== "number") return keep(`stdout: ${line.slice(0, 400)}`);
        c.pending.delete(msg.id!);
        clearTimeout(p.timer);
        p.resolve({ status: msg.status, body: msg.body ?? null });
        if (child === c) armIdle(c);
      }),
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
    if (live(c)) {
      // A cheap read: the pointer moves when ./evals runs from another checkout.
      const named = await pointedRoot(deps);
      const real = named ? await fsp.realpath(named).catch(() => null) : null;
      if (live(c) && real === c.root) return c;
      if (live(c)) end(c, `checkout moved to ${named ?? "nothing"}`);
    }
    const check = await validateEvalsCheckout(deps);
    if (!check.ok) return errorReply(503, { error: check.error, reason: check.reason });
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
      if ("status" in got) return got;
      const c = got;
      const id = nextId++;
      return new Promise<EvalsReply>((resolve) => {
        const timer = setTimeout(() => {
          c.pending.delete(id);
          resolve(errorReply(504, { error: `the evals process did not answer ${req.method} ${req.path} in ${Math.round(deps.requestTimeoutMs / 1000)}s` }));
          if (child === c) armIdle(c);
        }, deps.requestTimeoutMs);
        timer.unref?.();
        c.pending.set(id, { resolve, timer });
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

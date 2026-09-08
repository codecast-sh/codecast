/**
 * The daemon-side client for the `cast computer` helper.
 *
 * Three mechanisms carry the weight here, each answering a failure that has
 * already cost this codebase something:
 *
 * 1. **A generation counter over one promise chain.** Requests serialize, and
 *    every socket start stamps a generation. A restarted helper therefore
 *    never answers a queue that belonged to the one before it, and a chunk
 *    arriving on a socket that is no longer current is dropped rather than
 *    corrupting the live line buffer (Orca sidecar-client.ts:133-156).
 *
 * 2. **Reuse over relaunch.** The helper outlives the CLI process and holds
 *    the element cache the agent's indexes point into. A live one is attached
 *    to; a BUSY one (`unresponsive`) is reported as busy and never killed —
 *    that distinction is the 2026-08-14 restart-stampede lesson.
 *
 * 3. **A providerVersion handshake.** For up to two minutes after an update, a
 *    helper from the previous release can still be alive on its idle timer,
 *    running from a bundle now under `old/`. Silently reusing it would mean an
 *    agent driving last release's renderer, so a version mismatch costs one
 *    terminate and one relaunch instead.
 *
 * The helper is spawned DISCLAIMED (`cast _disclaimed --`, see disclaim.ts):
 * without that it inherits the CLI's or the daemon's responsible process, and
 * macOS attributes the Accessibility grant to bun. The grant must belong to
 * `sh.codecast.computer` and to nothing else.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveCastInvocation } from "../castInvocation.js";
import { isPidAlive } from "../workspace/chrome.js";
import { asComputerError, ComputerError, computerErrorFromWire } from "./errors.js";
import { helperAppPath, materializeHelperApp, withPrepareLock } from "./helperApp.js";
import { spawnObserved, type ObservedLaunch } from "./launchObserver.js";
import {
  acquireStartLock,
  clearInstance,
  probeLiveness,
  readInstance,
  stampComputerRaise,
  strayHelperPids,
  writeInstance,
  type ComputerInstanceState,
} from "./instance.js";
import {
  COMPUTER_PROTOCOL_VERSION,
  type ComputerActionMethod,
  type ComputerActionResult,
  type ComputerListAppsResult,
  type ComputerListWindowsResult,
  type ComputerMethod,
  type ComputerProviderCapabilities,
  type ComputerResponse,
  type ComputerSnapshotResult,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 10_000;
/** macOS `sun_path` is 104 bytes; a longer path binds nothing. */
const MAX_SOCKET_PATH = 103;

export interface HelperLaunch {
  cmd: string;
  args: string[];
}

export interface ComputerClientOptions {
  /** The CLI's own version. A helper reporting another one is relaunched. */
  version?: string;
  /** Builds the launch command. The default materializes the embedded bundle
   *  and routes it through the disclaim wrapper; tests pass a fake helper. */
  helperLaunch?: (socketPath: string, tokenPath: string) => HelperLaunch;
  /** Identifies this CLI to the helper's peer check. */
  castBinary?: string;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** How long a live-but-silent helper is given before it reads as busy. */
  patienceMs?: number;
  /** Stamps a deliberate raise so the daemon's focus sentinel does not bounce
   *  it. Called BEFORE the request goes out — a raise that lands fast must not
   *  be judged against a stamp that has not been written yet. */
  stampRaise?: () => void;
}

/**
 * The default launch: the materialized helper, spawned disclaimed.
 *
 * The disclaimed route is the primary one for both the socket helper and the
 * permission probe, because it yields a real child pid and a real spawn error,
 * and because disclaiming is precisely the mechanism that stops TCC
 * inheritance. `open -n` remains the documented fallback for the two cases
 * where disclaiming is unavailable: CODECAST_NO_DISCLAIM=1, and a macOS that
 * drops the private symbol (execDisclaimed returns -1).
 */
export function defaultHelperLaunch(socketPath: string, tokenPath: string, version?: string): HelperLaunch {
  const { executablePath } = materializeHelperApp({ version });
  const helperArgs = ["--agent", socketPath, "--token-file", tokenPath];
  const cast = resolveCastInvocation();
  if (process.platform !== "darwin" || process.env.CODECAST_NO_DISCLAIM === "1") {
    return { cmd: executablePath, args: helperArgs };
  }
  return { cmd: cast.cmd, args: [...cast.prefixArgs, "_disclaimed", "--", executablePath, ...helperArgs] };
}

/** Fill a missing verification from the action path, so an older helper can
 *  never look verified (design 14.3). */
export function normalizeActionResult(result: ComputerActionResult): ComputerActionResult {
  const action = result?.action;
  if (!action || action.verification) return result;
  const reason =
    action.path === "synthetic"
      ? ("synthetic_input" as const)
      : action.path === "clipboard"
        ? ("clipboard_paste" as const)
        : action.path === "accessibility"
          ? ("accessibility_action_unasserted" as const)
          : null;
  if (!reason) return result;
  return { ...result, action: { ...action, verification: { state: "unverified", reason } } };
}

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };

export class ComputerClient {
  private socket: net.Socket | null = null;
  private detach: (() => void) | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private chain: Promise<void> | null = null;
  /** Bumped on every shutdown. A request enqueued before one runs against a
   *  helper that no longer exists, so it is refused rather than answered by
   *  the replacement. */
  private queueGeneration = 0;
  /** Bumped on every socket start, so a startup that was overtaken destroys
   *  its own socket instead of installing itself over the winner. */
  private startGeneration = 0;
  private state: ComputerInstanceState | null = null;
  private caps: ComputerProviderCapabilities | null = null;
  private connecting: Promise<net.Socket> | null = null;
  /** Socket directories this process created, removed when it tears the
   *  helper down. A reused helper's directory belongs to whoever made it. */
  private ownedSocketDir: string | null = null;

  constructor(private readonly opts: ComputerClientOptions = {}) {}

  async capabilities(): Promise<ComputerProviderCapabilities> {
    return this.enqueue(async () => {
      await this.ensureCompatible();
      return this.caps!;
    });
  }

  listApps(): Promise<ComputerListAppsResult> {
    return this.request<ComputerListAppsResult>("listApps", {});
  }

  listWindows(params: unknown): Promise<ComputerListWindowsResult> {
    return this.request<ComputerListWindowsResult>("listWindows", params);
  }

  getAppState(params: unknown): Promise<ComputerSnapshotResult> {
    return this.request<ComputerSnapshotResult>("getAppState", params);
  }

  async action(method: ComputerActionMethod, params: unknown): Promise<ComputerActionResult> {
    return normalizeActionResult(await this.request<ComputerActionResult>(method, params));
  }

  /** Stop the helper this client is talking to, and forget it. Never launches
   *  one: a `terminate` that spawned a helper in order to stop it would be a
   *  new process, an idle timer and a TCC prompt for nothing. */
  async terminate(): Promise<void> {
    await this.enqueue(async () => {
      const state = this.state ?? readInstance();
      if (!state) return;
      await this.stopHelper(state);
      this.cleanupOwnedSocketDir();
    });
  }

  /** Drop the connection without stopping the helper. Every CLI process ends
   *  here: the helper stays up for its idle window, holding the element cache
   *  the next command's indexes point into. */
  shutdown(): void {
    const socket = this.socket;
    this.socket = null;
    this.connecting = null;
    this.caps = null;
    this.buffer = "";
    this.queueGeneration++;
    this.detach?.();
    this.detach = null;
    if (socket && !socket.destroyed) socket.end();
    const err = new ComputerError("accessibility_error", "the computer helper connection was closed");
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(err);
    }
  }

  // ── queue ────────────────────────────────────────────────────────────────

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const generation = this.queueGeneration;
    const run = () => {
      if (generation !== this.queueGeneration) {
        throw new ComputerError("accessibility_error", "the computer helper queue was invalidated; retry the request");
      }
      return fn();
    };
    const result: Promise<T> = this.chain ? this.chain.then(run, run) : Promise.resolve().then(run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.chain = tail;
    void tail.then(() => {
      if (this.chain === tail) this.chain = null;
    });
    return result;
  }

  private request<T>(method: ComputerMethod, params: unknown): Promise<T> {
    return this.enqueue(async () => {
      await this.ensureCompatible();
      if (isRestoreWindow(params)) (this.opts.stampRaise ?? stampComputerRaise)();
      return (await this.send(method, params)) as T;
    });
  }

  // ── handshake ────────────────────────────────────────────────────────────

  private async ensureCompatible(): Promise<void> {
    if (this.caps) return;
    let caps = await this.handshake();
    if (caps.protocolVersion !== COMPUTER_PROTOCOL_VERSION) {
      this.shutdown();
      caps = await this.handshake();
      if (caps.protocolVersion !== COMPUTER_PROTOCOL_VERSION) {
        throw new ComputerError(
          "provider_incompatible",
          `the computer helper speaks protocol ${caps.protocolVersion}, this CLI requires ${COMPUTER_PROTOCOL_VERSION}`,
        );
      }
    }
    const want = this.opts.version;
    if (want && caps.providerVersion && caps.providerVersion !== want) {
      // A helper from the previous release, still alive on its idle timer and
      // running from a bundle now under old/. One lost element cache beats an
      // agent silently driving last release's renderer.
      const stale = this.state ?? readInstance();
      if (stale) await this.stopHelper(stale);
      else this.shutdown();
      caps = await this.handshake();
      if (caps.providerVersion && caps.providerVersion !== want) {
        throw new ComputerError(
          "provider_incompatible",
          `the computer helper reports version ${caps.providerVersion}, this CLI is ${want} — the CLI and the helper it materializes must come from the same release`,
        );
      }
    }
    this.caps = caps;
  }

  private async handshake(): Promise<ComputerProviderCapabilities> {
    return (await this.send("handshake", {
      castBinary: this.opts.castBinary ?? process.execPath,
      protocolVersion: COMPUTER_PROTOCOL_VERSION,
    })) as ComputerProviderCapabilities;
  }

  /** Send `terminate` over whatever connection exists, wait for the pid to go,
   *  and forget the instance. Shared by the explicit verb and the
   *  providerVersion relaunch. */
  private async stopHelper(state: ComputerInstanceState): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      try {
        this.write({ id: this.nextId++, method: "terminate", params: {}, token: state.token });
      } catch {
        /* it is going away either way */
      }
    }
    this.shutdown();
    const deadline = Date.now() + 3_000;
    while (isPidAlive(state.pid) && Date.now() < deadline) await sleep(100);
    clearInstance();
    this.state = null;
  }

  // ── transport ────────────────────────────────────────────────────────────

  private async send(method: ComputerMethod, params: unknown): Promise<unknown> {
    await this.ensureConnected();
    const token = this.state?.token ?? "";
    const id = this.nextId++;
    const timeoutMs = this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Shut the connection down rather than leaving a request the helper may
        // still answer later on a socket the next command would reuse.
        this.shutdown();
        reject(new ComputerError("action_timeout", `computer helper ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      this.write({ id, method, params, token });
    } catch (err) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
      }
      this.shutdown();
      throw asComputerError(err);
    }
    return await result;
  }

  private write(request: { id: number; method: ComputerMethod; params: unknown; token: string }): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new ComputerError("accessibility_error", "the computer helper connection is closed");
    socket.write(`${JSON.stringify(request)}\n`);
  }

  private async ensureConnected(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connecting) return await this.connecting;
    const attempt = this.connect();
    this.connecting = attempt;
    try {
      return await attempt;
    } finally {
      if (this.connecting === attempt) this.connecting = null;
    }
  }

  private async connect(): Promise<net.Socket> {
    const existing = readInstance();
    if (existing) {
      let attached: net.Socket | null = null;
      const liveness = await probeLiveness(
        existing,
        async (state, ms) => {
          attached = await connectOnce(state.socketPath, ms);
          return attached !== null;
        },
        this.opts.patienceMs ?? 4_000,
      );
      if (liveness === "unresponsive") {
        throw new ComputerError(
          "action_timeout",
          `the computer helper (pid ${existing.pid}) is busy and did not answer — it is still working, so it was not restarted; retry shortly`,
        );
      }
      if (liveness === "live" && attached) {
        this.state = existing;
        this.adopt(attached);
        return attached;
      }
      // dead: the recorded pid is gone, so its socket directory is stale.
      this.discardSocketDir(existing.socketDir);
      clearInstance();
    }
    return await this.launch();
  }

  private async launch(): Promise<net.Socket> {
    const release = await acquireStartLock();
    try {
      // Someone may have won the race while we queued behind the lock.
      const fresh = readInstance();
      if (fresh && isPidAlive(fresh.pid)) {
        const socket = await connectOnce(fresh.socketPath, 1_000);
        if (socket) {
          this.state = fresh;
          this.adopt(socket);
          return socket;
        }
      }
      return await this.spawnHelper();
    } finally {
      release();
    }
  }

  private async spawnHelper(): Promise<net.Socket> {
    const generation = ++this.startGeneration;
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-computer-"));
    fs.chmodSync(socketDir, 0o700);
    const socketPath = path.join(socketDir, "helper.sock");
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
      fs.rmSync(socketDir, { recursive: true, force: true });
      throw new ComputerError("invalid_argument", "computer socket path is too long");
    }
    const tokenPath = path.join(socketDir, "helper.token");
    const token = randomBytes(32).toString("hex");
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });

    let observed: ObservedLaunch;
    try {
      // The bundle swap and the launch share prepare.lock, so no process can
      // observe the fixed path missing or half-populated mid-spawn.
      const launch = await withPrepareLock(() =>
        this.opts.helperLaunch
          ? this.opts.helperLaunch(socketPath, tokenPath)
          : defaultHelperLaunch(socketPath, tokenPath, this.opts.version),
      );
      // Why: stderr goes to a file inside the socket directory, which is
      // already private and already swept, so a helper that dies naming a
      // missing dylib or a refused signature says so in the error instead of
      // arriving as a bare exit code (ct-49674).
      observed = spawnObserved(launch.cmd, launch.args, path.join(socketDir, "helper.log"));
    } catch (err) {
      fs.rmSync(socketDir, { recursive: true, force: true });
      throw asComputerError(err);
    }
    const child = observed.child;

    const failure = watchLaunchFailure(observed);
    let socket: net.Socket;
    try {
      socket = await Promise.race([
        connectWithRetry(socketPath, this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS),
        failure.promise,
      ]);
    } catch (err) {
      failure.cleanup();
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      fs.rmSync(socketDir, { recursive: true, force: true });
      throw asComputerError(err);
    }
    failure.cleanup();
    // The token now lives only in this process's memory and in instance.json
    // at 0600, which is what lets the NEXT invocation reconnect.
    fs.rmSync(tokenPath, { force: true });

    if (generation !== this.startGeneration) {
      socket.destroy();
      fs.rmSync(socketDir, { recursive: true, force: true });
      throw new ComputerError("accessibility_error", "computer helper startup was superseded");
    }

    const state: ComputerInstanceState = {
      pid: child.pid ?? 0,
      socketPath,
      socketDir,
      token,
      helperPath: helperAppPath(),
      protocolVersion: COMPUTER_PROTOCOL_VERSION,
      startedAt: Date.now(),
    };
    writeInstance(state);
    this.state = state;
    this.ownedSocketDir = socketDir;
    this.adopt(socket);
    return socket;
  }

  private adopt(socket: net.Socket): void {
    socket.setEncoding("utf8");
    this.socket = socket;
    this.buffer = "";
    const onData = (chunk: string) => {
      // A timed-out helper socket can emit after a replacement starts; stale
      // data must never enter the live line buffer.
      if (this.socket !== socket) return;
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline === -1) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.trim()) this.handleLine(line);
      }
    };
    /**
     * Forget a connection that went away on its own, the way `shutdown()`
     * forgets one we ended. `caps` has to go with it: the handshake is what
     * tells a helper which binary may drive it, and the helper remembers that
     * per PROCESS — so the next request, which may reach a brand new helper,
     * must handshake again. Keeping stale caps here made every request after a
     * helper death fail with `permission_denied: computer agent peer is not
     * authorized`, which reads like a missing grant and is not one.
     */
    const forget = (): void => {
      this.socket = null;
      this.caps = null;
      this.detach?.();
      this.detach = null;
    };
    const onClose = () => {
      if (this.socket !== socket) return;
      forget();
      this.rejectPending(new ComputerError("accessibility_error", "the computer helper closed the connection"));
    };
    const onError = (err: Error) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.detach?.();
      this.detach = null;
      forget();
      if (!socket.destroyed) socket.destroy();
      this.rejectPending(asComputerError(err));
    };
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", onError);
    this.detach = () => {
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
      // Node treats an unhandled socket 'error' as a process exception, so a
      // detached socket keeps a no-op listener that retains nothing.
      socket.on("error", () => {});
    };
  }

  private handleLine(line: string): void {
    let response: ComputerResponse;
    try {
      response = JSON.parse(line) as ComputerResponse;
    } catch {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(computerErrorFromWire(response.error));
  }

  private rejectPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(err);
    }
  }

  private cleanupOwnedSocketDir(): void {
    if (!this.ownedSocketDir) return;
    this.discardSocketDir(this.ownedSocketDir);
    this.ownedSocketDir = null;
  }

  /**
   * Remove a socket directory, but only one we could have minted, and only
   * when nothing is still serving it.
   *
   * The name check is what keeps a hand-edited or corrupted instance.json from
   * turning this into a recursive delete of an arbitrary path. The stray check
   * fails open: a helper we cannot authenticate to exits on its own idle
   * timer, and pulling its socket out from under it buys nothing.
   */
  private discardSocketDir(dir: string): void {
    if (!dir || !path.basename(dir).startsWith("codecast-computer-")) return;
    if (strayHelperPids(dir).length > 0) return;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function isRestoreWindow(params: unknown): boolean {
  return !!params && typeof params === "object" && (params as { restoreWindow?: unknown }).restoreWindow === true;
}

function connectOnce(socketPath: string, timeoutMs: number): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    // Listeners BEFORE connect(): a missing socket path can emit 'error'
    // synchronously, and an unhandled socket 'error' is a process exception —
    // so `net.createConnection(path)` would throw out of this executor for the
    // ordinary "the helper has not bound yet" case that the retry loop exists
    // to absorb.
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      resolve(null);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("error", onError);
      socket.off("connect", onConnect);
    };
    const onError = () => {
      cleanup();
      socket.destroy();
      resolve(null);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
    try {
      socket.connect(socketPath);
    } catch {
      cleanup();
      socket.destroy();
      resolve(null);
    }
  });
}

async function connectWithRetry(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const socket = await connectOnce(socketPath, Math.min(1_000, Math.max(200, deadline - Date.now())));
    if (socket) return socket;
    if (Date.now() >= deadline) {
      throw new ComputerError("accessibility_error", `the computer helper did not open its socket within ${Math.round(timeoutMs / 1000)}s`);
    }
    await sleep(100);
  }
}

/** Race the connect against the child's own failure, so a helper that dies on
 *  launch fails fast with the real reason instead of timing out. The observer
 *  carries what the child said on the way out, which is what tells a missing
 *  bundle apart from a refused signature apart from a crash. */
function watchLaunchFailure(observed: ObservedLaunch): { promise: Promise<never>; cleanup: () => void } {
  const child = observed.child;
  let cleanup = (): void => {};
  const promise = new Promise<never>((_resolve, reject) => {
    const died = () => reject(new ComputerError("accessibility_error", `the computer helper ${observed.explain()}`));
    child.once("error", died);
    child.once("exit", died);
    cleanup = () => {
      child.off("error", died);
      child.off("exit", died);
      observed.cleanup();
    };
  });
  // Nothing awaits this promise once the race is over; without a catch its
  // late rejection would surface as an unhandled rejection.
  promise.catch(() => {});
  return { promise, cleanup };
}

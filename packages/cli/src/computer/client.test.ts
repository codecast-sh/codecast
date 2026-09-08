/**
 * The client's lifetime machinery, against a fake helper that speaks the real
 * protocol (__fixtures__/fakeHelper.ts).
 *
 * Each test pins a failure the design names: a restarted helper answering an
 * older queue, a helper from the previous release still alive on its idle
 * timer, a token that does not belong to this launch, a busy helper being
 * killed by an impatient agent, and two invocations racing to launch.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ComputerClient, normalizeActionResult } from "./client.js";
import { ComputerError } from "./errors.js";
import { readInstance, writeInstance } from "./instance.js";
import type { ComputerActionResult } from "./types.js";

const FAKE_HELPER = path.join(import.meta.dir, "__fixtures__", "fakeHelper.ts");

/**
 * Every test in the first group launches a real process and allows it an 8 s
 * connect budget, which does not fit inside bun's 5 s default per test: on a
 * busy machine two or three of them went red for the cold start of the fake
 * helper rather than for anything they assert. They run on a budget that
 * matches what they wait for.
 */
const HELPER_LAUNCH_TIMEOUT_MS = 30_000;
const helperTest = (name: string, body: () => void | Promise<void>) => test(name, body, HELPER_LAUNCH_TIMEOUT_MS);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/** Point CODECAST_DIR at a temp dir so nothing touches the real ~/.codecast. */
function isolatedHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-computer-test-"));
  const prev = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
  cleanups.push(() => {
    if (prev === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function withEnv(vars: Record<string, string>): void {
  const previous = Object.entries(vars).map(([k, v]) => {
    const old = process.env[k];
    process.env[k] = v;
    return [k, old] as const;
  });
  cleanups.push(() => {
    for (const [k, old] of previous) {
      if (old === undefined) delete process.env[k];
      else process.env[k] = old;
    }
  });
}

function makeClient(overrides: Partial<ConstructorParameters<typeof ComputerClient>[0]> = {}): ComputerClient {
  const client = new ComputerClient({
    version: "1.0.0",
    patienceMs: 500,
    connectTimeoutMs: 8_000,
    // No browser instance file in a temp home, so the raise stamp is a no-op;
    // it is asserted on its own in focusSentinel.test.ts.
    stampRaise: () => {},
    helperLaunch: (socketPath, tokenPath) => ({
      cmd: process.execPath,
      args: [FAKE_HELPER, "--agent", socketPath, "--token-file", tokenPath],
    }),
    ...overrides,
  });
  cleanups.push(() => {
    const state = readInstance();
    client.shutdown();
    if (state?.pid) {
      try {
        process.kill(state.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      fs.rmSync(state.socketDir, { recursive: true, force: true });
    }
  });
  return client;
}

describe("ComputerClient", () => {
  helperTest("launches a helper, records it, and destroys the token file once connected", async () => {
    isolatedHome();
    const client = makeClient();
    const caps = await client.capabilities();
    expect(caps.protocolVersion).toBe(1);
    expect(caps.providerVersion).toBe("1.0.0");

    const state = readInstance();
    expect(state).not.toBeNull();
    expect(state!.token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(state!.socketPath).mode & 0o777).toBeLessThanOrEqual(0o600);
    // The token lives only in memory and in instance.json at 0600 after the
    // connect; leaving the file on disk would widen the window a local process
    // has to read it.
    expect(fs.existsSync(path.join(state!.socketDir, "helper.token"))).toBe(false);
    expect(fs.statSync(state!.socketDir).mode & 0o777).toBe(0o700);
  });

  helperTest("a second client reuses the running helper instead of launching another", async () => {
    const home = isolatedHome();
    const log = path.join(home, "launches.log");
    withEnv({ FAKE_LAUNCH_LOG: log });

    const first = makeClient();
    await first.capabilities();
    first.shutdown();

    const second = makeClient();
    const result = (await second.listApps()) as unknown as { helperPid: number };
    expect(result.helperPid).toBe(readInstance()!.pid);
    expect(fs.readFileSync(log, "utf-8").trim().split("\n")).toHaveLength(1);
  });

  helperTest("a helper that dies mid-session is re-handshaken, not talked to as a stranger", async () => {
    // Found by A7's granted e2e on a real Mac (ct-49523). The helper's identity
    // check lives in the handshake: it learns which binary may drive it from
    // the `castBinary` that request carries, and remembers it per process. So a
    // reconnect that skips the handshake is refused by the fresh helper with
    // `permission_denied: computer agent peer is not authorized` — a message
    // that sends whoever reads it to System Settings, when the grant is fine
    // and the connection is what broke. `shutdown()` already clears the cached
    // capabilities for exactly this reason; an unexpected close must too.
    const home = isolatedHome();
    const log = path.join(home, "launches.log");
    withEnv({ FAKE_LAUNCH_LOG: log, FAKE_REQUIRE_HANDSHAKE: "1" });

    const client = makeClient();
    const first = (await client.listApps()) as unknown as { helperPid: number };
    expect(first.helperPid).toBe(readInstance()!.pid);

    // The helper dies under the client, the way a crash or a reap does.
    process.kill(readInstance()!.pid, "SIGKILL");
    await Bun.sleep(200);

    const second = (await client.listApps()) as unknown as { helperPid: number };
    expect(second.helperPid).not.toBe(first.helperPid);
    expect(fs.readFileSync(log, "utf-8").trim().split("\n")).toHaveLength(2);
  });

  helperTest("two invocations racing to launch produce one helper", async () => {
    const home = isolatedHome();
    const log = path.join(home, "launches.log");
    withEnv({ FAKE_LAUNCH_LOG: log });

    const clients = [makeClient(), makeClient()];
    await Promise.all(clients.map((c) => c.capabilities()));
    expect(fs.readFileSync(log, "utf-8").trim().split("\n")).toHaveLength(1);
  });

  helperTest("a helper from another release is terminated and relaunched, not reused", async () => {
    const home = isolatedHome();
    const log = path.join(home, "launches.log");
    // The first launch answers as the previous release; the relaunch answers
    // as this one, which is the post-update case in design 3.3.
    withEnv({ FAKE_LAUNCH_LOG: log, FAKE_VERSION_SEQUENCE: "0.9.0,1.0.0" });

    const client = makeClient();
    const caps = await client.capabilities();
    expect(caps.providerVersion).toBe("1.0.0");
    const launches = fs.readFileSync(log, "utf-8").trim().split("\n");
    expect(launches).toHaveLength(2);
    // The old helper is gone: reusing it would mean driving last release's
    // renderer through this release's client.
    expect(isAlive(Number(launches[0]))).toBe(false);
    expect(readInstance()!.pid).toBe(Number(launches[1]));
  });

  helperTest("with no version claimed, a helper of any version is reused", async () => {
    // Why: a CLI that carries no embedded helper adopts whatever is installed
    // at the fixed path, so it has no release identity to hold that bundle to.
    // Claiming one anyway would terminate a working helper and relaunch the
    // very same bundle, which reports the very same version — a refusal loop
    // rather than a mismatch (ct-49672). The protocol check below is the real
    // compatibility gate and is unconditional either way.
    const home = isolatedHome();
    const log = path.join(home, "launches.log");
    withEnv({ FAKE_LAUNCH_LOG: log, FAKE_VERSION_SEQUENCE: "0.9.0,1.0.0" });

    const client = makeClient({ version: undefined });
    const caps = await client.capabilities();
    expect(caps.providerVersion).toBe("0.9.0");
    expect(fs.readFileSync(log, "utf-8").trim().split("\n")).toHaveLength(1);
  });

  helperTest("a helper on another protocol version fails as provider_incompatible", async () => {
    isolatedHome();
    withEnv({ FAKE_PROTOCOL_VERSION: "7" });
    const client = makeClient();
    const err = await client.capabilities().catch((e) => e);
    expect(err).toBeInstanceOf(ComputerError);
    expect((err as ComputerError).code).toBe("provider_incompatible");
  });

  helperTest("a helper error keeps its code and carries the recovery", async () => {
    isolatedHome();
    withEnv({
      FAKE_ERROR_METHODS: JSON.stringify({
        getAppState: { code: "element_not_found", message: "element 42 is stale; run get-app-state again and use a fresh element index" },
      }),
    });
    const client = makeClient();
    const err = (await client.getAppState({ app: "com.apple.TextEdit" }).catch((e) => e)) as ComputerError;
    expect(err.code).toBe("element_not_found");
    expect(err.toJSON().recovery[0]).toContain("get-app-state");
  });

  helperTest("a code this CLI does not know reads as accessibility_error, not as success", async () => {
    isolatedHome();
    withEnv({ FAKE_ERROR_METHODS: JSON.stringify({ listApps: { code: "quantum_flux", message: "something new" } }) });
    const client = makeClient();
    const err = (await client.listApps().catch((e) => e)) as ComputerError;
    expect(err.code).toBe("accessibility_error");
    expect(err.message).toContain("quantum_flux");
  });

  helperTest("a request carrying the wrong token is refused", async () => {
    isolatedHome();
    const client = makeClient();
    await client.capabilities();
    client.shutdown();
    // A token from another launch is exactly what a stale instance.json holds.
    writeInstance({ ...readInstance()!, token: "f".repeat(64) });

    const other = makeClient();
    const err = (await other.listApps().catch((e) => e)) as ComputerError;
    expect(err.code).toBe("permission_denied");
    expect(err.message).toContain("token");
  });

  helperTest("a timed-out request invalidates the queue behind it", async () => {
    isolatedHome();
    withEnv({ FAKE_HANG_METHODS: "listApps" });
    const client = makeClient({ requestTimeoutMs: 400 });

    const failure = (p: Promise<unknown>) => p.then(() => null, (e) => e as ComputerError);
    const [a, b] = await Promise.all([failure(client.listApps()), failure(client.listWindows({ app: "x" }))]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    expect(a!.code).toBe("action_timeout");
    // The second request was enqueued against a helper the timeout shut down.
    // Answering it from a replacement is the bug the generation counter
    // exists to prevent, so it is refused with a retryable message.
    expect(b!.code).toBe("accessibility_error");
    expect(b!.message).toContain("invalidated");
  });

  helperTest("a busy helper is reported busy, never killed", async () => {
    isolatedHome();
    // A live pid (this process) with a socket that answers nothing is exactly
    // what an overloaded helper looks like from outside.
    writeInstance({
      pid: process.pid,
      socketPath: path.join(os.tmpdir(), `codecast-computer-missing-${process.pid}.sock`),
      socketDir: os.tmpdir(),
      token: "a".repeat(64),
      helperPath: "/nowhere",
      protocolVersion: 1,
      startedAt: Date.now(),
    });
    const client = makeClient();
    const err = (await client.listApps().catch((e) => e)) as ComputerError;
    expect(err.code).toBe("action_timeout");
    expect(err.message).toContain("busy");
    // Still recorded: nothing killed it and nothing forgot it.
    expect(readInstance()?.pid).toBe(process.pid);
  });

  helperTest("a helper that dies on launch fails with its exit, not with a timeout", async () => {
    isolatedHome();
    withEnv({ FAKE_EXIT_BEFORE_BIND: "3" });
    const client = makeClient({ connectTimeoutMs: 30_000 });
    const err = (await client.capabilities().catch((e) => e)) as ComputerError;
    expect(err.code).toBe("accessibility_error");
    expect(err.message).toContain("code 3");
  });

  helperTest("terminate stops the helper and forgets it", async () => {
    isolatedHome();
    const client = makeClient();
    await client.capabilities();
    const pid = readInstance()!.pid;
    await client.terminate();
    expect(readInstance()).toBeNull();
    expect(isAlive(pid)).toBe(false);
  });

  helperTest("--restore-window stamps the deliberate raise before the request goes out", async () => {
    isolatedHome();
    const order: string[] = [];
    const client = makeClient({
      stampRaise: () => order.push("stamped"),
      helperLaunch: (socketPath, tokenPath) => ({
        cmd: process.execPath,
        args: [FAKE_HELPER, "--agent", socketPath, "--token-file", tokenPath],
      }),
    });
    await client.getAppState({ app: "com.apple.TextEdit", restoreWindow: true });
    expect(order).toEqual(["stamped"]);

    order.length = 0;
    await client.getAppState({ app: "com.apple.TextEdit" });
    expect(order).toEqual([]);
  });
});

describe("normalizeActionResult", () => {
  const base = { snapshot: {}, screenshot: null, screenshotStatus: { state: "skipped", reason: "no_screenshot_flag" } } as unknown as ComputerActionResult;

  test("fills a missing verification from the action path", () => {
    for (const [pathName, reason] of [
      ["synthetic", "synthetic_input"],
      ["clipboard", "clipboard_paste"],
      ["accessibility", "accessibility_action_unasserted"],
    ] as const) {
      const out = normalizeActionResult({ ...base, action: { path: pathName } });
      expect(out.action?.verification).toEqual({ state: "unverified", reason });
    }
  });

  test("leaves a verification the helper already reported", () => {
    const verification = { state: "verified", property: "value" } as const;
    const out = normalizeActionResult({ ...base, action: { path: "accessibility", verification } });
    expect(out.action?.verification).toBe(verification);
  });

  test("a result with no action is returned untouched", () => {
    expect(normalizeActionResult(base)).toBe(base);
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

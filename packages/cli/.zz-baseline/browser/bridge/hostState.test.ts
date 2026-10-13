import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isolateCodecastDir, type IsolatedCodecastDir } from "../../test-helpers/codecastDir.js";
import * as http from "node:http";
import { bridgeStatePath, ensureBridgeHost, readBridgeState, startBridgeHost, updateBridgeHostState, writeBridgeState, type RunningHost } from "./host.js";
import { BRIDGE_PROTOCOL, bridgeProof } from "./protocol.js";
import { freePort } from "../instance.js";

let isolation: IsolatedCodecastDir;
const owner = { port: 41729, token: "original-token", hostPid: 12345 };

beforeEach(() => { isolation = isolateCodecastDir("bridge-owner-test-"); });
afterEach(() => { isolation.restore(); });

test("the owning host updates connection and tab state without replacing pairing", () => {
  writeBridgeState({ ...owner, startedAt: 1 });
  expect(updateBridgeHostState(owner, { extensionConnected: true, extensionSeenAt: 2 })).toBe(true);
  expect(updateBridgeHostState(owner, { sessionTabs: { agent: [{ tabId: 7, url: "https://example.com" }] } })).toBe(true);
  expect(readBridgeState()).toEqual({ ...owner, startedAt: 1, extensionConnected: true, extensionSeenAt: 2, sessionTabs: { agent: [{ tabId: 7, url: "https://example.com" }] } });
});

for (const replacement of [{ ...owner, port: 61544 }, { ...owner, token: "new-token" }, { ...owner, hostPid: 54321 }]) {
  test(`an old host cannot overwrite a replacement with ${JSON.stringify(replacement)}`, () => {
    const current = { ...replacement, extensionConnected: true, extensionSeenAt: 10, sessionTabs: { other: [{ tabId: 8, url: "https://other.example" }] } };
    writeBridgeState(current);
    expect(updateBridgeHostState(owner, { extensionConnected: false, extensionSeenAt: 1, sessionTabs: {} })).toBe(false);
    expect(readBridgeState()).toEqual(current);
  });
}

test("an old host cannot recreate a removed configuration", () => {
  fs.rmSync(bridgeStatePath(), { force: true });
  expect(updateBridgeHostState(owner, { extensionConnected: false })).toBe(false);
  expect(readBridgeState()).toBeNull();
});

test("a real host shutting down leaves its replacement configuration intact", async () => {
  writeBridgeState({ port: await freePort(), token: owner.token });
  const child = Bun.spawn([process.execPath, "--eval", `import { runBridgeHost } from ${JSON.stringify(path.join(import.meta.dir, "host.ts"))}; await runBridgeHost();`], {
    env: { ...process.env, CODECAST_DIR: isolation.dir },
    stdout: "ignore",
    stderr: Bun.file(path.join(isolation.dir, "host.log")),
  });
  try {
    await ensureBridgeHost(() => {});
    const replacement = { ...owner, port: await freePort(), extensionConnected: true, extensionSeenAt: 99 };
    writeBridgeState(replacement);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(readBridgeState()).toEqual(replacement);
    expect(fs.readFileSync(path.join(isolation.dir, "host.log"), "utf8")).toContain(`[host ${child.pid} port `);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}, 30_000);

test("a host that is slow to answer is waited for, never doubled", async () => {
  // The bridge port answers /healthz correctly, but only after 2.5s — a host
  // whose event loop is starved. The first 1.2s probe times out; the patient
  // probe keeps asking; no second host is started against the port.
  const port = await freePort();
  writeBridgeState({ port, token: owner.token });
  const slow = http.createServer((req, res) => {
    const nonce = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("nonce") ?? "";
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`cast-bridge protocol=${BRIDGE_PROTOCOL} proof=${bridgeProof(owner.token, "healthz", nonce)}`);
    }, 2_500);
  });
  await new Promise<void>((r) => slow.listen(port, "127.0.0.1", r));
  let starts = 0;
  try {
    const bridge = await ensureBridgeHost(() => {
      starts += 1;
    });
    expect(bridge.started).toBe(false);
    expect(bridge.port).toBe(port);
    expect(starts).toBe(0);
  } finally {
    slow.closeAllConnections?.();
    slow.close();
  }
}, 20_000);

test("a bridge host of ours holding another token is stopped and replaced, never reported", async () => {
  // A host left behind by a config this machine no longer has: our program,
  // our port, the wrong token. The impostor probe finds it; the pid lookup
  // says it is ours; it is stopped and a host with the current token started.
  const port = await freePort();
  writeBridgeState({ port, token: owner.token });
  let stale: RunningHost | null = await startBridgeHost({ port, token: "some-other-token" });
  const killed: number[] = [];
  let started: RunningHost | null = null;
  try {
    const bridge = await ensureBridgeHost(
      async (state) => {
        started = await startBridgeHost({ port: state.port, token: state.token });
      },
      {
        staleHostPids: () => [4242],
        kill: (pid) => {
          killed.push(pid);
          void stale?.close();
          stale = null;
        },
      },
    );
    expect(killed).toEqual([4242]);
    expect(bridge.started).toBe(true);
    expect(bridge.port).toBe(port);
  } finally {
    await (stale as RunningHost | null)?.close();
    await (started as RunningHost | null)?.close();
  }
}, 20_000);

test("a server on the port that is not ours is named, not stopped", async () => {
  const port = await freePort();
  writeBridgeState({ port, token: owner.token });
  const squatter = await startBridgeHost({ port, token: "squatter" });
  const killed: number[] = [];
  try {
    await expect(ensureBridgeHost(() => {}, { staleHostPids: () => [], kill: (pid) => killed.push(pid) })).rejects.toThrow(/cannot prove it holds the token/);
    expect(killed).toEqual([]);
  } finally {
    await squatter.close();
  }
});

test("a host that binds at once but answers late after a start is waited for", async () => {
  // The started host takes 4 s to answer its first probe: a bun parsing the
  // CLI on a loaded machine. The old 500 ms probes read that as down for the
  // whole budget; each probe now gets seconds, so a late answer counts.
  const port = await freePort();
  writeBridgeState({ port, token: owner.token });
  let slow: http.Server | null = null;
  try {
    const bridge = await ensureBridgeHost(async () => {
      slow = http.createServer((req, res) => {
        const nonce = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("nonce") ?? "";
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(`cast-bridge protocol=${BRIDGE_PROTOCOL} proof=${bridgeProof(owner.token, "healthz", nonce)}`);
        }, 2_000);
      });
      await new Promise<void>((r) => slow!.listen(port, "127.0.0.1", r));
    });
    expect(bridge.started).toBe(true);
  } finally {
    (slow as http.Server | null)?.closeAllConnections?.();
    (slow as http.Server | null)?.close();
  }
}, 40_000);

import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isolateCodecastDir, type IsolatedCodecastDir } from "../../test-helpers/codecastDir.js";
import { bridgeStatePath, ensureBridgeHost, readBridgeState, updateBridgeHostState, writeBridgeState } from "./host.js";
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

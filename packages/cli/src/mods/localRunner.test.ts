import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mods-runner-"));
process.env.CODECAST_DIR = dir;
const { localHash, setRevoked, startLocalMods } = await import("./localRunner.js");
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function runOnce(mods: unknown[]): Promise<string[]> {
  const started: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => new Response(JSON.stringify(String(url).endsWith("/cli/mods/local") ? { mods } : { calls: [] }))) as any;
  const runner = startLocalMods({ endpoint: () => ({ siteUrl: "https://x.test", apiToken: "t" }), log: (m) => { if (m.startsWith("[MODS] started")) started.push(m); } });
  await new Promise((r) => setTimeout(r, 300));
  runner.stop();
  globalThis.fetch = realFetch;
  return started;
}

describe("the local runner runs your enabled mods unless revoked here", () => {
  const code = `onmessage = () => {}; postMessage({ type: "ready", hooks: [] });`;

  test("an enabled mod starts with no approval step", async () => {
    const started = await runOnce([{ id: "y", name: "m2", rev: 1, enabled: true, local_code: code, manifest: {} }]);
    expect(started.length).toBe(1);
    expect(started[0]).toContain(localHash(code));
  });

  test("a mod revoked on this machine does not start, and approve brings it back", async () => {
    const mods = [{ id: "x", name: "m1", rev: 1, enabled: true, local_code: code, manifest: {} }];
    setRevoked("m1", true);
    expect(await runOnce(mods)).toEqual([]);
    setRevoked("m1", false);
    expect((await runOnce(mods)).length).toBe(1);
  });

  test("a mod turned off does not start", async () => {
    expect(await runOnce([{ id: "z", name: "m4", rev: 1, enabled: false, local_code: code, manifest: {} }])).toEqual([]);
  });
});

describe("fleet events reach the local halves that hook them", () => {
  test("a session transition from `cast sessions -w --json` arrives as session.state", async () => {
    const fakeCast = path.join(dir, "fake-cast.sh");
    fs.writeFileSync(fakeCast, `#!/bin/sh\necho '{"event":"transition","id":"jx7aaaa","from":"working","to":"needs_input","title":"Fix auth"}'\nsleep 5\n`, { mode: 0o755 });
    const code = `onmessage = (e) => {
      const m = e.data;
      if (m.type === "init") postMessage({ type: "ready", hooks: [{ event: "session.state" }] });
      if (m.type === "event") postMessage({ type: "log", level: "log", text: "heard " + m.payload.id + " " + m.payload.from + "->" + m.payload.to });
    };`;
    const mods = [{ id: "z", name: "m3", rev: 1, enabled: true, local_code: code, manifest: {} }];
    const logged: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: any) => {
      if (String(url).endsWith("/cli/mods/log")) for (const e of JSON.parse(init.body).entries) logged.push(e.text);
      return new Response(JSON.stringify(String(url).endsWith("/cli/mods/local") ? { mods } : { calls: [] }));
    }) as any;
    const runner = startLocalMods({ endpoint: () => ({ siteUrl: "https://x.test", apiToken: "t" }), log: () => {}, castBin: fakeCast });
    await new Promise((r) => setTimeout(r, 4000));
    runner.stop();
    await new Promise((r) => setTimeout(r, 100));
    globalThis.fetch = realFetch;
    expect(logged).toContain("heard jx7aaaa working->needs_input");
  }, 15_000);
});

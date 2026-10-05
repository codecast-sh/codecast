import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mods-runner-"));
process.env.CODECAST_DIR = dir;
const { localHash, startLocalMods, writeApproval } = await import("./localRunner.js");
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the local runner runs only approved code", () => {
  test("an approval names the code itself: new code under an approved label does not run", async () => {
    const approved = `postMessage({ type: "ready", hooks: [] });`;
    const swapped = `postMessage({ type: "ready", hooks: [] }); /* changed */`;
    writeApproval("m1", localHash(approved));
    // The server claims the swapped code still has the approved hash; the runner must not believe it.
    const mods = [{ id: "x", name: "m1", rev: 2, enabled: true, local_hash: localHash(approved), local_code: swapped, manifest: {} }];
    const started: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => new Response(JSON.stringify(String(url).endsWith("/cli/mods/local") ? { mods } : { calls: [] }))) as any;
    const runner = startLocalMods({ endpoint: () => ({ siteUrl: "https://x.test", apiToken: "t" }), log: (m) => { if (m.startsWith("[MODS] started")) started.push(m); } });
    await new Promise((r) => setTimeout(r, 300));
    runner.stop();
    globalThis.fetch = realFetch;
    expect(started).toEqual([]);
    expect(fs.existsSync(path.join(dir, "mods", "run"))).toBe(false);
  });

  test("the approved code itself starts", async () => {
    const code = `onmessage = () => {}; postMessage({ type: "ready", hooks: [] });`;
    writeApproval("m2", localHash(code));
    const mods = [{ id: "y", name: "m2", rev: 1, enabled: true, local_code: code, manifest: {} }];
    const started: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => new Response(JSON.stringify(String(url).endsWith("/cli/mods/local") ? { mods } : { calls: [] }))) as any;
    const runner = startLocalMods({ endpoint: () => ({ siteUrl: "https://x.test", apiToken: "t" }), log: (m) => { if (m.startsWith("[MODS] started")) started.push(m); } });
    await new Promise((r) => setTimeout(r, 300));
    runner.stop();
    globalThis.fetch = realFetch;
    expect(started.length).toBe(1);
    expect(started[0]).toContain(localHash(code));
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
    writeApproval("m3", localHash(code));
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

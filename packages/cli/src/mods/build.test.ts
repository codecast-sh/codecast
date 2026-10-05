// End to end below the browser: the real builder bundles a mod with the SDK,
// the bundle runs in a VM standing in for the sandboxed iframe, and the test
// plays the host's side of the protocol (shared/contracts/mods.ts).

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { buildMod } from "./build.js";
import { scaffoldFiles } from "./scaffold.js";
import type { FrameToHost, HostToFrame } from "@codecast/shared/contracts/mods";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function writeMod(name: string, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mod-test-"));
  dirs.push(dir);
  for (const [f, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), t);
  }
  return dir;
}

/** Runs a bundle the way mod-host.js does and answers its calls with `answer`. */
function runFrame(code: string, manifest: unknown, answer: (method: string, args: unknown[]) => unknown) {
  const out: FrameToHost[] = [];
  const listeners: ((ev: any) => void)[] = [];
  const parent: any = {
    postMessage(msg: FrameToHost) {
      out.push(msg);
      if (msg.type === "call") {
        let reply: HostToFrame;
        try { reply = { type: "reply", cid: msg.cid, ok: true, value: answer(msg.method, msg.args) }; }
        catch (err) { reply = { type: "reply", cid: msg.cid, ok: false, error: (err as Error).message }; }
        queueMicrotask(() => send(reply));
      }
    },
  };
  const send = (msg: HostToFrame) => { for (const l of listeners) l({ source: parent, data: msg }); };
  const context: any = {
    parent,
    console: { log() {}, warn() {}, error() {} },
    addEventListener: (type: string, fn: (ev: any) => void) => { if (type === "message") listeners.push(fn); },
    queueMicrotask, setTimeout, clearTimeout, fetch,
    __modLoad: { type: "load", proto: 1, mod: { id: "m1", name: "t", manifest, context: { user: null, team: null, surface: "web", theme: "dark" } }, code },
  };
  context.globalThis = context;
  vm.runInNewContext(code, context);
  const next = async (pred: (m: FrameToHost) => boolean, ms = 3000): Promise<FrameToHost> => {
    const start = Date.now();
    for (;;) {
      const hit = out.find(pred);
      if (hit) { out.splice(out.indexOf(hit), 1); return hit; }
      if (Date.now() - start > ms) throw new Error(`timed out; saw ${JSON.stringify(out.map((m) => m.type))}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { send, next, out };
}

describe("cast mod build + the frame protocol", () => {
  test("the scaffold builds, renders its pane with live data, and runs its handlers and command", async () => {
    const dir = writeMod("fleet-pulse", scaffoldFiles("fleet-pulse"));
    const build = await buildMod(dir);
    if (!build.ok) throw new Error(build.errors.join("\n"));
    expect(build.inspection.hooks).toContain("ui.render{pane:main}");
    expect(build.inspection.reads).toEqual(["sessions"]);
    expect(build.inspection.missing).toEqual([]);

    const calls: string[] = [];
    const frame = runFrame(build.code, build.manifest, (method, args) => {
      calls.push(method);
      if (method === "data.list") return [{ _id: "s1", title: "Fix auth", state: "needs_input", updated_at: 1, agent_type: "claude" }, { _id: "s2", state: "working" }];
      if (method === "tasks.create") return { id: "ct-9" };
      return null;
    });
    const ready = await frame.next((m) => m.type === "ready");
    expect((ready as any).hooks.map((h: any) => h.event).sort()).toEqual(["command.run", "ui.render", "ui.render"]);

    frame.send({ type: "render", rid: "r1", key: "pane:main@x", surface: { kind: "pane", id: "main" } });
    const rendered = (await frame.next((m) => m.type === "rendered")) as Extract<FrameToHost, { type: "rendered" }>;
    expect(rendered.error).toBeUndefined();
    const json = JSON.stringify(rendered.tree);
    expect(json).toContain('"t":"Stat"');
    expect(json).toContain('"label":"Needs you","value":1');
    expect(json).toContain('"t":"Table"');
    // Handlers leave the frame as ids, never as code, including inside an element passed as a prop.
    const ids = [...json.matchAll(/"\$fn":"([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBe(2);
    expect(ids.every((id) => id.startsWith("pane:main@x#"))).toBe(true);
    const tree = rendered.tree as any;
    const card = JSON.stringify(tree.c.find((n: any) => n.t === "Card"));
    const fn = card.match(/"actions":\{"t":"Button".*?"\$fn":"([^"]+)"/)![1];

    frame.send({ type: "invoke", rid: "d1", fn, args: [] });
    const done = (await frame.next((m) => m.type === "done" && (m as any).rid === "d1")) as any;
    expect(done.error).toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toContain("tasks.create");

    frame.send({ type: "command", rid: "d2", id: "open" });
    await frame.next((m) => m.type === "done" && (m as any).rid === "d2");
    expect(calls).toContain("ui.open");
  });

  test("a fence renders from its code, and a render that throws reports the error instead of a tree", async () => {
    const dir = writeMod("t", {
      "codecast-mod.json": JSON.stringify({ name: "fence-test", fences: [{ lang: "shout" }], panes: [{ id: "boom", title: "Boom" }] }),
      "ui.tsx": `import { h, Text } from "codecast-mod";
export function register(on: any) {
  on("ui.render", { fence: "shout" }, async ($: any, e: any) => <Text weight="bold">{e.props.code.toUpperCase()}</Text>);
  on("ui.render", { pane: "boom" }, async () => { throw new Error("kaboom"); });
}`,
    });
    const build = await buildMod(dir);
    if (!build.ok) throw new Error(build.errors.join("\n"));
    const frame = runFrame(build.code, build.manifest, () => null);
    await frame.next((m) => m.type === "ready");
    frame.send({ type: "render", rid: "r1", key: "fence:shout@1", surface: { kind: "fence", id: "shout", props: { code: "hello" } } });
    const r1 = (await frame.next((m) => m.type === "rendered")) as any;
    expect(r1.tree).toEqual({ t: "Text", p: { weight: "bold" }, c: ["HELLO"] });
    frame.send({ type: "render", rid: "r2", key: "pane:boom@1", surface: { kind: "pane", id: "boom" } });
    const r2 = (await frame.next((m) => m.type === "rendered")) as any;
    expect(r2.error).toContain("kaboom");
    expect(r2.tree).toBeUndefined();
  });

  test("the build refuses code that needs a grant the manifest does not give", async () => {
    const dir = writeMod("t", {
      "codecast-mod.json": JSON.stringify({ name: "greedy", panes: [{ id: "main", title: "Main" }] }),
      "ui.tsx": `export function register(on: any) { on("ui.render", { pane: "main" }, async ($: any) => { await $.data.list("tasks"); await $.sessions.send("x", "hi"); return null; }); }`,
    });
    const build = await buildMod(dir);
    expect(build.ok).toBe(false);
    if (!build.ok) {
      expect(build.errors.join("\n")).toContain('permissions.read "tasks"');
      expect(build.errors.join("\n")).toContain('permissions.write "sessions"');
    }
  });

  test("a manifest with an unknown key or a reserved fence is refused with the reason", async () => {
    const dir = writeMod("t", {
      "codecast-mod.json": JSON.stringify({ name: "bad", fences: [{ lang: "mermaid" }], pains: [] }),
      "ui.tsx": "export function register() {}",
    });
    const build = await buildMod(dir);
    expect(build.ok).toBe(false);
    if (!build.ok) {
      expect(build.errors.join("\n")).toContain('unknown key "pains"');
      expect(build.errors.join("\n")).toContain("mermaid");
    }
  });
});

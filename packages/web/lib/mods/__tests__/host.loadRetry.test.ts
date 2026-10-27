import { afterAll, describe, expect, it } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

// A slow load is not a verdict on the mod. On a loaded machine the 20s load
// timeout fires often, and a mod that stayed failed after it left every one of
// its object ids (contact-4108ba04) drawn raw until the window reloaded.

const dom = new JSDOM("<!doctype html><div id='c'></div>", { url: "https://codecast.test/" });
const restore = replaceGlobals({ window: dom.window, document: dom.window.document });
const { ModRuntime, modLoadTiming } = await import("../host");
// The retry waits far longer than the load timeout, so a busy test machine
// stalling the event loop cannot fire both before the test looks.
Object.assign(modLoadTiming, { timeout: 30, retryBase: 300, retryMax: 600 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean) => {
  for (const end = Date.now() + 2000; !ok(); await sleep(5)) if (Date.now() > end) throw new Error("timed out waiting");
};
const container = () => dom.window.document.getElementById("c")!;
const frames = () => [...container().querySelectorAll("iframe")];
const fromFrame = (frame: HTMLIFrameElement, data: unknown) =>
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, source: (frame as any).contentWindow }));
const row = (name: string): any => ({ _id: name, name, manifest: { name, permissions: {} }, code: "", rev: 1, version: 0, enabled: true, is_mine: true, updated_at: 1 });

const runtimes: InstanceType<typeof ModRuntime>[] = [];
afterAll(() => { runtimes.forEach((r) => r.dispose()); restore(); });

describe("mod load timeout", () => {
  it("a frame whose page never booted is mounted again and comes up", async () => {
    container().innerHTML = "";
    const rt = new ModRuntime(row("a"), container());
    runtimes.push(rt);
    const first = frames()[0];
    await until(() => rt.status !== "loading");
    expect(rt.status).toBe("failed");
    expect(frames()).toHaveLength(0);
    await until(() => rt.status !== "failed");
    expect(rt.status).toBe("loading");
    const second = frames()[0];
    expect(second).not.toBe(first);
    fromFrame(second, { type: "booted" });
    fromFrame(second, { type: "ready", hooks: [{ event: "object.resolve" }] });
    expect(rt.status).toBe("ready");
    expect(rt.error).toBeNull();
  });

  it("a frame still running register() is kept, and a late ready recovers it", async () => {
    container().innerHTML = "";
    const rt = new ModRuntime(row("b"), container());
    runtimes.push(rt);
    const frame = frames()[0];
    fromFrame(frame, { type: "booted" });
    await until(() => rt.status !== "loading");
    expect(rt.status).toBe("failed");
    expect(frames()).toEqual([frame]);
    const statuses: string[] = [];
    rt.onStatus(() => statuses.push(rt.status));
    fromFrame(frame, { type: "ready", hooks: [] });
    expect(rt.status).toBe("ready");
    expect(statuses).toEqual(["ready"]);
  });

  it("a mod whose register() threw stays failed", async () => {
    container().innerHTML = "";
    const rt = new ModRuntime(row("c"), container());
    runtimes.push(rt);
    const frame = frames()[0];
    fromFrame(frame, { type: "booted" });
    fromFrame(frame, { type: "load-failed", error: "boom" });
    await sleep(100);
    expect(rt.status).toBe("failed");
    expect(frames()).toEqual([frame]);
  });
});

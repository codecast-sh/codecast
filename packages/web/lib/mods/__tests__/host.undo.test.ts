import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { JSDOM } from "jsdom";
import { _resetUndoStacks, canUndo } from "@platform/engine";
import { replaceGlobals } from "../../../test-helpers/globals";

// A mod's writes from its event hooks are automation: they must not land on
// the person's undo stack (docs/architecture/undo-history.md section 4). The
// same write answering the person's click in a mod pane stays undoable. The
// runtime is driven through its real message protocol, with jsdom standing in
// for the page and the test playing the sandboxed frame.

const dom = new JSDOM("<!doctype html><div id='c'></div>", { url: "https://codecast.test/m/t/main" });
const restore = replaceGlobals({ window: dom.window, document: dom.window.document });
const { useInboxStore } = await import("../../../store/inboxStore");
const { ModRuntime } = await import("../host");

const A = "a".repeat(32);
const s = () => useInboxStore.getState() as any;
const owner = {};
const flush = () => new Promise((r) => setTimeout(r, 0));

let rt: InstanceType<typeof ModRuntime>;
let frameWin: any;
const fromFrame = (data: unknown) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, source: frameWin }));

beforeAll(async () => {
  s()._setDispatch(async () => null, { owner });
  const row: any = { _id: "mod1", name: "t", manifest: { name: "t", permissions: { read: ["tasks"], write: ["tasks"] } }, code: "", rev: 1, version: 0, enabled: true, is_mine: true, updated_at: 1 };
  rt = new ModRuntime(row, dom.window.document.getElementById("c")!);
  frameWin = (dom.window.document.querySelector("iframe") as any).contentWindow;
  fromFrame({ type: "ready", hooks: [{ event: "session.state" }] });
  await flush();
});
afterAll(() => { rt.dispose(); s()._clearDispatch(owner); restore(); });
beforeEach(() => {
  _resetUndoStacks();
  useInboxStore.setState({ tasks: { [A]: { _id: A, short_id: "ct-1", title: "t", status: "open", priority: "medium", updated_at: 1 } }, pending: {} } as any);
});

describe("mod writes and the undo stack", () => {
  it("a write from an event hook is automation: nothing to undo", async () => {
    fromFrame({ type: "call", cid: "c1", method: "tasks.update", args: ["ct-1", { priority: "high" }], origin: "hook" });
    await flush();
    expect(s().tasks[A].priority).toBe("high");
    expect(canUndo()).toBe(false);
  });

  it("a write a pane makes while drawing, with no click waiting on it, is automation too", async () => {
    fromFrame({ type: "call", cid: "c2", key: "pane:main@x", method: "tasks.update", args: ["ct-1", { priority: "low" }], origin: "ui" });
    await flush();
    expect(s().tasks[A].priority).toBe("low");
    expect(canUndo()).toBe(false);
  });

  it("the same write answering the person's click stays undoable", async () => {
    const done = rt.invoke("pane:main@x#1.1", []);
    await flush();
    fromFrame({ type: "call", cid: "c3", key: "pane:main@x", method: "tasks.update", args: ["ct-1", { priority: "urgent" }], origin: "ui" });
    await flush();
    expect(s().tasks[A].priority).toBe("urgent");
    expect(canUndo()).toBe(true);
    // The frame finishes the click; later writes are automation again.
    const sent = (rt as any).dones as Map<string, unknown>;
    const rid = [...sent.keys()][0];
    fromFrame({ type: "done", rid });
    await done;
    expect(rt.isAutomated("ui")).toBe(true);
  });
});

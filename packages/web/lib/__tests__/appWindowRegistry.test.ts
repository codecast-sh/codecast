import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  announceAppWindow,
  appWindowPresence,
  installAppWindowRegistry,
  requestAppWindowOpen,
  resetAppWindowRegistryForTests,
  subscribeAppWindowPresence,
} from "../appWindowRegistry";

// Two windows of one profile, with no shell between them: bun's
// BroadcastChannel delivers between instances in one process, which is the
// same contract the browser gives two windows of one origin.

const originalWindow = (globalThis as any).window;
const tick = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {} };
  resetAppWindowRegistryForTests();
});
afterEach(() => {
  resetAppWindowRegistryForTests();
  (globalThis as any).window = originalWindow;
});

describe("app window registry", () => {
  it("an announced app is present here at once and reaches a second window as hello", async () => {
    const opened: (string | null)[] = [];
    installAppWindowRegistry((p) => opened.push(p));
    const other = new BroadcastChannel("codecast-app-windows");
    const heard: any[] = [];
    other.onmessage = (e) => heard.push(e.data);
    const changes: number[] = [];
    subscribeAppWindowPresence(() => changes.push(1));

    const release = announceAppWindow("chat");
    expect(appWindowPresence()).toEqual({ chat: true });
    expect(changes.length).toBe(1);
    await tick();
    expect(heard).toEqual([{ type: "hello", app: "chat" }]);

    // A path handed to this app lands in the onOpen the window registered.
    other.postMessage({ type: "open", app: "chat", path: "/chat/ch1" });
    other.postMessage({ type: "open", app: "work", path: "/tasks" });
    other.postMessage({ type: "open", app: "chat", path: null });
    await tick();
    expect(opened).toEqual(["/chat/ch1", null]);

    release();
    expect(appWindowPresence()).toEqual({ chat: false });
    await tick();
    expect(heard.at(-1)).toEqual({ type: "bye", app: "chat" });
    other.close();
  });

  it("a hello from another window makes it present here, and a request goes out only when someone is there", async () => {
    installAppWindowRegistry(() => {});
    const other = new BroadcastChannel("codecast-app-windows");
    const heard: any[] = [];
    other.onmessage = (e) => heard.push(e.data);
    expect(requestAppWindowOpen("work", "/tasks")).toBe(false);
    other.postMessage({ type: "hello", app: "work" });
    await tick();
    expect(appWindowPresence()).toEqual({ work: true });
    expect(requestAppWindowOpen("work", "/tasks/ct-1")).toBe(true);
    await tick();
    expect(heard).toEqual([{ type: "open", app: "work", path: "/tasks/ct-1" }]);
    other.postMessage({ type: "bye", app: "work" });
    await tick();
    expect(appWindowPresence()).toEqual({ work: false });
    expect(requestAppWindowOpen("work", "/tasks")).toBe(false);
    other.close();
  });

  it("a window that loses the lock race never answers to the app's name", async () => {
    // Two breakouts on an older shell both show chat. The lock manager hands
    // the lock to one; the other must apply nothing sent to "chat".
    let grants = 0;
    (globalThis as any).navigator = {
      locks: {
        request: async (_name: string, _opts: unknown, cb: (lock: unknown) => unknown) => cb(grants++ === 0 ? {} : null),
        query: async () => ({ held: [] }),
      },
    };
    const opened: (string | null)[] = [];
    installAppWindowRegistry((p) => opened.push(p));
    announceAppWindow("chat"); // the winner in another window, from this registry's point of view: grant 0
    resetAppWindowRegistryForTests();
    installAppWindowRegistry((p) => opened.push(p));
    announceAppWindow("chat"); // this window loses: grant 1 is null
    await tick();
    const other = new BroadcastChannel("codecast-app-windows");
    other.postMessage({ type: "open", app: "chat", path: "/chat/ch1" });
    await tick();
    expect(opened).toEqual([]);
    other.close();
    delete (globalThis as any).navigator;
  });

  it("ignores junk on the channel", async () => {
    installAppWindowRegistry(() => {});
    const other = new BroadcastChannel("codecast-app-windows");
    other.postMessage({ type: "hello", app: "__proto__" });
    other.postMessage("nonsense");
    other.postMessage({ type: "hello", app: "people" });
    await tick();
    expect(appWindowPresence()).toEqual({});
    other.close();
  });
});

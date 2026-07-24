import { test, expect, describe, mock } from "bun:test";
import { createRequire } from "node:module";

// Exercises the REAL electron preload (packages/electron/preload.js) under a
// mocked `electron` module. The bug this guards: a codecast:// deep link that
// arrives during cold start — before the page's React onDeepLink handler has
// mounted — used to hit a not-yet-registered listener and vanish, stranding the
// app on its restored last conversation. The preload now registers the IPC
// listener at load time (it runs before any page JS) and buffers anything that
// lands before the handler subscribes, replaying it on subscribe.

type LoadedPreload = {
  exposed: any;
  emit: (channel: string, url: string) => void;
  listenerCount: (channel: string) => number;
};

// Fresh module state per load: re-running preload's top-level rebuilds its
// buffer/handler, so cases can't leak deep links into one another.
function loadPreload(): LoadedPreload {
  const ipcListeners: Record<string, Array<(e: any, url: string) => void>> = {};
  let exposed: any = null;
  const electronMock = () => ({
    contextBridge: { exposeInMainWorld: (_name: string, api: any) => { exposed = api; } },
    ipcRenderer: {
      on: (ch: string, cb: (e: any, url: string) => void) => { (ipcListeners[ch] ||= []).push(cb); },
      invoke: () => Promise.resolve(),
      send: () => {},
    },
    webFrame: { setZoomFactor: () => {} },
  });
  const resolved = require.resolve("../../electron/preload.js");
  mock.module("electron", electronMock);
  // Under bun's isolated install layout, the preload resolves "electron" through
  // packages/electron/node_modules into the .bun store — a different path than
  // this file's resolution, which is where mock.module keys the mock. Register
  // it under the preload's resolution too, or the real electron (which exports
  // only its binary path outside an electron app) leaks through.
  try {
    mock.module(createRequire(resolved).resolve("electron"), electronMock);
  } catch {}
  delete require.cache[resolved];
  require(resolved);
  return {
    exposed,
    emit: (channel, url) => (ipcListeners[channel] || []).forEach((cb) => cb({}, url)),
    listenerCount: (channel) => (ipcListeners[channel] || []).length,
  };
}

describe("electron preload deep-link delivery", () => {
  test("registers the IPC listener at load, before any subscribe", () => {
    const p = loadPreload();
    // The listener must exist before the page calls onDeepLink — that's what
    // makes a cold-start send land in the buffer instead of the void.
    expect(p.listenerCount("deep-link")).toBe(1);
    expect(typeof p.exposed.onDeepLink).toBe("function");
  });

  test("replays links that arrived BEFORE subscribe, in order", () => {
    const p = loadPreload();
    p.emit("deep-link", "codecast://open/tasks/A");
    p.emit("deep-link", "codecast://open/conversation/B");

    const got: string[] = [];
    p.exposed.onDeepLink((u: string) => got.push(u));
    expect(got).toEqual(["codecast://open/tasks/A", "codecast://open/conversation/B"]);
  });

  test("delivers links that arrive AFTER subscribe live", () => {
    const p = loadPreload();
    const got: string[] = [];
    p.exposed.onDeepLink((u: string) => got.push(u));
    p.emit("deep-link", "codecast://open/tasks/C");
    expect(got).toEqual(["codecast://open/tasks/C"]);
  });

  test("subscribing does not add IPC listeners and never double-delivers buffered links", () => {
    const p = loadPreload();
    p.emit("deep-link", "codecast://open/tasks/D");

    const first: string[] = [];
    p.exposed.onDeepLink((u: string) => first.push(u));
    expect(first).toEqual(["codecast://open/tasks/D"]);

    // A re-subscribe (e.g. handler swap) must not re-flush an already-drained
    // buffer, and must not stack a second ipcRenderer listener.
    const second: string[] = [];
    p.exposed.onDeepLink((u: string) => second.push(u));
    expect(second).toEqual([]);
    expect(p.listenerCount("deep-link")).toBe(1);

    // Live links after the swap go to the latest handler only.
    p.emit("deep-link", "codecast://open/tasks/E");
    expect(first).toEqual(["codecast://open/tasks/D"]);
    expect(second).toEqual(["codecast://open/tasks/E"]);
  });
});

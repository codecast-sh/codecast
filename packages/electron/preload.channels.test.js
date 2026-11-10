// Run: node --test packages/electron/preload.channels.test.js
//
// Every method the preload exposes must reach a handler in this shell.
//
// The shared half of the bridge is @platform/desktop's, written against that
// package's own main process; Codecast runs its own main.js. A method whose
// channel main.js never registered is not a no-op: `invoke` rejects with "No
// handler registered", and the web side, which gates on a method being
// PRESENT, takes presence as support. Seven such methods were exposed until
// 2026-11. preload.js now names the ones it takes off the bridge, and this
// test holds that list to the truth in both directions.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { createBridge } = require("@platform/desktop");
const { harness } = require("./mainTestRig");

beforeEach(harness.setup);
afterEach(harness.teardown);

const HERE = __dirname;
const PRELOAD = readFileSync(join(HERE, "preload.js"), "utf8");
// Every module of the shell itself: handlers registered once the app is ready
// (the capability policy, the browser panes) never run in the rig, so those
// are read from source.
const SHELL_SOURCE = readdirSync(HERE)
  .filter((f) => /\.(js|mjs)$/.test(f) && !/\.test\.js$/.test(f) && f !== "mainTestRig.js" && f !== "preload.js")
  .map((f) => readFileSync(join(HERE, f), "utf8"))
  .join("\n");

function removedSharedMethods() {
  const list = PRELOAD.match(/const SHARED_WITHOUT_A_HANDLER = \[([^\]]*)\]/);
  assert.ok(list, "preload.js names the shared methods it removes");
  return [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** method → the channel it invokes or sends on, for the shared bridge. */
function sharedChannels() {
  const out = new Map();
  let current = null;
  const ipcRenderer = {
    on() {},
    removeListener() {},
    invoke: (channel) => { out.set(current, channel); return Promise.resolve(); },
    send: (channel) => { out.set(current, channel); },
  };
  const bridge = createBridge({ ipcRenderer, argv: [] });
  for (const [name, value] of Object.entries(bridge)) {
    // `call` is the app-defined door: its channel is whatever name it is given.
    if (typeof value !== "function" || name === "call") continue;
    current = name;
    value(() => {});
  }
  return out;
}

function handledBy(rig) {
  return (channel) =>
    rig.handlers.has(channel) || new RegExp(`\\.(handle|on)\\(\\s*["']${channel}["']`).test(SHELL_SOURCE);
}

test("every exposed bridge method has a handler in this shell", () => {
  const handled = handledBy(harness.loadShell());
  const removed = new Set(removedSharedMethods());
  const orphans = [];
  for (const [method, channel] of sharedChannels()) {
    if (!removed.has(method) && !handled(channel)) orphans.push(`${method} → ${channel}`);
  }
  for (const m of PRELOAD.matchAll(/ipcRenderer\.(?:invoke|send)\("([^"]+)"/g)) {
    if (!handled(m[1])) orphans.push(`preload.js → ${m[1]}`);
  }
  assert.deepEqual(orphans, [], "handle these channels in main.js, or take the methods off the bridge in preload.js");
});

test("nothing is taken off the bridge that main.js answers, or that the bridge does not have", () => {
  const handled = handledBy(harness.loadShell());
  const channels = sharedChannels();
  for (const method of removedSharedMethods()) {
    assert.ok(channels.has(method), `${method} is not a method of the shared bridge`);
    assert.equal(handled(channels.get(method)), false, `${method} has a handler (${channels.get(method)}): expose it`);
  }
});

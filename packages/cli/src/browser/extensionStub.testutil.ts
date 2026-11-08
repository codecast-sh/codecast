/**
 * A `chrome.*` stand-in for unit tests of the extension's scripts, and the vm
 * loader that runs them against it. The extension is plain browser JS with
 * no exports, so a test loads status.js + background.js (or options.js) into
 * a vm context whose globals are these stubs, then calls the scripts'
 * top-level functions through the context.
 *
 * chromeStub() gives every namespace background.js touches at load a
 * harmless default (empty storage, no tabs, events that record listeners).
 * A test overrides only what it is about: each namespace is merged one level
 * deep, storage one area deep, so `{ tabs: { query } }` keeps the default
 * tab events and `{ storage: { session } }` keeps the default local area.
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

/** The extension file's source, read from packages/browser-extension. */
export function extensionSource(name: string): string {
  return readFileSync(new URL(`../../../browser-extension/${name}`, import.meta.url), "utf8");
}

export interface ChromeEvent<A extends unknown[] = any[]> {
  addListener(fn: (...args: A) => unknown): void;
  removeListener(fn: (...args: A) => unknown): void;
  hasListener(fn: (...args: A) => unknown): boolean;
  /** Call every listener, the way Chrome fires the event. */
  emit(...args: A): void;
  listeners: Array<(...args: A) => unknown>;
}

export function chromeEvent<A extends unknown[] = any[]>(): ChromeEvent<A> {
  const listeners: Array<(...args: A) => unknown> = [];
  return {
    listeners,
    addListener: (fn) => void listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    emit: (...args) => listeners.forEach((fn) => fn(...args)),
  };
}

/** A storage area over a plain object: get(key|keys|null) and set(items) behave like chrome.storage. */
export function storageArea(data: Record<string, unknown> = {}) {
  return {
    data,
    get: async (keys?: string | string[] | null) => {
      if (keys == null) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    set: async (items: Record<string, unknown>) => void Object.assign(data, items),
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
  };
}

type Namespace = Record<string, any>;
export type ChromeStub = Record<string, Namespace>;
export type ChromeOverrides = { [ns: string]: Namespace | undefined } & { storage?: { local?: Namespace; session?: Namespace } };

/** Every chrome namespace the extension uses, as inert defaults. */
function defaults(): ChromeStub {
  return {
    storage: { local: storageArea(), session: storageArea(), onChanged: chromeEvent() },
    action: { setTitle: async () => {}, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setIcon: async () => {} },
    offscreen: { Reason: { WORKERS: "WORKERS" }, hasDocument: async () => false, createDocument: async () => {}, closeDocument: async () => {} },
    runtime: {
      onStartup: chromeEvent(), onInstalled: chromeEvent(), onMessage: chromeEvent(),
      getManifest: () => ({ version: "0.1.0" }),
      getURL: (p: string) => `chrome-extension://ext/${p}`,
      sendMessage: async () => undefined,
      reload: () => {},
    },
    alarms: { create: async () => {}, clear: async () => true, onAlarm: chromeEvent() },
    tabs: {
      get: async (id: number) => ({ id, windowId: 1, groupId: -1, url: "about:blank", active: false }),
      query: async () => [],
      create: async (p: Namespace) => ({ id: 1, windowId: 1, groupId: -1, url: p.url ?? "about:blank", active: !!p.active }),
      update: async (id: number, p: Namespace) => ({ id, windowId: 1, groupId: -1, ...p }),
      remove: async () => {},
      group: async () => 1,
      ungroup: async () => {},
      getCurrent: async () => undefined,
      onCreated: chromeEvent(), onUpdated: chromeEvent(), onRemoved: chromeEvent(), onActivated: chromeEvent(), onReplaced: chromeEvent(),
      onDetached: chromeEvent(), onAttached: chromeEvent(),
    },
    tabGroups: {
      query: async () => [],
      get: async (id: number) => ({ id, windowId: 1, title: "", color: "grey" }),
      update: async (id: number, p: Namespace) => ({ id, windowId: 1, ...p }),
      onCreated: chromeEvent(), onUpdated: chromeEvent(), onRemoved: chromeEvent(),
    },
    windows: {
      getAll: async () => [{ id: 1, type: "normal" }],
      get: async (id: number) => ({ id, type: "normal" }),
      getLastFocused: async () => ({ id: 1, type: "normal" }),
      create: async () => ({ id: 2, type: "normal" }),
      onFocusChanged: chromeEvent(), onRemoved: chromeEvent(),
    },
    debugger: {
      attach: async () => {}, detach: async () => {}, getTargets: async () => [], sendCommand: async () => ({}),
      onEvent: chromeEvent(), onDetach: chromeEvent(),
    },
  };
}

/** A chrome object with defaults for everything, overridden per namespace (storage per area). */
export function chromeStub(overrides: ChromeOverrides = {}): ChromeStub {
  const chrome = defaults();
  for (const [ns, value] of Object.entries(overrides)) {
    if (!value) continue;
    if (ns === "storage") {
      for (const [area, impl] of Object.entries(value)) chrome.storage[area] = { ...(chrome.storage[area] ?? {}), ...impl };
    } else {
      chrome[ns] = { ...(chrome[ns] ?? {}), ...value };
    }
  }
  return chrome;
}

export interface LoadOptions {
  chrome: ChromeStub;
  /** Extra or replacement globals (WebSocket, setTimeout, location, document…). */
  globals?: Record<string, unknown>;
  /** Code run between status.js and the main script, e.g. to replace a status helper. */
  beforeMain?: string;
}

/** Run status.js and then `main` from packages/browser-extension in a fresh vm context. */
export function loadExtensionScript(main: string, opts: LoadOptions): vm.Context {
  const context = vm.createContext({
    chrome: opts.chrome, crypto: webcrypto, TextEncoder, URL, URLSearchParams, navigator: { userAgent: "test" },
    importScripts() {}, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    ...opts.globals,
  });
  vm.runInContext(extensionSource("status.js"), context);
  if (opts.beforeMain) vm.runInContext(opts.beforeMain, context);
  vm.runInContext(extensionSource(main), context);
  return context;
}

/** The service worker (background.js) against `chrome`. */
export function loadWorker(opts: LoadOptions): vm.Context {
  return loadExtensionScript("background.js", opts);
}

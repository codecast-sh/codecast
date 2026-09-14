import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = readFileSync(new URL('../../../browser-extension/background.js', import.meta.url), 'utf8');
const statusSource = readFileSync(new URL('../../../browser-extension/status.js', import.meta.url), 'utf8');

function worker(opts: { ownedTabs?: number[]; hungCleanup?: boolean } = {}) {
  const grouped: unknown[] = [];
  const detached: number[] = [];
  const created: unknown[] = [];
  const event = () => ({ addListener() {} });
  const tab = { id: 7, windowId: 1, groupId: -1, url: 'https://example.com', active: false };
  const storage = (data: object) => ({ get: async () => data, set: async () => {} });
  const chrome = {
    storage: { local: storage({}), session: storage({ ownedTabs: opts.ownedTabs ?? [] }) },
    action: { setTitle: async () => {}, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    runtime: { onStartup: event(), onInstalled: event(), onMessage: event(), getManifest: () => ({ version: '0.1.0' }) },
    alarms: { create: async () => {}, onAlarm: event() },
    tabs: {
      get: async () => ({ ...tab }), query: async () => [tab],
      create: async (p: object) => { created.push(p); return { ...tab }; },
      group: async (p: object) => { grouped.push(p); return 42; },
      onCreated: event(), onUpdated: event(), onRemoved: event(),
    },
    tabGroups: {
      query: async () => [], update: async (id: number, p: object) => ({ id, windowId: 1, ...p }),
      onCreated: event(), onUpdated: event(), onRemoved: event(),
    },
    windows: { getAll: async () => [{ id: 1 }] },
    debugger: {
      attach: async () => {}, detach: async ({ tabId }: { tabId: number }) => { detached.push(tabId); },
      sendCommand: async (_: unknown, method: string) => {
        if (opts.hungCleanup && method === 'Page.removeScriptToEvaluateOnNewDocument') return new Promise(() => {});
        return {};
      },
      onEvent: event(), onDetach: event(),
    },
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, TextEncoder, navigator: { userAgent: 'test' },
    importScripts() {}, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, 20)), clearTimeout,
    setInterval: () => 1, clearInterval() {},
  });
  vm.runInContext(statusSource, context);
  vm.runInContext(source, context);
  return { context, grouped, detached, created };
}

describe('extension tab lifecycle', () => {
  test('a client that omits grouping still creates a red Cast tab', async () => {
    const w = worker();
    await w.context.handle({ op: 'tabs.create', url: 'https://example.com', background: true });
    expect(w.grouped).toEqual([{ tabIds: [7] }]);
    expect(vm.runInContext('groups.get(42)', w.context)).toMatchObject({ title: 'Cast', color: 'red' });
    expect(w.created).toEqual([{ url: 'https://example.com', active: false }]);
  });

  test('an owned ungrouped tab is repaired when reattached', async () => {
    const w = worker({ ownedTabs: [7] });
    vm.runInContext('attached.add(7); borderScripts.set(7, "script-7")', w.context);
    await w.context.attachTab(7);
    expect(w.grouped).toEqual([{ tabIds: [7] }]);
  });

  test('attaching a human tab does not put it in the Cast group', async () => {
    const w = worker();
    vm.runInContext('attached.add(7); borderScripts.set(7, "script-7")', w.context);
    await w.context.attachTab(7);
    expect(w.grouped).toEqual([]);
  });

  test('host ownership restores the group after extension session storage is cleared', async () => {
    const w = worker();
    vm.runInContext('attached.add(7); borderScripts.set(7, "script-7")', w.context);
    await w.context.handle({ op: 'attach', tabId: 7, owned: true });
    expect(w.grouped).toEqual([{ tabIds: [7] }]);
    expect(vm.runInContext('ownedTabs.has(7)', w.context)).toBe(true);
  });

  test('a frozen renderer cannot prevent debugger detach', async () => {
    const w = worker({ hungCleanup: true });
    vm.runInContext('attached.add(7); borderScripts.set(7, "script-7")', w.context);
    await w.context.detachTab(7);
    expect(w.detached).toEqual([7]);
    expect(vm.runInContext('attached.has(7)', w.context)).toBe(false);
  });
});

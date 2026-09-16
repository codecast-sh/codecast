import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = readFileSync(new URL('../../../browser-extension/background.js', import.meta.url), 'utf8');
const statusSource = readFileSync(new URL('../../../browser-extension/status.js', import.meta.url), 'utf8');

function worker(opts: { ownedTabs?: number[]; hungCleanup?: boolean; humanTabDuringCreate?: boolean; coldRenderer?: boolean; hungGroupQuery?: boolean; hungTabQuery?: boolean; firstOwnershipReadStalls?: boolean; selfAlreadyAttached?: boolean } = {}) {
  const grouped: unknown[] = [];
  const detached: number[] = [];
  const created: unknown[] = [];
  const selfSessions: string[] = [];
  let selfHeld = !!opts.selfAlreadyAttached;
  const event = () => {
    const listeners: Array<(tab: object) => void> = [];
    return { addListener(fn: (tab: object) => void) { listeners.push(fn); }, emit(tab: object) { listeners.forEach((fn) => fn(tab)); } };
  };
  const tab = { id: 7, windowId: 1, groupId: -1, url: 'https://example.com', active: false };
  const storage = (data: object) => ({ get: async () => data, set: async () => {} });
  let ownershipReads = 0;
  const chrome = {
    storage: { local: storage({}), session: {
      ...storage({}),
      get: async () => ++ownershipReads === 1 && opts.firstOwnershipReadStalls
        ? new Promise(() => {}) : { ownedTabs: opts.ownedTabs ?? [] },
    } },
    action: { setTitle: async () => {}, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    runtime: { onStartup: event(), onInstalled: event(), onMessage: event(), getManifest: () => ({ version: '0.1.0' }), getURL: (path: string) => `chrome-extension://ext/${path}` },
    alarms: { create: async () => {}, onAlarm: event() },
    tabs: {
      get: async () => ({ ...tab }), query: async () => opts.hungTabQuery ? new Promise(() => {}) : [tab],
      create: async (p: object) => {
        created.push(p);
        if (opts.humanTabDuringCreate) chrome.tabs.onCreated.emit({ ...tab, id: 8 });
        chrome.tabs.onCreated.emit(tab);
        return { ...tab };
      },
      group: async (p: object) => { grouped.push(p); return 42; },
      onCreated: event(), onUpdated: event(), onRemoved: event(),
    },
    tabGroups: {
      query: async () => opts.hungGroupQuery ? new Promise(() => {}) : [], update: async (id: number, p: object) => ({ id, windowId: 1, ...p }),
      onCreated: event(), onUpdated: event(), onRemoved: event(),
    },
    windows: { getAll: async () => [{ id: 1 }] },
    debugger: {
      attach: async ({ targetId }: { tabId?: number; targetId?: string }) => {
        if (!targetId) return;
        if (selfHeld) throw new Error(`Another debugger is already attached to the target with id: ${targetId}.`);
        selfHeld = true;
        selfSessions.push(`attach ${targetId}`);
      },
      detach: async ({ tabId, targetId }: { tabId?: number; targetId?: string }) => {
        if (targetId) { selfHeld = false; selfSessions.push(`detach ${targetId}`); } else detached.push(tabId!);
      },
      getTargets: async () => [
        { id: 'page-7', type: 'page', url: 'https://example.com', attached: true },
        { id: 'sw-other', type: 'worker', url: 'chrome-extension://other/background.js', attached: false },
        { id: 'sw-self', type: 'worker', url: 'chrome-extension://ext/background.js', attached: selfHeld },
      ],
      sendCommand: async (_: unknown, method: string) => {
        if (opts.hungCleanup && method === 'Page.removeScriptToEvaluateOnNewDocument') return new Promise(() => {});
        if (opts.coldRenderer && method.endsWith('.enable')) await new Promise(resolve => setTimeout(resolve, 40));
        return {};
      },
      onEvent: event(), onDetach: event(),
    },
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, TextEncoder, navigator: { userAgent: 'test' },
    importScripts() {}, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms / 250), clearTimeout,
    setInterval: () => 1, clearInterval() {},
  });
  vm.runInContext(statusSource, context);
  vm.runInContext(source, context);
  const selfSettled = () => vm.runInContext('selfSync', context);
  const dropSelf = () => { selfHeld = false; chrome.debugger.onDetach.emit({ targetId: 'sw-self' }); };
  return { context, grouped, detached, created, selfSessions, selfSettled, dropSelf };
}

describe('extension tab lifecycle', () => {
  test('a stalled ownership read times out and the next command can recover safely', async () => {
    const w = worker({ firstOwnershipReadStalls: true, ownedTabs: [7] });
    await expect(Promise.race([
      w.context.handle({ op: 'tabs.list' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ownership stayed pending')), 100)),
    ])).rejects.toThrow('Chrome storage.session.get did not answer');
    const result = await w.context.handle({ op: 'tabs.list' });
    expect(result.tabs[0]).toMatchObject({ tabId: 7, owned: true });
  });

  test('a stalled group metadata query does not prevent listing live tabs', async () => {
    const w = worker({ hungGroupQuery: true, ownedTabs: [7] });
    const result = await Promise.race([
      w.context.handle({ op: 'tabs.list' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('tab listing stalled on group metadata')), 100)),
    ]);
    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0]).toMatchObject({ tabId: 7, owned: true });
  });

  test('a stalled tab query identifies the Chrome API that did not answer', async () => {
    const w = worker({ hungTabQuery: true });
    await expect(Promise.race([
      w.context.handle({ op: 'tabs.list' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('tab query stayed pending')), 100)),
    ])).rejects.toThrow('Chrome tabs.query did not answer');
  });

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

  test('a human tab opened during an agent create is not adopted', async () => {
    const w = worker({ humanTabDuringCreate: true });
    await w.context.handle({ op: 'tabs.create', url: 'https://example.com', background: true });
    expect(vm.runInContext('[...ownedTabs]', w.context)).toEqual([7]);
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

  test('the worker holds a DevTools session on itself while it holds a tab, and releases it with the last tab', async () => {
    const w = worker({ ownedTabs: [7] });
    await w.context.attachTab(7);
    await w.selfSettled();
    expect(w.selfSessions).toEqual(['attach sw-self']);
    await w.context.detachTab(7);
    await w.selfSettled();
    expect(w.selfSessions).toEqual(['attach sw-self', 'detach sw-self']);
  });

  test('a self session a previous worker left behind is taken over, not reported as a failure', async () => {
    const w = worker({ ownedTabs: [7], selfAlreadyAttached: true });
    await w.context.attachTab(7);
    await w.selfSettled();
    expect(w.selfSessions).toEqual(['detach sw-self', 'attach sw-self']);
    expect(vm.runInContext('selfTarget', w.context)).toBe('sw-self');
  });

  test('a self session Chrome drops while a tab is still attached is held again', async () => {
    const w = worker({ ownedTabs: [7] });
    await w.context.attachTab(7);
    await w.selfSettled();
    w.dropSelf();
    await w.selfSettled();
    expect(w.selfSessions).toEqual(['attach sw-self', 'attach sw-self']);
  });

  test('a cold renderer gets time to enable its domains after debugger attach', async () => {
    const w = worker({ coldRenderer: true, ownedTabs: [7] });
    await w.context.attachTab(7);
    expect(vm.runInContext('attached.has(7)', w.context)).toBe(true);
  });
});

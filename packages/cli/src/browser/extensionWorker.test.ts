import { describe, expect, test } from 'bun:test';
import vm from 'node:vm';
import { chromeEvent as event, chromeStub, loadWorker, storageArea } from './extensionStub.testutil';

function worker(opts: { ownedTabs?: number[]; hungCleanup?: boolean; humanTabDuringCreate?: boolean; coldRenderer?: boolean; hungGroupQuery?: boolean; hungTabQuery?: boolean; firstOwnershipReadStalls?: boolean; selfAlreadyAttached?: boolean; lateTabQueryMs?: number; castGroupWithTabs?: number[]; madeRecords?: [number, string][]; madeUsed?: number[]; keeperAlreadyOpen?: boolean; noOffscreenApi?: boolean; slowOverlay?: boolean; appWindowFocused?: boolean; groupFails?: boolean } = {}) {
  const grouped: unknown[] = [];
  const detached: number[] = [];
  const created: unknown[] = [];
  const selfSessions: string[] = [];
  const keeperDocs: object[] = [];
  let keeperExists = !!opts.keeperAlreadyOpen;
  let selfHeld = !!opts.selfAlreadyAttached;
  const tab = { id: 7, windowId: 1, groupId: -1, url: 'https://example.com', active: false };
  let ownershipReads = 0;
  const chrome = chromeStub({
    storage: {
      session: {
        get: async () => ++ownershipReads === 1 && opts.firstOwnershipReadStalls
          ? new Promise(() => {}) : { ownedTabs: opts.ownedTabs ?? [] },
      },
      local: storageArea(opts.madeRecords ? { madeTabs: opts.madeRecords, madeUsed: opts.madeUsed ?? [] } : {}),
    },
    offscreen: {
      hasDocument: async () => keeperExists,
      createDocument: async (p: object) => { keeperDocs.push(p); keeperExists = true; },
    },
    tabs: {
      get: async () => ({ ...tab }),
      query: async (q: { groupId?: number } = {}) => {
        if (opts.hungTabQuery) return new Promise(() => {});
        if (opts.lateTabQueryMs) await new Promise((resolve) => setTimeout(resolve, opts.lateTabQueryMs));
        if (q.groupId === 42) return (opts.castGroupWithTabs ?? []).map((id) => ({ ...tab, id, groupId: 42 }));
        return [tab, ...(opts.castGroupWithTabs ?? []).map((id) => ({ ...tab, id, groupId: 42 }))];
      },
      create: async (p: object) => {
        created.push(p);
        if (opts.humanTabDuringCreate) chrome.tabs.onCreated.emit({ ...tab, id: 8 });
        chrome.tabs.onCreated.emit(tab);
        return { ...tab };
      },
      group: async (p: object) => {
        grouped.push(p);
        if (opts.groupFails) throw new Error('Grouping is not supported by tabs in this window.');
        return 42;
      },
      onCreated: event(), onUpdated: event(), onRemoved: event(),
    },
    tabGroups: {
      query: async (q: { title?: string; color?: string } = {}) => {
        if (opts.hungGroupQuery) return new Promise(() => {});
        // Mid animation the title carries a frame; a human's red group is not ours.
        if (opts.castGroupWithTabs && q.color === 'red') return [{ id: 42, windowId: 1, title: 'Cast ...', color: 'red' }, { id: 43, windowId: 1, title: 'Shopping', color: 'red' }];
        return [];
      }, update: async (id: number, p: object) => ({ id, windowId: 1, ...p }),
      get: async (id: number) => ({ id, windowId: 1, title: id === 42 ? 'Cast' : 'Shopping', color: 'red' }),
      onCreated: event(), onUpdated: event(), onRemoved: event(),
    },
    // Window 9 stands for an installed web app's window: Chrome counts it as
    // last focused, but it is not a normal window and cannot hold a tab group.
    windows: {
      getAll: async () => [{ id: 1 }],
      getLastFocused: async (q: { windowTypes?: string[] } = {}) =>
        opts.appWindowFocused && !q.windowTypes?.includes('normal') ? { id: 9, type: 'app' } : { id: 1, type: 'normal' },
    },
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
        // The overlay's Runtime.evaluate waits on the page's main thread; a page still parsing holds it well past the worker's step bound.
        if (opts.slowOverlay) {
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } };
          if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
          if (method === 'Runtime.evaluate') await new Promise(resolve => setTimeout(resolve, 200));
        }
        return {};
      },
      onEvent: event(), onDetach: event(),
    },
  });
  if (opts.noOffscreenApi) delete chrome.offscreen;
  const context = loadWorker({ chrome, globals: { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms / 250), clearTimeout } });
  const selfSettled = () => vm.runInContext('selfSync', context);
  const dropSelf = () => { selfHeld = false; chrome.debugger.onDetach.emit({ targetId: 'sw-self' }); };
  const keeperSettled = () => vm.runInContext('keeperPending || Promise.resolve()', context);
  const alarm = (name: string) => chrome.alarms.onAlarm.emit({ name });
  const message = (msg: object) => chrome.runtime.onMessage.emit(msg);
  return { context, grouped, detached, created, selfSessions, selfSettled, dropSelf, keeperDocs, keeperSettled, alarm, message, dropKeeper: () => { keeperExists = false; } };
}

// A guard that fails a test whose call truly never settles. Generous on purpose: the worker's timers are
// scaled down 250x here, and on a loaded machine a real 100 ms clock fired before an 80 ms scaled one.
const HANG_GUARD_MS = 5_000;

describe('the keeper page', () => {
  test('is created at boot, once, with a reason that has no lifetime limit', async () => {
    const w = worker();
    await w.keeperSettled();
    expect(w.keeperDocs).toEqual([expect.objectContaining({ url: 'offscreen.html', reasons: ['WORKERS'] })]);
  });

  test('an existing page is kept, and one that Chrome dropped comes back on the next alarm', async () => {
    const w = worker({ keeperAlreadyOpen: true });
    await w.keeperSettled();
    expect(w.keeperDocs).toHaveLength(0);
    w.dropKeeper();
    w.alarm('cast-bridge-reconnect');
    await w.keeperSettled();
    expect(w.keeperDocs).toHaveLength(1);
  });

  test('a Chrome without the offscreen API boots and answers as before', async () => {
    const w = worker({ noOffscreenApi: true, ownedTabs: [7] });
    const result = await w.context.handle({ op: 'tabs.list' });
    expect(result.tabs).toHaveLength(1);
  });
});

describe('extension tab lifecycle', () => {
  test('a stalled ownership read times out and the next command can recover safely', async () => {
    const w = worker({ firstOwnershipReadStalls: true, ownedTabs: [7] });
    // The 20 s bound is 80 ms here, plus the 3 s grace for a frozen process (12 ms).
    await expect(Promise.race([
      w.context.handle({ op: 'tabs.list' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ownership stayed pending')), HANG_GUARD_MS)),
    ])).rejects.toThrow('Chrome storage.session.get did not answer');
    const result = await w.context.handle({ op: 'tabs.list' });
    expect(result.tabs[0]).toMatchObject({ tabId: 7, owned: true });
  });

  test('a stalled group metadata query does not prevent listing live tabs', async () => {
    const w = worker({ hungGroupQuery: true, ownedTabs: [7] });
    const result = await Promise.race([
      w.context.handle({ op: 'tabs.list' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('tab listing stalled on group metadata')), HANG_GUARD_MS)),
    ]);
    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0]).toMatchObject({ tabId: 7, owned: true });
  });

  test('a tab query that answers just after the bound (a process that was frozen) still succeeds', async () => {
    // The worker's timers run 250x faster in this harness: the 8 s bound on
    // tabs.query is 32 ms, the 3 s grace after it is 12 ms. An answer at
    // 36 ms is what a frozen process delivers a beat after the timer fired.
    const w = worker({ lateTabQueryMs: 36 });
    const result = await w.context.handle({ op: 'tabs.list' });
    expect(result.tabs).toHaveLength(1);
  });

  test('with ownership memory empty, only tabs this extension recorded making (same id and URL) are ours again', async () => {
    // 11 is a tab it made, still at its URL; 12 sits in a red group titled Cast but
    // was never recorded (a human's group, or a tab after a browser restart gave it a
    // new id); 13 was recorded at another URL, so the id now names some other page.
    const w = worker({ castGroupWithTabs: [11, 12, 13], madeRecords: [[11, 'https://example.com'], [13, 'https://elsewhere.example/']], madeUsed: [11] });
    const result = await w.context.handle({ op: 'tabs.list' });
    const byId = Object.fromEntries(result.tabs.map((t: { tabId: number; owned: boolean }) => [t.tabId, t.owned]));
    expect(byId).toEqual({ 7: false, 11: true, 12: false, 13: false });
    expect(vm.runInContext('[...ownedGroups]', w.context)).toEqual([42]);
    // The human had used 11 before the reload: it stays kept.
    expect(vm.runInContext('humanUsed.has(11)', w.context)).toBe(true);
  });

  test('a red group titled Cast is not ours when no tab in it was recorded', async () => {
    const w = worker({ castGroupWithTabs: [11, 12] });
    const result = await w.context.handle({ op: 'tabs.list' });
    expect(result.tabs.every((t: { owned: boolean }) => !t.owned)).toBe(true);
    expect(vm.runInContext('[...ownedGroups]', w.context)).toEqual([]);
  });

  test('a stalled tab query identifies the Chrome API that did not answer', async () => {
    const w = worker({ hungTabQuery: true });
    // The 30 s bound is 120 ms here, plus the 3 s grace for a frozen process (12 ms).
    await expect(Promise.race([
      w.context.handle({ op: 'tabs.list' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('tab query stayed pending')), HANG_GUARD_MS)),
    ])).rejects.toThrow('Chrome tabs.query did not answer');
  });

  test('a client that omits grouping still creates a red Cast tab', async () => {
    const w = worker();
    await w.context.handle({ op: 'tabs.create', url: 'https://example.com', background: true });
    expect(w.grouped).toEqual([{ tabIds: [7] }]);
    expect(vm.runInContext('groups.get(42)', w.context)).toMatchObject({ title: 'Cast', color: 'red' });
    expect(w.created).toEqual([{ url: 'https://example.com', active: false, windowId: 1 }]);
  });

  test('a new tab goes to a normal window even while an app window has focus', async () => {
    // tabs.create with no window lands in the last focused one; in an app window
    // the grouping step then fails: "Tabs can only be moved to and from normal windows".
    const w = worker({ appWindowFocused: true });
    await w.context.handle({ op: 'tabs.create', url: 'https://example.com', background: true });
    expect(w.created).toEqual([{ url: 'https://example.com', active: false, windowId: 1 }]);
  });

  test('a tab Chrome refuses to group is still returned, owned, and attachable', async () => {
    // The create used to throw after the tab existed: the caller never learned its id,
    // and every retry of `cast browser open` left one more tab behind.
    const w = worker({ groupFails: true });
    expect(await w.context.handle({ op: 'tabs.create', url: 'https://example.com', background: true })).toEqual({ tabId: 7 });
    expect(vm.runInContext('ownedTabs.has(7)', w.context)).toBe(true);
    await w.context.attachTab(7);
    expect(vm.runInContext('attached.has(7)', w.context)).toBe(true);
    expect(w.grouped).toEqual([{ tabIds: [7] }, { tabIds: [7] }]);
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

  test('a page that cannot paint the overlay yet still attaches: the frame is a courtesy, not a step', async () => {
    const w = worker({ slowOverlay: true, ownedTabs: [7] });
    const started = Date.now();
    await w.context.attachTab(7);
    expect(vm.runInContext('attached.has(7)', w.context)).toBe(true);
    expect(Date.now() - started).toBeLessThan(150);
  });

  test('a cold renderer gets time to enable its domains after debugger attach', async () => {
    const w = worker({ coldRenderer: true, ownedTabs: [7] });
    await w.context.attachTab(7);
    expect(vm.runInContext('attached.has(7)', w.context)).toBe(true);
  });
});

// Closing a tab takes it out of its group first (onUpdated groupId -1, then
// onRemoved). Every closed agent tab was claimed as "dragged out" by the
// human and logged so (soak ct-87421); only a tab still open outside the Cast
// group is the human's now.
describe('a tab leaving the Cast group', () => {
  function leaving(stillOpen: boolean) {
    const chrome = chromeStub({ tabs: { get: async (id: number) => {
      if (!stillOpen) throw new Error(`No tab with id: ${id}.`);
      return { id, windowId: 1, groupId: -1, url: 'https://example.com', active: false };
    } } });
    const context = loadWorker({ chrome, globals: { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms / 50), clearTimeout } });
    vm.runInContext('ownedGroups.add(42); ownedTabs.add(7); tabGroupOf.set(7, 42)', context);
    chrome.tabs.onUpdated.emit(7, { groupId: -1 }, { id: 7, windowId: 1, groupId: -1, url: 'https://example.com', active: false });
    if (!stillOpen) chrome.tabs.onRemoved.emit(7, { windowId: 1, isWindowClosing: false });
    return context;
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  test('a closed agent tab is not claimed or logged as dragged out', async () => {
    const context = leaving(false);
    await settle();
    expect(vm.runInContext('claimed.has(7)', context)).toBe(false);
    expect(vm.runInContext('recent.some((r) => r.includes("dragged out"))', context)).toBe(false);
  });

  test('an agent tab still open outside the group is the human\'s to keep', async () => {
    const context = leaving(true);
    await settle();
    expect(vm.runInContext('claimed.has(7)', context)).toBe(true);
    expect(vm.runInContext('recent.some((r) => r.includes("tab 7 dragged out of the Cast group; kept"))', context)).toBe(true);
  });
});

describe('a tab moved to another window', () => {
  test('is still the agent\'s, not claimed', async () => {
    const chrome = chromeStub({ tabs: { get: async (id: number) => ({ id, windowId: 2, groupId: -1, url: 'https://example.com', active: false }) } });
    const context = loadWorker({ chrome, globals: { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms / 50), clearTimeout } });
    vm.runInContext('ownedGroups.add(42); ownedTabs.add(7); tabGroupOf.set(7, 42)', context);
    chrome.tabs.onUpdated.emit(7, { groupId: -1 }, { id: 7, windowId: 1, groupId: -1, url: 'https://example.com', active: false });
    chrome.tabs.onDetached.emit(7, { oldWindowId: 1, oldPosition: 0 });
    chrome.tabs.onAttached.emit(7, { newWindowId: 2, newPosition: 0 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(vm.runInContext('claimed.has(7)', context)).toBe(false);
    expect(vm.runInContext('ownedTabs.has(7)', context)).toBe(true);
  });
});

describe('tabs the human is using stay theirs', () => {
  const tabAt = (id: number, extra: object = {}) => ({ id, windowId: 1, groupId: -1, url: `https://example.com/${id}`, active: false, ...extra });
  function context(extra: Record<string, unknown> = {}) {
    const chrome = chromeStub({
      tabs: { get: async (id: number) => tabAt(id), remove: async (id: number) => { removed.push(id); } },
      windows: { get: async (id: number) => ({ id, type: 'normal', focused: false }), getLastFocused: async () => ({ id: 1, focused: false }) },
      ...extra,
    });
    const removed: number[] = [];
    return { chrome, removed, ctx: loadWorker({ chrome }) };
  }
  const run = (ctx: vm.Context, code: string) => vm.runInContext(code, ctx);

  test('a popup opened from an agent tab while it waits on a handoff, or from a lent tab, is not adopted', async () => {
    const { ctx } = context();
    run(ctx, 'ownedTabs.add(5); handoffs.set(5, { id: "h1", state: "waiting", expires: Date.now() + 60000 }); lentTabs.add(6); attached.add(6); ownedTabs.add(8)');
    await run(ctx, 'adoptOpened(20, 5)');
    await run(ctx, 'adoptOpened(21, 6)');
    await run(ctx, 'adoptOpened(22, 8)');
    expect(run(ctx, '[ownedTabs.has(20), ownedTabs.has(21), ownedTabs.has(22)]')).toEqual([false, false, true]);
    expect(run(ctx, 'recent.some((r) => r.includes("tab 20 opened from tab 5 while it is the human\'s (handoff)"))')).toBe(true);
  });

  test('idle cleanup closes only tabs it made that the human never brought to the front', async () => {
    const { chrome, removed, ctx } = context();
    const old = 'Date.now() - 31 * 60 * 1000';
    // 30: made, idle. 31: made, then the human clicked it. 32: adopted popup, idle.
    run(ctx, `for (const id of [30, 31, 32]) { ownedTabs.add(id); touched.set(id, ${old}); } madeTabs.set(30, "u"); madeTabs.set(31, "u"); adoptedFrom.set(32, 30); ownershipLoaded = Promise.resolve();`);
    chrome.tabs.onActivated.emit({ tabId: 31, windowId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await run(ctx, 'cleanupIdle()');
    expect(removed).toEqual([30]);
    expect(run(ctx, 'keepReason({ id: 31 })')).toBe('used');
  });

  test('an agent raising its own tab is not the human using it', async () => {
    const { chrome, ctx } = context();
    run(ctx, 'ownedTabs.add(40); ownershipLoaded = Promise.resolve(); agentActivated(40)');
    chrome.tabs.onActivated.emit({ tabId: 40, windowId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run(ctx, 'humanUsed.has(40)')).toBe(false);
  });
});

describe('a command that hits another extension\'s frame', () => {
  test('is retried only when it reads; input is never sent twice', async () => {
    const sent: string[] = [];
    const chrome = chromeStub({
      debugger: { sendCommand: async (_d: object, method: string) => { sent.push(method); throw new Error('Cannot access a chrome-extension:// URL of different extension'); } },
      tabs: { sendMessage: async () => ({ removed: 1 }) },
    });
    const ctx = loadWorker({ chrome, globals: { setTimeout: (fn: () => void) => setTimeout(fn, 0), clearTimeout } });
    await expect(vm.runInContext('cdpPastForeignFrames(3, "Input.dispatchMouseEvent", {})', ctx)).rejects.toThrow('was not retried, since it may already have acted');
    expect(sent).toEqual(['Input.dispatchMouseEvent']);
    sent.length = 0;
    await expect(vm.runInContext('cdpPastForeignFrames(3, "DOM.getDocument", {})', ctx)).rejects.toThrow('different extension');
    expect(sent).toEqual(['DOM.getDocument', 'DOM.getDocument', 'DOM.getDocument']);
  });
});

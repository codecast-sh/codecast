import { describe, expect, test } from "bun:test";
import { installBrowserDispatchSelfHeal } from "./dispatchRecovery";

function makeBrowserHarness() {
  const windowListeners = new Map<string, () => void>();
  const documentListeners = new Map<string, () => void>();
  const removedWindowListeners: string[] = [];
  const removedDocumentListeners: string[] = [];
  const clearedIntervals: unknown[] = [];
  let intervalCallback: (() => void) | null = null;

  return {
    browserWindow: {
      addEventListener: (type: string, listener: () => void) => {
        windowListeners.set(type, listener);
      },
      removeEventListener: (type: string) => {
        removedWindowListeners.push(type);
        windowListeners.delete(type);
      },
      setInterval: (listener: () => void) => {
        intervalCallback = listener;
        return 17;
      },
      clearInterval: (id: unknown) => {
        clearedIntervals.push(id);
      },
    },
    browserDocument: {
      visibilityState: "visible",
      addEventListener: (type: string, listener: () => void) => {
        documentListeners.set(type, listener);
      },
      removeEventListener: (type: string) => {
        removedDocumentListeners.push(type);
        documentListeners.delete(type);
      },
    },
    windowListeners,
    documentListeners,
    removedWindowListeners,
    removedDocumentListeners,
    clearedIntervals,
    getIntervalCallback: () => intervalCallback,
  };
}

describe("browser dispatch self-heal", () => {
  test("stays installed when the initial authorization capture is null", () => {
    const browser = makeBrowserHarness();
    let authorizationReady = false;
    let wired = false;
    let bindAttempts = 0;
    let drains = 0;
    let clears = 0;

    const cleanup = installBrowserDispatchSelfHeal({
      bindDispatch: () => {
        bindAttempts++;
        if (!authorizationReady) return false;
        wired = true;
        return true;
      },
      isDispatchWired: () => wired,
      drainOutbox: () => { drains++; },
      clearDispatch: () => { clears++; },
      browserWindow: browser.browserWindow,
      browserDocument: browser.browserDocument,
    });

    expect(bindAttempts).toBe(1);
    expect(browser.windowListeners.has("online")).toBe(true);
    expect(browser.documentListeners.has("visibilitychange")).toBe(true);
    expect(browser.getIntervalCallback()).toBeFunction();

    authorizationReady = true;
    browser.windowListeners.get("online")?.();
    expect(bindAttempts).toBe(2);
    expect(wired).toBe(true);
    expect(drains).toBe(1);

    cleanup();
    expect(clears).toBe(1);
    expect(browser.removedWindowListeners).toEqual(["online"]);
    expect(browser.removedDocumentListeners).toEqual(["visibilitychange"]);
    expect(browser.clearedIntervals).toEqual([17]);
  });

  test("keeps the native/non-browser branch listener-free", () => {
    let binds = 0;
    let clears = 0;
    const cleanup = installBrowserDispatchSelfHeal({
      bindDispatch: () => { binds++; return true; },
      isDispatchWired: () => true,
      drainOutbox: () => {
        throw new Error("non-browser recovery must not drain");
      },
      clearDispatch: () => { clears++; },
      browserWindow: null,
      browserDocument: null,
    });

    expect(binds).toBe(1);
    cleanup();
    expect(clears).toBe(1);
  });
});

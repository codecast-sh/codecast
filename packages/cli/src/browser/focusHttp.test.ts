import { describe, expect, test } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { focusBrowserTab, focusEndpoint, handleBrowserFocusHttp, probeBrowserTab, focusRequestedTab, makeBridgeFocusEngine, matchTab, type BridgeFocusDeps, type FocusEngine, type FocusTab } from "./focusHttp.js";
import { shortTabId, tabLine } from "./tabId.js";

const T1 = "2BE86883491FD502B8D986C164423006";
const T2 = "4A2CDC7E00000000AAAA000000000000";

const tab = (id: string, over: Partial<FocusTab> = {}): FocusTab => ({
  id,
  url: "https://example.com",
  port: 9333,
  pid: 1234,
  ...over,
});

describe("tabId", () => {
  test("prints the 8-char prefix the web parses back", () => {
    expect(shortTabId(T2)).toBe("4A2CDC7E");
    expect(tabLine(T2, "next: cast browser snapshot")).toBe("tab 4A2CDC7E — next: cast browser snapshot");
    expect(tabLine(T2)).toBe("tab 4A2CDC7E");
  });
});

describe("matchTab", () => {
  const tabs = [tab(T1), tab(T2)];

  test("exact id wins", () => {
    expect(matchTab(tabs, T2)?.id).toBe(T2);
  });

  test("short-id prefix matches case-insensitively", () => {
    expect(matchTab(tabs, "2be86883")?.id).toBe(T1);
  });

  test("no match returns null", () => {
    expect(matchTab(tabs, "DEADBEEF")).toBeNull();
    expect(matchTab([], "2BE86883")).toBeNull();
  });

  test("empty query never matches", () => {
    expect(matchTab(tabs, "")).toBeNull();
  });
});

/** A fake engine that records what was asked of it. */
function engine(name: string, over: Partial<FocusEngine> & { calls?: string[] } = {}): FocusEngine {
  const calls = over.calls ?? [];
  return {
    name,
    listTabs: over.listTabs ?? (async () => [tab(T1)]),
    activate:
      over.activate ??
      (async (t) => {
        calls.push(`${name}:activate:${t.id}@${t.port}`);
      }),
  };
}

describe("focusBrowserTab", () => {
  test("activates the matched tab and raises its browser", async () => {
    const calls: string[] = [];
    const result = await focusBrowserTab("2be86883", {
      engines: [engine("builtin", { calls })],
      raiseApp: (pid) => {
        calls.push(`raise:${pid}`);
      },
    });
    expect(result).toEqual({ ok: true, tab: T1, pid: 1234 });
    expect(calls).toEqual([`builtin:activate:${T1}@9333`, "raise:1234"]);
  });

  test("no engine has a browser running means browser-stopped", async () => {
    const result = await focusBrowserTab("2be86883", {
      engines: [engine("builtin", { listTabs: async () => [] }), engine("local-chrome", { listTabs: async () => [] })],
      raiseApp: () => {},
    });
    expect(result).toEqual({ ok: false, reason: "browser-stopped" });
  });

  test("engine not answering means browser-unreachable", async () => {
    const result = await focusBrowserTab("2be86883", {
      engines: [
        engine("builtin", {
          listTabs: async () => {
            throw new Error("connect ECONNREFUSED");
          },
        }),
      ],
      raiseApp: () => {},
    });
    expect(result).toEqual({ ok: false, reason: "browser-unreachable" });
  });

  test("closed tab means tab-not-found", async () => {
    const result = await focusBrowserTab("DEADBEEF", { engines: [engine("builtin")], raiseApp: () => {} });
    expect(result).toEqual({ ok: false, reason: "tab-not-found" });
  });

  test("activation failure reports browser-unreachable, not success", async () => {
    const raised: number[] = [];
    const result = await focusBrowserTab("2be86883", {
      engines: [
        engine("builtin", {
          activate: async () => {
            throw new Error("CDP connection closed");
          },
        }),
      ],
      raiseApp: (pid) => {
        raised.push(pid);
      },
    });
    expect(result).toEqual({ ok: false, reason: "browser-unreachable" });
    expect(raised).toEqual([]);
  });

  test("falls through engines: built-in lacks the tab, an agent-browser Chrome has it", async () => {
    const calls: string[] = [];
    const result = await focusBrowserTab("4a2cdc7e", {
      engines: [
        engine("builtin", { calls, listTabs: async () => [tab(T1)] }),
        engine("local-chrome", { calls, listTabs: async () => [tab("other-1", { port: 51078, pid: 57386 }), tab(T2, { port: 51078, pid: 57386 })] }),
      ],
      raiseApp: (pid) => {
        calls.push(`raise:${pid}`);
      },
    });
    expect(result).toEqual({ ok: true, tab: T2, pid: 57386 });
    expect(calls).toEqual([`local-chrome:activate:${T2}@51078`, "raise:57386"]);
  });

  test("a stopped engine beside a running one that lacks the tab reads as tab-not-found", async () => {
    const result = await focusBrowserTab("DEADBEEF", {
      engines: [engine("builtin", { listTabs: async () => [] }), engine("local-chrome")],
      raiseApp: () => {},
    });
    expect(result).toEqual({ ok: false, reason: "tab-not-found" });
  });

  test("the first engine to report the tab wins; slower engines are not waited for", async () => {
    const calls: string[] = [];
    const slow = (name: string, ms: number, tabs: FocusTab[]): FocusEngine =>
      engine(name, { calls, listTabs: () => new Promise((r) => setTimeout(() => r(tabs), ms)) });
    const started = Date.now();
    const result = await focusBrowserTab("2be86883", {
      engines: [slow("builtin", 20, []), slow("local-chrome", 400, [tab(T1, { port: 1111 })]), slow("bridge", 60, [tab(T1, { port: 2222 })])],
      raiseApp: () => {},
    });
    expect(result).toEqual({ ok: true, tab: T1, pid: 1234 });
    // The bridge answered at 60ms with the tab; the 400ms process scan did
    // not hold the click.
    expect(calls).toEqual([`bridge:activate:${T1}@2222`]);
    expect(Date.now() - started).toBeLessThan(300);
  });

  test("a slow engine that has the tab still wins when the fast ones lack it", async () => {
    const calls: string[] = [];
    const slow = (name: string, ms: number, tabs: FocusTab[] | Error): FocusEngine =>
      engine(name, { calls, listTabs: () => new Promise((r, j) => setTimeout(() => (tabs instanceof Error ? j(tabs) : r(tabs)), ms)) });
    const result = await focusBrowserTab("2be86883", {
      engines: [slow("builtin", 10, [tab(T2)]), slow("local-chrome", 20, new Error("gone")), slow("bridge", 120, [tab(T1)])],
      raiseApp: () => {},
    });
    expect(result).toEqual({ ok: true, tab: T1, pid: 1234 });
    expect(calls).toEqual([`bridge:activate:${T1}@9333`]);
  });

  test("a tab with no known pid still activates, without a raise", async () => {
    const calls: string[] = [];
    const result = await focusBrowserTab("2be86883", {
      engines: [engine("local-chrome", { calls, listTabs: async () => [tab(T1, { pid: undefined })] })],
      raiseApp: (pid) => {
        calls.push(`raise:${pid}`);
      },
    });
    expect(result).toEqual({ ok: true, tab: T1 });
    expect(calls).toEqual([`local-chrome:activate:${T1}@9333`]);
  });
});

describe("probeBrowserTab", () => {
  test("finds the tab without activating or raising anything", async () => {
    const calls: string[] = [];
    expect(await probeBrowserTab("2be86883", { engines: [engine("builtin", { calls })] })).toEqual({ ok: true, tab: T1 });
    expect(calls).toEqual([]);
  });

  test("a closed tab is tab-not-found, the same answer focus gives", async () => {
    expect(await probeBrowserTab("4a2cdc7e", { engines: [engine("builtin")] })).toEqual({ ok: false, reason: "tab-not-found" });
  });
});

describe("focusEndpoint", () => {
  test("a Chrome tab is reached by bare port, a bridge tab by port plus token", () => {
    expect(focusEndpoint({ port: 9333 })).toBe(9333);
    expect(focusEndpoint({ port: 41729, token: "t0k" })).toEqual({ port: 41729, token: "t0k", raise: true });
  });
});

describe("bridge focus engine", () => {
  const state = { port: 41729, token: "t0k", hostPid: 4242 };
  const target = { targetId: "1E21CD78", type: "page", title: "Console", url: "https://console.example/creds" };
  const deps = (over: Partial<BridgeFocusDeps> = {}): BridgeFocusDeps => ({
    readState: () => state,
    isPidAlive: () => true,
    prove: async (s) => ({ ...s, proven: true as const }),
    listTargets: async () => [target],
    realChromePid: () => 90468,
    ...over,
  });

  test("lists the human's Chrome tabs with the bridge token and the real Chrome pid", async () => {
    const tabs = await makeBridgeFocusEngine(deps()).listTabs();
    expect(tabs).toEqual([{ id: "1E21CD78", url: "https://console.example/creds", port: 41729, token: "t0k", pid: 90468 }]);
  });

  test("never paired, or the host is dead: no browser here, not an error", async () => {
    expect(await makeBridgeFocusEngine(deps({ readState: () => null })).listTabs()).toEqual([]);
    expect(await makeBridgeFocusEngine(deps({ isPidAlive: () => false })).listTabs()).toEqual([]);
  });

  test("a host that cannot prove itself is unreachable, not silent", async () => {
    const engine = makeBridgeFocusEngine(deps({ prove: async () => { throw new Error("impostor"); } }));
    await expect(engine.listTabs()).rejects.toThrow("impostor");
  });

  test("a real-Chrome tab the clone lacks is found through the bridge and Chrome is raised", async () => {
    const calls: string[] = [];
    const bridge = makeBridgeFocusEngine(deps());
    const result = await focusBrowserTab("1e21cd78", {
      engines: [engine("builtin", { calls }), { ...bridge, activate: async (t) => { calls.push(`bridge:activate:${t.id}@${JSON.stringify(focusEndpoint(t))}`); } }],
      raiseApp: (pid) => {
        calls.push(`raise:${pid}`);
      },
    });
    expect(result).toEqual({ ok: true, tab: "1E21CD78", pid: 90468 });
    expect(calls).toEqual(['bridge:activate:1E21CD78@{"port":41729,"token":"t0k","raise":true}', "raise:90468"]);
  });
});

describe("focusRequestedTab", () => {
  test("a row's own tab id wins over the session's current tab", async () => {
    const calls: string[] = [];
    const out = await focusRequestedTab(new URLSearchParams({ tab: "2be86883", session_uuid: "s-1" }), {
      engines: [engine("builtin", { calls, listTabs: async () => [tab(T2), tab(T1)] })],
      raiseApp: () => {},
      resolveSessionTabs: () => [T2],
    });
    expect(out).toEqual({ tab: T1, result: { ok: true, tab: T1, pid: 1234 } });
    expect(calls).toEqual([`builtin:activate:${T1}@9333`]);
  });

  test("a row that lost its tab footer raises the tab its session drives", async () => {
    const calls: string[] = [];
    const asked: string[][] = [];
    const out = await focusRequestedTab(new URLSearchParams({ session_uuid: "s-1" }), {
      engines: [engine("builtin", { calls })],
      raiseApp: () => {},
      resolveSessionTabs: (keys) => (asked.push(keys), [T1]),
    });
    expect(asked).toEqual([["session:s-1", "env:s-1"]]);
    expect(out).toEqual({ tab: T1, result: { ok: true, tab: T1, pid: 1234 } });
    expect(calls).toEqual([`builtin:activate:${T1}@9333`]);
  });

  // Agents switch, share and close each other's tabs, so an older row's tab is
  // often gone while the session drives another one: the tab "watch live"
  // shows. The click raises that one instead of offering to reopen the page.
  test("a row whose tab is gone raises the tab its session drives now", async () => {
    const calls: string[] = [];
    const out = await focusRequestedTab(new URLSearchParams({ tab: "4a2cdc7e", session_uuid: "s-1" }), {
      engines: [engine("builtin", { calls })],
      raiseApp: () => {},
      resolveSessionTabs: () => [T1],
    });
    expect(out).toEqual({ tab: T1, result: { ok: true, tab: T1, pid: 1234 } });
    expect(calls).toEqual([`builtin:activate:${T1}@9333`]);
  });

  // Every row of an older session names a tab that is gone, and a process
  // scan on a loaded machine takes tens of seconds: the browser holding the
  // session's tab answers for the row's tab too, so the click waits on it alone.
  test("a gone row tab raises the session's tab without waiting on a slower engine", async () => {
    const calls: string[] = [];
    const never = engine("local-chrome", { calls, listTabs: () => new Promise<FocusTab[]>(() => {}) });
    const out = await focusRequestedTab(new URLSearchParams({ tab: "4a2cdc7e", session_uuid: "s-1" }), {
      engines: [never, engine("bridge", { calls })],
      raiseApp: () => {},
      resolveSessionTabs: () => [T1],
    });
    expect(out).toEqual({ tab: T1, result: { ok: true, tab: T1, pid: 1234 } });
    expect(calls).toEqual([`bridge:activate:${T1}@9333`]);
  });

  // A session that works through named tabs (`--tab li`) leaves its default
  // pin on a tab closed long ago. The click tries every tab it pinned, newest
  // first, and raises the first one a browser still holds.
  test("a session whose newest pins are gone raises the newest tab still open", async () => {
    const calls: string[] = [];
    const out = await focusRequestedTab(new URLSearchParams({ tab: "deadbeef", session_uuid: "s-1" }), {
      engines: [engine("bridge", { calls, listTabs: async () => [tab(T2), tab(T1)] })],
      raiseApp: () => {},
      resolveSessionTabs: () => ["DEAD0001", T1, "DEAD0002", T2],
    });
    expect(out).toEqual({ tab: T1, result: { ok: true, tab: T1, pid: 1234 } });
    expect(calls).toEqual([`bridge:activate:${T1}@9333`]);
  });

  test("a gone row tab with no session tab stays tab-not-found, so the reopen is offered", async () => {
    const out = await focusRequestedTab(new URLSearchParams({ tab: "4a2cdc7e", session_uuid: "s-1" }), {
      engines: [engine("builtin")],
      raiseApp: () => {},
      resolveSessionTabs: () => [],
    });
    expect(out).toEqual({ tab: "4a2cdc7e", result: { ok: false, reason: "tab-not-found" } });
  });

  test("a session that drives no tab is tab-not-found, never a random tab", async () => {
    const out = await focusRequestedTab(new URLSearchParams({ session_uuid: "s-1" }), {
      engines: [engine("builtin")],
      raiseApp: () => {},
      resolveSessionTabs: () => [],
    });
    expect(out).toEqual({ tab: "", result: { ok: false, reason: "tab-not-found" } });
  });
});

describe("handleBrowserFocusHttp", () => {
  test("a handler that throws after the route returned still answers, with a 500", async () => {
    const logged: string[] = [];
    const opts = { token: "t0ken", log: (m: string) => logged.push(m), allowOrigin: () => true };
    const deps = {
      engines: [],
      raiseApp: () => {},
      resolveSessionTabs: () => {
        throw new Error("binding file unreadable");
      },
    };
    const srv = http.createServer((req, res) => {
      handleBrowserFocusHttp(req, res, opts, deps);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      const headers = { Authorization: "Bearer t0ken", Origin: "http://example.test" };
      for (const route of ["focus", "probe"]) {
        const res = await fetch(`${base}/browser/${route}?session_uuid=s-1`, { method: "POST", headers, signal: AbortSignal.timeout(5000) });
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "internal" });
      }
      expect(logged.filter((l) => l.includes("binding file unreadable"))).toHaveLength(2);
    } finally {
      srv.close();
    }
  });
});

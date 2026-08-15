import { describe, expect, test } from "bun:test";
import { focusBrowserTab, matchTab, type FocusEngine, type FocusTab } from "./focusHttp.js";
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
    expect(result).toEqual({ ok: true });
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
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([`local-chrome:activate:${T2}@51078`, "raise:57386"]);
  });

  test("a stopped engine beside a running one that lacks the tab reads as tab-not-found", async () => {
    const result = await focusBrowserTab("DEADBEEF", {
      engines: [engine("builtin", { listTabs: async () => [] }), engine("local-chrome")],
      raiseApp: () => {},
    });
    expect(result).toEqual({ ok: false, reason: "tab-not-found" });
  });

  test("a tab with no known pid still activates, without a raise", async () => {
    const calls: string[] = [];
    const result = await focusBrowserTab("2be86883", {
      engines: [engine("local-chrome", { calls, listTabs: async () => [tab(T1, { pid: undefined })] })],
      raiseApp: (pid) => {
        calls.push(`raise:${pid}`);
      },
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([`local-chrome:activate:${T1}@9333`]);
  });
});

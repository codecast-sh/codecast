import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BrowserTabsReporter,
  ClaudeChromeTabs,
  TabSet,
  parseClaudeTabListing,
  scanCastTabs,
  sessionIdOfEngineKey,
} from "./sessionBrowserTabs";

const A = "11111111-aaaa-4aaa-8aaa-111111111111";
const B = "22222222-bbbb-4bbb-8bbb-222222222222";

function stateDirWith(pins: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbt-"));
  for (const [key, targetId] of Object.entries(pins)) fs.writeFileSync(path.join(dir, `${key}.target`), JSON.stringify({ targetId }));
  return dir;
}

describe("sessionIdOfEngineKey", () => {
  test("reads the session id off env, session, named-tab and real keys; pane owners have none", () => {
    expect(sessionIdOfEngineKey(`env-${A}`)).toBe(A);
    expect(sessionIdOfEngineKey(`env-${A}-real`)).toBe(A);
    expect(sessionIdOfEngineKey(`session-${A}__checkout`)).toBe(A);
    expect(sessionIdOfEngineKey("pane-12-default")).toBeNull();
  });
});

describe("scanCastTabs", () => {
  test("the person's Chrome: every cast tab under each session holding it, with its live title", async () => {
    const into = new TabSet();
    await scanCastTabs(into, {
      stateDir: stateDirWith({ [`env-${A}-real`]: "T1" }),
      bridgeTabs: async () => [
        { id: "T1", type: "page", title: "Inbox", url: "https://mail.example.com", cast: true, sessions: [`env-${A}-real`] },
        { id: "T2", type: "page", title: "Docs", url: "https://docs.example.com", cast: true, sessions: [`env-${B}__docs-real`] },
        { id: "H1", type: "page", title: "The person's own tab", url: "https://x.com" },
      ],
      agentPort: () => null,
      panePort: () => null,
    });
    const reports = into.reports();
    expect(reports.map((r) => [r.session_id, r.tabs.map((t) => `${t.where}:${t.title}`)])).toEqual([
      [A, ["chrome:Inbox"]],
      [B, ["chrome:Docs"]],
    ]);
  });

  test("the agent Chrome: only pinned tabs that are still open", async () => {
    const into = new TabSet();
    await scanCastTabs(into, {
      stateDir: stateDirWith({ [`env-${A}`]: "P1", [`env-${B}`]: "GONE" }),
      bridgeTabs: async () => { throw new Error("not asked: no real pins"); },
      targets: async () => [{ targetId: "P1", title: "Dev server", url: "http://localhost:3000" }],
      agentPort: () => 9222,
      panePort: () => null,
    });
    expect(into.reports()).toEqual([
      { session_id: A, tabs: [{ id: "P1", title: "Dev server", url: "http://localhost:3000", where: "agent" }], last_used_at: expect.any(Number) },
    ]);
  });

  test("no pins, no browser calls", async () => {
    const into = new TabSet();
    await scanCastTabs(into, { stateDir: stateDirWith({}), bridgeTabs: async () => { throw new Error("asked"); } });
    expect(into.reports()).toEqual([]);
  });
});

// ── Claude in Chrome ────────────────────────────────────────────────────────

const now = Date.parse("2026-11-25T12:00:00Z");
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const use = (id: string, name: string, input: object, minAgo = 1) =>
  JSON.stringify({ type: "assistant", timestamp: at(minAgo), message: { content: [{ type: "tool_use", id, name: `mcp__claude-in-chrome__${name}`, input }] } });
const result = (id: string, text: string, minAgo = 1) =>
  JSON.stringify({ type: "user", timestamp: at(minAgo), message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } });

function transcript(lines: string[]): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sbt-t-")), "s.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

describe("parseClaudeTabListing", () => {
  test("reads the bullet listing and JSON tab objects", () => {
    expect(parseClaudeTabListing('Tab Context:\n- Available tabs:\n  • tabId 42: "Pull requests" (https://github.com/pulls)')).toEqual([
      { id: "42", title: "Pull requests", url: "https://github.com/pulls" },
    ]);
    expect(parseClaudeTabListing('{"availableTabs":[{"tabId":7,"title":"Home","url":"https://a.com"}]}')).toEqual([{ id: "7", title: "Home", url: "https://a.com" }]);
  });
});

describe("ClaudeChromeTabs", () => {
  test("a tab the session drove, titled from a result, address from navigate", () => {
    const file = transcript([
      use("u1", "tabs_context_mcp", {}),
      result("u1", '{"availableTabs":[{"tabId":42,"title":"Pull requests","url":"https://github.com/pulls"}]}'),
      use("u2", "navigate", { tabId: 42, url: "https://github.com/pulls" }),
      result("u2", "Navigated.\nTab Context:\n- Executed on tabId: 42"),
      use("u3", "navigate", { tabId: 9, url: "https://example.com/" }),
      result("u3", "Navigated."),
    ]);
    const into = new TabSet();
    new ClaudeChromeTabs().scan(into, A, file, now);
    expect(into.reports()[0].tabs).toEqual([
      { id: "9", title: "", url: "https://example.com/", where: "claude" },
      { id: "42", title: "Pull requests", url: "https://github.com/pulls", where: "claude" },
    ]);
  });

  test("only new bytes are read on the next scan, and stale use reports nothing", () => {
    const file = transcript([use("u1", "navigate", { tabId: 5, url: "https://a.com" }, 45), result("u1", "ok", 45)]);
    const reader = new ClaudeChromeTabs();
    let into = new TabSet();
    reader.scan(into, A, file, now);
    expect(into.reports()).toEqual([]);
    fs.appendFileSync(file, use("u2", "computer", { tabId: 5, action: "screenshot" }, 0) + "\n");
    into = new TabSet();
    reader.scan(into, A, file, now);
    expect(into.reports()[0].tabs.map((t) => t.url)).toEqual(["https://a.com"]);
  });
});

describe("BrowserTabsReporter", () => {
  test("sends on change and on keepalive, never an initial empty set", async () => {
    const sent: unknown[] = [];
    let tabs = [{ id: "T1", type: "page", title: "One", url: "https://a.com", cast: true, sessions: [`env-${A}-real`] }];
    const reporter = new BrowserTabsReporter(async (s) => { sent.push(s); }, {
      stateDir: stateDirWith({ [`env-${A}-real`]: "T1" }),
      bridgeTabs: async () => tabs,
      agentPort: () => null,
      panePort: () => null,
    });
    expect(await reporter.tick([], 0)).toBe(true);
    expect(await reporter.tick([], 1_000)).toBe(false);
    tabs = [{ ...tabs[0], title: "Two" }];
    expect(await reporter.tick([], 2_000)).toBe(true);
    expect(await reporter.tick([], 2_000 + 6 * 60_000)).toBe(true);
    expect(sent).toHaveLength(3);

    const empty = new BrowserTabsReporter(async () => { throw new Error("sent"); }, { stateDir: stateDirWith({}) });
    expect(await empty.tick([], 0)).toBe(false);
  });
});

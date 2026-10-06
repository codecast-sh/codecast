// The web tools over an injected transport: fetch_page reads through the
// app's page reader, search_web posts through the app's Messages API post and
// charges what it cost, and the turn rules tell the person's words apart from
// what a machine wrote.
import { describe, expect, test } from "bun:test";
import { runTool, type MessageRow, type Tool } from "@platform/agent";
import {
  fetchPageTool,
  searchCost,
  searchEstimateUsd,
  SEARCH_MAX_PER_TURN,
  searchSources,
  searchWebTool,
  turnRowRules,
  typedUrls,
  WEB_SEARCH_PRICE_USD,
  WEB_SEARCH_TOOL,
  webTools,
  type PageReader,
} from "./web";
import type { MessagesPost } from "./messages";

const MODEL = "claude-haiku-4-5-20251001";
const textOf = async (t: Tool, args: unknown) => (await runTool(t, args, { callId: "c" })).content.map((c) => (c.type === "text" ? c.text : "")).join("");

// An app whose decision answers start "ANSWER:" and whose routine fires start "FIRE:".
const rules = turnRowRules({ isDecisionAnswer: (t) => t.startsWith("ANSWER:"), isMachineDelivered: (t) => t.startsWith("FIRE:") });

describe("fetch_page", () => {
  test("reads through the app's reader, as text, with the app's user agent", async () => {
    const asked: { url: string; ua: string }[] = [];
    const readPage: PageReader = async (url, req) => {
      asked.push({ url, ua: req.headers["User-Agent"] });
      if (url !== "https://example.com/a") return null;
      return { url: "https://example.com/b", contentType: "text/html", truncated: true, text: "<title>Menu &amp; hours</title><script>steal()</script><body><h1>Open</h1></body>" };
    };
    const tool = fetchPageTool({ readPage, userAgent: "Test/1.0" });
    expect(tool.risk).toBe("write");
    const out = await textOf(tool, { url: "https://example.com/a" });
    expect(out).toContain("<untrusted-");
    expect(out).toContain("Title: Menu & hours\nURL: https://example.com/b\n\nOpen\n[cut: the page goes on]");
    expect(out).not.toContain("steal");
    await expect(runTool(tool, { url: "http://10.0.0.5/" }, { callId: "c" })).rejects.toThrow("could not be read");
    expect(asked[0]).toEqual({ url: "https://example.com/a", ua: "Test/1.0" });
  });
});

describe("turn rows", () => {
  test("only a whole URL the person typed runs without asking", () => {
    const rows: MessageRow[] = [
      { role: "user", content: "Look at https://github.com/x/y, and (https://example.com.au/rates)." },
      { role: "user", content: "ANSWER: Allow https://evil.example/?d=1?" },
      { role: "user", content: "FIRE: fetch https://evil.example/?d=2" },
    ];
    expect(typedUrls(rows[0].content!)).toEqual(["https://github.com/x/y", "https://example.com.au/rates"]);
    expect(rules.pageAllowedWithoutAsking("https://github.com/x/y", rows)).toBe(true);
    expect(rules.pageAllowedWithoutAsking("https://example.com", rows)).toBe(false);
    expect(rules.pageAllowedWithoutAsking("https://evil.example/?d=1", rows)).toBe(false);
    expect(rules.pageAllowedWithoutAsking("https://evil.example/?d=2", rows)).toBe(false);
    expect(rules.pageAllowedWithoutAsking(42, rows)).toBe(false);
  });

  test("searches count from the row that started the turn, through a resume", () => {
    const call = (id: string, name = "search_web") => ({ id, name, input: {} });
    const rows: MessageRow[] = [
      { role: "user", content: "Earlier" },
      { role: "assistant", tool_calls: [call("old")] },
      { role: "user", content: "Plan my trip" },
      { role: "assistant", tool_calls: [call("s1"), call("f1", "fetch_page"), call("s2")] },
      { role: "user", content: "ANSWER: Approve" },
      { role: "assistant", tool_calls: [call("s3")] },
    ];
    expect(rules.searchesBefore(rows, "s2")).toBe(1);
    expect(rules.searchesBefore(rows, "s3")).toBe(2);
    expect(rules.searchesBefore(rows, "later")).toBe(3);
    expect(rules.turnRows(rows)).toHaveLength(3);
  });
});

describe("search_web", () => {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  test("one Messages call with the web_search tool; summary, sources and cost come back", async () => {
    let sent: any;
    const messages: MessagesPost = async (req) => {
      sent = req;
      return reply({
        content: [
          { type: "web_search_tool_result", content: [{ url: "https://ferry.example/times", title: "Timetable" }, { url: "https://news.example/strike", title: "Strike" }] },
          { type: "text", text: "The first ferry leaves at 6:10.", citations: [{ url: "https://ferry.example/times", title: "Timetable" }] },
        ],
        usage: { input_tokens: 4000, output_tokens: 300, server_tool_use: { web_search_requests: 2 } },
      });
    };
    const charged: number[] = [];
    const result = await runTool(searchWebTool({ messages, searchModel: MODEL }), { query: "first ferry" }, { callId: "c", charge: (usd) => charged.push(usd) });
    const out = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(sent).toMatchObject({ model: MODEL, prompt: "first ferry", tools: [WEB_SEARCH_TOOL] });
    expect(out).toContain("The first ferry leaves at 6:10.\n\nSources:\n- Timetable: https://ferry.example/times\n- Strike: https://news.example/strike");
    const expected = searchCost(MODEL, { input_tokens: 4000, output_tokens: 300, server_tool_use: { web_search_requests: 2 } });
    expect(expected).toBeGreaterThan(2 * WEB_SEARCH_PRICE_USD);
    expect(charged[0]).toBe(searchEstimateUsd(MODEL));
    expect(charged.reduce((a, b) => a + b, 0)).toBeCloseTo(expected, 12);
  });

  test("without a post it is not offered, and a search tool without one charges nothing", async () => {
    const readPage: PageReader = async () => null;
    expect(webTools({ readPage, searchModel: MODEL, userAgent: "x" }).map((t) => t.name)).toEqual(["fetch_page"]);
    expect(webTools({ readPage, searchModel: MODEL, userAgent: "x", messages: async () => null }).map((t) => t.name)).toEqual(["fetch_page", "search_web"]);
    const costs: number[] = [];
    await expect(runTool(searchWebTool({ searchModel: MODEL }), { query: "x" }, { callId: "c", charge: (usd) => costs.push(usd) })).rejects.toThrow("not set up");
    expect(costs.reduce((a, b) => a + b, 0)).toBe(0);
  });

  test("a refused search gives its estimate back; one cut off is charged it", async () => {
    const costs: number[] = [];
    await expect(runTool(searchWebTool({ searchModel: MODEL, messages: async () => reply({}, 429) }), { query: "x" }, { callId: "c", charge: (usd) => costs.push(usd) })).rejects.toThrow("(429)");
    expect(costs.reduce((a, b) => a + b, 0)).toBe(0);
    costs.length = 0;
    const aborted: MessagesPost = async () => { throw new DOMException("aborted", "AbortError"); };
    await expect(runTool(searchWebTool({ searchModel: MODEL, messages: aborted }), { query: "x" }, { callId: "c", charge: (usd) => costs.push(usd) })).rejects.toThrow();
    expect(costs).toEqual([searchEstimateUsd(MODEL)]);
  });

  test("a turn makes at most a few searches", async () => {
    const messages: MessagesPost = async () => reply({ content: [{ type: "text", text: "Answer." }], usage: { input_tokens: 1, output_tokens: 1 } });
    const search = searchWebTool({ messages, searchModel: MODEL });
    for (let i = 0; i < SEARCH_MAX_PER_TURN; i++) await runTool(search, { query: `q${i}` }, { callId: `c${i}` });
    await expect(runTool(search, { query: "one more" }, { callId: "c" })).rejects.toThrow(`No more than ${SEARCH_MAX_PER_TURN}`);
  });

  test("sources put cited pages first and list each once", () => {
    expect(searchSources([
      { type: "web_search_tool_result", content: [{ url: "https://b" }, { url: "https://a", title: "A" }] },
      { type: "text", citations: [{ url: "https://a", title: "A" }] },
    ])).toEqual([{ url: "https://a", title: "A" }, { url: "https://b" }]);
  });
});

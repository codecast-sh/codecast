// The web tools (plan pl-840): fetch_page reads public pages as text and
// refuses private hosts on every hop; search_web makes one Messages API call
// with the web_search server tool and reports what it cost.
import { afterEach, describe, expect, test } from "bun:test";
import { runTool, type Tool } from "@platform/agent";
import { CHEAP_MODEL, modelCost } from "../../lib/anthropic";
import { fetchPageTool, searchSources, searchWebTool, WEB_SEARCH_PRICE_USD, WEB_SEARCH_TOOL, webTools } from "./web";

const textOf = async (t: Tool, args: unknown) => (await runTool(t, args, { callId: "c" })).content.map((c) => (c.type === "text" ? c.text : "")).join("");

function pages(routes: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetch = (async (input: string) => {
    asked.push(input);
    const route = routes[input];
    return route ? route() : new Response("nope", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

const html = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

describe("fetch_page", () => {
  test("reads a page as text, fenced as web content", async () => {
    const p = pages({
      "https://example.com/a": () => new Response(null, { status: 301, headers: { location: "/b" } }),
      "https://example.com/b": () => html("<html><head><title>Menu &amp; hours</title><script>steal()</script></head><body><h1>Open daily</h1><p>9 to 5</p></body></html>"),
    });
    const out = await textOf(fetchPageTool({ fetch: p.fetch }), { url: "https://example.com/a" });
    expect(p.asked).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(out).toContain("<untrusted-");
    expect(out).toContain("Title: Menu & hours\nURL: https://example.com/b\n\nOpen daily\n\n9 to 5");
    expect(out).not.toContain("steal");
  });

  test("refuses a private host, including one reached by redirect, and a binary body", async () => {
    const p = pages({
      "https://example.com/r": () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
      "https://example.com/img": () => new Response("x", { status: 200, headers: { "content-type": "image/png" } }),
    });
    const t = fetchPageTool({ fetch: p.fetch });
    for (const url of ["http://localhost:3000/", "http://10.0.0.5/admin", "https://example.com/r", "https://example.com/img", "file:///etc/passwd"]) {
      await expect(runTool(t, { url }, { callId: "c" })).rejects.toThrow("could not be read");
    }
    expect(p.asked).toEqual(["https://example.com/r", "https://example.com/img"]);
  });
});

describe("search_web", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  });

  test("one Messages call with the web_search tool; summary, sources and cost come back", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    let sent: any;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        content: [
          { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "ferry times" } },
          { type: "web_search_tool_result", tool_use_id: "s1", content: [
            { type: "web_search_result", url: "https://ferry.example/times", title: "Timetable" },
            { type: "web_search_result", url: "https://news.example/strike", title: "Strike news" },
          ] },
          { type: "text", text: "The first ferry leaves at 6:10.", citations: [{ type: "web_search_result_location", url: "https://ferry.example/times", title: "Timetable", cited_text: "6:10" }] },
        ],
        usage: { input_tokens: 4000, output_tokens: 300, server_tool_use: { web_search_requests: 2 } },
      }), { status: 200 });
    }) as typeof fetch;
    const costs: [number, string][] = [];
    const result = await runTool(searchWebTool({ onCost: (usd, tool) => costs.push([usd, tool]) }), { query: "first ferry tomorrow" }, { callId: "c" });
    const out = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(sent).toMatchObject({ model: CHEAP_MODEL, tools: [WEB_SEARCH_TOOL], messages: [{ role: "user", content: "first ferry tomorrow" }] });
    expect(out).toContain("<untrusted-");
    expect(out).toContain("The first ferry leaves at 6:10.\n\nSources:\n- Timetable: https://ferry.example/times\n- Strike news: https://news.example/strike");
    const expected = modelCost(CHEAP_MODEL, { input_tokens: 4000, output_tokens: 300 }) + 2 * WEB_SEARCH_PRICE_USD;
    expect(costs).toEqual([[expected, "search_web"]]);
    expect(result.details).toEqual({ searches: 2, sources: 2, cost_usd: expected });
  });

  test("a failed search says so, and the tool is offered only with a deployment key", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      content: [{ type: "web_search_tool_result", tool_use_id: "s1", content: { type: "web_search_tool_result_error", error_code: "too_many_requests" } }],
      usage: { input_tokens: 10, output_tokens: 0 },
    }), { status: 200 })) as typeof fetch;
    await expect(runTool(searchWebTool(), { query: "x" }, { callId: "c" })).rejects.toThrow("too_many_requests");
    expect(webTools().map((t) => t.name)).toEqual(["fetch_page", "search_web"]);
    delete process.env.ANTHROPIC_API_KEY;
    expect(webTools().map((t) => t.name)).toEqual(["fetch_page"]);
  });

  test("sources put cited pages first and list each once", () => {
    expect(searchSources([
      { type: "web_search_tool_result", content: [{ url: "https://b" }, { url: "https://a", title: "A" }] },
      { type: "text", citations: [{ url: "https://a", title: "A" }] },
    ])).toEqual([{ url: "https://a", title: "A" }, { url: "https://b" }]);
  });
});

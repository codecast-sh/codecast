import { describe, expect, test } from "bun:test";
import type { ReplayEvent } from "../contracts/replay";
import { fromRrweb, primaryFailure, renderTimeline, replayCounts, toRepro, type RrwebEvent } from "./index";
import { formatReplayTime, isFailedRequest } from "./events";
import { placeholderValue } from "./repro";

const checkout: ReplayEvent[] = [
  { type: "nav", t: 0, url: "https://shop.example.com/checkout?step=1", title: "Checkout" },
  { type: "view", t: 10, outline: "Checkout\nCart (2 items)\nEmail\nPay now" },
  { type: "input", t: 1000, label: "Email", selector: "input#email", length: 3, redacted: true },
  { type: "input", t: 1200, label: "Email", selector: "input#email", length: 16, redacted: true },
  { type: "scroll", t: 2000, y: 100, of: 2000 },
  { type: "scroll", t: 3000, y: 400, of: 2000 },
  { type: "scroll", t: 4000, y: 900, of: 2000 },
  { type: "click", t: 5000, label: "Pay now", role: "button", selector: "button.pay" },
  { type: "network", t: 5100, method: "POST", url: "https://shop.example.com/api/pay?id=123", status: 500, ms: 340 },
  { type: "error", t: 5200, message: "TypeError: Cannot read properties of undefined (reading 'total')", stack: "TypeError: Cannot read properties of undefined\n    at pay (app.js:10:3)\n    at onClick (app.js:40:1)" },
  { type: "console", t: 5300, level: "warn", message: "retrying" },
];

describe("shared rules", () => {
  test("a failed request is status 0 or 4xx/5xx", () => {
    expect(isFailedRequest({ type: "network", t: 0, method: "GET", url: "/", status: 0, ms: 1 })).toBe(true);
    expect(isFailedRequest({ type: "network", t: 0, method: "GET", url: "/", status: 404, ms: 1 })).toBe(true);
    expect(isFailedRequest({ type: "network", t: 0, method: "GET", url: "/", status: 200, ms: 9000 })).toBe(false);
  });

  test("counts and the primary failure prefer the page error over the request that preceded it", () => {
    expect(replayCounts(checkout)).toEqual({ clicks: 1, errors: 1, failed_requests: 1 });
    expect(primaryFailure(checkout)?.type).toBe("error");
    expect(primaryFailure(checkout.filter((e) => e.type !== "error"))?.type).toBe("network");
  });

  test("times read m:ss.s", () => {
    expect(formatReplayTime(0)).toBe("0:00.0");
    expect(formatReplayTime(65_250)).toBe("1:05.3");
    expect(formatReplayTime(3_726_000)).toBe("1:02:06");
  });
});

describe("renderTimeline", () => {
  const md = renderTimeline(checkout, { title: "rp-7" });

  test("heads with counts and reads relative times", () => {
    expect(md.split("\n")[0]).toBe("replay rp-7 · 11 events · 0:05.3 · 1 click · 1 error · 1 failed request");
    expect(md).toContain("- 0:00.0 nav /checkout?step=1 \"Checkout\"");
    expect(md).toContain("- 0:05.0 click button \"Pay now\"");
  });

  test("folds a scroll burst and a typing run into one line each", () => {
    expect(md).toContain("- 0:02.0 scroll x3 to 900 of 2000");
    expect(md).toContain("- 0:01.0 type into \"Email\": 16 chars x2");
    expect(md.match(/scroll/g)?.length).toBe(1);
  });

  test("highlights failures and cuts the stack", () => {
    expect(md).toContain("**POST /api/pay?id=123 -> 500 (340 ms)**");
    expect(md).toContain("**ERROR TypeError: Cannot read properties of undefined (reading 'total')**\n    at pay (app.js:10:3)");
    expect(md).toContain("console.warn retrying");
  });

  test("abbreviates a long outline", () => {
    const long = renderTimeline([{ type: "view", t: 0, outline: "word ".repeat(400) }]);
    const viewLine = long.split("\n")[1];
    expect(viewLine.length).toBeLessThan(400);
    expect(viewLine).toMatch(/\(\+\d+ chars\)$/);
  });

  test("over the cap, keeps the lines around the failure and says what it left out", () => {
    const noise: ReplayEvent[] = [];
    for (let i = 0; i < 2000; i++) noise.push({ type: "click", t: i * 100, label: `item ${i}`, role: "button", selector: `li.i${i}` });
    noise.push({ type: "error", t: 100_050, message: "Boom in the middle" });
    for (let i = 0; i < 2000; i++) noise.push({ type: "click", t: 200_000 + i * 100, label: `later ${i}`, role: "button", selector: `li.l${i}` });
    const capped = renderTimeline(noise, { maxChars: 4000 });
    expect(capped.length).toBeLessThanOrEqual(4000);
    expect(capped).toContain("**ERROR Boom in the middle**");
    expect(capped).toMatch(/- … \d+ earlier lines not shown/);
    expect(capped).toMatch(/- … \d+ later lines not shown/);
    // Twice as much before the failure as after it.
    const lines = capped.split("\n");
    const at = lines.findIndex((l) => l.includes("Boom"));
    expect(at - 2).toBeGreaterThan((lines.length - at - 2) * 1.5);
  });

  test("the default cap is the cached column's 32 KB", () => {
    const many: ReplayEvent[] = Array.from({ length: 5000 }, (_, i) => ({ type: "mark" as const, t: i, name: `step-${i}-${"x".repeat(20)}` }));
    expect(renderTimeline(many).length).toBeLessThanOrEqual(32 * 1024);
  });
});

describe("toRepro", () => {
  const src = toRepro(checkout, { baseUrl: "http://localhost:3000" });

  test("replays navigation, the typed placeholder, and the click by role and name", () => {
    expect(src).toContain("import { test, expect } from \"@playwright/test\";");
    expect(src).toContain("const BASE_URL = process.env.BASE_URL ?? \"http://localhost:3000\";");
    expect(src).toContain("await page.goto(new URL(\"/checkout?step=1\", BASE_URL).toString());");
    expect(src).toContain("await page.getByLabel(\"Email\").fill(\"user@example.com\");");
    expect(src.match(/getByLabel\("Email"\)/g)?.length).toBe(1);
    expect(src).toContain("await page.getByRole(\"button\", { name: \"Pay now\" }).click();");
    expect(src).toContain("window.scrollTo(0, 900)");
  });

  test("asserts the recorded page error does not happen", () => {
    expect(src).toContain("pageErrors.filter((m) => m.includes(\"TypeError: Cannot read properties of undefined (reading 'total')\"))");
    expect(src).toContain("toEqual([]);");
  });

  test("aims at a failed request when that is all that broke", () => {
    const r = toRepro(checkout.filter((e) => e.type !== "error"), { baseUrl: "http://x" });
    expect(r).toContain("r.method === \"POST\" && new URL(r.url).pathname === \"/api/pay\"");
  });

  test("stops at the failure: nothing after it is replayed", () => {
    const after: ReplayEvent[] = [...checkout, { type: "click", t: 9000, label: "Retry", role: "button", selector: "button.retry" }];
    expect(toRepro(after, { baseUrl: "http://x" })).not.toContain("Retry");
  });

  test("a navigation right after a click waits for the URL instead of going there", () => {
    const flow: ReplayEvent[] = [
      { type: "nav", t: 0, url: "https://a.test/" },
      { type: "click", t: 100, label: "Settings", role: "link", selector: "a.s" },
      { type: "nav", t: 600, url: "https://a.test/settings" },
      { type: "console", t: 700, level: "error", message: "Failed to load profile 8f3a9c2d1e" },
    ];
    const r = toRepro(flow, { baseUrl: "http://x" });
    expect(r).toContain("await page.waitForURL((u) => u.pathname === \"/settings\");");
    expect(r).toContain("consoleErrors.filter((m) => m.includes(\"Failed to load profile\"))");
  });

  test("falls back to the selector without a label, and to a clean-run assertion without a failure", () => {
    const r = toRepro([{ type: "click", t: 0, label: "", selector: "div.card" }], { baseUrl: "http://x" });
    expect(r).toContain("await page.goto(BASE_URL);");
    expect(r).toContain("page.locator(\"div.card\").click()");
    expect(r).toContain("expect(pageErrors, \"page errors\").toEqual([]);");
  });

  test("placeholders fit the field", () => {
    expect(placeholderValue("Phone number", 10)).toBe("5555550123");
    expect(placeholderValue("Notes", 7)).toHaveLength(7);
    expect(placeholderValue("Password", 4).length).toBeGreaterThanOrEqual(10);
  });
});

describe("fromRrweb", () => {
  // A tiny page: a labelled email field, a button with an icon span inside, and a link.
  const snapshot = {
    type: 0, id: 1, childNodes: [
      { type: 2, id: 2, tagName: "html", attributes: {}, childNodes: [
        { type: 2, id: 3, tagName: "head", attributes: {}, childNodes: [
          { type: 2, id: 4, tagName: "title", attributes: {}, childNodes: [{ type: 3, id: 5, textContent: "Checkout" }] },
        ] },
        { type: 2, id: 6, tagName: "body", attributes: {}, childNodes: [
          { type: 2, id: 7, tagName: "label", attributes: { for: "email" }, childNodes: [{ type: 3, id: 8, textContent: "Email address" }] },
          { type: 2, id: 9, tagName: "input", attributes: { id: "email", type: "email" }, childNodes: [] },
          { type: 2, id: 10, tagName: "button", attributes: { class: "btn primary" }, childNodes: [
            { type: 2, id: 11, tagName: "span", attributes: { class: "icon" }, childNodes: [] },
            { type: 3, id: 12, textContent: " Pay now " },
          ] },
          { type: 2, id: 13, tagName: "a", attributes: { href: "/help", "aria-label": "Get help" }, childNodes: [{ type: 3, id: 14, textContent: "?" }] },
        ] },
      ] },
    ],
  };
  const T = 1_700_000_000_000;
  const rr: RrwebEvent[] = [
    { type: 4, timestamp: T, data: { href: "https://shop.example.com/checkout", width: 1280, height: 800 } },
    { type: 2, timestamp: T + 5, data: { node: snapshot } },
    { type: 3, timestamp: T + 1000, data: { source: 5, id: 9, text: "a@b.co" } },
    { type: 3, timestamp: T + 1500, data: { source: 1, positions: [] } },
    { type: 3, timestamp: T + 2000, data: { source: 2, type: 1, id: 11 } },
    { type: 3, timestamp: T + 2001, data: { source: 2, type: 2, id: 11 } },
    { type: 3, timestamp: T + 2100, data: { source: 3, id: 1, x: 0, y: 300 } },
    { type: 3, timestamp: T + 2500, data: { source: 3, id: 1, x: 0, y: 350 } },
    { type: 6, timestamp: T + 3000, data: { plugin: "rrweb/network@1", payload: { requests: [
      { url: "https://shop.example.com/api/pay", method: "post", status: 502, startTime: 10, endTime: 130 },
      { url: "https://shop.example.com/api/ok", method: "GET", status: 200, startTime: 0, endTime: 20 },
    ] } } },
    { type: 6, timestamp: T + 3100, data: { plugin: "rrweb/console@1", payload: { level: "error", payload: ["\"Payment failed\"", "{\"code\":502}"], trace: [] } } },
    { type: 6, timestamp: T + 3200, data: { plugin: "rrweb/console@1", payload: { level: "log", payload: ["\"noise\""] } } },
    // A node added later, then clicked.
    { type: 3, timestamp: T + 4000, data: { source: 0, adds: [{ parentId: 6, node: { type: 2, id: 20, tagName: "button", attributes: { "data-testid": "retry" }, childNodes: [{ type: 3, id: 21, textContent: "Try again" }] } }], removes: [], texts: [], attributes: [] } },
    { type: 3, timestamp: T + 4500, data: { source: 2, type: 2, id: 21 } },
    { type: 3, timestamp: T + 5000, data: { source: 2, type: 2, id: 14 } },
  ];
  const events = fromRrweb(rr);

  test("meta becomes a nav, titled from the snapshot", () => {
    expect(events[0]).toEqual({ type: "nav", t: 0, url: "https://shop.example.com/checkout", title: "Checkout" });
  });

  test("an input keeps the length and the label, never the value", () => {
    const input = events.find((e) => e.type === "input");
    expect(input).toEqual({ type: "input", t: 1000, label: "Email address", selector: "input#email", length: 6, redacted: true });
    expect(JSON.stringify(events)).not.toContain("a@b.co");
  });

  test("a click on an icon resolves to its button and the button's text; mousedown is dropped", () => {
    const clicks = events.filter((e) => e.type === "click");
    expect(clicks[0]).toEqual({ type: "click", t: 2001, label: "Pay now", role: "button", selector: "button.btn.primary" });
    expect(clicks).toHaveLength(3);
  });

  test("nodes added by a mutation resolve too, and aria-label wins over text", () => {
    const clicks = events.filter((e) => e.type === "click");
    expect(clicks[1]).toMatchObject({ label: "Try again", role: "button", selector: "[data-testid=\"retry\"]" });
    expect(clicks[2]).toMatchObject({ label: "Get help", role: "link", text: "?" });
  });

  test("scrolls are throttled to one a second", () => {
    expect(events.filter((e) => e.type === "scroll")).toEqual([{ type: "scroll", t: 2100, y: 300, of: 1100 }]);
  });

  test("the network plugin keeps failures only; the console plugin keeps warn and error, unquoted", () => {
    expect(events.filter((e) => e.type === "network")).toEqual([
      { type: "network", t: 3000, method: "POST", url: "https://shop.example.com/api/pay", status: 502, ms: 120 },
    ]);
    expect(events.filter((e) => e.type === "console")).toEqual([{ type: "console", t: 3100, level: "error", message: "Payment failed {\"code\":502}" }]);
  });

  test("PostHog's network payload shape reads the same; hidden cross-origin resource statuses are not failures", () => {
    const ph = fromRrweb([
      { type: 4, timestamp: T, data: { href: "https://a.test/" } },
      { type: 6, timestamp: T + 10, data: { plugin: "rrweb/network@1", payload: { requests: [
        { name: "https://a.test/api/x", method: "GET", responseStatus: 404, duration: 12.4, initiatorType: "fetch" },
        { name: "https://cdn.test/font.woff", initiatorType: "css", duration: 3 },
        { name: "https://a.test/api/slow", method: "GET", responseStatus: 200, duration: 2500, initiatorType: "xmlhttprequest" },
      ] } } },
    ]);
    expect(ph.filter((e) => e.type === "network")).toEqual([
      { type: "network", t: 10, method: "GET", url: "https://a.test/api/x", status: 404, ms: 12 },
      { type: "network", t: 10, method: "GET", url: "https://a.test/api/slow", status: 200, ms: 2500 },
    ]);
  });

  test("Sentry's console breadcrumbs and fetch spans read the same", () => {
    const s = fromRrweb([
      { type: 4, timestamp: T, data: { href: "https://a.test/" } },
      { type: 5, timestamp: T + 20, data: { tag: "breadcrumb", payload: { category: "console", level: "warning", message: "deprecated" } } },
      { type: 5, timestamp: T + 30, data: { tag: "performanceSpan", payload: { op: "resource.fetch", description: "https://a.test/api/y", startTimestamp: 1, endTimestamp: 1.05, data: { method: "PUT", statusCode: 500 } } } },
    ]);
    expect(s.slice(1)).toEqual([
      { type: "console", t: 20, level: "warn", message: "deprecated" },
      { type: "network", t: 30, method: "PUT", url: "https://a.test/api/y", status: 500, ms: 50 },
    ]);
  });

  test("the converted stream renders and reproduces", () => {
    expect(renderTimeline(events)).toContain("**console.error** Payment failed");
    const repro = toRepro(events, { baseUrl: "http://localhost:3000" });
    expect(repro).toContain("page.getByLabel(\"Email address\").fill(\"user@example.com\")");
    expect(repro).toContain("consoleErrors.filter((m) => m.includes(\"Payment failed");
    expect(repro).not.toContain("Try again");
  });

  test("garbage in, nothing out", () => {
    expect(fromRrweb([])).toEqual([]);
    expect(fromRrweb([{ type: 3, timestamp: 1, data: null }, { foo: 1 } as any])).toEqual([]);
  });
});

describe("parseReplayEvents", () => {
  test("keeps well formed events, clips them, and drops the rest", async () => {
    const { parseReplayEvents } = await import("./index");
    const out = parseReplayEvents({ events: [
      { type: "click", t: 5, label: "Go", selector: "button", role: "button" },
      { type: "input", t: 6, label: "Name", selector: "input", length: 4, value: "secret" },
      { type: "key", t: 7, key: "a" },
      { type: "console", t: 8, level: "log", message: "noise" },
      { type: "error", t: 9, message: "x".repeat(5000) },
      { type: "nope", t: 1 },
      { type: "nav", t: -1, url: "/" },
      null,
      { type: "mark", t: 10, name: "step", data: { big: "y".repeat(5000) } },
    ] });
    expect(out.map((e) => e.type)).toEqual(["click", "input", "error", "mark"]);
    expect(JSON.stringify(out)).not.toContain("secret");
    expect((out[2] as any).message.length).toBe(1000);
    expect((out[3] as any).data).toEqual({ _truncated: "5010 chars" });
    expect(parseReplayEvents("junk")).toEqual([]);
  });
});

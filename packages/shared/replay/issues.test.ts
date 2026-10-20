import { describe, expect, test } from "bun:test";
import type { ReplayEvent } from "../contracts/replay";
import { ECHO_MS, errorLine, replayIssues, routeOf, sameSite, serviceOf } from "./issues";

const page = "https://app.example.com/orders/8f3a9c21?tab=items";

describe("routes", () => {
  test("ids fold to :id and the query goes", () => {
    expect(routeOf("/orders/8f3a9c21")).toBe("/orders/:id");
    expect(routeOf("/users/K6DuuR5T0jm7mXWDs4MzEY1HIUCGpoch/edit")).toBe("/users/:id/edit");
    expect(routeOf("/p/123?x=1")).toBe("/p/:id");
    expect(routeOf("/items/0c9e4a3e-1b2c-4d5e-8f90-1234567890ab")).toBe("/items/:id");
    expect(routeOf("/about-us/")).toBe("/about-us");
    expect(routeOf("/settings/notifications")).toBe("/settings/notifications");
    expect(routeOf("")).toBe("/");
  });

  test("the product's own site includes its sibling hosts, not vendors", () => {
    expect(sameSite("https://api.example.com/v1/x", page)).toBe(true);
    expect(sameSite("https://app.example.com/api/x", page)).toBe(true);
    expect(sameSite("https://o1.ingest.sentry.io/api/1/envelope/", page)).toBe(false);
    expect(sameSite("https://shop.example.co.uk/a", "https://www.example.co.uk/")).toBe(true);
    expect(sameSite("https://other.co.uk/a", "https://www.example.co.uk/")).toBe(false);
  });

  test("a console error's inline stack is cut from its line", () => {
    expect(errorLine("TwilioDeviceProvider error: ConnectionError at e0._onSignalingError (https://app.example.com/_next/static/chunks/a.js:2:1)")).toBe("TwilioDeviceProvider error: ConnectionError");
    expect(errorLine("TypeError: x is undefined\n    at f (app.js:1:1)")).toBe("TypeError: x is undefined");
    expect(errorLine("Twilio error: @https://app.example.com/_next/static/chunks/2rzq.js:3:39641")).toBe("Twilio error");
    expect(errorLine("init failed: request@https://app.example.com/a.js:40:1337 more")).toBe("init failed");
  });
});

describe("replayIssues", () => {
  const stream: ReplayEvent[] = [
    { type: "nav", t: 0, url: page },
    // A vendor's ingest refusing is not the product's wall.
    { type: "network", t: 100, method: "POST", url: "https://o1.ingest.sentry.io/api/1/envelope/", status: 429, ms: 80 },
    // A cancelled GET (a long poll, an unmount) says nothing.
    { type: "network", t: 200, method: "GET", url: "https://app.example.com/api/shape?live=", status: 0, ms: 9000 },
    { type: "network", t: 300, method: "GET", url: "https://api.example.com/users/K6DuuR5T0jm7mXWDs4MzEY1HIUCGpoch", status: 403, ms: 40 },
    { type: "network", t: 310, method: "GET", url: "https://api.example.com/users/Z9DuuR5T0jm7mXWDs4MzEY1HIUCGpocq", status: 403, ms: 40 },
    { type: "click", t: 1000, label: "Save", role: "button", selector: "button.save" },
    { type: "network", t: 1010, method: "POST", url: "https://app.example.com/api/orders/8f3a9c21", status: 0, ms: 30000 },
    { type: "click", t: 1300, label: "Save", role: "button", selector: "button.save" },
    { type: "click", t: 1600, label: "Save", role: "button", selector: "button.save" },
    { type: "click", t: 2100, label: "Save", role: "button", selector: "button.save" },
    { type: "console", t: 2500, level: "warn", message: "slow" },
    { type: "console", t: 2600, level: "error", message: "Order 4411 failed to save at f (https://app.example.com/a.js:1:2)" },
    { type: "nav", t: 5000, url: "https://app.example.com/orders" },
    { type: "error", t: 5100, message: "TypeError: Cannot read properties of undefined (reading 'total')", stack: "at f (app.js:1:1)" },
  ];

  test("one issue per route and failure, earliest first", () => {
    const issues = replayIssues(stream);
    expect(issues.map((i) => [i.kind, i.title, i.route])).toEqual([
      ["request", "GET api.example.com/users/:id answers 403", "/orders/:id"],
      ["rage_click", 'Rage click on button "Save" on /orders/:id', "/orders/:id"],
      ["request", "POST /api/orders/:id answers no response", "/orders/:id"],
      ["error", "Order 4411 failed to save", "/orders/:id"],
      ["error", "TypeError: Cannot read properties of undefined (reading 'total')", "/orders"],
    ]);
    expect(issues[0].message).toContain("-> 403");
    expect(issues[1].t).toBe(1000);
    expect(issues[4].message).toContain("at f (app.js:1:1)");
  });

  test("an error or a failed request keys alike on every page; a rage click keys by its page", () => {
    const on = (url: string, e: ReplayEvent) => replayIssues([{ type: "nav", t: 0, url }, e])[0];
    const err: ReplayEvent = { type: "console", t: 5, level: "error", message: "Order 1 failed to save" };
    expect(on("https://app.example.com/orders/1111", err).fp).toBe(on("https://app.example.com/cart", { ...err, message: "Order 2 failed to save" }).fp);
    const req: ReplayEvent = { type: "network", t: 5, method: "GET", url: "https://app.example.com/api/users/123", status: 403, ms: 1 };
    expect(on("https://app.example.com/a", req).fp).toBe(on("https://app.example.com/b", { ...req, url: "https://app.example.com/api/users/456" }).fp);
    expect(on("https://app.example.com/a", { ...req, status: 500 }).fp).not.toBe(on("https://app.example.com/a", req).fp);
    const rage = (url: string) =>
      replayIssues([{ type: "nav", t: 0, url }, ...[0, 200, 400].map((t): ReplayEvent => ({ type: "click", t: 10 + t, label: "Pay", role: "button", selector: "button.pay" }))])[0];
    expect(rage("https://app.example.com/a").fp).not.toBe(rage("https://app.example.com/b").fp);
  });

  test("repeated clicks on text, fields and choices are not rage, nor is Cloudflare's own traffic", () => {
    const burst = (target: { label: string; role?: string; selector: string }): ReplayEvent[] => [0, 200, 400].map((t) => ({ type: "click", t, ...target }));
    expect(replayIssues([{ type: "nav", t: 0, url: page }, ...burst({ label: "", selector: "p.lead" })])).toEqual([]);
    expect(replayIssues([{ type: "nav", t: 0, url: page }, ...burst({ label: "Name", role: "textbox", selector: "input.name" })])).toEqual([]);
    expect(replayIssues([{ type: "nav", t: 0, url: page }, ...burst({ label: "Ada", role: "radio", selector: "input.pick" })])).toEqual([]);
    expect(replayIssues([{ type: "nav", t: 0, url: page }, ...burst({ label: "", selector: "a.next" })])).toHaveLength(1);
    expect(replayIssues([{ type: "nav", t: 0, url: page }, { type: "network", t: 1, method: "GET", url: "https://app.example.com/cdn-cgi/rum", status: 404, ms: 1 }])).toEqual([]);
  });

  test("times count from the recording's clock zero", () => {
    const [i] = replayIssues([{ type: "nav", t: 26_000_000, url: page }, { type: "error", t: 26_000_500, message: "boom" }]);
    expect(i.t).toBe(500);
    expect(replayIssues([{ type: "error", t: 700, message: "boom" }], page, 0)[0].t).toBe(700);
  });

  test("clicks spread out are not rage, and a nav resets the count", () => {
    const issues = replayIssues([
      { type: "nav", t: 0, url: page },
      { type: "click", t: 0, label: "Next", selector: "a.next" },
      { type: "click", t: 2000, label: "Next", selector: "a.next" },
      { type: "click", t: 4000, label: "Next", selector: "a.next" },
      { type: "click", t: 4100, label: "Next", selector: "a.next" },
      { type: "nav", t: 4200, url: page },
      { type: "click", t: 4300, label: "Next", selector: "a.next" },
    ]);
    expect(issues).toEqual([]);
  });

  test("a recording with nothing wrong has no issues", () => {
    expect(replayIssues([{ type: "nav", t: 0, url: page }, { type: "scroll", t: 10, y: 1, of: 2 }])).toEqual([]);
  });

  test("the start url places events before the first navigation", () => {
    const [i] = replayIssues([{ type: "error", t: 1, message: "boom" }], "https://app.example.com/start");
    expect(i.route).toBe("/start");
  });
});

describe("one failure, one key", () => {
  const at = (t: number, message: string): ReplayEvent => ({ type: "console", t, level: "error", message });
  const get = (t: number, path: string, status: number): ReplayEvent => ({ type: "network", t, method: "GET", url: `https://app.example.com${path}`, status, ms: 40 });

  test("errors written by several sites at once are one failure, whichever wrote first", () => {
    const sdkFirst = replayIssues([{ type: "nav", t: 0, url: page }, at(10, "[Voice][Device] Received error: TransportError"), at(12, "VoiceProvider error: TransportError")]);
    const providerFirst = replayIssues([{ type: "nav", t: 0, url: page }, at(10, "VoiceProvider error: TransportError"), at(13, "[Voice][Device] Received error: TransportError")]);
    expect(sdkFirst.map((i) => i.fp)).toHaveLength(1);
    expect(sdkFirst.map((i) => i.fp)).toEqual(providerFirst.map((i) => i.fp));
  });

  test("errors seconds apart stay apart", () => {
    const issues = replayIssues([{ type: "nav", t: 0, url: page }, at(10, "VoiceProvider error: TransportError"), at(10 + ECHO_MS + 2400, "VoiceProvider error: AccessTokenInvalid")]);
    expect(issues.map((i) => i.title)).toEqual(["VoiceProvider error: TransportError", "VoiceProvider error: AccessTokenInvalid"]);
  });

  test("an error that names the request that just failed is that request's; one that does not stays its own", () => {
    const named = replayIssues([{ type: "nav", t: 0, url: page }, get(10, "/api/sync/teams", 403), at(14, "[sync] stopped (403) https://app.example.com/api/sync/teams")]);
    expect(named.map((i) => i.kind)).toEqual(["request"]);
    const unrelated = replayIssues([{ type: "nav", t: 0, url: page }, get(10, "/api/sync/teams", 403), at(14, "TypeError: total is undefined")]);
    expect(unrelated.map((i) => i.kind)).toEqual(["request", "error"]);
  });

  test("a gateway status is the service's outage across its endpoints; a 500 keeps its endpoint", () => {
    const issues = replayIssues([
      { type: "nav", t: 0, url: page },
      get(10, "/api/sync/shape/calls", 502),
      get(20, "/api/sync/shape/needs", 503),
      get(30, "/api/sync/shape/contacts", 524),
      get(40, "/api/hitl/my-tasks", 502),
      get(50, "/api/calls/heartbeat", 500),
      get(60, "/api/calls/token", 500),
    ]);
    expect(issues.map((i) => i.title)).toEqual([
      "/api/sync does not answer (502 on /api/sync/shape/calls)",
      "/api/hitl does not answer (502 on /api/hitl/my-tasks)",
      "GET /api/calls/heartbeat answers 500",
      "GET /api/calls/token answers 500",
    ]);
  });

  test("a service is the api's first segment, else the path's", () => {
    expect([serviceOf("/api/sync/shape/calls"), serviceOf("/book"), serviceOf("/api/:id/x"), serviceOf("/")]).toEqual(["/api/sync", "/book", "/api", "/"]);
  });
});

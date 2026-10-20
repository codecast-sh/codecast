import { describe, expect, test } from "bun:test";
import type { ReplayEvent } from "../contracts/replay";
import { errorLine, replayIssues, routeOf, sameSite } from "./issues";

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
    { type: "click", t: 1400, label: "Save", role: "button", selector: "button.save" },
    { type: "click", t: 1800, label: "Save", role: "button", selector: "button.save" },
    { type: "click", t: 2100, label: "Save", role: "button", selector: "button.save" },
    { type: "console", t: 2500, level: "warn", message: "slow" },
    { type: "console", t: 2600, level: "error", message: "Order 4411 failed to save at f (https://app.example.com/a.js:1:2)" },
    { type: "nav", t: 5000, url: "https://app.example.com/orders" },
    { type: "error", t: 5100, message: "TypeError: Cannot read properties of undefined (reading 'total')", stack: "at f (app.js:1:1)" },
  ];

  test("one issue per route and failure, earliest first", () => {
    const issues = replayIssues(stream);
    expect(issues.map((i) => [i.kind, i.title])).toEqual([
      ["request", "GET api.example.com/users/:id 403 on /orders/:id"],
      ["rage_click", 'Rage click on button "Save" on /orders/:id'],
      ["request", "POST /api/orders/:id no response on /orders/:id"],
      ["error", "Order 4411 failed to save on /orders/:id"],
      ["error", "TypeError: Cannot read properties of undefined (reading 'total') on /orders"],
    ]);
    expect(issues[0].message).toContain("-> 403");
    expect(issues[1].t).toBe(1000);
    expect(issues[4].message).toContain("at f (app.js:1:1)");
  });

  test("the same failure on the same route keys alike across recordings, and differs by route", () => {
    const a = replayIssues([{ type: "nav", t: 0, url: "https://app.example.com/orders/1111" }, { type: "console", t: 5, level: "error", message: "Order 1 failed to save" }]);
    const b = replayIssues([{ type: "nav", t: 0, url: "https://app.example.com/orders/2222" }, { type: "console", t: 9, level: "error", message: "Order 2 failed to save" }]);
    const c = replayIssues([{ type: "nav", t: 0, url: "https://app.example.com/cart" }, { type: "console", t: 9, level: "error", message: "Order 2 failed to save" }]);
    expect(a[0].fp).toBe(b[0].fp);
    expect(a[0].fp).not.toBe(c[0].fp);
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

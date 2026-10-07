import { describe, expect, test } from "bun:test";
import type { ReplayEvent } from "../contracts/replay";
import { formatReplayMoment, replayClockDuration, replayClockStart, replayMoment } from "./moment";

// A recorder ring buffer: the stream starts 60s into the session.
const S = 60_000;
const events: ReplayEvent[] = [
  { type: "nav", t: S, url: "https://shop.test/cart", title: "Cart" },
  { type: "view", t: S + 100, outline: "Cart\nCheckout" },
  { type: "click", t: S + 2_000, label: "Checkout", selector: "#go", role: "button" },
  { type: "nav", t: S + 3_000, url: "https://shop.test/pay" },
  { type: "view", t: S + 3_100, outline: "Pay\nCard number" },
  { type: "input", t: S + 5_000, label: "Card number", selector: "#cc", length: 16, redacted: true },
  { type: "network", t: S + 7_500, method: "POST", url: "https://shop.test/api/pay", status: 500, ms: 120 },
  { type: "console", t: S + 7_600, level: "error", message: "payment failed" },
  { type: "error", t: S + 7_700, message: "TypeError: x is undefined" },
  { type: "click", t: S + 30_000, label: "Retry", selector: "#retry" },
];

describe("replayMoment", () => {
  test("reads the clock from the first event", () => {
    expect(replayClockStart(events)).toBe(S);
    expect(replayClockDuration(events)).toBe(30_000);
  });

  test("names the page, its outline, what came before, and the console and network around it", () => {
    const m = replayMoment(events, 8_000);
    expect(m).toMatchObject({ at_ms: 8_000, url: "https://shop.test/pay", outline: "Pay\nCard number", outline_at_ms: 3_100 });
    expect(m.before.map((e) => e.type)).toEqual(["nav", "click", "nav", "input"]);
    expect(m.console.map((e) => e.type)).toEqual(["console", "error"]);
    expect(m.network).toHaveLength(1);
  });

  test("before the first navigation is on the opening page; past the end is held to it", () => {
    expect(replayMoment(events, 0).url).toBe("https://shop.test/cart");
    expect(replayMoment(events, 999_999).at_ms).toBe(30_000);
  });

  test("prints on the replay clock, and a rendered frame's text wins over the stream's outline", () => {
    const m = replayMoment(events, 8_000);
    const text = formatReplayMoment(m, S);
    expect(text).toContain("at 0:08.0 of 0:30.0");
    expect(text).toContain("url: https://shop.test/pay");
    expect(text).toContain("outline (taken at 0:03.1)");
    expect(text).toContain("0:05.0 type into \"Card number\": 16 chars");
    expect(text).toContain("0:07.5 POST /api/pay -> 500");
    const framed = formatReplayMoment(m, S, { visible: "Payment declined" });
    expect(framed).toContain("visible text (rendered frame):\n  Payment declined");
    expect(framed).not.toContain("Card number\n");
  });
});

import { describe, expect, test } from "bun:test";
import { formatSessionQueue } from "./sessionQueueFormat.js";

const NOW = 1_800_000_000_000;
const msg = (over: Partial<Parameters<typeof formatSessionQueue>[0]["queued"][number]>) => ({
  message_id: "m", created_at: NOW - 125_000, status: "pending", content: "", hold_reason: null, retry_count: 0, from_name: "Ada", ...over,
});

describe("cast read --queued (GitHub #88)", () => {
  test("every queued message prints whole, multi-line text included, with its hold", () => {
    const long = `first line\nsecond line\n${"x".repeat(400)}`;
    const out = formatSessionQueue({
      short_id: "jx7abcd", title: "Worker",
      queued: [msg({ content: long, hold_reason: "another program is running this session (pid 4551)" }), msg({ content: "two", status: "injected" })],
      cancelled: [],
    }, NOW);
    expect(out).toContain("2 messages queued for jx7abcd (Worker), in delivery order:");
    expect(out).toContain("1. pending · 2m ago · from Ada · held: another program is running this session (pid 4551)");
    expect(out).toContain("   second line");
    expect(out).toContain("x".repeat(400));
    expect(out).toContain("2. injected");
  });

  test("messages a kill cancelled stay readable", () => {
    const out = formatSessionQueue({ short_id: "jx7abcd", title: null, queued: [], cancelled: [msg({ status: "cancelled", content: "lost text\nline two" })] }, NOW);
    expect(out).toContain("Nothing queued for jx7abcd.");
    expect(out).toContain("Cancelled, newest first");
    expect(out).toContain("   lost text\n   line two");
  });
});

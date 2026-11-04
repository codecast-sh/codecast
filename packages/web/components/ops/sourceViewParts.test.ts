import { describe, expect, test } from "bun:test";
import { liveFailures } from "./appsModel";
import { argsFromForm, arrivedSince, dailyBins, formatAnswer, prettyJson, sampleTitle, shortUrl, testEventCommand, watchLine } from "./sourceViewModel";
import type { OpsAppCall } from "./opsTypes";

const NOW = Date.UTC(2026, 10, 3, 12);
const call = (o: Partial<OpsAppCall>): OpsAppCall => ({ _id: `c${Math.random()}`, source_id: "s1", user_id: "u", kind: "read", name: "metrics.read", args_hash: "", status: "ok", ms: 5, bytes: 1, created_at: NOW, ...o } as OpsAppCall);

describe("the Apps board and a source's health read the same failures", () => {
  test("a reader agents keep timing out on is failing now; a watch's own failures are not counted twice", () => {
    const calls = [
      call({ status: "error", error: "no answer in 15s", conversation_id: "conv1", created_at: NOW - 1000 }),
      call({ status: "error", error: "no answer in 15s", conversation_id: "conv1", created_at: NOW - 2000 }),
      call({ status: "error", error: "watch jobs:check: answered 500", name: "jobs", created_at: NOW - 3000 }),
      call({ status: "ok", name: "other", created_at: NOW - 4000 }),
    ];
    expect(liveFailures(calls, { grants: [], watchState: [], watches: [], now: NOW })).toMatchObject([{ kind: "read", name: "metrics.read", reason: "Timed out", count: 2, reasons: [{ reason: "Timed out", count: 2 }], since: NOW - 2000 }]);
  });
});

describe("running from the board", () => {
  const params = [
    { name: "limit", type: "integer", required: true, description: null },
    { name: "dry", type: "boolean", required: false, description: null },
    { name: "filter", type: "object", required: false, description: null },
    { name: "who", type: "string", required: false, description: null },
  ];
  test("values become typed args; empty optional fields stay out", () => {
    expect(argsFromForm(params, { limit: "5", dry: true, filter: '{"a":1}', who: " " })).toEqual({ args: { limit: 5, dry: true, filter: { a: 1 } }, errors: [] });
  });
  test("a missing or malformed field says which", () => {
    expect(argsFromForm(params, { limit: "", filter: "{" }).errors).toEqual(["limit is required", "filter is not JSON"]);
    expect(argsFromForm(params, { limit: "x" }).errors).toEqual(["limit must be a number"]);
  });
  test("JSON answers read pretty, anything else as sent", () => {
    expect(formatAnswer('{"ok":true}')).toBe('{\n  "ok": true\n}');
    expect(formatAnswer("plain")).toBe("plain");
  });
});

describe("a silent source's check", () => {
  test("the test is a named event that opens no issue, keyed from the environment", () => {
    const cmd = testEventCommand("https://c.example/");
    expect(cmd).toContain("https://c.example/cli/ingest/$CODECAST_INGEST_KEY");
    expect(cmd).toContain('"type":"event","name":"codecast.test"');
  });
  test("arrival counts only events after the check opened", () => {
    expect(arrivedSince(NOW - 1, NOW)).toBe(false);
    expect(arrivedSince(NOW + 5, NOW)).toBe(true);
    expect(arrivedSince(null, NOW)).toBe(false);
  });
});

describe("the overview's numbers", () => {
  test("day bars before the counter began are unknown, not zero", () => {
    const today = new Date(NOW).toISOString().slice(0, 10);
    const bins = dailyBins({ days: [{ day: today, events: 4, dropped: 1 }] }, NOW, 3);
    expect(bins.map((b) => [!!b.unknown, b.total])).toEqual([[true, 0], [true, 0], [false, 5]]);
  });
  test("a watch's line reads as where it alerts, in its unit", () => {
    expect(watchLine({ threshold: 1, direction: "below", unit: undefined })).toBe("line < 1");
    expect(watchLine({ threshold: undefined, direction: "above", unit: undefined })).toBeNull();
  });
});

describe("occurrence rows", () => {
  test("a url shows its path, a message its first line, JSON pretty", () => {
    expect(shortUrl("https://app.test/checkout?step=2")).toBe("/checkout?step=2");
    expect(shortUrl(undefined)).toBeNull();
    expect(sampleTitle({ message: "TypeError: boom\n  at x" })).toBe("TypeError: boom");
    expect(sampleTitle({ message: "" }, { title: "Group title" })).toBe("Group title");
    expect(prettyJson("{}")).toBeNull();
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  });
});

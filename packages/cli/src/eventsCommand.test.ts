// `cast events` (external-data.md X3, X10): the lines, the watch loop, and
// what each verb posts.
import { describe, expect, test } from "bun:test";
import { formatEventLine, formatGroupDetail, formatGroupLine, freshEvents, watchEvents, type EventRow, type GroupRow } from "./eventsCommand.js";
import { SCOPE, useCliHarness } from "./externalDataCli.testHarness.js";

const event = (id: string, at: number, title = "TypeError: x"): EventRow => ({
  _id: id,
  kind: "error_new",
  title,
  created_at: at,
  data: { transition: "new", group_short_id: "eg-4", source_name: "web", count: 3, release: "1.2" },
});

const group: GroupRow = {
  _id: "g1", short_id: "eg-4", kind: "error", status: "open", title: "TypeError: x", count: 12,
  first_seen: 0, last_seen: 60_000, buckets: [{ hour: 0, count: 1 }, { hour: 1, count: 8 }], first_release: "1.1",
};

describe("lines", () => {
  test("an event names its transition, source, group and counts", () => {
    const line = formatEventLine(event("e1", 1_000), 121_000);
    for (const part of ["2m ago", "error_new", "web", "eg-4", "TypeError: x", "×3, release 1.2"]) expect(line).toContain(part);
  });

  test("a group shows its count, age and the last hours as a sparkline", () => {
    const line = formatGroupLine(group, 120_000);
    expect(line).toContain("eg-4");
    expect(line).toContain("×12");
    expect(line).toContain("last 1m ago");
    expect(line).toContain("▁█");
  });

  test("a Sentry group's detail reads the live event's exceptions", () => {
    const text = formatGroupDetail({ group, samples: [], source: { name: "web", provider: "sentry" }, issue: { ok: true, event: { title: "TypeError: x", exceptions: [{ type: "TypeError", value: "x is undefined", stack: "  at f (a.ts:3)" }] }, replay_id: "r9" } }, 120_000);
    expect(text).toContain("TypeError: x is undefined");
    expect(text).toContain("at f (a.ts:3)");
    expect(text).toContain("cast replay ls --source web");
  });
});

describe("the watch loop", () => {
  test("prints each new row once, oldest first, and moves its cursor", async () => {
    const pages = [[event("b", 20), event("a", 10)], [event("c", 30), event("b", 20)], []];
    const asked: number[] = [];
    const printed: string[] = [];
    await watchEvents(async (since) => { asked.push(since); return pages.shift() ?? []; }, (r) => printed.push(r._id), { since: 0, rounds: 3, sleep: async () => {} });
    expect(printed).toEqual(["a", "b", "c"]);
    expect(asked).toEqual([0, 20, 30]);
  });

  test("freshEvents skips what was seen", () => {
    expect(freshEvents([event("a", 1), event("b", 2)], new Set(["a"])).map((r) => r._id)).toEqual(["b"]);
  });
});

describe("cast events on the wire", () => {
  const h = useCliHarness("events", async () => (await import("./eventsCommand.js")).registerEventsCommand);

  test("ls reads the timeline with the scope and --since as a time", async () => {
    h.answer = () => [event("e1", Date.now())];
    const before = Date.now();
    await h.run("ls", "--source", "web", "--since", "2h");
    expect(h.calls[0].path).toBe("/cli/events/list");
    expect(h.calls[0].body).toMatchObject({ source: "web", ...SCOPE });
    expect(h.calls[0].body.since).toBeGreaterThanOrEqual(before - 2 * 3_600_000);
    expect(h.out()).toContain("error_new");
  });

  test("groups refuses an unknown status before posting", async () => {
    await expect(h.run("groups", "--status", "closed")).rejects.toThrow(/exit 1/);
    expect(h.calls).toHaveLength(0);
    h.answer = () => [group];
    await h.run("groups", "--status", "open", "--kind", "error", "--json");
    expect(h.calls[0]).toEqual({ path: "/cli/events/groups", body: { status: "open", kind: "error", ...SCOPE } });
    expect(JSON.parse(h.logs[1])).toEqual([group]);
  });

  test("show reads Sentry's live detail only for a mirrored group", async () => {
    h.answer = (path) => (path === "/cli/events/group" ? { group, samples: [], source: null } : {});
    await h.run("show", "eg-4");
    expect(h.calls.map((c) => c.path)).toEqual(["/cli/events/group"]);
    h.calls.length = 0;
    h.answer = (path) => (path === "/cli/events/group" ? { group: { ...group, external: { provider: "sentry", id: "1" } }, samples: [], source: null } : { ok: true, event: null });
    await h.run("show", "eg-4");
    expect(h.calls.map((c) => c.path)).toEqual(["/cli/events/group", "/cli/events/issue"]);
  });

  test("resolve names the release; ignore sets the status", async () => {
    h.answer = () => ({ group });
    await h.run("resolve", "eg-4", "--in", "1.3.0");
    await h.run("ignore", "eg-4");
    expect(h.calls).toEqual([
      { path: "/cli/events/set-status", body: { group: "eg-4", status: "resolved", resolved_in: "1.3.0" } },
      { path: "/cli/events/set-status", body: { group: "eg-4", status: "ignored" } },
    ]);
  });
});

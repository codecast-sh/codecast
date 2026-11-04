import { describe, expect, test } from "bun:test";
import type { OpsGroup, OpsSample } from "./opsTypes";
import { attentionLane, issueLane, jobFailureSplit, jobQuiet, layoutChart, sampleTag, sharedLead, FAILURE_KEY } from "./issuesModel";
import { attentionItems, attentionCounts } from "./opsHomeModel";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 4, 15, 37);
const g = (over: Partial<OpsGroup> = {}): OpsGroup =>
  ({ _id: `g${Math.random()}`, short_id: "eg-1", source_id: "s1", kind: "job", title: "agent.broker", status: "open", count: 9729, first_seen: NOW - 29 * DAY, last_seen: NOW - 5 * DAY, buckets: [], ...over }) as OpsGroup;
const sample = (message: string, at: number): OpsSample => ({ _id: `s${Math.random()}`, group_id: "g", source_id: "s1", at, message }) as OpsSample;

describe("a job's failures", () => {
  const samples = [
    sample("Agent run failed: broker: write CONNECT_TIMEOUT undefined:undefined", NOW - 4 * DAY),
    sample("Agent run failed: broker: write CONNECT_TIMEOUT undefined:undefined", NOW - 5 * DAY),
    sample("Agent run failed: broker: CONNECTION_CLOSED us-west-3.pg.psdb.cloud:6432", NOW - 6 * DAY),
    sample("Agent run failed: broker: Provider openrouter unavailable (billing) since 2026-10-27T15:24:38.879Z", NOW - 7 * DAY),
  ];

  test("split by what each said, from the kept samples when the server holds no tally, the shared lead dropped", () => {
    const split = jobFailureSplit(g(), samples)!;
    expect(split.from).toBe("kept");
    expect(split.total).toBe(4);
    expect(split.rows.map((r) => [r.label, r.n])).toEqual([["write CONNECT_TIMEOUT undefined:undefined", 2], ["CONNECTION_CLOSED us-west-3.pg.psdb.cloud:6432", 1], ["Provider openrouter unavailable (billing) since #", 1]]);
    expect(split.rows[0].share).toBe(0.5);
    // A row's press filters the samples to its own.
    expect(samples.filter((s) => sampleTag(s, FAILURE_KEY) === split.rows[0].key)).toHaveLength(2);
  });

  test("counted from the server's tally when the group holds one", () => {
    const split = jobFailureSplit(g({ messages: [{ key: "a: x", count: 90, first_seen: NOW - 9 * DAY, last_seen: NOW - DAY }, { key: "a: y", count: 10, first_seen: NOW - 3 * DAY, last_seen: NOW - 2 * DAY }] }), samples)!;
    expect(split).toMatchObject({ from: "tally", total: 100, since: NOW - 9 * DAY });
    expect(split.rows.map((r) => r.label)).toEqual(["x", "y"]);
  });

  test("the lead is cut where a word ends", () => {
    expect(sharedLead(["Agent run failed: a", "Agent run failed: b"])).toBe("Agent run failed: ");
    expect(sharedLead(["timeout a", "timeout b"])).toBe("");
  });

  test("a job quiet for well past its usual gap is quiet, not failing; one still failing is not", () => {
    expect(jobQuiet(g(), NOW)).toBe(true);
    expect(jobQuiet(g({ last_seen: NOW - 10 * 60_000 }), NOW)).toBe(false);
    // A daily job a day late is not yet quiet.
    expect(jobQuiet(g({ count: 30, first_seen: NOW - 30 * DAY, last_seen: NOW - 2 * DAY }), NOW)).toBe(false);
  });

  test("a window past the counted days is never a confident zero", () => {
    const l = layoutChart(g({ days: undefined }), [], NOW, 7 * 24);
    expect(l.total).toBe(0);
    expect(l.bars.some((b) => b.unknown)).toBe(true);
  });
});

describe("one lane for an issue on every surface", () => {
  test("a record is in no lane", () => {
    expect(issueLane(g({ kind: "check", count: 0, status: "open", last_seen: NOW - HOUR, first_seen: NOW - HOUR }), NOW)).toBeNull();
  });

  test("the Overview counts a flapper where the list does, given the same failure count", () => {
    const flapper = g({ kind: "metric", count: 40, first_seen: NOW - 6 * DAY, last_seen: NOW - 10 * 60_000, buckets: Array.from({ length: 24 }, (_, i) => ({ hour: Math.floor(NOW / HOUR) * HOUR - i * HOUR, count: 2 })) });
    const failures = () => 6;
    const listLane = attentionLane(flapper, NOW, failures());
    const counts = attentionCounts(attentionItems({ sources: [], groups: [flapper], watches: [], replays: [], failures }, NOW, () => undefined));
    expect(counts.escalating).toBe(listLane === "escalating" ? 1 : 0);
    expect(counts.new + counts.regressed + counts.escalating + counts.firing).toBe(listLane ? 1 : 0);
  });
});

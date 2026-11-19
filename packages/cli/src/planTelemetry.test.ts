import { expect, test } from "bun:test";
import { formatTelemetryTable, type PlanTelemetry } from "./planTelemetry.js";

const run = (over: Partial<PlanTelemetry>): PlanTelemetry => ({
  plan: "pl-1", policy: "lead", tasks: 4, done: 4, blocked: 0, retries: 1, finished: true, wall_minutes: 42.5, task_minutes: 120,
  entries: {}, sessions: 5, uncounted: 0, tokens: 1_234_567, list_usd: 18.4, ...over,
});

test("formatTelemetryTable sets two policies' runs side by side", () => {
  const lines = formatTelemetryTable([
    run({}),
    run({ plan: "pl-2", policy: "shared-log", done: 3, finished: false, wall_minutes: 30, uncounted: 1, entries: { fact: 4, fail: 2, interface: 1 } }),
  ]).split("\n");
  expect(lines[0].split(/\s{2,}/)).toEqual(["plan", "policy", "done", "wall", "task time", "tokens", "list $", "sessions", "retries", "blocked", "fact/fail/iface"]);
  expect(lines[1].split(/\s{2,}/)).toEqual(["pl-1", "lead", "4/4", "42.5m", "120m", "1.2M", "18.40", "5", "1", "0", "0/0/0"]);
  expect(lines[2].split(/\s{2,}/)).toEqual(["pl-2", "shared-log", "3/4", "30m+", "120m", "1.2M", "18.40", "5 +1 uncounted", "1", "0", "4/2/1"]);
  // Columns line up.
  expect(lines[1].indexOf("4/4")).toBe(lines[0].indexOf("done"));
});

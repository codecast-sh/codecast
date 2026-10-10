import { expect, test } from "bun:test";
import { renderQueueReport, withQueuePositions, type QueueReport } from "./queueCommand.js";

const caps = { per_session: 10, per_machine: 2 };
const now = 10 * 60_000;

test("queued workers carry their place among rows that compete for the same machine", () => {
  const rows = withQueuePositions([
    { id: "jx7run1aaa", parent: "p1", device: "mac", slot: "running", at: 0, caps, title: "a" },
    { id: "jx7que1bbb", parent: "p1", device: "mac", slot: "queued", at: 1, caps, title: "b" },
    { id: "jx7que2ccc", parent: "p2", device: "mac", slot: "queued", at: 2, caps, title: "c" },
  ]);
  expect(rows.map((r) => r.ahead)).toEqual([null, 0, 1]);
});

test("the report shows each queue's load against its cap, what waits, and how to change the caps", () => {
  const report: QueueReport = {
    check: { cap: 6, running: [{ project: "cli", root: "/r", pid: 1, checking: true }], waiting: [{ project: "web", root: "/r", pid: 2, at: now - 120_000 }] },
    interactive_jobs: { cap: 8, running: [{ pid: 3, at: now - 3 * 60_000, what: "cast spawn --cloud x" }], waiting: [] },
    workers: {
      device: "mac",
      rows: withQueuePositions([
        { id: "jx7run1aaa", parent: "p1", device: "mac", slot: "running", at: 0, caps, title: "a" },
        { id: "jx7que1bbb", parent: "p1", device: "mac", slot: "queued", at: now - 60_000, caps, title: "fix the thing" },
        { id: "jx7else1dd", parent: "p9", device: "linux", slot: "running", at: 0, caps, title: "x" },
      ]),
    },
  };
  const text = renderQueueReport(report, now);
  expect(text).toContain("Typecheck watchers  1/6 running, 1 waiting");
  expect(text).toContain("waiting 2m: web @ /r");
  expect(text).toContain("Interactive jobs  1/8 running");
  expect(text).toContain("3m  pid 3  cast spawn --cloud x");
  expect(text).toContain("Workers on this machine  1/2 running, 1 waiting");
  expect(text).toContain("jx7que1  queued, next, 1m  fix the thing");
  expect(text).toContain("(1 more on your other machines)");
  expect(text).toContain("interactive_jobs.per_machine");
});

test("a server that cannot be reached leaves the local queues readable", () => {
  const text = renderQueueReport({ check: { cap: 6, running: [], waiting: [] }, interactive_jobs: { cap: 8, running: [], waiting: [] }, workers: { error: "offline" } }, now);
  expect(text).toContain("Workers  unavailable: offline");
  expect(text).toContain("Typecheck watchers  0/6 running");
});

import { expect, test } from "bun:test";
import type { CloudPlacementProgress } from "@codecast/shared/contracts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { placementDurations, placementReporter, readPlacementTimings, savePlacementTimings } from "./placementProgress";

test("steps send at once, lines coalesce, and nothing goes out before the host is known", async () => {
  const sent: CloudPlacementProgress[] = [];
  let t = 1000;
  const r = placementReporter("tok", async (p) => { sent.push(p); }, () => t);
  r.step("host");
  r.line("probing hosts");
  expect(sent).toHaveLength(0);
  r.host("i-1", "dev-1", { host_id: "i-0", why: "swap 1.9 of 2.0 GB used" });
  t = 2000; r.step("wake");
  r.line("\x1b[32mstarting i-1\x1b[0m");
  r.step("wake");
  await r.flush();
  const last = sent.at(-1)!;
  expect(last).toMatchObject({ token: "tok", host_id: "i-1", host_device_id: "dev-1", moved_from: { host_id: "i-0" }, started_at: 1000 });
  expect(last.steps).toEqual([{ step: "host", at: 1000 }, { step: "wake", at: 2000 }]);
  expect(last.lines).toEqual(["probing hosts", "starting i-1"]);
});

test("a row with no park token sends nothing, and a failing send never throws", async () => {
  const none: unknown[] = [];
  const r = placementReporter(undefined, async (p) => { none.push(p); });
  r.host("i-1"); r.step("host"); await r.flush();
  expect(none).toEqual([]);
  const failing = placementReporter("tok", async () => { throw new Error("offline"); });
  failing.host("i-1"); failing.step("wake"); failing.line("x");
  await failing.flush();
});

test("every push lands in the local sink, token or not, and the saved copy outlives the server's", async () => {
  let t = 1000;
  const kept: CloudPlacementProgress[] = [];
  const r = placementReporter(undefined, async () => {}, () => t, (p) => kept.push(p));
  r.host("i-1"); t = 3000; r.step("wake"); t = 63000; r.step("checkout"); t = 70000; r.line("done"); await r.flush();
  const last = kept.at(-1)!;
  expect(last.steps.map((s) => s.step)).toEqual(["wake", "checkout"]);
  expect(placementDurations(last)).toEqual({ rows: [{ step: "start up", ms: 2000 }, { step: "wake", ms: 60000 }, { step: "checkout", ms: 7000 }], totalMs: 69000 });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "placements-"));
  process.env.CAST_PLACEMENT_TIMINGS_DIR = dir;
  try {
    savePlacementTimings("jx7abc123", { ...last, token: "secret-token" });
    savePlacementTimings("../escape", last);
    const read = readPlacementTimings();
    expect(read.map((x) => x.conversation_id)).toEqual(["jx7abc123"]);
    expect(JSON.stringify(read)).not.toContain("secret-token");
  } finally {
    delete process.env.CAST_PLACEMENT_TIMINGS_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a sink that throws never breaks the report", async () => {
  const sent: unknown[] = [];
  const r = placementReporter("tok", async (p) => { sent.push(p); }, Date.now, () => { throw new Error("disk full"); });
  r.host("i-1"); r.step("wake"); await r.flush();
  expect(sent.length).toBeGreaterThan(0);
});

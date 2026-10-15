import { expect, test } from "bun:test";
import type { CloudPlacementProgress } from "@codecast/shared/contracts";
import { placementReporter } from "./placementProgress";

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

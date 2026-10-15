import { expect, test } from "bun:test";
import type { CloudPlacementProgress } from "@codecast/shared/contracts";
import { placementSteps } from "../CloudPlacementStrip";
import { cloneHostLedger } from "../settings/AddCloudHost";

const record = (steps: CloudPlacementProgress["steps"], failed_at?: number): CloudPlacementProgress =>
  ({ token: "t", host_id: "i-1", steps, started_at: 0, lines: [], at: 0, ...(failed_at ? { failed_at } : {}) });

test("each step reached shows its duration; the current one runs to now, later ones wait", () => {
  const s = placementSteps(record([{ step: "host", at: 0 }, { step: "wake", at: 2_000 }, { step: "config", at: 5_000 }]), 65_000);
  expect(s.slice(0, 4)).toEqual([
    { step: "host", state: "done", ms: 2_000 },
    { step: "wake", state: "done", ms: 3_000 },
    { step: "config", state: "current", ms: 60_000 },
    { step: "checkout", state: "todo" },
  ]);
  expect(s.map((x) => x.step)).toEqual(["host", "wake", "config", "checkout", "seed", "worktree", "start"]);
});

test("a launch shows only when autoscale adds a host", () => {
  const launched = placementSteps(record([{ step: "host", at: 0 }, { step: "launch", at: 1_000 }]), 600_000);
  expect(launched[1]).toEqual({ step: "launch", state: "current", ms: 599_000 });
})

test("a failure marks the step it stopped in and freezes the clock there", () => {
  const s = placementSteps(record([{ step: "host", at: 0 }, { step: "seed", at: 1_000 }], 9_000), 99_999);
  expect(s.find((x) => x.step === "seed")).toEqual({ step: "seed", state: "failed", ms: 8_000 });
  // Steps passed over (a shared checkout skips the seed; here the record jumped) are not shown.
  expect(s.map((x) => x.step)).toEqual(["host", "seed", "worktree", "start"]);
});

test("the launch review prices the picked size and refuses with the laptop offline", () => {
  const l = cloneHostLedger({ like: "Cloud Linux", region: "us-west-2", laptop: "MacBook", laptopOnline: true, size: "t3.xlarge" });
  expect(l.figures.map((f) => f.value)).toEqual(["$0.17/h", "$120/mo", "16 GB"]);
  expect(l.pick).toEqual({ k: "Size", options: ["8 GB", "16 GB", "32 GB"], value: "16 GB" });
  expect(l.confirm).toBe("Launch t3.xlarge");
  expect(l.blocked).toBeUndefined();
  expect(cloneHostLedger({ like: "x", laptop: "MacBook", laptopOnline: false, size: "t3.large" }).blocked).toBe("MacBook is offline");
});

import { autoscaleLedger } from "../settings/CloudAutoscale";

test("the autoscale review prices the cap at its worst: every added host awake", () => {
  const l = autoscaleLedger({ like: "Cloud Linux", laptop: "MacBook", laptopOnline: true, maxExtra: 3, size: "t3.xlarge" });
  expect(l.figures.map((f) => f.value)).toEqual(["$0.50/h", "3", "20 min"]);
  expect(l.pick).toEqual({ k: "Up to", options: ["1 host", "2 hosts", "3 hosts"], value: "3 hosts" });
  expect(l.confirm).toBe("Turn on autoscale");
  expect(autoscaleLedger({ like: "x", laptop: "MacBook", laptopOnline: false, maxExtra: 1, size: "t3.large" }).blocked).toBe("MacBook is offline");
});

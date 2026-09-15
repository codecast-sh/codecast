import { expect, test } from "bun:test";
import { hasActiveCloudWork } from "./activity";
import { HIBERNATE_SUBAGENT_QUIET_MS } from "../hibernation";

test("quiet running tools retain the host activity lease, dormant agents do not", () => {
  expect(hasActiveCloudWork(["working"], 0)).toBe(true);
  expect(hasActiveCloudWork(["idle"], 1)).toBe(true);
  expect(hasActiveCloudWork(["idle", "stopped", "hibernated"], 0)).toBe(false);
});

test("background and in-process child work outlive the parent's Stop hook", () => {
  expect(hasActiveCloudWork(["waiting"], 0)).toBe(true);
  expect(hasActiveCloudWork(["idle"], 0, [0])).toBe(true);
  expect(hasActiveCloudWork(["dormant"], 0, [HIBERNATE_SUBAGENT_QUIET_MS - 1])).toBe(true);
  expect(hasActiveCloudWork(["done"], 0, [NaN])).toBe(true);
  expect(hasActiveCloudWork(["idle"], 0, [Infinity, HIBERNATE_SUBAGENT_QUIET_MS])).toBe(false);
});

test("resuming and compacting cannot lose the host during a quiet transition", () => {
  for (const status of ["starting", "resuming", "compacting"]) {
    expect(hasActiveCloudWork([status], 0)).toBe(true);
  }
});

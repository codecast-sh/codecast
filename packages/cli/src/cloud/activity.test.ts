import { expect, test } from "bun:test";
import { hasActiveCloudWork } from "./activity";

test("quiet running tools retain the host activity lease, dormant agents do not", () => {
  expect(hasActiveCloudWork(["working"], 0)).toBe(true);
  expect(hasActiveCloudWork(["idle"], 1)).toBe(true);
  expect(hasActiveCloudWork(["idle", "stopped", "hibernated"], 0)).toBe(false);
});

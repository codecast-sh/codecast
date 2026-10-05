import { expect, test } from "bun:test";
import { wantsInteractivePriority } from "./interactiveJob.js";

test("cloud placement and the host verbs that build, upload or mirror run at Interactive priority; everything else stays put", () => {
  expect(wantsInteractivePriority(["spawn", "--subagent", "--cloud", "i-1", "--", "task"])).toBe(true);
  expect(wantsInteractivePriority(["fork", "--cloud=i-1", "dir"])).toBe(true);
  expect(wantsInteractivePriority(["hosts", "update", "i-1"])).toBe(true);
  expect(wantsInteractivePriority(["spawn", "--subagent", "--", "--cloud"])).toBe(false);
  expect(wantsInteractivePriority(["spawn", "--subagent", "--", "task"])).toBe(false);
  expect(wantsInteractivePriority(["hosts", "ls"])).toBe(false);
  expect(wantsInteractivePriority(["sessions"])).toBe(false);
});

import { expect, test } from "bun:test";
import { jobVerdict, launchdJobState, wantsInteractivePriority } from "./interactiveJob.js";
import { EXIT_INFRA } from "./infraExit.js";

test("cloud placement and the host verbs that build, upload or mirror run at Interactive priority; everything else stays put", () => {
  expect(wantsInteractivePriority(["spawn", "--subagent", "--cloud", "i-1", "--", "task"])).toBe(true);
  expect(wantsInteractivePriority(["fork", "--cloud=i-1", "dir"])).toBe(true);
  expect(wantsInteractivePriority(["hosts", "update", "i-1"])).toBe(true);
  expect(wantsInteractivePriority(["spawn", "--subagent", "--", "--cloud"])).toBe(false);
  expect(wantsInteractivePriority(["spawn", "--subagent", "--", "task"])).toBe(false);
  expect(wantsInteractivePriority(["hosts", "ls"])).toBe(false);
  expect(wantsInteractivePriority(["sessions"])).toBe(false);
});

test("a job's own exit code passes through; a SIGKILL is the tool's failure, with a hint", () => {
  expect(jobVerdict(0, ["cast", "hosts", "update"])).toEqual({ code: 0, hint: null });
  expect(jobVerdict(3, ["cast", "hosts", "update"])).toEqual({ code: 3, hint: null });
  expect(jobVerdict(137, ["cast", "hosts", "update"])).toEqual({ code: EXIT_INFRA, hint: expect.stringContaining("most likely for memory") });
  expect(jobVerdict(127, ["/gone/cast"])).toEqual({ code: 127, hint: expect.stringContaining("`/gone/cast` or one it calls") });
  expect(jobVerdict(NaN, ["cast", "x"]).code).toBe(EXIT_INFRA);
});

test("launchctl print says whether the job runs, and how it ended when it does not", () => {
  expect(launchdJobState(0, "\tstate = running\n\tpid = 4\n")).toEqual({ running: true, detail: null });
  expect(launchdJobState(0, "\tstate = not running\n\tlast exit code = 0\n")).toEqual({ running: false, detail: "last exit code 0" });
  expect(launchdJobState(0, "\tstate = not running\n\tlast terminating signal = Killed: 9\n")).toEqual({ running: false, detail: "last signal: Killed: 9" });
  expect(launchdJobState(113, "")).toEqual({ running: false, detail: null });
  // A launchctl that timed out or failed some other way is no evidence the job ended.
  expect(launchdJobState(null, "")).toEqual({ running: true, detail: null });
  expect(launchdJobState(5, "")).toEqual({ running: true, detail: null });
  // A job still being spawned on a loaded machine has not ended.
  expect(launchdJobState(0, "\tstate = spawn scheduled\n")).toEqual({ running: true, detail: null });
});

import { expect, test } from "bun:test";
import { parseForegroundCpu, parsePsCpuTime, starvedAcross, tmuxAgentStarved } from "./daemon.js";

test("ps cpu times parse in every shape ps prints", () => {
  expect(parsePsCpuTime("4:29.36")).toBe(269_360);
  expect(parsePsCpuTime("01:02:03")).toBe(3_723_000);
  expect(parsePsCpuTime("2-01:00:00")).toBe(49 * 3_600_000);
  expect(parsePsCpuTime("-")).toBeNull();
});

// The 2026-10-26 pane: claude at background priority, runnable, 10 ms of CPU in 12 s.
const sample = (claude: string, child = "S+ 0:00.05") => parseForegroundCpu([
  " 1676  1676 1784 Ss     0:00.02",
  ` 1784  1784 1784 ${claude}`,
  ` 2125  1784 1784 ${child}`,
].join("\n"));

test("only the foreground group leader counts", () => {
  expect([...sample("R+ 4:29.36").keys()]).toEqual([1784]);
});

test("an agent is starved when it stays runnable and gains no CPU", () => {
  expect(starvedAcross(sample("R+ 4:29.36"), sample("R+ 4:29.37"))).toBe(true);
  expect(starvedAcross(sample("R+ 4:29.36"), sample("R+ 4:29.90"))).toBe(false);
  expect(starvedAcross(sample("S+ 4:29.36"), sample("S+ 4:29.36"))).toBe(false);
  expect(starvedAcross(sample("R+ 4:29.36"), sample("S+ 4:29.36"))).toBe(false);
  expect(starvedAcross(new Map(), new Map())).toBe(false);
});

test("a pane that cannot be read is never called starved", async () => {
  expect(await tmuxAgentStarved("no-such-session:0.0", 10)).toBe(false);
});

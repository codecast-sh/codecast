import { describe, expect, test } from "bun:test";
import { progressPrinter } from "./herdCommand.js";
import { formatElapsed } from "./herdTake.js";

function out(isTTY: boolean) {
  const writes: string[] = [];
  return { isTTY, write: (text: string) => { writes.push(text); }, writes, text: () => writes.join("") };
}

describe("progressPrinter", () => {
  test("not a terminal: each event is a plain line, with the time when it carries one", () => {
    const o = out(false);
    const p = progressPrinter(o);
    p.step({ message: "stopping tmux cc-x" });
    p.step({ message: "waiting for claude to come up", step: "claude-up", elapsedSec: 135 });
    p.end();
    expect(o.text()).toBe("stopping tmux cc-x\nwaiting for claude to come up · 2m15s\n");
  });

  test("a terminal: one spinner line per step, rewritten in place and written out when the step changes", () => {
    let clock = 1000;
    const o = out(true);
    const p = progressPrinter(o, () => clock);
    p.step({ message: "agent is active — waiting for the turn", step: "busy:turn" });
    clock += 7000;
    p.step({ message: "agent is active — waiting for the turn (still)", step: "busy:turn", elapsedSec: 15 });
    expect(o.text().split("\n")).toHaveLength(1);
    expect(o.writes.at(-1)).toContain("agent is active — waiting for the turn (still) · 7s");
    expect(o.writes.at(-1)).toMatch(/^\r\x1b\[2K[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /);
    p.step({ message: "stopping tmux cc-x" });
    expect(o.text()).toContain("\r\x1b[2Kagent is active — waiting for the turn (still)\n");
    p.end();
    expect(o.text().endsWith("\r\x1b[2Kstopping tmux cc-x\n")).toBe(true);
  });

  test("ending with no step writes nothing", () => {
    const o = out(true);
    progressPrinter(o).end();
    expect(o.writes).toEqual([]);
  });
});

test("formatElapsed", () => {
  expect([5, 59, 60, 135, 3600].map(formatElapsed)).toEqual(["5s", "59s", "1m00s", "2m15s", "60m00s"]);
});

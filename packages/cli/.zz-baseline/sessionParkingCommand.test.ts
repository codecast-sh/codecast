import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerSessionParkingCommands, awaitSessionCommand } from "./sessionParkingCommand";
import { countTrackedFleet, fleetCountText } from "./fleetCounts";

describe("session parking commands without daemon startup", () => {
  for (const command of ["hibernate", "wake"]) test(`${command} waits on server-issued exact command identity`, async () => {
    const calls: unknown[] = [], printed: string[] = [];
    const program = new Command();
    registerSessionParkingCommands(program, {
      print: s => printed.push(s),
      wait: async () => {},
      post: async (path, body) => {
        calls.push([path, body]);
        if (!path.endsWith("command-results")) return { short_id: "session", command_id: "authorized-command" };
        return [{ command_id: "authorized-command", command: command === "wake" ? "resume_session" : "hibernate_session", executed_at: 1, result: command === "wake" ? '{"resumed":true}' : "hibernated" }];
      },
    });
    await program.parseAsync(["bun", "cast", command, "short-session"]);
    expect(calls[0]).toEqual([`/cli/sessions/${command === "wake" ? "resume" : "hibernate"}`, { session: "short-session" }]);
    expect(calls[1]).toEqual(["/cli/sessions/command-results", { command_ids: ["authorized-command"] }]);
    expect(printed.at(-1)).toBe(command === "wake" ? "session: resumed" : "session: hibernated, resumes on send");
  });
  test("skip is reported and missing acknowledgment stays pending", async () => {
    const skipped = await awaitSessionCommand("id", { print: () => {}, post: async () => [{ command_id: "id", executed_at: 1, result: "skipped_attached", error: "not parked: attached" }] });
    expect(skipped).toEqual({ state: "skipped", message: "not parked: attached" });
    let now = 0;
    const pending = await awaitSessionCommand("id", { print: () => {}, post: async () => [], now: () => now, wait: async () => { now += 1000; }, timeoutMs: 2000 });
    expect(pending.state).toBe("pending");
    expect(pending.message).toContain("not confirmed");
  });
  test("health counts are bounded memory snapshots and unknown is not zero", () => {
    const counts = countTrackedFleet(new Set(["a", "b", "c"]), new Set(["b", "old-untracked"]), 100);
    expect(counts).toEqual({ live: 2, hibernated: 1, at: 100 });
    expect(fleetCountText(counts, "live", 101)).toBe("2");
    expect(fleetCountText({ live: 0, at: 100 }, "hibernated", 101)).toBe("unknown");
    expect(fleetCountText(undefined, "live", 101)).toBe("unknown");
    expect(fleetCountText(counts, "live", 100000)).toBe("unknown");
    expect(fleetCountText({ live: 0, at: 100 }, "live", 101)).toBe("0");
  });
});

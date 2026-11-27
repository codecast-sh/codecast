import { describe, expect, test } from "bun:test";
import { judgeTriggerPrecheck } from "@codecast/shared/contracts";
import { formatSweep, runSweep, type Sweep } from "./releaseSweepCommand";

// `cast release sweep` gates the Release Captain's hourly check: exit 0 only
// when something needs action, 1 when quiet, 2 when the sweep failed, and
// every exception names the id and the command that acts on it.

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const QUIET: Sweep = { incidents: [], late_targets: [], failed_runs: [], laggards: [], unretired: [] };
const BUSY: Sweep = {
  incidents: [{ short_id: "ct-500", title: "Change stopped at CI: CI failed", runs: [{ task_short_id: "ct-501", station: "land__ci" }, { task_short_id: "ct-502", station: "land__ci" }] }],
  late_targets: [
    { target: "web", repository: "acme/app", commits: 2, oldest_sha: "abcdef0123456789", waiting_since: NOW - 120 * MIN, deadline_ms: 30 * MIN, open: null },
    { target: "cli", repository: "acme/app", commits: 1, oldest_sha: "0123456789abcdef", waiting_since: NOW - 90 * MIN, deadline_ms: 60 * MIN, open: { short_id: "dp-9", status: "running" } },
  ],
  failed_runs: [{ task_short_id: "ct-601", flow: "change", station: "land__ci", reason: "Stopped: CI failed", failed_at: NOW - 10 * MIN }],
  laggards: [
    { device_id: "dev-ana", label: "ana-mac", owner: "Ana", own: true, cli_version: "1.1.305", floor: "1.1.306", floor_set_at: NOW - 40 * MIN },
    { device_id: "dev-bo", label: "bo-mac", owner: "Bo", own: false, cli_version: "1.1.299", floor: "1.1.306", floor_set_at: null },
  ],
  unretired: [{ short_id: "jx7done", title: "Fix checkout" }],
};

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (l: string) => out.push(l), error: (l: string) => err.push(l) };
}

describe("cast release sweep", () => {
  test("exits 0 when anything needs action, 1 when quiet, 2 when the read fails; --quiet prints nothing in any case", async () => {
    for (const [read, code] of [[async () => BUSY, 0], [async () => QUIET, 1], [async () => { throw new Error("HTTP 502"); }, 2]] as const) {
      const c = capture();
      expect(await runSweep({ read, quiet: true, log: c.log, error: c.error, now: () => NOW })).toBe(code);
      expect([...c.out, ...c.err]).toEqual([]);
    }
    const failed = capture();
    expect(await runSweep({ read: async () => { throw new Error("HTTP 502"); }, log: failed.log, error: failed.error })).toBe(2);
    expect(failed.err).toEqual(["release sweep failed: HTTP 502"]);
    const quiet = capture();
    expect(await runSweep({ read: async () => QUIET, log: quiet.log, error: quiet.error })).toBe(1);
    expect(quiet.out).toHaveLength(1);
  });

  test("one line per exception, each with its id and the command that acts", () => {
    const lines = formatSweep(BUSY, NOW);
    expect(lines).toHaveLength(7);
    expect(lines[0]).toStartWith("ct-500  incident:");
    expect(lines[0]).toContain("holds 2 runs (ct-501 at land__ci, ct-502 at land__ci)");
    expect(lines[0]).toContain("cast task done ct-500");
    expect(lines[1]).toBe("web  2 commits not live 2h after merging (deadline 30m), oldest abcdef0123  send: cast line deploy --target web --go (in a checkout of acme/app)");
    expect(lines[2]).toContain("dp-9 is running: cast line deploy show dp-9");
    expect(lines[3]).toBe("ct-601  change run failed at land__ci 10m ago: Stopped: CI failed  resume once fixed: cast workflow resume ct-601 --at land__ci");
    expect(lines[4]).toBe("ana-mac  Ana's machine runs 1.1.305, below the floor 1.1.306 for 40m  update: cast devices update ana-mac");
    expect(lines[5]).toContain("ask Bo to run: cast devices update bo-mac");
    expect(lines[6]).toBe("jx7done  live everywhere and settled, not retired: Fix checkout  retire: cast kill jx7done");
  });

  // The changes precheck wakes the captain when this output differs from the
  // last firing's, so standing exceptions must print the same every hour.
  test("--keys prints the same sorted keys for the same exceptions at any time, and new keys for new ones", async () => {
    const keysAt = async (s: Sweep, now: number) => {
      const c = capture();
      expect(await runSweep({ read: async () => s, keys: true, log: c.log, error: c.error, now: () => now })).toBe(0);
      expect(c.err).toEqual([]);
      return c.out;
    };
    const first = await keysAt(BUSY, NOW);
    expect(first).toEqual([
      "failed ct-601 land__ci 1799999400000",
      "incident ct-500",
      "lagging dev-ana below 1.1.306",
      "lagging dev-bo below 1.1.306",
      "late cli 0123456789",
      "late web abcdef0123",
      "unretired jx7done",
    ]);
    // Five hours on, the same exceptions (one more commit behind web, an open deploy on cli, another run held) print identically.
    const later: Sweep = {
      ...BUSY,
      incidents: [{ ...BUSY.incidents[0], runs: [...BUSY.incidents[0].runs, { task_short_id: "ct-503", station: null }] }],
      late_targets: [{ ...BUSY.late_targets[0], commits: 3 }, { ...BUSY.late_targets[1], open: { short_id: "dp-10", status: "queued" } }],
    };
    expect(await keysAt(later, NOW + 5 * 60 * MIN)).toEqual(first);
    // A run failing again, or a raised floor, reads as new.
    const refailed: Sweep = { ...BUSY, failed_runs: [{ ...BUSY.failed_runs[0], failed_at: NOW + 60 * MIN }], laggards: [{ ...BUSY.laggards[0], floor: "1.1.307" }] };
    const next = await keysAt(refailed, NOW + 2 * 60 * MIN);
    expect(next).toContain(`failed ct-601 land__ci ${NOW + 60 * MIN}`);
    expect(next).toContain("lagging dev-ana below 1.1.307");
    expect(next).not.toEqual(first);
    // Quiet prints no keys and exits 1, so the precheck skips and keeps its record.
    const quiet = capture();
    expect(await runSweep({ read: async () => QUIET, keys: true, log: quiet.log, error: quiet.error })).toBe(1);
    expect(quiet.out).toEqual([]);
  });

  test("read by the changes precheck, standing exceptions skip and a new one wakes", async () => {
    const firing = async (s: Sweep, now: number) => {
      const c = capture();
      const exitCode = await runSweep({ read: async () => s, keys: true, log: c.log, error: c.error, now: () => now });
      return { command: "cast release sweep --keys", exitCode, timedOut: false, durationMs: 5, stdout: c.out.map((l) => `${l}\n`).join("") };
    };
    const judge = async (s: Sweep, now: number, previous: string | undefined) => judgeTriggerPrecheck("changes", await firing(s, now), previous, (o) => o);
    const recorded = await judge(BUSY, NOW, undefined);
    expect(recorded.wake).toBe(false);
    expect((await judge(BUSY, NOW + 60 * MIN, recorded.state)).reason).toBe("precheck output unchanged");
    expect((await judge(BUSY, NOW + 24 * 60 * MIN, recorded.state)).reason).toBe("precheck output unchanged");
    const withNew: Sweep = { ...BUSY, incidents: [...BUSY.incidents, { short_id: "ct-700", title: "Main stayed red", runs: [] }] };
    const woke = await judge(withNew, NOW + 2 * 60 * MIN, recorded.state);
    expect(woke.wake).toBe(true);
    expect(woke.message).toContain("incident ct-700");
    expect((await judge(QUIET, NOW + 3 * 60 * MIN, woke.state)).reason).toBe("precheck exited 1");
  });

  test("--json prints the sweep as read", async () => {
    const c = capture();
    expect(await runSweep({ read: async () => BUSY, json: true, log: c.log, error: c.error })).toBe(0);
    expect(JSON.parse(c.out.join("\n"))).toEqual(BUSY);
  });
});

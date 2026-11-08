import "./test-helpers/isolatedTmuxServer.js";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "./proc.js";
import { tmuxRunAsync } from "./tmux.js";
import { FLEET_INVENTORY_TTL_MS } from "./tmuxFleetInventory.js";

// Real per-session tmux servers on this process's private TMUX_TMPDIR (the
// preload), listed through the fleet inventory: answers from one chained client
// per server must read exactly as the per-format clients did, and a write must
// show in the next listing.
const run = Math.random().toString(36).slice(2, 8);
const names = [0, 1, 2, 3].map((i) => `cc-claude-inv${run}${i}`);
const rawTmux = (args: string[]) => spawnSync("tmux", args, { stdio: "ignore", env: process.env }).status;
const off = { env: { CODECAST_FLEET_INVENTORY: "0" } };
const STAMP = ["list-sessions", "-F", "#{session_name}|#{@codecast_session_id}"];
const PANES = ["list-panes", "-a", "-F", "#{session_name} #{pane_pid} #{window_index}.#{pane_index}"];
const sorted = (s: string) => s.split("\n").filter(Boolean).filter((l) => l.includes(run)).sort();

setDefaultTimeout(60_000);

beforeAll(() => {
  for (const name of names) {
    expect(rawTmux(["-L", `cast-${name}`, "new-session", "-d", "-s", name, "sleep 100000"])).toBe(0);
    expect(rawTmux(["-L", `cast-${name}`, "set-option", "-q", "-t", name, "@codecast_session_id", `sid-${name}`])).toBe(0);
  }
});
afterAll(() => {
  for (const name of names) rawTmux(["-L", `cast-${name}`, "kill-server"]);
});

describe("fleet inventory against real tmux", () => {
  test("chained listings answer exactly what one client per format answers", async () => {
    const [stamp, panes] = await Promise.all([tmuxRunAsync(STAMP), tmuxRunAsync(PANES)]);
    const [stampOff, panesOff] = await Promise.all([tmuxRunAsync(STAMP, off), tmuxRunAsync(PANES, off)]);
    expect(stamp.status).toBe(0);
    // The per-format path can drop a server too busy to answer (holdsNothing),
    // so its rows are a subset; the chained answer holds every session.
    expect(sorted(stamp.stdout)).toEqual(names.map((n) => `${n}|sid-${n}`).sort());
    expect(sorted(panes.stdout).map((row) => row.split(" ")[0])).toEqual([...names].sort());
    for (const row of sorted(stampOff.stdout)) expect(sorted(stamp.stdout)).toContain(row);
    for (const row of sorted(panesOff.stdout)) expect(sorted(panes.stdout)).toContain(row);
    // Asked again after the window, both formats ride in one chained client.
    await new Promise((r) => setTimeout(r, FLEET_INVENTORY_TTL_MS + 100));
    expect(sorted((await tmuxRunAsync(PANES)).stdout)).toEqual(sorted(panes.stdout));
    expect(sorted((await tmuxRunAsync(STAMP)).stdout)).toEqual(sorted(stamp.stdout));
  });

  test("this process's writes show in the very next listing", async () => {
    await tmuxRunAsync(STAMP);
    expect((await tmuxRunAsync(["set-option", "-q", "-t", names[0], "@codecast_session_id", "changed"])).status).toBe(0);
    expect(sorted((await tmuxRunAsync(STAMP)).stdout)).toContain(`${names[0]}|changed`);
    expect((await tmuxRunAsync(["kill-session", "-t", names[3]])).status).toBe(0);
    expect((await tmuxRunAsync(STAMP)).stdout).not.toContain(names[3]);
  });

  test("another process's writes show once the window has passed", async () => {
    await tmuxRunAsync(STAMP);
    expect(rawTmux(["-L", `cast-${names[1]}`, "new-session", "-d", "-s", `${names[1]}x`, "sleep 100000"])).toBe(0);
    await new Promise((r) => setTimeout(r, FLEET_INVENTORY_TTL_MS + 100));
    expect((await tmuxRunAsync(STAMP)).stdout).toContain(`${names[1]}x|`);
  });
});

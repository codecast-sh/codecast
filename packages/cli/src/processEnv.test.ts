import { describe, expect, test } from "bun:test";
import { envSessionLookup, followsCredentialStore, parseProcArgs2, tmuxEnvNamesSession, tmuxSessionEnvUpdates } from "./processEnv";
import { attributeProcesses, listedProcesses, processesStartedOutside, summarizeProcesses } from "./systemResources";
import type { ResourceProcess } from "@codecast/shared/contracts";

const procargs = (args: string[], env: string[]) => {
  const body = Buffer.from(["/bin/bash", "", "", ...args, ...env, ""].join("\0") + "\0");
  const argc = Buffer.alloc(4); argc.writeInt32LE(args.length);
  return new Uint8Array(Buffer.concat([argc, body]));
};

describe("session from inherited environment", () => {
  test("parses KERN_PROCARGS2 past argv, keeping only the keys it needs", () => {
    expect(parseProcArgs2(procargs(["bash", "-c", "A=1 ffmpeg"], ["HOME=/x", "CLAUDE_CODE_SESSION_ID=s1", "TMUX=/tmp/t,900,0"])))
      .toEqual({ CLAUDE_CODE_SESSION_ID: "s1", TMUX: "/tmp/t,900,0" });
  });

  test("a backgrounded job reparented to init is the session's, marked detached", () => {
    const snapshot = new Map([
      [10, { pid: 10, ppid: 1, cpu: 1, rss: 100, command: "claude" }],
      [20, { pid: 20, ppid: 1, cpu: 80, rss: 50, command: "ffmpeg" }],
      [30, { pid: 30, ppid: 1, cpu: 5, rss: 50, command: "WindowServer" }],
      [40, { pid: 40, ppid: 1, cpu: 5, rss: 50, command: "claude" }],
    ]);
    const sessions = new Map([["s1", 10]]);
    const env: Record<number, Record<string, string>> = { 20: { CLAUDE_CODE_SESSION_ID: "s1" }, 40: { CLAUDE_CODE_SESSION_ID: "s1" } };
    const rows = attributeProcesses(snapshot, sessions, envSessionLookup(snapshot, sessions, (pid) => env[pid] ?? {}, 0));
    expect(rows.map((p) => [p.pid, p.sessionId, p.detached])).toEqual([[10, "s1", undefined], [20, "s1", "background"], [30, undefined, undefined], [40, undefined, undefined]]);
  });

  test("an id every tmux pane inherits from the server names no session", () => {
    const snapshot = new Map([
      [10, { pid: 10, ppid: 1, cpu: 1, rss: 100, command: "claude" }],
      [900, { pid: 900, ppid: 1, cpu: 0, rss: 10, command: "tmux" }],
      [21, { pid: 21, ppid: 900, cpu: 9, rss: 10, command: "bun" }],
      [22, { pid: 22, ppid: 1, cpu: 9, rss: 10, command: "bun" }],
    ]);
    const sessions = new Map([["s1", 10]]);
    const env: Record<number, Record<string, string>> = {
      900: { CLAUDE_CODE_SESSION_ID: "s1" },
      21: { CLAUDE_CODE_SESSION_ID: "s1", TMUX: "/tmp/t,900,0" },
      22: { CLAUDE_CODE_SESSION_ID: "s1", TMUX: "/tmp/t,900,3" },
    };
    const lookup = envSessionLookup(snapshot, sessions, (pid) => env[pid] ?? {}, 0);
    expect(lookup(snapshot.get(21)!)).toBeUndefined();
    // Reparented out of the pane (pid 22 escaped to init) yet still carrying the server's id: still not evidence.
    expect(lookup(snapshot.get(22)!)).toBeUndefined();
  });
});

describe("what a move stops", () => {
  const snapshot = new Map([
    [10, { pid: 10, ppid: 1, cpu: 1, rss: 100, command: "claude" }],
    [11, { pid: 11, ppid: 10, cpu: 1, rss: 100, command: "bash" }],
    [20, { pid: 20, ppid: 1, cpu: 80, rss: 50, command: "ffmpeg" }],
    [900, { pid: 900, ppid: 1, cpu: 0, rss: 10, command: "tmux" }],
    [30, { pid: 30, ppid: 900, cpu: 9, rss: 10, command: "bun" }],
    [50, { pid: 50, ppid: 1, cpu: 9, rss: 10, command: "claude" }],
    [51, { pid: 51, ppid: 50, cpu: 9, rss: 10, command: "node" }],
    [70, { pid: 70, ppid: 1, cpu: 1, rss: 10, command: "bun" }],
    [71, { pid: 71, ppid: 70, cpu: 1, rss: 10, command: "git" }],
  ]);
  const env: Record<number, Record<string, string>> = {
    20: { CLAUDE_CODE_SESSION_ID: "gone" },
    30: { CLAUDE_CODE_SESSION_ID: "gone", TMUX: "/tmp/t,900,4" },
    // A subagent the moved session spawned carries its id but is a session of its own, and so is its tree.
    50: { CLAUDE_CODE_SESSION_ID: "gone" },
    51: { CLAUDE_CODE_SESSION_ID: "gone" },
    // The daemon (pid 70) was started from the moved session's shell.
    70: { CLAUDE_CODE_SESSION_ID: "gone" },
    71: { CLAUDE_CODE_SESSION_ID: "gone" },
  };
  test("background jobs and tmux work stop; other sessions and the daemon's children do not", () => {
    const stops = processesStartedOutside(snapshot, new Map([["sub", 50], ["gone", 10]]), "gone", (pid) => env[pid] ?? {}, 70);
    expect(stops.map((p) => [p.pid, p.detached])).toEqual([[20, "background"], [30, "tmux"]]);
  });
  test("while the agent still runs, its own tree (an MCP server in its pane) is not listed as outside", () => {
    const withTree = new Map(snapshot).set(12, { pid: 12, ppid: 10, cpu: 1, rss: 10, command: "paper" });
    const env2: Record<number, Record<string, string>> = { ...env, 12: { CLAUDE_CODE_SESSION_ID: "gone", TMUX: "/tmp/t,900,1" } };
    const stops = processesStartedOutside(withTree, new Map([["sub", 50], ["gone", 10]]), "gone", (pid) => env2[pid] ?? {}, 70);
    expect(stops.map((p) => p.pid)).toEqual([20, 30]);
  });
});

describe("tmux", () => {
  test("a tmux server an agent's shell started is never that agent's to stop", () => {
    const snapshot = new Map([[900, { pid: 900, ppid: 1, cpu: 1, rss: 10, command: "tmux -S /tmp/x start-server" }]]);
    expect(envSessionLookup(snapshot, new Map([["s1", 10]]), () => ({ CLAUDE_CODE_SESSION_ID: "s1" }), 0)(snapshot.get(900)!)).toBeUndefined();
  });
  test("the server learns to copy each session id variable once", () => {
    expect(tmuxSessionEnvUpdates("DISPLAY\nSSH_AUTH_SOCK\nCLAUDE_CODE_SESSION_ID\n").map((a) => a[3])).toEqual(["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODECAST_SESSION_ID", "CODECAST_MANAGED_SESSION"]);
    expect(tmuxSessionEnvUpdates("CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID CODEX_SESSION_ID CODECAST_SESSION_ID CODECAST_MANAGED_SESSION")).toEqual([]);
  });
  test("a tmux session whose environment carries the id was created by that agent", () => {
    expect(tmuxEnvNamesSession("-DISPLAY\nCLAUDE_CODE_SESSION_ID=s1\n-SSH_AUTH_SOCK", "s1")).toBe(true);
    expect(tmuxEnvNamesSession("-CLAUDE_CODE_SESSION_ID\nDISPLAY=:0", "s1")).toBe(false);
  });
});

describe("listed processes", () => {
  test("busy small processes are named as readily as large idle ones", () => {
    const rows: ResourceProcess[] = [
      ...Array.from({ length: 300 }, (_, i) => ({ pid: 1000 + i, ppid: 1, name: "big", kind: "app" as const, cpu: 0, rss: 1e9 + i })),
      { pid: 1, ppid: 1, name: "ffmpeg", kind: "tool", cpu: 90, rss: 1 },
    ];
    const listed = listedProcesses(rows).map((p) => p.name);
    expect(listed).toHaveLength(256);
    expect(listed).toContain("ffmpeg");
    expect(summarizeProcesses(rows).omittedProcessCount).toBe(45);
  });

  test("every session keeps its top process when busier ones fill the list", () => {
    const rows: ResourceProcess[] = [
      ...Array.from({ length: 300 }, (_, i) => ({ pid: 1000 + i, ppid: 1, name: "big", kind: "app" as const, cpu: 5, rss: 1e9 + i })),
      ...Array.from({ length: 40 }, (_, i) => ({ pid: 5000 + i, ppid: 1, name: `claude-${i}`, kind: "agent" as const, cpu: 0, rss: 1e6, sessionId: `s${i}` })),
      { pid: 6000, ppid: 5000, name: "claude-0-child", kind: "tool", cpu: 0, rss: 1, sessionId: "s0" },
    ];
    const listed = listedProcesses(rows);
    expect(listed).toHaveLength(256);
    expect(new Set(listed.filter((p) => p.sessionId).map((p) => p.sessionId)).size).toBe(40);
    expect(listed.map((p) => p.name)).toContain("claude-0");
    expect(listed.map((p) => p.name)).not.toContain("claude-0-child");
  });
});

describe("followsCredentialStore", () => {
  const fleet = "/Users/x/.codecast/cc-fleet";
  test("a launched session on the store follows it", () => {
    expect(followsCredentialStore(1, fleet, () => parseProcArgs2(procargs(["claude"], [`CLAUDE_SECURESTORAGE_CONFIG_DIR=${fleet}`])))).toBe(true);
  });
  test("a claude started by hand reads the keychain and does not follow", () => {
    expect(followsCredentialStore(1, fleet, () => parseProcArgs2(procargs(["claude", "--resume", "s1"], ["HOME=/Users/x", "TERM_PROGRAM=iTerm.app"])))).toBe(false);
  });
  test("a session pinned to another profile's store does not follow", () => {
    expect(followsCredentialStore(1, fleet, () => ({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "/Users/x/.codecast/cc-store/p1" }))).toBe(false);
  });
  test("a session carrying an OAuth token runs on it, not on the store", () => {
    expect(followsCredentialStore(1, fleet, () => parseProcArgs2(procargs(["claude"], [`CLAUDE_SECURESTORAGE_CONFIG_DIR=${fleet}`, "CLAUDE_CODE_OAUTH_TOKEN=t"])))).toBe(false);
  });
  test("an unreadable environment is unknown", () => {
    expect(followsCredentialStore(1, fleet, () => null)).toBeUndefined();
  });
});

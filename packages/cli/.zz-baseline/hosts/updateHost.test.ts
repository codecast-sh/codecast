import { expect, test } from "bun:test";
import type { RemoteHost } from "../remote/session-move.js";
import { castForPrepare, hostCastPlatform } from "./updateHost.js";

const host = { user: "ubuntu", address: "10.0.0.1", keyPath: "/k" } as RemoteHost;

function run(laptop: string, current: string | null, update: () => any = () => ({ version: laptop, restart: { pid: "42" } })) {
  const calls: Array<{ platform: string; restart: boolean }> = [];
  const lines: string[] = [];
  const line = castForPrepare(host, "linux", (m) => lines.push(m), {
    laptop: () => laptop,
    read: () => current,
    update: (_h, platform, opts) => { calls.push({ platform, restart: opts.restart }); return update(); },
  });
  return { line, calls, lines };
}

test("a host behind the laptop is updated and its daemon restarted onto the new build", () => {
  const r = run("1.1.169", "1.1.160");
  expect(r.calls).toEqual([{ platform: "linux", restart: true }]);
  expect(r.line).toBe("host cast updated to 1.1.169 and its daemon restarted onto it");
});

test("an equal or newer host is left alone: no downgrade, no flapping between worktrees at one version", () => {
  expect(run("1.1.169", "1.1.169").calls).toEqual([]);
  expect(run("1.1.160", "1.1.169").calls).toEqual([]);
  expect(run("1.1.160", "1.1.169").line).toBe("cast 1.1.169 on the host");
});

test("a host with no cast gets one; a refused restart and a failed install are reported, never thrown", () => {
  expect(run("1.1.169", null).calls.length).toBe(1);
  expect(run("1.1.169", "1.1.160", () => ({ version: "1.1.169", restart: { refused: "sessions" } })).line).toContain("keeps the old build until its sessions can stop");
  expect(run("1.1.169", "1.1.160", () => { throw new Error("scp failed"); }).line).toBe("host cast update failed, keeping 1.1.160: scp failed");
});

test("a Mac host is updated without a restart, which would end its sessions", () => {
  const calls: boolean[] = [];
  castForPrepare(host, "darwin", () => {}, { laptop: () => "2.0.0", read: () => "1.0.0", update: (_h, _p, opts) => { calls.push(opts.restart); return { version: "2.0.0" }; } });
  expect(calls).toEqual([false]);
  expect(hostCastPlatform({ provider: "scaleway-mac" })).toBe("darwin");
  expect(hostCastPlatform({ platform: "darwin" })).toBe("darwin");
  expect(hostCastPlatform({ provider: "aws" })).toBe("linux");
});

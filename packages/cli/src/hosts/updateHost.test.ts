import { expect, test } from "bun:test";
import type { RemoteHost } from "../remote/session-move.js";
import { castForPrepare, hostCastPlatform } from "./updateHost.js";
import { HostCastBehind, type CastRelease } from "./installRelease.js";

const host = { user: "ubuntu", address: "10.0.0.1", keyPath: "/k" } as RemoteHost;
const release = (version: string): CastRelease => ({ version, binaries: {} });

/** castForPrepare against a fake host: `versions` are what it reports on each read. */
function run(laptop: string, versions: Array<string | null>, opts: { update?: () => any; release?: (v: string) => CastRelease; platform?: "linux" | "darwin" } = {}) {
  const calls: Array<{ platform: string; restart: boolean; release?: string }> = [];
  const lines: string[] = [];
  const reads = [...versions];
  const call = () => castForPrepare(host, opts.platform ?? "linux", (m) => lines.push(m), {
    laptop: () => laptop,
    read: () => (reads.length > 1 ? reads.shift()! : reads[0]),
    release: opts.release ?? release,
    update: (_h, platform, o) => {
      calls.push({ platform, restart: o.restart, release: o.release?.version });
      return (opts.update ?? (() => ({ version: o.release!.version, restart: { pid: "42" } })))();
    },
  });
  return { call, calls, lines };
}

test("a host behind this laptop gets exactly the laptop's release, proven by reading it back", () => {
  const r = run("1.1.213", ["1.1.200", "1.1.213"]);
  expect(r.call()).toBe("host cast updated to 1.1.213 and its daemon restarted onto it");
  expect(r.calls).toEqual([{ platform: "linux", restart: true, release: "1.1.213" }]);
});

test("a host at or ahead of the laptop is left alone: never a downgrade", () => {
  const same = run("1.1.213", ["1.1.213"]);
  expect(same.call()).toBe("cast 1.1.213 on the host");
  const ahead = run("1.1.200", ["1.1.213"]);
  expect(ahead.call()).toBe("cast 1.1.213 on the host, ahead of this laptop's 1.1.200");
  expect([...same.calls, ...ahead.calls]).toEqual([]);
});

test("a host that cannot be brought to the laptop's version stops everything, loudly", () => {
  const unfetchable = run("1.1.213", ["1.1.200"], { release: () => { throw new Error("no published release objects"); } });
  expect(unfetchable.call).toThrow(HostCastBehind);
  expect(unfetchable.call).toThrow("cast 1.1.213 could not be fetched: no published release objects");
  expect(unfetchable.calls).toEqual([]);
  expect(run("1.1.213", ["1.1.200"], { update: () => { throw new Error("scp failed"); } }).call).toThrow("installing 1.1.213 failed: scp failed");
  // Installed, but the host still answers with another version.
  expect(run("1.1.213", ["1.1.200", "1.1.200"]).call).toThrow("after installing 1.1.213 it reports 1.1.200");
  expect(run("1.1.213", [null]).call).toThrow("the host runs cast none, behind this laptop's 1.1.213");
});

test("a refused daemon restart is reported, not thrown: the host's cast is right, its daemon moves later", () => {
  const r = run("1.1.213", ["1.1.200", "1.1.213"], { update: () => ({ version: "1.1.213", restart: { refused: "sessions" } }) });
  expect(r.call()).toContain("keeps the old build until its sessions can stop");
});

test("a Mac host is updated without a restart, which would end its sessions", () => {
  const r = run("2.0.0", ["1.0.0", "2.0.0"], { platform: "darwin", update: () => ({ version: "2.0.0" }) });
  r.call();
  expect(r.calls).toEqual([{ platform: "darwin", restart: false, release: "2.0.0" }]);
  expect(hostCastPlatform({ provider: "scaleway-mac" })).toBe("darwin");
  expect(hostCastPlatform({ platform: "darwin" })).toBe("darwin");
  expect(hostCastPlatform({ provider: "aws" })).toBe("linux");
});

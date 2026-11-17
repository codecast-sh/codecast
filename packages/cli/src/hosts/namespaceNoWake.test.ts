import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { writeHosts, type CloudHost } from "../browser/cloudHost";
import { saveRecord } from "../run/records";
import { FAKE_BOX, installFakeNamespace } from "../test-helpers/fakeNamespace";
import { buildHostsCommand } from "./cli";

const PROXY = "/b/devbox ssh-proxy cast-box";
const host: CloudHost = {
  id: "box123", provider: "namespace", region: "iad", platform: "linux", user: "devbox", keyPath: "/k/cast-box.key",
  address: "cast-box", proxyCommand: PROXY,
};
const NOT_DIALED = "not dialed (no open connection)";

let root: string, fake: ReturnType<typeof installFakeNamespace>, lines: string[], log: ReturnType<typeof spyOn>;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cast-nswake-"));
  fake = installFakeNamespace(root, { ssh: true });
  for (const k of ["HOME", "PATH", "FAKE_NS", "CODECAST_DIR"]) saved[k] = process.env[k];
  process.env.HOME = fake.home;
  process.env.PATH = `${fake.bin}:${saved.PATH}`;
  process.env.FAKE_NS = fake.state;
  process.env.CODECAST_DIR = path.join(root, "codecast");
  fs.mkdirSync(process.env.CODECAST_DIR, { recursive: true });
  writeHosts([host]);
  fake.set("devbox-list", JSON.stringify([FAKE_BOX]));
  fake.set("nsc-list", JSON.stringify([{ created_at: "2026-11-17T10:00:00Z" }]));
  lines = [];
  log = spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
});

afterEach(() => {
  log.mockRestore();
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  fs.rmSync(root, { recursive: true, force: true });
});

const sshArgv = () => fake.argv().filter((a) => a[0] === "ssh");
const isMuxCheck = (a: string[]) => a.slice(-3, -1).join(" ") === "-O check";
const cast = (...argv: string[]) => {
  const program = new Command().exitOverride();
  buildHostsCommand(program);
  return program.parseAsync(["hosts", ...argv], { from: "user" });
};

describe("cast hosts ls on a running Devbox", () => {
  const report = async () => {
    await cast("_report", "box123");
    return JSON.parse(lines.at(-1)!);
  };

  test("with no control master open it reads state from nsc and opens no connection", async () => {
    fake.set("ssh-fail");
    const r = await report();
    expect(r.state).toBe("running");
    expect([r.worktreesNote, r.mirrorNote, r.toolsNote].map((n: string) => n.includes(NOT_DIALED))).toEqual([true, true, true]);
    expect(r.device.note).toContain(NOT_DIALED);
    expect(sshArgv().length).toBeGreaterThan(0);
    expect(sshArgv().every(isMuxCheck)).toBe(true);
  });

  test("with a control master open it reads the box over it", async () => {
    const r = await report();
    expect(`${r.worktreesNote ?? ""}${r.mirrorNote ?? ""}${r.toolsNote ?? ""}`).not.toContain(NOT_DIALED);
    expect(sshArgv().some((a) => !isMuxCheck(a))).toBe(true);
  });
});

describe("cast hosts sync <id> --dry-run on a sleeping Devbox", () => {
  test("previews against the box's home without dialing it", async () => {
    fake.set("ssh-fail");
    await cast("sync", "box123", "--dry-run", "--json");
    expect(JSON.parse(lines.join("\n")).target_home).toBe("/home/devbox");
    expect(sshArgv().every(isMuxCheck)).toBe(true);
  });
});

const castRun = async (...args: string[]) => {
  const { stdout } = await promisify(execFile)(process.execPath, [path.resolve(import.meta.dir, "../index.ts"), "run", ...args], {
    env: { ...process.env, HOME: fake.home, FAKE_NS: fake.state, CODECAST_DIR: process.env.CODECAST_DIR! }, timeout: 60_000,
  });
  return stdout;
};

describe("cast run show on a sleeping Devbox", () => {
  const show = async (...flags: string[]) => {
    saveRecord({
      id: "rabc1234", host: { id: "box123", address: "cast-box", user: "devbox", keyPath: "/k/cast-box.key", proxyCommand: PROXY },
      repo: "r", seedCwd: "/s", cwdRel: "", argv: ["bun", "test"], outputs: [], sha: "0123456789abcdef", base: "b", dirty: false, createdAt: Date.now(), timings: {},
    });
    return castRun("show", "rabc1234", ...flags);
  };

  test("says the host is asleep and asks it nothing", async () => {
    fake.set("ssh-fail");
    fake.set("nsc-list", "null");
    expect(await show()).toContain("unknown: box123 is asleep");
    expect(sshArgv().every(isMuxCheck)).toBe(true);
  }, 90_000);

  test("with a control master open it reads the run's state from the host", async () => {
    await show();
    expect(sshArgv().some((a) => !isMuxCheck(a))).toBe(true);
  }, 90_000);

  test("a running box with no control master is not called asleep by a fresh process", async () => {
    fake.set("ssh-fail");
    expect(await show()).not.toContain("asleep");
  }, 90_000);
});

describe("cast run hosts in a fresh process", () => {
  test("lists a running Devbox that has no control master open", async () => {
    fake.set("ssh-fail");
    expect(await castRun("hosts")).toContain("box123");
  }, 90_000);

  test("leaves out a Devbox nsc does not list as running", async () => {
    fake.set("ssh-fail");
    fake.set("nsc-list", "null");
    expect(await castRun("hosts")).not.toContain("box123");
  }, 90_000);
});

describe("the daemon's reach removal", () => {
  test("is gated on dialsWithoutWaking like every other dial it makes", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dir, "../daemon.ts"), "utf-8");
    expect(src).toContain('if (host?.address && !host.reach?.some((f) => f.path === folder) && dialsWithoutWaking(host)) {\n        spawn("ssh", reachRemoveArgs(');
  });
});

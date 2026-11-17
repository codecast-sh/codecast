import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { readHosts, type CloudHost } from "../browser/cloudHost";
import { registeredHostId } from "../cloud/autoscale";
import { FAKE_BOX, installFakeNamespace } from "../test-helpers/fakeNamespace";
import { buildHostsCommand } from "./cli";
import { buildCloudHostReport } from "../cloud/hostReports";
import { hostRunLimit, parseMaxRun, runLimitText } from "./namespaceCli";

let root: string, fake: ReturnType<typeof installFakeNamespace>, lines: string[], log: ReturnType<typeof spyOn>;
const saved: Record<string, string | undefined> = {};
const keyFile = () => path.join(fake.home, ".namespace", "ssh", "cast-box.devbox.namespace.key");
const sshFile = () => keyFile().replace(/\.key$/, ".ssh");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cast-nscli-"));
  fake = installFakeNamespace(root);
  for (const k of ["HOME", "FAKE_NS", "CODECAST_DIR"]) saved[k] = process.env[k];
  process.env.HOME = fake.home;
  process.env.FAKE_NS = fake.state;
  process.env.CODECAST_DIR = path.join(root, "codecast");
  lines = [];
  log = spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
});

afterEach(() => {
  log.mockRestore();
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  fs.rmSync(root, { recursive: true, force: true });
});

const cast = (...argv: string[]) => {
  const program = new Command().exitOverride();
  buildHostsCommand(program);
  return program.parseAsync(["hosts", ...argv], { from: "user" });
};

function installBox(): void {
  fake.set("devbox-list", JSON.stringify([FAKE_BOX]));
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  fs.writeFileSync(keyFile(), "");
  fs.writeFileSync(sshFile(), "");
}

const REGISTERED = (home: string): CloudHost => ({
  id: "box123", provider: "namespace", region: "iad", platform: "linux", user: "devbox",
  keyPath: path.join(home, ".namespace", "ssh", "cast-box.devbox.namespace.key"), address: "cast-box",
  proxyCommand: `${path.join(home, ".local", "bin", "devbox")} ssh-proxy cast-box`,
});

describe("cast hosts add --provider namespace", () => {
  test("registers the box by name with its generated key and proxy, and no --key", async () => {
    installBox();
    await cast("add", "--provider", "namespace", "cast-box");
    expect(readHosts()).toEqual([REGISTERED(fake.home)]);
    expect(lines.join("\n")).toContain("registered box123 (Linux, stopped)");
    expect(fake.calls().map((c) => c.slice(0, 2).join(" "))).toEqual(["devbox list", "nsc list"]);
  });

  test("--max-run is kept as minutes and a re-add keeps the rest of the entry", async () => {
    installBox();
    await cast("add", "--provider", "namespace", "cast-box", "--max-run", "1h30m");
    expect(readHosts()[0]).toMatchObject({ ...REGISTERED(fake.home), maxRunMinutes: 90 });
    await cast("add", "--provider", "namespace", "cast-box");
    expect(readHosts()[0]!.maxRunMinutes).toBe(90);
  });

  test("changing --max-run on a registered host without --provision says the host needs provisioning", async () => {
    installBox();
    await cast("add", "--provider", "namespace", "cast-box", "--max-run", "90m");
    expect(lines.join("\n")).not.toContain("cast hosts provision");
    await cast("add", "--provider", "namespace", "cast-box", "--max-run", "90m");
    expect(lines.join("\n")).not.toContain("cast hosts provision");
    await cast("add", "--provider", "namespace", "cast-box", "--max-run", "2h");
    expect(lines.filter((l) => l.includes("cast hosts provision box123` is needed"))).toHaveLength(1);
    expect(readHosts()[0]!.maxRunMinutes).toBe(120);
  });

  test("a name devbox does not list is an error, and so is a missing key file", async () => {
    await expect(cast("add", "--provider", "namespace", "cast-box")).rejects.toThrow("no Devbox named cast-box");
    fake.set("devbox-list", JSON.stringify([FAKE_BOX]));
    await expect(cast("add", "--provider", "namespace", "cast-box")).rejects.toThrow("devbox configure-ssh cast-box");
    expect(readHosts()).toEqual([]);
  });

  test("an aws-only flag is refused", async () => {
    installBox();
    await expect(cast("add", "--provider", "namespace", "cast-box", "--key", "/k")).rejects.toThrow("--key does not apply");
  });
});

describe("cast hosts create --provider namespace", () => {
  test("runs devbox create with the 5 minute idle stop, registers the box and prints the Registered line", async () => {
    await cast("create", "linux", "--provider", "namespace", "--name", "cast-box", "--no-provision", "--max-run", "4h");
    expect(fake.calls().find((c) => c[1] === "create")).toEqual([
      "devbox", "create", "--name", "cast-box", "--size", "s", "--no_checkout", "--image", "builtin:default", "--auto_stop_idle_timeout", "5m",
    ]);
    expect(readHosts()).toEqual([{ ...REGISTERED(fake.home), maxRunMinutes: 240 }]);
    expect(lines).toContain("Registered box123. Resume setup with: cast hosts provision box123");
    expect(registeredHostId(lines.at(-1)!)).toBe("box123");
  });

  test("--type is the Devbox size, and the default name is generated", async () => {
    await cast("create", "linux", "--provider", "namespace", "--type", "xl", "--no-provision");
    const create = fake.calls().find((c) => c[1] === "create")!;
    expect(create[create.indexOf("--size") + 1]).toBe("xl");
    expect(create[3]).toMatch(/^cast-[0-9a-f]{6}$/);
    await expect(cast("create", "linux", "--provider", "namespace", "--type", "t3.large", "--no-provision")).rejects.toThrow("Devbox size");
  });

  test("a dry run creates and registers nothing", async () => {
    await cast("create", "linux", "--provider", "namespace", "--name", "cast-box", "--dry-run");
    expect(fake.calls()).toEqual([]);
    expect(readHosts()).toEqual([]);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ provider: "namespace", name: "cast-box", size: "s" });
  });

  test("an existing name, a Mac, an aws flag and --max-run on aws are refused", async () => {
    fake.set("devbox-list", JSON.stringify([FAKE_BOX]));
    await expect(cast("create", "linux", "--provider", "namespace", "--name", "cast-box", "--no-provision")).rejects.toThrow("already exists");
    await expect(cast("create", "mac", "--provider", "namespace", "--no-provision")).rejects.toThrow("Linux host");
    await expect(cast("create", "linux", "--provider", "namespace", "--subnet", "subnet-1", "--no-provision")).rejects.toThrow("--subnet does not apply");
    await expect(cast("create", "linux", "--max-run", "4h")).rejects.toThrow("--max-run is for --provider namespace");
    expect(fake.calls().some((c) => c[1] === "create")).toBe(false);
  });
});

describe("cast hosts rm for a Namespace host", () => {
  test("forgets the entry and removes the two generated ssh files, with one line on restoring them", async () => {
    installBox();
    await cast("add", "--provider", "namespace", "cast-box");
    await cast("rm", "box123");
    expect(readHosts()).toEqual([]);
    expect(fs.existsSync(keyFile())).toBe(false);
    expect(fs.existsSync(sshFile())).toBe(false);
    expect(lines.filter((l) => l.includes("configure-ssh"))).toHaveLength(1);
    expect(fake.calls().some((c) => c[0] === "devbox" && c[1] !== "list")).toBe(false);
  });

  test("cli.ts has no branch on the provider name for it", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "cli.ts"), "utf-8");
    expect(src).not.toContain('h.provider === "namespace"');
  });
});

describe("--max-run durations", () => {
  test("hours, minutes and both", () => {
    expect([parseMaxRun("4h"), parseMaxRun("90m"), parseMaxRun("1h30m"), parseMaxRun("0h45m"), parseMaxRun("31m")]).toEqual([240, 90, 90, 45, 31]);
  });

  test("a limit that leaves no room before the 30 minute warning is refused", () => {
    for (const short of ["30m", "0h30m", "1m", "29m"]) expect(() => parseMaxRun(short)).toThrow("must be longer than 30 minutes");
  });

  test("the stored ProxyCommand quotes a devbox path that needs it", async () => {
    const spaced = path.join(fake.home, "my bin");
    fs.mkdirSync(spaced);
    fs.copyFileSync(path.join(fake.bin, "devbox"), path.join(spaced, "devbox"));
    fs.chmodSync(path.join(spaced, "devbox"), 0o755);
    fs.rmSync(path.join(fake.bin, "devbox"));
    const prev = process.env.PATH;
    process.env.PATH = `${spaced}:${prev}`;
    try {
      const { namespaceHost } = await import("./namespaceCli");
      expect(namespaceHost(FAKE_BOX, undefined, undefined).proxyCommand).toBe(`'${spaced}/devbox' ssh-proxy cast-box`);
    } finally {
      process.env.PATH = prev;
    }
  });

  test("anything else is refused", () => {
    for (const bad of ["", "0m", "90", "1.5h", "1m30h", "-1h", "4 h"]) expect(() => parseMaxRun(bad)).toThrow("--max-run is a duration");
  });
});

describe("autoscale's registered-host id", () => {
  test("reads an EC2 id and a Devbox id, and nothing else", () => {
    expect(registeredHostId("Registered i-0123abc. Resume setup with: cast hosts provision i-0123abc")).toBe("i-0123abc");
    expect(registeredHostId("Registered box123. Resume setup with: cast hosts provision box123")).toBe("box123");
    expect(registeredHostId("Registered managed session (tmux: x)")).toBeUndefined();
    expect(registeredHostId("registered i-1 (Linux, running)")).toBeUndefined();
  });
});

describe("the run limit on `cast hosts ls` and the host report", () => {
  const MIN = 60_000;
  const limited: CloudHost = { ...REGISTERED("/h"), maxRunMinutes: 240 };
  const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

  test("time left counts from the instance's start, and a host with no limit reports none", () => {
    const now = Date.parse("2026-11-17T12:00:00Z");
    expect(hostRunLimit(limited, now - 215 * MIN, now)).toEqual({ runLimit: { maxMinutes: 240, minutesLeft: 25 } });
    expect(hostRunLimit(limited, undefined, now)).toEqual({ runLimit: { maxMinutes: 240 } });
    expect(hostRunLimit(limited, now - 300 * MIN, now)).toEqual({ runLimit: { maxMinutes: 240, minutesLeft: 0 } });
    expect(hostRunLimit({ ...limited, maxRunMinutes: undefined }, now, now)).toEqual({});
  });

  test("the line names the limit and the time left", () => {
    expect(strip(runLimitText({ maxMinutes: 240, minutesLeft: 25 }))).toBe("limit 4h, 25 min left");
    expect(strip(runLimitText({ maxMinutes: 90 }))).toBe("limit 90m");
  });

  test("the cloud host report carries max_run_minutes for a limited host only", () => {
    installBox();
    const at = Date.now();
    const report = (host: Partial<CloudHost>) => buildCloudHostReport({ ...REGISTERED(fake.home), ...host }, "laptop", at);
    expect(report({ maxRunMinutes: 240 }).max_run_minutes).toBe(240);
    expect(report({})).not.toHaveProperty("max_run_minutes");
  });
});

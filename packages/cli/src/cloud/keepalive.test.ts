import { afterEach, beforeEach, describe, expect, spyOn, test, setDefaultTimeout, type Mock } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { buildHostsCommand } from "../hosts/cli.js";
import { createHostKeepalive, registerHostKeepaliveCommand, type KeepaliveOptions } from "./keepalive.js";
import { baseProvisionScript, idleWatchdogScript } from "../browser/provisionLinux.js";
import { cloudIdleProbeScript } from "./idleProbe.js";

const scratch: string[] = [];
const now = Date.parse("2026-09-14T12:00:00.987Z");
setDefaultTimeout(30_000);
const exec = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepalive-child-"));
  scratch.push(dir);
  const out = path.join(dir, "stdout");
  const err = path.join(dir, "stderr");
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile("bash", ["-c", 'exec "$@" > "$TEST_OUT" 2> "$TEST_ERR"', "child", command, ...args], {
      env: { ...process.env, ...options.env, TEST_OUT: out, TEST_ERR: err }, timeout: 20_000,
    }, (error) => {
      const stdout = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
      const stderr = fs.existsSync(err) ? fs.readFileSync(err, "utf8") : "";
      if (error) {
        error.message += `\n${stderr}`;
        reject(error);
      } else resolve({ stdout, stderr });
    });
  });
};
let logs: Mock<typeof console.log>;

function fixture(): KeepaliveOptions & { configDir: string; idleConfigPath: string; idleWatchdogPath: string; idleProbePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-keepalive-"));
  scratch.push(root);
  const idleConfigPath = path.join(root, "cast-idle-minutes");
  fs.writeFileSync(idleConfigPath, "20\n");
  const idleWatchdogPath = path.join(root, "cast-idle-check");
  const idleProbePath = path.join(root, "idle-probe.py");
  fs.writeFileSync(idleWatchdogPath, idleWatchdogScript());
  fs.writeFileSync(idleProbePath, cloudIdleProbeScript);
  return { configDir: path.join(root, "config"), idleConfigPath, idleWatchdogPath, idleProbePath, platform: "linux", now };
}

function command(options: KeepaliveOptions): Command {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerHostKeepaliveCommand(program.command("hosts"), options);
  return program;
}

beforeEach(() => {
  logs = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logs.mockRestore();
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("host keepalive leases", () => {
  test.each(["1", "1440"])("accepts the %s minute boundary and writes a private numeric Unix expiry", (minutes) => {
    const options = fixture();
    const lease = createHostKeepalive(minutes, options);
    const dir = path.join(options.configDir, "host-keepalive");
    const file = path.join(dir, lease.id);
    const expiry = Math.floor(now / 1000) + Number(minutes) * 60;
    expect(lease.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.readdirSync(dir)).toEqual([lease.id]);
    expect(fs.readFileSync(file, "utf8")).toBe(`${expiry}\n`);
    expect(lease.expiresAt).toBe(new Date(expiry * 1000).toISOString());
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(expiry * 1000 - now).toBeLessThanOrEqual(Number(minutes) * 60_000);
  });

  test.each(["", " ", "0", "-1", "1441", "1.5", "1.0", "1e2", "0x10", "+1", "1m", "1 2", "1\n", " 1", "1 ", "NaN", "Infinity", "999999999999999999999999"])("rejects malformed or unbounded duration %j before any writes", (minutes) => {
    const options = fixture();
    expect(() => createHostKeepalive(minutes, options)).toThrow("minutes must be a whole number from 1 to 1440");
    expect(fs.existsSync(options.configDir)).toBe(false);
  });

  test("validation runs before inspecting the host or writing", () => {
    const options = fixture();
    expect(() => createHostKeepalive("5m", { ...options, idleConfigPath: `${options.idleConfigPath}/invalid` })).toThrow("minutes must be a whole number");
    expect(fs.existsSync(options.configDir)).toBe(false);
  });

  test("expires at the exact stored second and a later lease leaves the old expiry unchanged", () => {
    const options = fixture();
    const first = createHostKeepalive("1", options);
    const firstFile = path.join(options.configDir, "host-keepalive", first.id);
    const expiry = Number(fs.readFileSync(firstFile, "utf8"));
    const activeAt = (seconds: number) => fs.readdirSync(path.dirname(firstFile))
      .filter((id) => Number(fs.readFileSync(path.join(path.dirname(firstFile), id), "utf8")) > seconds);
    expect(activeAt(expiry - 1)).toEqual([first.id]);
    expect(activeAt(expiry)).toEqual([]);
    expect(activeAt(expiry + 1)).toEqual([]);
    const second = createHostKeepalive("1", { ...options, now: expiry * 1000 });
    expect(second.id).not.toBe(first.id);
    expect(activeAt(expiry)).toEqual([second.id]);
    expect(Number(fs.readFileSync(firstFile, "utf8"))).toBe(expiry);
    expect(activeAt(expiry + 60)).toEqual([]);
  });

  test("tightens an existing lease directory without modifying another lease", () => {
    const options = fixture();
    const dir = path.join(options.configDir, "host-keepalive");
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(path.join(dir, "older-lease"), "123\n", { mode: 0o600 });
    createHostKeepalive("10", options);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(dir, "older-lease"), "utf8")).toBe("123\n");
    expect(fs.readdirSync(dir)).toHaveLength(2);
  });

  test("propagates filesystem failures", () => {
    const options = fixture();
    fs.mkdirSync(options.configDir);
    fs.writeFileSync(path.join(options.configDir, "host-keepalive"), "blocked");
    expect(() => createHostKeepalive("1", options)).toThrow();
    expect(fs.readFileSync(path.join(options.configDir, "host-keepalive"), "utf8")).toBe("blocked");
    expect(() => createHostKeepalive("1", { ...options, idleConfigPath: `${options.idleConfigPath}/invalid` })).toThrow();
  });

  test("concurrent processes publish independent complete leases", async () => {
    const options = fixture();
    const modulePath = path.join(import.meta.dir, "keepalive.ts");
    const runs = await Promise.allSettled(Array.from({ length: 12 }, async (_, i) => {
      const script = `import { createHostKeepalive } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(createHostKeepalive(${JSON.stringify(String(i + 1))}, ${JSON.stringify(options)})));`;
      return exec(process.execPath, ["--eval", script]);
    }));
    const results = runs.map((run) => {
      if (run.status === "rejected") throw run.reason;
      expect(run.value.stdout, JSON.stringify(run.value)).not.toBe("");
      return JSON.parse(run.value.stdout) as { id: string; expiresAt: string };
    });
    const dir = path.join(options.configDir, "host-keepalive");
    expect(new Set(results.map((lease) => lease.id)).size).toBe(12);
    expect(fs.readdirSync(dir).sort()).toEqual(results.map((lease) => lease.id).sort());
    for (const [i, lease] of results.entries()) {
      const expiry = Math.floor(now / 1000) + (i + 1) * 60;
      expect(fs.readFileSync(path.join(dir, lease.id), "utf8")).toBe(`${expiry}\n`);
      expect(Date.parse(lease.expiresAt)).toBe(expiry * 1000);
      expect(fs.statSync(path.join(dir, lease.id)).mode & 0o777).toBe(0o600);
    }
  });
});

describe("cast hosts keepalive", () => {
  test.each(["missing probe", "missing watchdog", "legacy watchdog", "commented guard"])("refuses %s before promising a lease", (kind) => {
    const options = fixture();
    if (kind === "missing probe") fs.unlinkSync(options.idleProbePath);
    if (kind === "missing watchdog") fs.unlinkSync(options.idleWatchdogPath);
    if (kind === "legacy watchdog") fs.writeFileSync(options.idleWatchdogPath, "#!/bin/bash\nexit 0\n");
    if (kind === "commented guard") fs.writeFileSync(options.idleWatchdogPath, fs.readFileSync(options.idleWatchdogPath, "utf8").replace("if ! timeout", "# if ! timeout"));
    expect(() => command(options).parse(["hosts", "keepalive", "1", "--json"], { from: "user" })).toThrow("upgrade its idle watchdog");
    expect(fs.existsSync(options.configDir)).toBe(false);
    expect(logs).not.toHaveBeenCalled();
  });

  test("the existing hosts builder exposes the local keepalive command", () => {
    const hosts = buildHostsCommand(new Command());
    const keepalive = hosts.commands.find((child) => child.name() === "keepalive");
    expect(keepalive).toBeDefined();
    expect(keepalive!.helpInformation()).toContain("<minutes>");
    expect(keepalive!.helpInformation()).toContain("--json");
  });

  test.each(["darwin", "win32"] as const)("rejects %s even when the cloud marker exists", (platform) => {
    const options = fixture();
    expect(() => command({ ...options, platform }).parse(["hosts", "keepalive", "1", "--json"], { from: "user" })).toThrow("existing cloud Linux host");
    expect(fs.existsSync(options.configDir)).toBe(false);
    expect(logs).not.toHaveBeenCalled();
  });

  test("rejects Linux without the provisioned marker", () => {
    const options = fixture();
    fs.unlinkSync(options.idleConfigPath);
    expect(() => command(options).parse(["hosts", "keepalive", "1"], { from: "user" })).toThrow("/etc/cast-idle-minutes");
    expect(fs.existsSync(options.configDir)).toBe(false);
    expect(logs).not.toHaveBeenCalled();
  });

  test.each([
    ["root HOME", "/root", false],
    ["alternate CODECAST_DIR", "/home/ubuntu", true],
  ] as const)("the actual default writer targets the installed watchdog with %s", async (_, home, alternateConfig) => {
    const { configDir, ...options } = fixture();
    const modulePath = path.join(import.meta.dir, "keepalive.ts");
    const atomicPath = path.join(import.meta.dir, "..", "atomicWrite.ts");
    const script = `
      import { mock, spyOn } from "bun:test";
      import * as fs from "node:fs";
      const directories = [];
      const permissions = [];
      const writes = [];
      spyOn(fs, "mkdirSync").mockImplementation((dir, options) => { directories.push({ dir, options }); });
      spyOn(fs, "chmodSync").mockImplementation((dir, mode) => { permissions.push({ dir, mode }); });
      mock.module(${JSON.stringify(atomicPath)}, () => ({
        atomicWriteFile: (file, contents, options) => { writes.push({ file, contents, options }); },
      }));
      const { createHostKeepalive } = await import(${JSON.stringify(modulePath)});
      const lease = createHostKeepalive("1", ${JSON.stringify(options)});
      console.log(JSON.stringify({ lease, directories, permissions, writes }));
    `;
    const { stdout } = await exec(process.execPath, ["--eval", script], {
      env: { ...process.env, HOME: home, CODECAST_DIR: alternateConfig ? configDir : "", CODECAST_REMOTE_DEVICE: "" },
    });
    const { lease, directories, permissions, writes } = JSON.parse(stdout);
    const dir = "/home/ubuntu/.codecast/host-keepalive";
    expect(directories).toEqual([{ dir, options: { recursive: true, mode: 0o700 } }]);
    expect(permissions).toEqual([{ dir, mode: 0o700 }]);
    expect(writes).toEqual([{
      file: path.join(dir, lease.id),
      contents: `${Math.floor(now / 1000) + 60}\n`,
      options: { mode: 0o600 },
    }]);
    expect(lease.expiresAt).toBe("2026-09-14T12:01:00.000Z");
    expect(fs.existsSync(configDir)).toBe(false);
  });

  test("a remote environment flag cannot replace the local marker", async () => {
    const options = fixture();
    fs.unlinkSync(options.idleConfigPath);
    const modulePath = path.join(import.meta.dir, "keepalive.ts");
    const script = `import { createHostKeepalive } from ${JSON.stringify(modulePath)}; createHostKeepalive("1", ${JSON.stringify(options)});`;
    await expect(exec(process.execPath, ["--eval", script], {
      env: { ...process.env, CODECAST_REMOTE_DEVICE: "1" },
    })).rejects.toThrow("/etc/cast-idle-minutes");
    expect(fs.existsSync(options.configDir)).toBe(false);
  });

  test("rejects a directory in place of the cloud marker", () => {
    const options = fixture();
    fs.unlinkSync(options.idleConfigPath);
    fs.mkdirSync(options.idleConfigPath);
    expect(() => command(options).parse(["hosts", "keepalive", "1"], { from: "user" })).toThrow("existing cloud Linux host");
    expect(fs.existsSync(options.configDir)).toBe(false);
  });

  test.each([
    ["hosts", "keepalive"],
    ["hosts", "keepalive", "1", "another-host"],
    ["hosts", "keepalive", "1", "--host", "remote"],
    ["hosts", "keepalive", "1m"],
  ].map((args) => ({ args })))("rejects invalid command arguments %j before writes", ({ args }) => {
    const options = fixture();
    expect(() => command(options).parse(args, { from: "user" })).toThrow();
    expect(fs.existsSync(options.configDir)).toBe(false);
    expect(logs).not.toHaveBeenCalled();
  });

  test.each([true, false])("returns a verifiable id and ISO expiry with json=%s", (json) => {
    const options = fixture();
    command(options).parse(["hosts", "keepalive", "60", ...(json ? ["--json"] : [])], { from: "user" });
    expect(logs).toHaveBeenCalledTimes(1);
    const output = String(logs.mock.calls[0][0]);
    const [id] = fs.readdirSync(path.join(options.configDir, "host-keepalive"));
    const expiresAt = "2026-09-14T13:00:00.000Z";
    if (json) expect(JSON.parse(output)).toEqual({ id, expiresAt });
    else expect(output).toBe(`Keepalive lease ${id} expires at ${expiresAt}`);
    expect(Number(fs.readFileSync(path.join(options.configDir, "host-keepalive", id), "utf8"))).toBe(Date.parse(expiresAt) / 1000);
  });
});

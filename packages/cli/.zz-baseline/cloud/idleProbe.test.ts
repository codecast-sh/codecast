import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { cloudIdleProbeScript } from "./idleProbe";
import { idleWatchdogScript } from "../browser/provisionLinux";

setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-idle-"));
  roots.push(root);
  const proc = path.join(root, "proc");
  fs.mkdirSync(proc);
  const file = path.join(root, "probe.py");
  fs.writeFileSync(file, cloudIdleProbeScript);
  const process = (pid: number, ppid: number, args: string[], name = path.basename(args[0]!), state = "S", uid = globalThis.process.getuid!(), tty = 1) => {
    const dir = path.join(proc, String(pid));
    fs.mkdirSync(dir, { recursive: true });
    const fields = Array.from({ length: 20 }, () => "0");
    fields[0] = state; fields[1] = String(ppid); fields[4] = String(tty); fields[19] = "1";
    fs.writeFileSync(path.join(dir, "stat"), `${pid} (${name}) ${fields.join(" ")}`);
    fs.writeFileSync(path.join(dir, "comm"), name);
    fs.writeFileSync(path.join(dir, "status"), `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    fs.writeFileSync(path.join(dir, "cmdline"), args.join("\0") + "\0");
  };
  process(1, 0, ["systemd"]);
  const run = () => new Promise<Record<string, unknown>>((resolve, reject) => {
    execFile("bash", ["-c", 'python3 "$@" > "$1.result"', "probe", file, root, proc], { env: { ...globalThis.process.env }, encoding: "utf8", timeout: 10_000 }, (error, stdout, stderr) => {
      if (stderr || (error && typeof error.code !== "number")) {
        reject(error ?? new Error(`Missing probe result: ${stderr}`));
        return;
      }
      resolve({ code: error?.code ?? 0, ...JSON.parse(fs.readFileSync(`${file}.result`, "utf8")) });
    });
  });
  return { root, proc, process, run, file };
}

test("an idle Claude parent with a quiet Bash task vetoes stop until the task exits", async () => {
  const f = fixture();
  f.process(10, 1, ["claude", "--resume", "parent"]);
  expect((await f.run()).active).toBe(false);
  f.process(11, 10, ["/bin/bash", "-c", "source snapshot; eval 'sleep 3600'"]);
  expect((await f.run())).toMatchObject({ code: 1, reason: "live-task-process", pid: 11 });
  fs.rmSync(path.join(f.proc, "11"), { recursive: true });
  expect((await f.run())).toMatchObject({ code: 0, active: false });
});

test("tools below daemon-owned Codex and detached tmux jobs are protected", async () => {
  const f = fixture();
  f.process(2, 1, ["bun", "/codecast/daemon.ts"]);
  f.process(3, 2, ["codex", "app-server"]);
  f.process(4, 3, ["/bin/bash", "-lc", "bun test"]);
  expect((await f.run())).toMatchObject({ active: true, pid: 4 });
  fs.rmSync(path.join(f.proc, "4"), { recursive: true });
  f.process(10, 1, ["tmux"], "tmux: server");
  f.process(11, 10, ["/bin/bash"]);
  expect((await f.run()).active).toBe(false);
  f.process(12, 11, ["node", "/workspace/node_modules/typescript/bin/tsc"]);
  expect((await f.run())).toMatchObject({ active: true, pid: 12 });
});

test("dormant agents, MCP servers, browser, daemon and zombies do not hold the host", async () => {
  const f = fixture();
  f.process(10, 1, ["tmux"], "tmux: server");
  f.process(11, 10, ["/bin/bash"]);
  f.process(12, 11, ["claude", "--resume", "parent"]);
  f.process(13, 12, ["npx", "-y", "@modelcontextprotocol/server-filesystem"]);
  f.process(14, 13, ["node", "worker.js"]);
  f.process(15, 12, ["chrome", "--headless"]);
  f.process(16, 15, ["renderer"]);
  f.process(17, 12, ["bun", "test"], "bun", "Z");
  f.process(18, 11, ["bun", "/usr/local/lib/codecast/index.js", "_daemon"]);
  expect((await f.run())).toMatchObject({ code: 0, active: false });
});

test("independent leases expire and malformed values cannot disable sleep forever", async () => {
  const f = fixture();
  const dir = path.join(f.root, ".codecast/host-keepalive");
  fs.mkdirSync(dir, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(dir, "a"), String(now - 1));
  fs.writeFileSync(path.join(dir, "b"), "not-a-number");
  fs.writeFileSync(path.join(dir, "c"), String(now + 9999999));
  expect((await f.run()).active).toBe(false);
  fs.writeFileSync(path.join(dir, "d"), String(now + 300));
  expect((await f.run())).toMatchObject({ code: 1, reason: "keepalive" });
  fs.unlinkSync(path.join(dir, "d"));
  expect((await f.run()).active).toBe(false);
});

test("failed or incomplete process evidence refuses shutdown", async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.proc, "1/stat"), "malformed");
  expect((await f.run())).toMatchObject({ code: 2, active: true, reason: "probe-failed" });
  fs.rmSync(path.join(f.proc, "1"), { recursive: true });
  expect((await f.run())).toMatchObject({ code: 2, active: true, reason: "probe-failed" });
});

test("the generated watchdog protects live work with a stale stamp, but still stops an idle host", async () => {
  const f = fixture();
  const bin = path.join(f.root, "bin");
  fs.mkdirSync(bin);
  const executable = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  executable("ss", "exit 0");
  executable("pgrep", "exit 1");
  executable("logger", "exit 0");
  executable("stat", "echo 0");
  executable("timeout", 'shift; exec "$@"');
  executable("systemctl", `printf '%s' "$*" > '${f.root}/poweroff'`);
  fs.writeFileSync(path.join(f.root, "minutes"), "1");
  fs.writeFileSync(path.join(f.root, "stamp"), "old");
  const original = idleWatchdogScript();
  const script = original.replaceAll("/etc/cast-idle-minutes", `${f.root}/minutes`)
    .replaceAll("/run/cast-last-active", `${f.root}/state`)
    .replaceAll("/home/ubuntu/.codecast/host-active", `${f.root}/stamp`)
    .replaceAll("/run/cast-idle-work.json", `${f.root}/decision.json`)
    .replace("/usr/local/lib/codecast/idle-probe.py /home/ubuntu", `${f.root}/probe.py ${f.root} ${f.proc}`);
  const run = async (body: string) => {
    fs.writeFileSync(path.join(f.root, "state"), "1");
    fs.rmSync(path.join(f.root, "poweroff"), { force: true });
    const file = path.join(f.root, "check.sh");
    fs.writeFileSync(file, body);
    await new Promise<void>((resolve, reject) => execFile("bash", [file], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 20_000,
    }, (error) => error ? reject(error) : resolve()));
    return fs.existsSync(path.join(f.root, "poweroff"));
  };
  f.process(10, 1, ["claude", "--resume", "parent"]);
  f.process(11, 10, ["bash", "-c", "sleep 3600"]);
  const oldCode = script.replace(/if ! timeout 15s python3[^\n]+\n  active=1\nfi\n/, "");
  expect(oldCode).not.toBe(script);
  expect(await run(oldCode)).toBe(true);
  expect(await run(script)).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(f.root, "decision.json"), "utf8"))).toMatchObject({ active: true, pid: 11 });
  fs.rmSync(path.join(f.proc, "11"), { recursive: true });
  expect(await run(script)).toBe(true);
  fs.writeFileSync(path.join(f.proc, "1/stat"), "malformed");
  expect(await run(script)).toBe(false);
});

test("command text cannot disguise live work as infrastructure", async () => {
  const f = fixture();
  f.process(10, 1, ["claude", "--resume", "parent"]);
  f.process(11, 10, ["bash", "-c", "cd /work/mcp/server; sleep 3600"]);
  expect((await f.run()).active).toBe(true);
  f.process(11, 10, ["node", "/work/mcp/test.js"]);
  expect((await f.run()).active).toBe(true);
  f.process(11, 10, ["python3", "-c", "x = '/app/mcp.js'; import time; time.sleep(3600)"]);
  expect((await f.run()).active).toBe(true);
});

test("headless subagents and script-only shells are busy without child tools", async () => {
  const f = fixture();
  f.process(10, 1, ["tmux"], "tmux: server");
  f.process(11, 10, ["claude", "-p", "long task"]);
  expect((await f.run())).toMatchObject({ active: true, reason: "headless-agent" });
  f.process(11, 10, ["bash", "/work/long-build.sh"]);
  expect((await f.run())).toMatchObject({ active: true, reason: "live-task-process" });
});

test("launch wrappers around dormant agents and MCP servers do not pin the host", async () => {
  const f = fixture();
  f.process(10, 1, ["tmux"], "tmux: server");
  f.process(11, 10, ["bash", "-lc", "claude --resume parent"]);
  f.process(12, 11, ["claude", "--resume", "parent"]);
  f.process(13, 12, ["npx", "-y", "@modelcontextprotocol/server-filesystem"]);
  f.process(14, 13, ["node", "server.js"]);
  expect((await f.run())).toMatchObject({ code: 0, active: false });
  f.process(13, 12, ["npm exec @modelcontextprotocol/server-filesystem /work"], "npm exec");
  expect((await f.run()).active).toBe(false);
  f.process(13, 12, ["node", "/opt/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js"]);
  expect((await f.run()).active).toBe(false);
  f.process(15, 12, ["node", "tests.js", "@modelcontextprotocol/server-filesystem"]);
  expect((await f.run()).active).toBe(true);
});

test("ancestry survives elevated descendants but unrelated users do not anchor work", async () => {
  const f = fixture();
  f.process(10, 1, ["tmux"], "tmux: server");
  f.process(11, 10, ["sudo", "bash", "/work/build.sh"], "sudo", "S", 0);
  f.process(12, 11, ["bash", "/work/build.sh"], "bash", "S", 0);
  expect((await f.run()).active).toBe(true);
  fs.rmSync(path.join(f.proc, "10"), { recursive: true });
  expect((await f.run()).active).toBe(false);
  f.process(20, 1, ["claude", "-p", "quiet worker"]);
  expect((await f.run())).toMatchObject({ active: true, reason: "headless-agent" });
  f.process(20, 1, ["claude", "-p", "other user"], "claude", "S", 12345);
  expect((await f.run()).active).toBe(false);
});

test("stdin-fed and multi-option noninteractive shells are not dormant prompts", async () => {
  const f = fixture();
  f.process(10, 1, ["tmux"], "tmux: server");
  f.process(11, 10, ["bash", "-s"]);
  expect((await f.run()).active).toBe(true);
  f.process(11, 10, ["bash", "-l", "-c", "long work"]);
  expect((await f.run()).active).toBe(true);
  f.process(11, 10, ["bash"], "bash", "S", globalThis.process.getuid!(), 0);
  expect((await f.run()).active).toBe(true);
});

test("Codex profiles are resident configuration, not Claude print mode", async () => {
  const f = fixture();
  f.process(10, 1, ["tmux"], "tmux: server");
  f.process(11, 10, ["codex", "-p", "default"]);
  expect((await f.run()).active).toBe(false);
  f.process(11, 10, ["codex", "--profile", "exec"]);
  expect((await f.run()).active).toBe(false);
  for (const subcommand of ["e", "review"]) {
    f.process(11, 10, ["codex", subcommand, "task"]);
    expect((await f.run())).toMatchObject({ active: true, reason: "headless-agent" });
  }
  f.process(11, 10, ["codex", "--profile", "default", "exec", "task"]);
  expect((await f.run())).toMatchObject({ active: true, reason: "headless-agent" });
});

test("an apparently idle interactive shell with advancing CPU counters vetoes stop", async () => {
  const f = fixture();
  f.process(10, 1, ["tmux"], "tmux: server");
  f.process(11, 10, ["bash"]);
  f.process(12, 11, ["codex", "--profile", "default"]);
  const script = `import runpy, sys, json
from pathlib import Path
m=runpy.run_path(sys.argv[1])
p=Path(sys.argv[3])/'11'/'stat'
def advance(_):
 s=p.read_text(); prefix,fields=s.rsplit(') ',1); parts=fields.split(); parts[11]='1'; p.write_text(prefix+') '+' '.join(parts))
m['time'].sleep=advance
print(json.dumps(m['probe'](Path(sys.argv[2]),Path(sys.argv[3]),0)))
`;
  const runner = path.join(f.root, "cpu.py");
  fs.writeFileSync(runner, script);
  await new Promise<void>((resolve, reject) => execFile("bash", ["-c", 'python3 "$@" > "$1.result"', "cpu", runner, f.file, f.root, f.proc], { env: { ...process.env }, timeout: 10_000 }, (error) => error ? reject(error) : resolve()));
  expect(JSON.parse(fs.readFileSync(`${runner}.result`, "utf8"))).toMatchObject({ active: true, reason: "process-cpu", pid: 11 });
});

test("long shell startup options do not masquerade as script commands", async () => {
  const f = fixture();
  f.process(10, 1, ["tmux"], "tmux: server");
  f.process(11, 10, ["bash", "--noprofile", "--norc", "-i"]);
  expect((await f.run()).active).toBe(false);
  f.process(11, 10, ["bash", "--rcfile", "/work/profile", "-i"]);
  expect((await f.run()).active).toBe(false);
});

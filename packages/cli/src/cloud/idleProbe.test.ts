import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { cloudIdleProbeScript } from "./idleProbe";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-idle-"));
  roots.push(root);
  const proc = path.join(root, "proc");
  fs.mkdirSync(proc);
  const file = path.join(root, "probe.py");
  fs.writeFileSync(file, cloudIdleProbeScript);
  const process = (pid: number, ppid: number, args: string[], name = path.basename(args[0]!), state = "S") => {
    const dir = path.join(proc, String(pid));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "stat"), `${pid} (${name}) ${state} ${ppid} 0`);
    fs.writeFileSync(path.join(dir, "comm"), name);
    fs.writeFileSync(path.join(dir, "cmdline"), args.join("\0") + "\0");
  };
  process(1, 0, ["systemd"]);
  const run = () => {
    const result = spawnSync("python3", [file, root, proc], { encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    return { code: result.status, ...JSON.parse(result.stdout) };
  };
  return { root, proc, process, run };
}

test("an idle Claude parent with a quiet Bash task vetoes stop until the task exits", () => {
  const f = fixture();
  f.process(10, 1, ["claude", "--resume", "parent"]);
  expect(f.run().active).toBe(false);
  f.process(11, 10, ["/bin/bash", "-c", "source snapshot; eval 'sleep 3600'"]);
  expect(f.run()).toMatchObject({ code: 1, reason: "live-task-process", pid: 11 });
  fs.rmSync(path.join(f.proc, "11"), { recursive: true });
  expect(f.run()).toMatchObject({ code: 0, active: false });
});

test("tools below daemon-owned Codex and detached tmux jobs are protected", () => {
  const f = fixture();
  f.process(2, 1, ["bun", "/codecast/daemon.ts"]);
  f.process(3, 2, ["codex", "app-server"]);
  f.process(4, 3, ["/bin/bash", "-lc", "bun test"]);
  expect(f.run()).toMatchObject({ active: true, pid: 4 });
  fs.rmSync(path.join(f.proc, "4"), { recursive: true });
  f.process(10, 1, ["tmux"], "tmux: server");
  f.process(11, 10, ["/bin/bash"]);
  expect(f.run().active).toBe(false);
  f.process(12, 11, ["node", "/workspace/node_modules/typescript/bin/tsc"]);
  expect(f.run()).toMatchObject({ active: true, pid: 12 });
});

test("dormant agents, MCP servers, browser, daemon and zombies do not hold the host", () => {
  const f = fixture();
  f.process(10, 1, ["tmux"], "tmux: server");
  f.process(11, 10, ["/bin/bash"]);
  f.process(12, 11, ["claude", "--resume", "parent"]);
  f.process(13, 12, ["node", "/app/mcp/server.js"]);
  f.process(14, 13, ["node", "worker.js"]);
  f.process(15, 12, ["chrome", "--headless"]);
  f.process(16, 15, ["renderer"]);
  f.process(17, 12, ["bun", "test"], "bun", "Z");
  f.process(18, 11, ["bun", "/app/daemon.ts"]);
  expect(f.run()).toMatchObject({ code: 0, active: false });
});

test("independent leases expire and malformed values cannot disable sleep forever", () => {
  const f = fixture();
  const dir = path.join(f.root, ".codecast/host-keepalive");
  fs.mkdirSync(dir, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(dir, "a"), String(now - 1));
  fs.writeFileSync(path.join(dir, "b"), "not-a-number");
  fs.writeFileSync(path.join(dir, "c"), String(now + 9999999));
  expect(f.run().active).toBe(false);
  fs.writeFileSync(path.join(dir, "d"), String(now + 300));
  expect(f.run()).toMatchObject({ code: 1, reason: "keepalive" });
  fs.unlinkSync(path.join(dir, "d"));
  expect(f.run().active).toBe(false);
});

test("failed or incomplete process evidence refuses shutdown", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.proc, "1/stat"), "malformed");
  expect(f.run()).toMatchObject({ code: 2, active: true, reason: "probe-failed" });
  fs.rmSync(path.join(f.proc, "1"), { recursive: true });
  expect(f.run()).toMatchObject({ code: 2, active: true, reason: "probe-failed" });
});

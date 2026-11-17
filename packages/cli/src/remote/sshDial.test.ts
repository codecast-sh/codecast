import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeHosts, type CloudHost } from "../browser/cloudHost";

const ADDRESS = "203.0.113.10";
const SOCKET = path.join(os.tmpdir(), "cast-ssh-ubuntu-203.0.113.10");
const aws: CloudHost = { id: "i-1", provider: "aws", region: "us-west-2", user: "ubuntu", keyPath: "/k/aws.pem", address: ADDRESS, remoteBaseDir: "/home/ubuntu/work", homeDir: "/home/ubuntu" } as CloudHost;

const SSH_BASE = [
  "-i", "/k/aws.pem",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ConnectTimeout=20",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=4",
  "-o", "ControlMaster=auto",
  "-o", `ControlPath=${SOCKET}`,
  "-o", "ControlPersist=120",
];

let dir: string, prev: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-ssh-dial-"));
  prev = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
  writeHosts([aws]);
});

afterEach(() => {
  if (prev === undefined) delete process.env.CODECAST_DIR; else process.env.CODECAST_DIR = prev;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function run(body: string): Promise<{ calls: string[][]; out: unknown }> {
  const home = path.join(dir, "home");
  const bin = path.join(home, ".local", "bin");
  const log = path.join(dir, "calls.log");
  const folder = path.join(dir, "folder");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(bin, "aws"), `#!/bin/sh
case "$*" in
  *describe-instances*) echo '{"Reservations":[{"Instances":[{"State":{"Name":"running"},"PublicIpAddress":"${ADDRESS}"}]}]}';;
  *) echo '{}';;
esac
`, { mode: 0o755 });
  for (const tool of ["ssh", "rsync"]) {
    fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\nIFS='|'\necho "$(basename "$0")|$*" >> '${log}'\nexit 0\n`, { mode: 0o755 });
  }
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", `
    import { ensureUp } from ${JSON.stringify(path.resolve(import.meta.dir, "../browser/cloudHost.ts"))};
    import { gitEnv, pushPath, ssh } from ${JSON.stringify(path.resolve(import.meta.dir, "session-move.ts"))};
    const aws = ${JSON.stringify(aws)};
    const folder = ${JSON.stringify(folder)};
    ${body}
  `], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, timeout: 30_000 });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => l.split("|")) : [];
  return { calls, out: stdout.trim() ? JSON.parse(stdout) : undefined };
}

describe("the ssh target and identity for an aws host", () => {
  test("ssh() runs sshBase, then user@address, then the command", async () => {
    const { calls } = await run(`ssh(aws, "uptime");`);
    expect(calls).toEqual([["ssh", ...SSH_BASE, "ubuntu@203.0.113.10", "uptime"]]);
  }, 40_000);

  test("rsync -e is ssh plus the joined sshBase, and the remote side is user@address:dir/", async () => {
    const { calls } = await run(`await pushPath(aws, folder);`);
    const rsync = calls.find((c) => c[0] === "rsync")!;
    expect(rsync[rsync.indexOf("-e") + 1]).toBe(`ssh ${SSH_BASE.join(" ")}`);
    expect(rsync.at(-1)).toMatch(/^ubuntu@203\.0\.113\.10:\/home\/ubuntu\/work\/.*\/$/);
  }, 40_000);

  test("GIT_SSH_COMMAND carries the key and its own options", async () => {
    const { out } = await run(`console.log(JSON.stringify(gitEnv(aws).GIT_SSH_COMMAND));`);
    expect(out).toBe("ssh -i /k/aws.pem -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20");
  }, 40_000);

  test("ensureUp probes with the key, its own options and user@address", async () => {
    const { calls } = await run(`await ensureUp(aws);`);
    const probe = calls.find((c) => c[0] === "ssh" && c.at(-1) === "true" && c[1] === "-i");
    expect(probe).toEqual([
      "ssh",
      "-i", "/k/aws.pem",
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=10",
      "-o", "BatchMode=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${SOCKET}`,
      "-o", "ControlPersist=120",
      "ubuntu@203.0.113.10", "true",
    ]);
  }, 40_000);
});

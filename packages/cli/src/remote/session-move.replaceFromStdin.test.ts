import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replaceFromStdin } from "./session-move";

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }); });

function hostHome(old: string): { home: string; dest: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "replace-stdin-"));
  homes.push(home);
  fs.mkdirSync(path.join(home, ".claude"));
  const dest = path.join(home, ".claude", ".credentials.json");
  fs.writeFileSync(dest, old);
  return { home, dest };
}

function push(home: string): ChildProcess {
  return spawn("bash", ["-c", replaceFromStdin("~/.claude", ".credentials.json")], {
    env: { ...process.env, HOME: home },
    stdio: ["pipe", "ignore", "pipe"],
  });
}

const closed = (child: ChildProcess) => new Promise<number | null>((resolve) => child.on("close", resolve));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("replaceFromStdin", () => {
  test("the file keeps the old login until the new one has fully arrived", async () => {
    const { home, dest } = hostHome('{"old":true}');
    const child = push(home);
    await sleep(200); // the shell is up and waiting on stdin, as over a slow ssh
    expect(fs.readFileSync(dest, "utf8")).toBe('{"old":true}');
    child.stdin!.end('{"new":true}');
    expect(await closed(child)).toBe(0);
    expect(fs.readFileSync(dest, "utf8")).toBe('{"new":true}');
    expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(dest)).filter((f) => f.startsWith(".cast-push."))).toEqual([]);
  });

  test("a transfer cut off midway leaves the old login in place", async () => {
    const { home, dest } = hostHome('{"old":true}');
    const child = push(home);
    child.stdin!.write('{"new":');
    await sleep(200);
    child.kill("SIGKILL");
    await closed(child);
    expect(fs.readFileSync(dest, "utf8")).toBe('{"old":true}');
  });
});

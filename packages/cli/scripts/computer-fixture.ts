/**
 * What the computer benches share: self-reporting fixture apps (built from a
 * Swift source next to this file, launched at the back, read through the
 * status file they write), a polling wait, and a client on the installed
 * helper.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import { ComputerClient } from "../src/computer/client.js";
import { helperExecutablePath } from "../src/computer/helperApp.js";
import { disclaimedHelperLaunch } from "../src/test-helpers/computerPermissionProbe.js";

export const WORK = path.join(os.tmpdir(), "cc-bench");

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Compiles `source` (a Swift file beside this one) unless the binary is newer. */
export function buildSwift(source: string): string {
  fs.mkdirSync(WORK, { recursive: true });
  const sourcePath = path.join(import.meta.dir, source);
  const binary = path.join(WORK, path.basename(source, ".swift"));
  const fresh = fs.existsSync(binary) && fs.statSync(binary).mtimeMs > fs.statSync(sourcePath).mtimeMs;
  if (!fresh) {
    const built = spawnSync("swiftc", ["-O", sourcePath, "-o", binary], { stdio: "inherit" });
    if (built.status !== 0) throw new Error(`${source} did not compile`);
  }
  return binary;
}

export type Fixture = { child: ChildProcess; pid: number; windows: Record<string, number>; statusFile: string };

/** Starts a fixture and waits for its `READY pid=<n> windows=<title>=<id>,...` line. */
export async function launchFixture(source = "computer-bench-fixture.swift", extra: string[] = []): Promise<Fixture> {
  const statusFile = path.join(WORK, `status-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  const child = spawn(buildSwift(source), ["--status-file", statusFile, ...extra], { stdio: ["ignore", "pipe", "inherit"] });
  const ready = await new Promise<string>((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => reject(new Error(`${source} never said READY`)), 60_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
      const line = seen.split("\n").find((l) => l.startsWith("READY"));
      if (line) {
        clearTimeout(timer);
        resolve(line);
      }
    });
    child.on("exit", () => reject(new Error(`${source} exited before READY`)));
  });
  const pid = Number(/pid=(\d+)/.exec(ready)?.[1]);
  const windows: Record<string, number> = {};
  for (const pair of (/windows=(.*)$/.exec(ready)?.[1] ?? "").split(",")) {
    const [title, id] = pair.split("=");
    if (title && id) windows[title] = Number(id);
  }
  return { child, pid, windows, statusFile };
}

export function status(fixture: Fixture): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(fixture.statusFile, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await sleep(25);
  }
  return check();
}

export function makeClient(): ComputerClient {
  return new ComputerClient({
    helperLaunch: (socketPath, tokenPath) =>
      disclaimedHelperLaunch(helperExecutablePath(), ["--agent", socketPath, "--token-file", tokenPath]),
  });
}

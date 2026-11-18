/**
 * The bench fixture (scripts/computer-bench-fixture.swift): an app that opens
 * its windows at the back, never activates, and writes what it did to a status
 * file, so a test reads whether an action landed from the app itself.
 * Shared by scripts/computer-bench.ts and the computer e2e tests.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "../proc.js";
import { isolateCodecastDir } from "./codecastDir.js";

import { ComputerClient } from "../computer/client.js";
import { helperExecutablePath } from "../computer/helperApp.js";
import { disclaimedHelperLaunch } from "./computerPermissionProbe.js";

const FIXTURE_SOURCE = path.join(import.meta.dir, "..", "..", "scripts", "computer-bench-fixture.swift");
const WORK = path.join(os.tmpdir(), "cc-bench");

export type Fixture = {
  child: ChildProcess;
  pid: number;
  windows: Record<string, number>;
  statusFile: string;
  /** Everything the fixture has printed so far (READY, then HUNG under --hang). */
  output: () => string;
};

/** Compiles a fixture (a Swift source under scripts/, the bench fixture by
 *  default) unless its binary is newer. */
export function buildFixture(source = FIXTURE_SOURCE): string {
  fs.mkdirSync(WORK, { recursive: true });
  const binary = path.join(WORK, source === FIXTURE_SOURCE ? "fixture" : path.basename(source, ".swift"));
  const fresh = fs.existsSync(binary) && fs.statSync(binary).mtimeMs > fs.statSync(source).mtimeMs;
  if (!fresh) {
    const built = spawnSync("swiftc", ["-O", source, "-o", binary], { stdio: "inherit" });
    if (built.status !== 0) throw new Error(`${path.basename(source)} did not compile`);
  }
  return binary;
}

/** A Swift file under scripts/, by name. */
export const scriptSource = (name: string) => path.join(import.meta.dir, "..", "..", "scripts", name);

/** Any fixture that prints `READY pid=<n> windows=<title>=<id>,...` works. */
export async function launchFixture(extra: string[] = [], source = FIXTURE_SOURCE): Promise<Fixture> {
  const statusFile = path.join(WORK, `status-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  const child = spawn(buildFixture(source), ["--status-file", statusFile, ...extra], { stdio: ["ignore", "pipe", "inherit"] });
  let seen = "";
  const ready = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the fixture never said READY")), 60_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
      const line = seen.split("\n").find((l) => l.startsWith("READY"));
      if (line) {
        clearTimeout(timer);
        resolve(line);
      }
    });
    child.on("exit", () => reject(new Error("the fixture exited before READY")));
  });
  const pid = Number(/pid=(\d+)/.exec(ready)?.[1]);
  const windows: Record<string, number> = {};
  for (const pair of (/windows=(.*)$/.exec(ready)?.[1] ?? "").split(",")) {
    const [title, id] = pair.split("=");
    if (title && id) windows[title] = Number(id);
  }
  return { child, pid, windows, statusFile, output: () => seen };
}

export function fixtureStatus(fixture: Fixture): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(fixture.statusFile, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * A client for the installed helper, or with `helper` for a build run in
 * place: spawned as this process's child, so it borrows this terminal's grants
 * instead of its own, with a home of its own so it never attaches to the
 * installed helper's instance.
 */
export function fixtureClient(helper?: string): ComputerClient {
  if (helper) isolateCodecastDir("cc-bench-dev-home-");
  return new ComputerClient({
    helperLaunch: (socketPath, tokenPath) =>
      helper
        ? { cmd: helper, args: ["--agent", socketPath, "--token-file", tokenPath] }
        : disclaimedHelperLaunch(helperExecutablePath(), ["--agent", socketPath, "--token-file", tokenPath]),
  });
}

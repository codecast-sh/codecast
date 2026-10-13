import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { helperAppPath, helperExecutablePath, materializeLinuxHelper } from "../helperApp.js";
import { computerLinuxHelperSource, helperIsEmbedded } from "../helperPayload.js";

const SCRIPT = path.join(import.meta.dir, "helper.py");
const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe("the Linux helper", () => {
  // The renderer, chords and PNG encoder are pure, so they run anywhere
  // python3 does; the AT-SPI and X11 halves are proven on a Linux host.
  test.skipIf(!hasPython)("passes its own self-test", () => {
    const run = spawnSync("python3", [SCRIPT, "--self-test"], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.stdout.trim()).toBe("self-test ok");
    expect(run.status).toBe(0);
  });

  test("is embedded byte for byte, so every build carries the script it was built from", () => {
    expect(computerLinuxHelperSource()).toBe(fs.readFileSync(SCRIPT, "utf-8"));
    expect(helperIsEmbedded("linux")).toBe(true);
  });

  test.skipIf(!hasPython)("refuses to run by hand", () => {
    const run = spawnSync("python3", [SCRIPT], { encoding: "utf8" });
    expect(run.status).toBe(13);
  });
});

describe("materializeLinuxHelper", () => {
  let dir: string;
  const saved = process.env.CODECAST_DIR;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-linux-helper-"));
    process.env.CODECAST_DIR = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("writes the script once, private to the user, and leaves identical bytes alone", () => {
    const first = materializeLinuxHelper("print('v1')\n");
    expect(first.installed).toBe(true);
    expect(first.executablePath).toBe(helperExecutablePath(helperAppPath("linux"), "linux"));
    expect(fs.readFileSync(first.executablePath, "utf-8")).toBe("print('v1')\n");
    expect(fs.statSync(first.executablePath).mode & 0o777).toBe(0o700);
    expect(materializeLinuxHelper("print('v1')\n").installed).toBe(false);
  });

  test("replaces a stale script and leaves no temp file behind", () => {
    materializeLinuxHelper("print('old')\n");
    const next = materializeLinuxHelper("print('new')\n");
    expect(next.installed).toBe(true);
    expect(fs.readFileSync(next.executablePath, "utf-8")).toBe("print('new')\n");
    expect(fs.readdirSync(next.appPath)).toEqual(["codecast-computer.py"]);
  });
});

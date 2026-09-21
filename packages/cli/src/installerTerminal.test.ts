import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const installer = process.env.CAST_INSTALLER_TEST_SCRIPT ?? resolve(import.meta.dir, "../../web/public/install.sh");
const driver = join(import.meta.dir, "test-helpers/installerTerminal.py");
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function install(mode: string, token = "", existingLogin = false) {
  const home = mkdtempSync(join(tmpdir(), "cast installer "));
  homes.push(home);
  const bin = join(home, "bin");
  mkdirSync(bin);
  if (existingLogin) {
    mkdirSync(join(home, ".codecast"));
    writeFileSync(join(home, ".codecast/config.json"), "{}");
  }
  const resultPath = join(home, "result.json");
  const binary = join(home, "prompt");
  writeFileSync(binary, `#!${process.execPath}
import { confirm } from ${JSON.stringify(import.meta.resolve("@inquirer/prompts"))};
import { writeFileSync } from "node:fs";
const result = { args: process.argv.slice(2), interactive: process.stdin.isTTY === true };
if (result.args[0] !== "start" && result.interactive) {
  result.syncAll = await confirm({ message: "Sync all projects? (recommended)", default: true });
  result.memory = await confirm({ message: "Keep agent memory enabled?", default: true });
}
writeFileSync(process.env.INSTALL_TEST_RESULT, JSON.stringify(result));
`, { mode: 0o755 });
  writeFileSync(join(bin, "curl"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    cp "$INSTALL_TEST_BINARY" "$2"
    exit 0
  fi
  shift
done
exit 1
`, { mode: 0o755 });
  const env = {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    SHELL: "/bin/sh",
    TERM: "xterm-256color",
    TMPDIR: home,
    INSTALL_TEST_BINARY: binary,
    INSTALL_TEST_RESULT: resultPath,
  };
  const options = join(home, "options.json");
  const report = join(home, "terminal.json");
  writeFileSync(options, JSON.stringify({ script: installer, token, mode, env, report }));
  const { stdout, stderr, status } = spawnSync(Bun.which("python3")!, [driver, options], { encoding: "utf8", timeout: 25_000 });
  expect(stderr).toBe("");
  expect(status, stdout).toBe(0);
  const terminal = JSON.parse(readFileSync(report, "utf8")) as { status: number; output: string };
  expect(terminal.status, terminal.output).toBe(0);
  return {
    ...terminal,
    installed: existsSync(join(home, ".local/bin/cast")),
    result: existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null,
  };
}

describe.skipIf(process.platform === "win32" || !Bun.which("python3"))("installer terminal input", () => {
  for (const token of ["", "fixture-token"]) {
    for (const mode of ["piped", "direct", "stdout-only", "stderr-only"]) {
      test(`${token ? "token login" : "browser auth"} accepts two answers with ${mode} input`, () => {
        const result = install(mode, token);
        expect(result.installed).toBe(true);
        expect(result.result).toEqual({
          args: token ? ["login", token] : ["auth"], interactive: true, syncAll: false, memory: true,
        });
      }, 30_000);
    }
  }

  test("a headless token install invokes noninteractive login", () => {
    const result = install("headless", "fixture-token");
    expect(result.installed).toBe(true);
    expect(result.result).toEqual({ args: ["login", "fixture-token"], interactive: false });
  }, 30_000);

  test("a headless fresh install prints the sign-in command", () => {
    const result = install("headless");
    expect(result.installed).toBe(true);
    expect(result.result).toBeNull();
    expect(result.output).toContain("Run 'cast auth' to authenticate and start syncing.");
  }, 30_000);

  test("an existing login still starts the daemon", () => {
    const result = install("headless", "", true);
    expect(result.installed).toBe(true);
    expect(result.result).toEqual({ args: ["start"], interactive: false });
  }, 30_000);
});

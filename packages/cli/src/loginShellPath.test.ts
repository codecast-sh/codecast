import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { captureLoginShellPath, parseCapturedPath, recordLoginShellPath, LOGIN_PATH_FILENAME } from "./loginShellPath";
import { buildDaemonLauncherScript, shellEscapeForSh } from "./supervision";

describe("parseCapturedPath", () => {
  test("reads only the marked line, past whatever the profile printed", () => {
    expect(parseCapturedPath("Welcome!\n__CAST_LOGIN_PATH__/opt/homebrew/bin:/usr/bin__CAST_LOGIN_PATH__\nbye")).toBe("/opt/homebrew/bin:/usr/bin");
    expect(parseCapturedPath("no marker here")).toBeNull();
    expect(parseCapturedPath("__CAST_LOGIN_PATH____CAST_LOGIN_PATH__")).toBeNull();
  });
});

describe("captureLoginShellPath", () => {
  test("a real login shell answers with a PATH", () => {
    const got = captureLoginShellPath("/bin/sh");
    expect(got).toContain("/");
  });
  test("a shell that does not exist yields null", () => {
    expect(captureLoginShellPath("/nonexistent/shell")).toBeNull();
  });
});

describe("the daemon launcher", () => {
  test("puts the recorded login PATH ahead of launchd's bare one before exec", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "login-path-"));
    recordLoginShellPath(dir, () => "/fake/mise/shims:/fake/homebrew/bin");
    const file = path.join(dir, LOGIN_PATH_FILENAME);
    const launcher = path.join(dir, "launcher.sh");
    fs.writeFileSync(launcher, buildDaemonLauncherScript({ daemonCommand: `${shellEscapeForSh("/bin/sh")} -c 'echo "$PATH"'`, loginPathFile: file }));
    const out = spawnSync("/bin/sh", [launcher], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect(out.stdout.trim()).toBe("/fake/mise/shims:/fake/homebrew/bin:/usr/bin:/bin");

    // No capture recorded: launchd's PATH passes through unchanged.
    fs.rmSync(file);
    const bare = spawnSync("/bin/sh", [launcher], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect(bare.stdout.trim()).toBe("/usr/bin:/bin");
  });
});

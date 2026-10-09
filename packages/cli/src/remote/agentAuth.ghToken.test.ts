import { describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as realProc from "../proc.js";

let spawns = 0;
mock.module("../proc.js", () => ({
  ...realProc,
  spawnSync: (cmd: string, args: string[], opts: any) => {
    if (cmd !== "gh") return realProc.spawnSync(cmd, args, opts);
    spawns++;
    return { status: 0, stdout: `gho_token${spawns}\n`, stderr: "" };
  },
}));

const { readGhLogin } = await import("./agentAuth.js");

describe("readGhLogin keychain token", () => {
  test("reuses the token while hosts.yml is unchanged, asks again after the TTL or a change", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-login-"));
    const hostsFile = path.join(dir, "hosts.yml");
    fs.writeFileSync(hostsFile, "github.com:\n    user: ada\n    git_protocol: ssh\n");
    const env = { GH_CONFIG_DIR: dir };
    const t0 = 1_000_000;

    expect(readGhLogin("/home", env, t0)).toContain("oauth_token: gho_token1");
    expect(readGhLogin("/home", env, t0 + 60_000)).toContain("oauth_token: gho_token1");
    expect(spawns).toBe(1);

    expect(readGhLogin("/home", env, t0 + 31 * 60_000)).toContain("oauth_token: gho_token2");
    expect(spawns).toBe(2);

    fs.writeFileSync(hostsFile, "github.com:\n    user: grace\n    git_protocol: ssh\n");
    expect(readGhLogin("/home", env, t0 + 32 * 60_000)).toContain("oauth_token: gho_token3");
    expect(spawns).toBe(3);
  });
});

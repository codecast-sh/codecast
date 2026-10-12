import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readGhLogin } from "./agentAuth.js";

// A stub gh on PATH that counts its calls and answers token<n>.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gh-login-"));
const bin = path.join(root, "bin");
const calls = path.join(root, "calls");
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho x >> "${calls}"\necho "gho_token$(wc -l < "${calls}" | tr -d ' ')"\n`, { mode: 0o755 });
const savedPath = process.env.PATH;
process.env.PATH = `${bin}:${savedPath}`;
afterAll(() => { process.env.PATH = savedPath; });

const spawns = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf-8").split("\n").filter(Boolean).length : 0);

describe("readGhLogin keychain token", () => {
  test("reuses the token while hosts.yml is unchanged, asks again after the TTL or a change", () => {
    const dir = path.join(root, "gh");
    fs.mkdirSync(dir);
    const hostsFile = path.join(dir, "hosts.yml");
    fs.writeFileSync(hostsFile, "github.com:\n    user: ada\n    git_protocol: ssh\n");
    const env = { GH_CONFIG_DIR: dir };
    const t0 = 1_000_000;

    expect(readGhLogin("/home", env, t0)).toContain("oauth_token: gho_token1");
    expect(readGhLogin("/home", env, t0 + 60_000)).toContain("oauth_token: gho_token1");
    expect(spawns()).toBe(1);

    expect(readGhLogin("/home", env, t0 + 31 * 60_000)).toContain("oauth_token: gho_token2");
    expect(spawns()).toBe(2);

    fs.writeFileSync(hostsFile, "github.com:\n    user: grace\n    git_protocol: ssh\n");
    expect(readGhLogin("/home", env, t0 + 32 * 60_000)).toContain("oauth_token: gho_token3");
    expect(spawns()).toBe(3);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const processEntry = path.join(import.meta.dir, "main.ts");
const scratch: string[] = [];

function scratchHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-config-cli-"));
  scratch.push(home);
  fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codecast", "update-state.json"), JSON.stringify({ lastCheck: new Date().toISOString() }));
  return home;
}

function runCli(home: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [processEntry, ...args], {
      env: { ...process.env, HOME: home, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

function config(home: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(home, ".codecast", "config.json"), "utf-8"));
}

afterEach(() => {
  for (const h of scratch.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

describe("cast config — the home mirror keys", () => {
  test("cloud_mirror_enabled persists a boolean; true/1/false/0 coerce; anything else is refused", async () => {
    const home = scratchHome();
    expect((await runCli(home, ["config", "cloud_mirror_enabled", "false"])).code).toBe(0);
    expect(config(home).cloud_mirror_enabled).toBe(false);
    expect((await runCli(home, ["config", "cloud_mirror_enabled", "1"])).code).toBe(0);
    expect(config(home).cloud_mirror_enabled).toBe(true);
    expect((await runCli(home, ["config", "cloud_mirror_enabled", "0"])).code).toBe(0);
    expect(config(home).cloud_mirror_enabled).toBe(false);
    expect((await runCli(home, ["config", "cloud_mirror_enabled", "true"])).code).toBe(0);
    expect(config(home).cloud_mirror_enabled).toBe(true);
    const bad = await runCli(home, ["config", "cloud_mirror_enabled", "maybe"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("takes true or false");
    expect(config(home).cloud_mirror_enabled).toBe(true);
    const shown = await runCli(home, ["config", "cloud_mirror_enabled"]);
    expect(shown.stdout.trim()).toBe("cloud_mirror_enabled: true");
  }, 60_000);

  test("cloud_mirror_exclude and cloud_mirror_include round-trip; an unknown key still exits 1; the listing names the keys", async () => {
    const home = scratchHome();
    expect((await runCli(home, ["config", "cloud_mirror_exclude", ".claude/skills/private-*"])).code).toBe(0);
    expect(config(home).cloud_mirror_exclude).toBe(".claude/skills/private-*");
    expect((await runCli(home, ["config", "cloud_mirror_exclude"])).stdout.trim()).toBe("cloud_mirror_exclude: .claude/skills/private-*");
    expect((await runCli(home, ["config", "cloud_mirror_include", ".dotfiles/skills"])).code).toBe(0);
    expect(config(home).cloud_mirror_include).toBe(".dotfiles/skills");
    const bogus = await runCli(home, ["config", "bogus", "x"]);
    expect(bogus.code).toBe(1);
    expect(bogus.stderr).toContain("Unknown config key");
    const listing = await runCli(home, ["config"]);
    expect(listing.stdout).toContain("cloud_mirror_enabled: true");
    expect(listing.stdout).toContain("cloud_mirror_exclude: .claude/skills/private-*");
    expect(listing.stdout).toContain("cloud_mirror_include: .dotfiles/skills");
  }, 60_000);
});

// The hook secret and the upgrade path for scripts installed before it.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  admitHookRequest,
  createLegacyHookGrace,
  installedHooksCarryToken,
  refreshInstalledHookScripts,
  tokenCarryingHookScripts,
} from "./hookAdmission.js";
import { HOOK_TOKEN_MARKER, hookBearerToken, hookTokenMatches, loadOrCreateHookToken, readHookToken } from "./hookIdentity.js";

const TOKEN = "c".repeat(64);

function scratchHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-hook-"));
  fs.mkdirSync(path.join(home, ".claude", "hooks"), { recursive: true });
  return home;
}

describe("hook secret", () => {
  test("mints once and keeps it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cfg-"));
    const first = loadOrCreateHookToken(dir);
    expect(first.length).toBe(64);
    expect(loadOrCreateHookToken(dir)).toBe(first);
    expect(readHookToken(dir)).toBe(first);
    expect(fs.statSync(path.join(dir, "hook-token")).mode & 0o777).toBe(0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("an empty expected token authenticates nobody", () => {
    expect(hookTokenMatches("", "")).toBe(false);
    expect(hookTokenMatches(TOKEN, "")).toBe(false);
    expect(hookTokenMatches("", TOKEN)).toBe(false);
    expect(hookTokenMatches(undefined, TOKEN)).toBe(false);
  });

  test("reads only a bearer header", () => {
    expect(hookBearerToken({ authorization: `Bearer ${TOKEN}` })).toBe(TOKEN);
    expect(hookBearerToken({ authorization: TOKEN })).toBe("");
    expect(hookBearerToken({})).toBe("");
    expect(hookBearerToken({ authorization: [`Bearer ${TOKEN}`] })).toBe(TOKEN);
  });
});

describe("admission", () => {
  const opts = (legacy: boolean) => ({ token: TOKEN, legacyAllowed: () => legacy });

  test("no token is refused once the grace is over", () => {
    expect(admitHookRequest({}, opts(false))).toEqual({ ok: false, reason: "no-token" });
  });

  test("no token is accepted as legacy while the grace holds", () => {
    expect(admitHookRequest({}, opts(true))).toEqual({ ok: true, legacy: true });
  });

  test("a wrong token is refused whatever the grace says", () => {
    for (const legacy of [false, true]) {
      expect(admitHookRequest({ authorization: `Bearer ${"d".repeat(64)}` }, opts(legacy))).toEqual({
        ok: false,
        reason: "bad-token",
      });
    }
  });

  test("the real token is accepted", () => {
    expect(admitHookRequest({ authorization: `Bearer ${TOKEN}` }, opts(false))).toEqual({ ok: true, legacy: false });
  });
});

describe("legacy hook scripts", () => {
  test("every script this build installs carries the marker", () => {
    for (const [name, text] of Object.entries(tokenCarryingHookScripts())) {
      expect(text.includes(HOOK_TOKEN_MARKER), name).toBe(true);
    }
  });

  test("an old script on disk keeps the grace open, and the daemon upgrades it", () => {
    const home = scratchHome();
    const file = path.join(home, ".claude", "hooks", "codecast-status.sh");
    fs.writeFileSync(file, "#!/bin/bash\n# codecast status hook from before the token\nexit 0\n", { mode: 0o755 });

    expect(installedHooksCarryToken(home)).toBe(false);

    const logs: string[] = [];
    const grace = createLegacyHookGrace({ home, log: (m) => logs.push(m) });
    // The post that found the old script is still believed…
    expect(grace.allowed()).toBe(true);
    // …and the script it found has been rewritten, so the next one is not.
    expect(fs.readFileSync(file, "utf8")).toContain(HOOK_TOKEN_MARKER);
    expect(grace.allowed()).toBe(false);
    expect(logs.join("\n")).toContain("upgraded installed hook scripts");

    fs.rmSync(home, { recursive: true, force: true });
  });

  test("a machine with current scripts never opens the grace", () => {
    const home = scratchHome();
    for (const [name, text] of Object.entries(tokenCarryingHookScripts())) {
      fs.writeFileSync(path.join(home, ".claude", "hooks", name), text, { mode: 0o755 });
    }
    expect(installedHooksCarryToken(home)).toBe(true);
    expect(createLegacyHookGrace({ home, log: () => {} }).allowed()).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("a machine with no codecast hooks installed never opens the grace", () => {
    const home = scratchHome();
    expect(installedHooksCarryToken(home)).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("a script somebody else owns is never rewritten", () => {
    const home = scratchHome();
    const file = path.join(home, ".claude", "hooks", "codecast-status.sh");
    fs.writeFileSync(file, "#!/bin/bash\n# someone else's script\n", { mode: 0o755 });
    expect(refreshInstalledHookScripts(home)).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toContain("someone else's script");
    fs.rmSync(home, { recursive: true, force: true });
  });
});

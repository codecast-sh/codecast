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
import { handStartedAt, LaunchTokenLedger } from "./launchToken.js";

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

// The other half of the same migration. A hook forwards its pane's launch
// token out of its own ENV, so a pane this daemon launched always has one to
// forward; a tokenless post for a pane the ledger knows can only be a script
// too old to read it. That acceptance ends when such a script is no longer
// installed — the same reading that ends the tokenless HTTP grace.
describe("legacy launch tokens", () => {
  const ledger = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ledger-"));
    return new LaunchTokenLedger({ dir });
  };
  const SESSION = "9f8c1e2a-4b6d-4f31-9c0a-1b2c3d4e5f60";

  test("a tokenless post for a known pane is believed while an old script is installed", () => {
    const l = ledger();
    l.issue("cast-agent-1", SESSION);
    expect(l.admit({ sessionId: SESSION, legacyScripts: true }).decision).toBe("accept");
  });

  test("and is dropped once every installed script forwards the token", () => {
    const l = ledger();
    l.issue("cast-agent-1", SESSION);
    const verdict = l.admit({ sessionId: SESSION, legacyScripts: false });
    expect(verdict.decision).toBe("drop");
    expect(verdict.reason).toBe("legacy");
  });

  test("a pane this daemon never launched is unaffected either way", () => {
    // A claude the user opened in their own terminal. Nothing here fences it.
    for (const legacyScripts of [true, false]) {
      const l = ledger();
      const verdict = l.admit({ sessionId: "someone-elses-session", legacyScripts });
      expect(verdict.decision, String(legacyScripts)).toBe("accept");
      expect(verdict.reason, String(legacyScripts)).toBe("unmanaged");
    }
  });

  test("a current token is admitted whatever the scripts look like", () => {
    for (const legacyScripts of [true, false]) {
      const l = ledger();
      const token = l.issue("cast-agent-1", SESSION);
      expect(l.admit({ sessionId: SESSION, token, legacyScripts }).decision).toBe("accept");
    }
  });

  test("callers that know nothing about installed scripts behave as they always did", () => {
    const l = ledger();
    l.issue("cast-agent-1", SESSION);
    expect(l.admit({ sessionId: SESSION }).decision).toBe("accept");
  });

  // A session codecast once resumed into its own tmux, then resumed by hand in
  // the person's own terminal (`claude --resume <id>` in herdr, Ghostty, …).
  // That claude has no CODECAST_LAUNCH_TOKEN in its env, so every post it
  // makes is tokenless, and its SessionStart claim in the session registry
  // says so (`"launch_token":""`). It is not an old script: it is a session
  // codecast no longer launched, and it must report status like one.
  test("a session resumed by hand after codecast launched it is not fenced", () => {
    let now = 1_793_000_000_000;
    const l = new LaunchTokenLedger({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "cc-ledger-")), now: () => now });
    l.issue("cc-resume-notes-0a1b2c3d", SESSION);
    now += 3 * 24 * 60 * 60 * 1000;
    const handStart = Math.floor(now / 1000);
    const verdict = l.admit({ sessionId: SESSION, legacyScripts: false, handStartedAt: handStart * 1000 });
    expect(verdict.decision).toBe("accept");
    expect(verdict.reason).toBe("unmanaged");
    expect(verdict.notable).toBe(false);
  });

  test("a hand start older than codecast's launch still leaves a tokenless post fenced", () => {
    let now = 1_793_000_000_000;
    const l = new LaunchTokenLedger({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "cc-ledger-")), now: () => now });
    const handStart = now - 60_000;
    l.issue("cc-resume-notes-0a1b2c3d", SESSION);
    const verdict = l.admit({ sessionId: SESSION, legacyScripts: false, handStartedAt: handStart });
    expect(verdict.decision).toBe("drop");
    expect(verdict.reason).toBe("legacy");
  });

  test("a hand start never admits a superseded launch token", () => {
    let now = 1_793_000_000_000;
    const l = new LaunchTokenLedger({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "cc-ledger-")), now: () => now });
    const stale = l.issue("cc-resume-notes-0a1b2c3d", SESSION);
    now += 1000;
    l.issue("cc-resume-notes-0a1b2c3d-2", SESSION);
    now += 60_000;
    const verdict = l.admit({ sessionId: SESSION, token: stale, legacyScripts: false, handStartedAt: now });
    expect(verdict.decision).toBe("drop");
  });
});

describe("handStartedAt reads a tokenless SessionStart claim", () => {
  test("a claim with an empty launch token is a hand start, in ms", () => {
    expect(handStartedAt({ pid: 51234, tty: "ttys004", ts: 1790000000, term: "herdr", launch_token: "" })).toBe(1790000000 * 1000);
  });

  test("a claim from a codecast launch is not", () => {
    expect(handStartedAt({ pid: 51234, tty: "ttys004", ts: 1790000000, term: "tmux", launch_token: "ab".repeat(16) })).toBeUndefined();
  });

  test("a claim from a hook too old to write the field proves nothing", () => {
    expect(handStartedAt({ pid: 51234, tty: "ttys004", ts: 1790000000, term: "herdr" })).toBeUndefined();
    expect(handStartedAt(null)).toBeUndefined();
    expect(handStartedAt({ pid: 1, launch_token: "", ts: "soon" })).toBeUndefined();
  });
});

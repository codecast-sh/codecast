import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LEGACY_CC_KEYCHAIN_SERVICE,
  ccKeychainAccount,
  ccKeychainReadArgs,
  ccKeychainReadItems,
  ccKeychainWriteItem,
  claudeConfigDir,
} from "./ccKeychain.js";
import { readLocalCredentialAsync } from "./remote/session-move.js";

// Every test runs with a sandboxed env: HOME in a temp dir, and a PATH that
// names no real directory so a keychain lookup finds no `security` to run.
// Only the ASYNC read may be exercised here: bun's SYNC spawn resolves the
// binary regardless of PATH, so a sync read would answer from the machine's
// real keychain (the note in ccAccounts.test.ts records the same trap).
const ENV_KEYS = ["CLAUDE_CONFIG_DIR", "USER", "USERNAME", "PATH", "HOME"] as const;
let saved: Record<string, string | undefined>;
let tmp: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cckeychain-"));
  process.env.HOME = tmp;
  process.env.PATH = path.join(tmp, "empty-path");
  process.env.USER = "ashot";
  delete process.env.USERNAME;
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const scoped = (dir: string) =>
  `${LEGACY_CC_KEYCHAIN_SERVICE}-${createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8)}`;

describe("ccKeychainReadItems", () => {
  it("is the legacy item alone when no config dir is set", () => {
    expect(ccKeychainReadItems()).toEqual([{ service: LEGACY_CC_KEYCHAIN_SERVICE, account: "ashot" }]);
  });

  it("names the item Claude Code 2.1 actually reads", () => {
    // Observed live on 2.1.263: with CLAUDE_CONFIG_DIR=/tmp/ccdir.gAP66S, claude
    // authenticated off an item planted at this exact service name and reported
    // "Not logged in" while only the machine item held a login.
    expect(ccKeychainReadItems("/tmp/ccdir.gAP66S")[0].service).toBe("Claude Code-credentials-d3213560");
    expect(ccKeychainReadItems("/private/tmp/ccdir.gAP66S")[0].service).toBe(
      "Claude Code-credentials-cbc4144b",
    );
  });

  it("puts the scoped item first and keeps the legacy item as a fallback", () => {
    const dir = path.join(fs.realpathSync(tmp), "config");
    fs.mkdirSync(dir);
    expect(ccKeychainReadItems(dir).map((i) => i.service)).toEqual([
      scoped(dir),
      LEGACY_CC_KEYCHAIN_SERVICE,
    ]);
  });

  it("tries the resolved spelling too — /var and /private/var hash differently", () => {
    const real = path.join(tmp, "real-config");
    fs.mkdirSync(real);
    const link = path.join(tmp, "link-config");
    fs.symlinkSync(real, link);
    expect(ccKeychainReadItems(link).map((i) => i.service)).toEqual([
      scoped(link),
      scoped(fs.realpathSync(real)),
      LEGACY_CC_KEYCHAIN_SERVICE,
    ]);
  });

  it("keeps one candidate per spelling when the path resolves to itself", () => {
    const dir = fs.realpathSync(tmp);
    expect(ccKeychainReadItems(dir)).toHaveLength(2);
  });

  it("hashes a config dir that does not exist yet", () => {
    const dir = path.join(tmp, "never-created");
    expect(ccKeychainReadItems(dir).map((i) => i.service)).toEqual([
      scoped(dir),
      LEGACY_CC_KEYCHAIN_SERVICE,
    ]);
  });

  it("normalizes to NFC, so a decomposed path finds the composed item", () => {
    const composed = "/tmp/caf\u00E9-config";
    const decomposed = "/tmp/cafe\u0301-config";
    expect(composed).not.toBe(decomposed);
    expect(ccKeychainReadItems(decomposed)[0].service).toBe(ccKeychainReadItems(composed)[0].service);
  });

  it("reads the config dir from the env", () => {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/ccdir.gAP66S";
    expect(claudeConfigDir()).toBe("/tmp/ccdir.gAP66S");
    expect(ccKeychainReadItems()[0].service).toBe("Claude Code-credentials-d3213560");
  });

  it("treats a blank CLAUDE_CONFIG_DIR as unset", () => {
    process.env.CLAUDE_CONFIG_DIR = "   ";
    expect(claudeConfigDir()).toBeUndefined();
    expect(ccKeychainReadItems()).toHaveLength(1);
  });

  it("matches on service alone — an old item can carry an account our rule never picks", () => {
    expect(ccKeychainReadArgs({ service: "svc", account: "ashot" })).toEqual([
      "find-generic-password",
      "-s",
      "svc",
      "-w",
    ]);
  });
});

describe("ccKeychainAccount", () => {
  it("is $USER when the keychain rule accepts it", () => {
    process.env.USER = "ashot.dev_1-x";
    expect(ccKeychainAccount()).toBe("ashot.dev_1-x");
  });

  it("falls back to claude-code-user for an SSO-style name", () => {
    process.env.USER = "first@example.com";
    expect(ccKeychainAccount()).toBe("claude-code-user");
  });

  it("falls back for a name with a space", () => {
    process.env.USER = "Ada Lovelace";
    expect(ccKeychainAccount()).toBe("claude-code-user");
  });

  it("takes USERNAME when USER is unset", () => {
    delete process.env.USER;
    process.env.USERNAME = "ada";
    expect(ccKeychainAccount()).toBe("ada");
  });

  it("falls back to the process owner when neither is set", () => {
    delete process.env.USER;
    delete process.env.USERNAME;
    expect(ccKeychainAccount()).toBe(os.userInfo().username);
  });
});

describe("ccKeychainWriteItem", () => {
  it("is the legacy item when no config dir is set", () => {
    expect(ccKeychainWriteItem()).toEqual({ service: LEGACY_CC_KEYCHAIN_SERVICE, account: "ashot" });
  });

  it("writes ONLY the scoped item, never the machine login too", () => {
    const dir = path.join(tmp, "config");
    fs.mkdirSync(dir);
    expect(ccKeychainWriteItem(dir)).toEqual({ service: scoped(dir), account: "ashot" });
  });

  it("writes the spelling it was given — that is the one the session set", () => {
    const real = path.join(tmp, "real-config");
    fs.mkdirSync(real);
    const link = path.join(tmp, "link-config");
    fs.symlinkSync(real, link);
    expect(ccKeychainWriteItem(link).service).toBe(scoped(link));
  });
});

describe("readLocalCredentialAsync", () => {
  it("walks every candidate, then falls back to the file form", async () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "config");
    fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".claude", ".credentials.json"), '{"claudeAiOauth":{}}');
    expect(await readLocalCredentialAsync()).toBe('{"claudeAiOauth":{}}');
  });

  it("returns null when neither the keychain nor the file has one", async () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "config");
    expect(await readLocalCredentialAsync()).toBeNull();
  });
});

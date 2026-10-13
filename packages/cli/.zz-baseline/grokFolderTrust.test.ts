import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ensureGrokFolderTrusted,
  grokFolderIsTrusted,
  grokTrustedFoldersPath,
  normalizeGrokFolderPath,
  upsertGrokTrustedFolder,
} from "./grokFolderTrust.js";

const EXISTING = `[folders."/Users/ashot/src/codecast"]
trusted = true
decided_at = 1788277445

[folders."/Users/ashot/src/union-mobile"]
trusted = true
decided_at = 1788279605
`;

describe("upsertGrokTrustedFolder", () => {
  test("appends an untrusted cwd in grok's own table shape", () => {
    const { text, changed } = upsertGrokTrustedFolder(EXISTING, "/Users/ashot/src/mail", 1789572151);
    expect(changed).toBe(true);
    expect(text).toContain('[folders."/Users/ashot/src/mail"]');
    expect(text).toContain("trusted = true");
    expect(text).toContain("decided_at = 1789572151");
    expect(grokFolderIsTrusted(text, "/Users/ashot/src/mail")).toBe(true);
    expect(grokFolderIsTrusted(text, "/Users/ashot/src/codecast")).toBe(true);
  });

  test("is a no-op when the cwd is already trusted", () => {
    const { text, changed } = upsertGrokTrustedFolder(EXISTING, "/Users/ashot/src/codecast", 1);
    expect(changed).toBe(false);
    expect(text).toBe(EXISTING);
  });

  test("strips a trailing slash so git-root and cwd agree", () => {
    expect(normalizeGrokFolderPath("/Users/ashot/src/mail/")).toBe("/Users/ashot/src/mail");
    expect(grokFolderIsTrusted(EXISTING, "/Users/ashot/src/codecast/")).toBe(true);
  });

  test("starts a missing file as a single table", () => {
    const { text, changed } = upsertGrokTrustedFolder("", "/tmp/untrusted", 10);
    expect(changed).toBe(true);
    expect(text).toBe('[folders."/tmp/untrusted"]\ntrusted = true\ndecided_at = 10\n');
  });
});

describe("ensureGrokFolderTrusted", () => {
  test("writes the cwd and does not clobber other folders", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-trust-"));
    fs.writeFileSync(grokTrustedFoldersPath(home), EXISTING);
    expect(ensureGrokFolderTrusted("/Users/ashot/src/mail", home)).toBe(true);
    expect(ensureGrokFolderTrusted("/Users/ashot/src/mail", home)).toBe(false);
    const toml = fs.readFileSync(grokTrustedFoldersPath(home), "utf8");
    expect(grokFolderIsTrusted(toml, "/Users/ashot/src/mail")).toBe(true);
    expect(grokFolderIsTrusted(toml, "/Users/ashot/src/codecast")).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

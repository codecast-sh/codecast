// `patchOauthAccount` is a read-modify-write over a file codecast does not own.
// ~/.claude.json is CC's own config — per-project history, MCP servers, settings,
// megabytes of it on an established machine — and codecast owns exactly one key
// in it. Every case below asks the same question: when the read half fails, does
// the write half still fire and take the rest of the file with it?
//
// The interesting failure is not exotic. CC rewrites this file non-atomically
// from every running claude process, so reading it mid-write returns truncated
// JSON, and an account switch runs at exactly the moments claude is busy.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { patchOauthAccount, readOauthAccount } from "./ccAccounts.js";

const ACCOUNT = { emailAddress: "new@example.com", accountUuid: "uuid-new" };

// What CC keeps in the file besides our one key. Nothing here is reconstructible
// from anywhere else on the machine, which is the whole reason to refuse a write.
const EXISTING_CONFIG = {
  oauthAccount: { emailAddress: "old@example.com", accountUuid: "uuid-old" },
  numStartups: 412,
  projects: { "/Users/x/src/thing": { history: ["a query", "another query"] } },
  mcpServers: { linear: { command: "linear-mcp" } },
};

describe("patchOauthAccount: never trade CC's config for one key", () => {
  let home: string;
  let savedHome: string | undefined;
  const configPath = () => path.join(home, ".claude.json");

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-claudejson-"));
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("replaces our key and leaves every other one untouched", () => {
    fs.writeFileSync(configPath(), JSON.stringify(EXISTING_CONFIG, null, 2));

    patchOauthAccount(ACCOUNT);

    const after = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
    expect(after.oauthAccount).toEqual(ACCOUNT);
    expect(after.numStartups).toBe(412);
    expect(after.projects).toEqual(EXISTING_CONFIG.projects);
    expect(after.mcpServers).toEqual(EXISTING_CONFIG.mcpServers);
  });

  it("creates the file when there is none, which is first run and not a failure", () => {
    patchOauthAccount(ACCOUNT);

    expect(JSON.parse(fs.readFileSync(configPath(), "utf-8"))).toEqual({
      oauthAccount: ACCOUNT,
    });
    expect(readOauthAccount()).toEqual(ACCOUNT);
  });

  it("refuses a config that does not parse, and leaves the bytes alone", () => {
    // A read that caught CC mid-write: valid JSON up to the cut.
    const torn = JSON.stringify(EXISTING_CONFIG, null, 2).slice(0, 120);
    fs.writeFileSync(configPath(), torn);

    expect(() => patchOauthAccount(ACCOUNT)).toThrow(/not valid JSON/);
    // The point of the throw: the damaged file is still all the user has, and a
    // torn read is transient — the next switch reads it whole.
    expect(fs.readFileSync(configPath(), "utf-8")).toBe(torn);
  });

  it("refuses a config it cannot read, and leaves the bytes alone", () => {
    if (process.getuid?.() === 0) return; // root reads through any mode
    const before = JSON.stringify(EXISTING_CONFIG, null, 2);
    fs.writeFileSync(configPath(), before);
    fs.chmodSync(configPath(), 0o000);

    expect(() => patchOauthAccount(ACCOUNT)).toThrow(/Cannot read/);

    fs.chmodSync(configPath(), 0o600);
    expect(fs.readFileSync(configPath(), "utf-8")).toBe(before);
  });

  it("refuses valid JSON that is not a config object", () => {
    // Parses fine, so a parse check alone lets this through — and assigning a
    // key to an array is dropped by JSON.stringify, so the write would succeed
    // while silently discarding the account it was called to set.
    fs.writeFileSync(configPath(), "[1, 2]");

    expect(() => patchOauthAccount(ACCOUNT)).toThrow(/an array/);
    expect(fs.readFileSync(configPath(), "utf-8")).toBe("[1, 2]");
  });

  it("writes over a zero-byte config, which has nothing left to lose", () => {
    fs.writeFileSync(configPath(), "");

    patchOauthAccount(ACCOUNT);

    expect(readOauthAccount()).toEqual(ACCOUNT);
  });

  it("keeps the permissions the config already has", () => {
    fs.writeFileSync(configPath(), JSON.stringify(EXISTING_CONFIG));
    fs.chmodSync(configPath(), 0o600);

    patchOauthAccount(ACCOUNT);

    // A user who hardened a file holding their OAuth identity must not find it
    // world-readable again after an account switch.
    expect((fs.statSync(configPath()).mode & 0o777).toString(8)).toBe("600");
  });

  it("says what to do next in every refusal", () => {
    const messages: string[] = [];
    for (const [body, _label] of [
      ["{ broken", "torn"],
      ["[1, 2]", "array"],
    ] as const) {
      fs.writeFileSync(configPath(), body);
      try {
        patchOauthAccount(ACCOUNT);
        throw new Error(`expected a refusal for ${body}`);
      } catch (err) {
        messages.push((err as Error).message);
      }
    }
    for (const message of messages) {
      expect(message).toContain(".claude.json"); // which file
      expect(message).toMatch(/refusing to rewrite/); // what did not happen
      expect(message).toMatch(/re-run the switch|repair or move/i); // what to do
    }
  });
});

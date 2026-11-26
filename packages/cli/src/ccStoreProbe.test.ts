import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { probeSecureStorageSupport } from "./ccStoreProbe.js";
import { isolateCodecastDir, type IsolatedCodecastDir } from "./test-helpers/codecastDir.js";

describe("probeSecureStorageSupport (isolated CODECAST_DIR)", () => {
  let home: string;
  let sandbox: IsolatedCodecastDir;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-store-probe-test-"));
    sandbox = isolateCodecastDir("cc-store-probe-dir-");
  });
  afterEach(() => {
    sandbox.restore();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("probes support once per binary: an empty store must report no login", async () => {
    const calls: Array<{ bin: string; args: string[]; dir: string | undefined }> = [];
    const exec = async (bin: string, args: string[], env: NodeJS.ProcessEnv) => {
      calls.push({ bin, args, dir: env.CLAUDE_SECURESTORAGE_CONFIG_DIR });
      return JSON.stringify({ loggedIn: calls.length === 1 ? false : true });
    };
    const bin = path.join(home, "claude");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    expect(await probeSecureStorageSupport(bin, { execImpl: exec })).toBe("supported");
    expect(calls[0].args).toEqual(["auth", "status", "--json"]);
    expect(calls[0].dir).toBeDefined();
    expect(fs.existsSync(calls[0].dir!)).toBe(false); // probe dir cleaned up
    // Cached: the same binary is not asked twice.
    expect(await probeSecureStorageSupport(bin, { execImpl: exec })).toBe("supported");
    expect(calls).toHaveLength(1);
    // A changed binary is asked again — and this one still sees the login.
    fs.writeFileSync(bin, "#!/bin/sh\n# v2\n");
    expect(await probeSecureStorageSupport(bin, { execImpl: exec })).toBe("unsupported");
    expect(calls).toHaveLength(2);
  });

  it("a probe that cannot answer is unknown, and is never cached as a negative", async () => {
    const bin = path.join(home, "claude");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    const ask = (impl: () => Promise<string>) => probeSecureStorageSupport(bin, { execImpl: impl, fresh: true });
    // A first run that waits on Gatekeeper past the timeout, then the same
    // binary answering normally once the machine is quiet again.
    expect(await ask(async () => { throw new Error("spawn timed out"); })).toBe("unknown");
    // Output that is not the JSON we asked for proves nothing either.
    expect(await ask(async () => "Downloading update...\n")).toBe("unknown");
    // A binary answering in a shape we do not understand is also unknown.
    expect(await ask(async () => JSON.stringify({ loggedIn: "no" }))).toBe("unknown");
    expect(await ask(async () => JSON.stringify({ loggedIn: false }))).toBe("supported");
    const cache = path.join(sandbox.dir, "cc-store", ".support.json");
    expect(JSON.parse(fs.readFileSync(cache, "utf-8")).verdict).toBe("supported");
  });

  // 2026-11-25 review: a remembered negative, then a fresh probe (the person
  // clicked Sign in again after updating) that times out on Gatekeeper. If the
  // negative stayed cached, the next beat would delete the store the sign-in
  // just filled.
  it("an unknown replaces an older negative, and is asked again after ten minutes", async () => {
    const bin = path.join(home, "claude");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    const t0 = 1_800_000_000_000;
    let calls = 0;
    const keychain = async () => { calls++; return JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }); };
    const timeout = async () => { calls++; throw new Error("spawn timed out"); };
    const empty = async () => { calls++; return JSON.stringify({ loggedIn: false }); };
    expect(await probeSecureStorageSupport(bin, { execImpl: keychain, now: t0 })).toBe("unsupported");
    expect(await probeSecureStorageSupport(bin, { execImpl: timeout, now: t0 + 60_000, fresh: true })).toBe("unknown");
    // The next beat reads the unknown, not the negative, and asks nothing.
    expect(await probeSecureStorageSupport(bin, { execImpl: empty, now: t0 + 90_000 })).toBe("unknown");
    expect(calls).toBe(2);
    expect(await probeSecureStorageSupport(bin, { execImpl: empty, now: t0 + 60_000 + 10 * 60_000 })).toBe("supported");
    expect(calls).toBe(3);
    // Nor by one that times out after another probe proved support meanwhile.
    const cache = path.join(sandbox.dir, "cc-store", ".support.json");
    fs.writeFileSync(cache, JSON.stringify({ identity: "other", verdict: "unknown", checked_at: t0 }));
    const racedBySupport = async () => {
      const identity = JSON.parse(fs.readFileSync(cache, "utf-8")).identity === "other" ? `${bin}:${fs.statSync(bin).size}:${Math.floor(fs.statSync(bin).mtimeMs)}` : "";
      fs.writeFileSync(cache, JSON.stringify({ identity, verdict: "supported", checked_at: t0 + 11 * 60_000 }));
      throw new Error("spawn timed out");
    };
    expect(await probeSecureStorageSupport(bin, { execImpl: racedBySupport, now: t0 + 11 * 60_000, fresh: true })).toBe("supported");
    // A proof stamped by a probe that started later still counts.
    const racedLater = async () => {
      const identity = `${bin}:${fs.statSync(bin).size}:${Math.floor(fs.statSync(bin).mtimeMs)}`;
      fs.writeFileSync(cache, JSON.stringify({ identity, verdict: "supported", checked_at: Date.now() }));
      throw new Error("spawn timed out");
    };
    expect(await probeSecureStorageSupport(bin, { execImpl: racedLater, now: Date.now() - 5_000, fresh: true })).toBe("supported");
    // Back to the proof from the first race, for the steps below.
    fs.writeFileSync(cache, JSON.stringify({ identity: `${bin}:${fs.statSync(bin).size}:${Math.floor(fs.statSync(bin).mtimeMs)}`, verdict: "supported", checked_at: t0 + 11 * 60_000 }));
    expect(JSON.parse(fs.readFileSync(cache, "utf-8")).verdict).toBe("supported");
    // A current proof of support is not displaced by a probe that times out.
    expect(await probeSecureStorageSupport(bin, { execImpl: timeout, now: t0 + 12 * 60_000, fresh: true })).toBe("supported");
    expect(await probeSecureStorageSupport(bin, { execImpl: timeout, now: t0 + 13 * 60_000 })).toBe("supported");
    expect(calls).toBe(4);
  });

  // 2026-11-25: an Anthropic Console login in ~/.config/anthropic answered
  // `loggedIn: true` (authMethod "oauth_token") with the store empty, and a
  // current Claude Code was recorded as ignoring the store.
  it("asks with every other credential source emptied, and only a keychain login is a negative", async () => {
    const bin = path.join(home, "claude");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    let seen: NodeJS.ProcessEnv = {};
    const answering = (status: object) => async (_b: string, _a: string[], env: NodeJS.ProcessEnv) => {
      seen = env;
      return JSON.stringify(status);
    };
    const env = { PATH: "/bin", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o", ANTHROPIC_CONFIG_DIR: "/real" };
    const ask = (status: object) => probeSecureStorageSupport(bin, { env, execImpl: answering(status), fresh: true });
    expect(await ask({ loggedIn: false, authMethod: "none" })).toBe("supported");
    expect(seen.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(seen.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(seen.ANTHROPIC_CONFIG_DIR).not.toBe("/real");
    expect(seen.ANTHROPIC_CONFIG_DIR!.startsWith(seen.CLAUDE_SECURESTORAGE_CONFIG_DIR!)).toBe(true);
    expect(seen.PATH).toBe("/bin");
    expect(await ask({ loggedIn: true, authMethod: "claude.ai" })).toBe("unsupported");
    expect(await ask({ loggedIn: true })).toBe("unsupported");
    // Some other source signed in: it says nothing about the store.
    expect(await ask({ loggedIn: true, authMethod: "oauth_token" })).toBe("unknown");
    expect(await ask({ loggedIn: true, authMethod: "api_key" })).toBe("unknown");
  });

  // A launcher script that execs the newest version keeps its size and mtime
  // across Claude Code updates, so a cached answer must expire on its own.
  it("a cached answer lasts an hour, and an entry without a check time is stale", async () => {
    const bin = path.join(home, "claude");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    let calls = 0;
    let answer = true;
    const exec = async () => { calls++; return JSON.stringify({ loggedIn: answer, authMethod: answer ? "claude.ai" : "none" }); };
    const t0 = 1_800_000_000_000;
    expect(await probeSecureStorageSupport(bin, { execImpl: exec, now: t0 })).toBe("unsupported");
    expect(await probeSecureStorageSupport(bin, { execImpl: exec, now: t0 + 59 * 60_000 })).toBe("unsupported");
    expect(calls).toBe(1);
    answer = false; // Claude Code updated behind the same launcher
    expect(await probeSecureStorageSupport(bin, { execImpl: exec, now: t0 + 61 * 60_000 })).toBe("supported");
    expect(calls).toBe(2);
    // An entry written before entries carried a check time is asked again.
    const cache = path.join(sandbox.dir, "cc-store", ".support.json");
    const entry = JSON.parse(fs.readFileSync(cache, "utf-8"));
    fs.writeFileSync(cache, JSON.stringify({ identity: entry.identity, supported: false }));
    expect(entry.verdict).toBe("supported");
    expect(await probeSecureStorageSupport(bin, { execImpl: exec, now: t0 + 62 * 60_000 })).toBe("supported");
    expect(calls).toBe(3);
    // A clock that stepped back does not keep an entry from the future alive.
    expect(await probeSecureStorageSupport(bin, { execImpl: exec, now: t0 })).toBe("supported");
    expect(calls).toBe(4);
  });
});

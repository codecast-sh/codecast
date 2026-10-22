// vault:// references in env files: parsing, layering, what refuses before a
// read, and how a read secret fills each reference.
import { describe, expect, test } from "bun:test";
import { envFromFiles, parseVaultRef, readEnvFiles, referencedSecrets, unresolvedRefs } from "./envFile.js";
import type { ReadSecret } from "./inject.js";

const files = (map: Record<string, string>) => (p: string) => {
  if (!(p in map)) throw new Error("ENOENT");
  return map[p]!;
};

describe("parseVaultRef", () => {
  test("a name, a name and field, a literal, and malformed references", () => {
    expect(parseVaultRef("vault://stripe-test")).toEqual({ secret: "stripe-test" });
    expect(parseVaultRef("vault://github-bot/username")).toEqual({ secret: "github-bot", field: "username" });
    expect(parseVaultRef("postgres://u:p@h/db")).toBeNull();
    expect(parseVaultRef("vault://Stripe Test")).toMatchObject({ error: expect.stringContaining("vault://<name>/<field>") });
    expect(parseVaultRef("vault://a/b/c")).toMatchObject({ error: expect.any(String) });
    expect(parseVaultRef("vault://gh/totp")).toMatchObject({ error: expect.stringContaining("value, username, password, content") });
  });
});

describe("readEnvFiles", () => {
  test("a later line and file win a var; literals and references are kept apart; problems name the file and var", () => {
    const got = readEnvFiles(["/a", "/b", "/missing"], files({
      "/a": "export STRIPE=vault://stripe-test\nNODE_ENV=development\nBAD=vault://NOPE\n",
      "/b": "NODE_ENV=test\nGH_USER=vault://github-bot/username\n",
    }));
    expect([...got.entries]).toEqual([
      ["STRIPE", { ref: { secret: "stripe-test" } }],
      ["NODE_ENV", { literal: "test" }],
      ["GH_USER", { ref: { secret: "github-bot", field: "username" } }],
    ]);
    expect(got.problems).toEqual([expect.stringMatching(/^BAD: vault:\/\/NOPE is not a reference/), "Cannot read /missing: pass the path of a readable env file"]);
    expect(referencedSecrets(got.entries)).toEqual(["stripe-test", "github-bot"]);
  });
});

describe("resolving", () => {
  const { entries } = readEnvFiles(["/e"], files({
    "/e": "KEY=vault://stripe-test\nUSER=vault://github-bot/username\nPASS=vault://github-bot\nSA=vault://gcp-sa\nSA_JSON=vault://gcp-sa/content\nPLAIN=hello\n",
  }));
  const meta = (name: string, kind: "key" | "login" | "file" | "signin", status: "ready" | "requested" = "ready") => ({ name, kind, status, short_id: `sec-${name.length}` });

  test("before any read: an absent, requested, sign-in or wrong-field reference is named with its fix", () => {
    expect(unresolvedRefs(entries, [meta("stripe-test", "key"), meta("github-bot", "login"), meta("gcp-sa", "file")])).toEqual([]);
    const lines = unresolvedRefs(entries, [meta("stripe-test", "login"), meta("github-bot", "login", "requested"), meta("gcp-sa", "signin")]);
    expect(lines).toEqual([
      "USER: github-bot (sec-10) is requested and has no value yet. Fill it on the Vault page or with cast vault fill github-bot",
      "PASS: github-bot (sec-10) is requested and has no value yet. Fill it on the Vault page or with cast vault fill github-bot",
      "SA: gcp-sa is a signin, which fills no env var",
      "SA_JSON: gcp-sa is a signin, which fills no env var",
    ]);
    const wrong = readEnvFiles(["/w"], files({ "/w": "K=vault://stripe-test/password\n" })).entries;
    expect(unresolvedRefs(wrong, [meta("stripe-test", "key")])).toEqual(["K: stripe-test is a key, which has no password. Use vault://stripe-test/value"]);
    expect(unresolvedRefs(entries, [])[0]).toBe("KEY: no secret stripe-test in your Vault. Ask for it: cast vault request stripe-test --env KEY");
  });

  test("after the read: a key's value, a login's fields, a file's temp path or content, literals as written", () => {
    const secrets: ReadSecret[] = [
      { id: "1", short_id: "sec-1", name: "stripe-test", kind: "key", payload: { value: "sk_1" } },
      { id: "2", short_id: "sec-2", name: "github-bot", kind: "login", payload: { username: "ci", password: "pw" } },
      { id: "3", short_id: "sec-3", name: "gcp-sa", kind: "file", payload: { content: "{}\n" } },
    ];
    expect(envFromFiles(entries, secrets, new Map([["gcp-sa", "/tmp/x/sa.json"]]))).toEqual({
      env: { KEY: "sk_1", USER: "ci", PASS: "pw", SA: "/tmp/x/sa.json", SA_JSON: "{}\n", PLAIN: "hello" },
      problems: [],
    });
    const noPassword = envFromFiles(entries, [{ ...secrets[1]!, payload: { username: "ci" } }, secrets[0]!, secrets[2]!], new Map([["gcp-sa", "/p"]]));
    expect(noPassword.problems).toEqual(["PASS: github-bot is a login with no password: store one with cast vault rotate github-bot"]);
  });
});

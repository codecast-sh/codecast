import { describe, expect, test } from "bun:test";
import type { SecretMeta } from "@codecast/shared/contracts/secrets";
import { classifyPaste, filterSecrets, nameIssue, parseEnvText, payloadOf, siteName, slugify, suggestName } from "./vaultModel";

describe("parseEnvText", () => {
  test("reads assignments and skips everything else", () => {
    const text = [
      "# stripe",
      "STRIPE_SECRET_KEY=sk_test_123",
      "export DATABASE_URL=postgres://u:p@h/db?x=1",
      "",
      "not an assignment",
      "QUOTED=\"two\\nlines\"",
      "SINGLE='keep $raw \\n'",
      "TRAILING=abc # a comment",
      "EMPTY=",
      "1BAD=x",
    ].join("\n");
    expect(parseEnvText(text)).toEqual([
      { key: "STRIPE_SECRET_KEY", value: "sk_test_123" },
      { key: "DATABASE_URL", value: "postgres://u:p@h/db?x=1" },
      { key: "QUOTED", value: "two\nlines" },
      { key: "SINGLE", value: "keep $raw \\n" },
      { key: "TRAILING", value: "abc" },
    ]);
  });

  test("a key given twice keeps its last value", () => {
    expect(parseEnvText("A=1\nA=2")).toEqual([{ key: "A", value: "2" }]);
  });
});

describe("classifyPaste", () => {
  test("an otpauth link is a 2FA seed", () => {
    const p = classifyPaste("otpauth://totp/GitHub:bot@acme.dev?secret=JBSWY3DPEHPK3PXP&issuer=GitHub");
    expect(p).toEqual({ kind: "otp", seed: "otpauth://totp/GitHub:bot@acme.dev?secret=JBSWY3DPEHPK3PXP&issuer=GitHub", issuer: "GitHub", account: "bot@acme.dev" });
  });
  test("one KEY=value line fills env and value", () => {
    expect(classifyPaste("OPENAI_API_KEY=sk-abc")).toEqual({ kind: "env-line", env: "OPENAI_API_KEY", value: "sk-abc" });
  });
  test("several lines are an .env to import", () => {
    expect(classifyPaste("A=1\nB=2\n")).toEqual({ kind: "env-file", entries: [{ key: "A", value: "1" }, { key: "B", value: "2" }] });
  });
  test("a plain value is just a value", () => {
    expect(classifyPaste("sk_live_abcdef")).toBeNull();
    expect(classifyPaste("otpauth://hotp/x?secret=JBSWY3DP")).toBeNull();
  });
});

describe("names", () => {
  test("slugify and siteName", () => {
    expect(slugify("STRIPE_SECRET_KEY")).toBe("stripe-secret-key");
    expect(slugify("--A  b--")).toBe("a-b");
    expect(slugify("x".repeat(70)).length).toBe(63);
    expect(siteName("https://dashboard.stripe.com/test")).toBe("stripe");
    expect(siteName("www.vercel.com")).toBe("vercel");
    expect(siteName("localhost:3000")).toBe("localhost");
  });
  test("suggestName prefers the env var, then the site", () => {
    expect(suggestName({ kind: "key", env: "STRIPE_SECRET_KEY", site: "stripe.com" })).toBe("stripe-secret-key");
    expect(suggestName({ kind: "login", site: "github.com" })).toBe("github");
    expect(suggestName({ kind: "signin", site: "vercel.com" })).toBe("vercel-signin");
    expect(suggestName({ kind: "key" })).toBe("");
  });
  test("nameIssue", () => {
    const taken = new Set(["stripe-test"]);
    expect(nameIssue("", taken)).toBe("Name it");
    expect(nameIssue("Stripe", taken)).toBe("Lowercase letters, digits and dashes");
    expect(nameIssue("stripe-test", taken)).toBe("Already in this vault");
    expect(nameIssue("stripe-live", taken)).toBeNull();
  });
});

describe("filterSecrets", () => {
  const row = (over: Partial<SecretMeta>): SecretMeta =>
    ({ _id: over.name!, short_id: "sec-1", kind: "key", status: "ready", workspace: "team:t", created_by: "u", created_at: 0, updated_at: 0, ...over }) as SecretMeta;
  const rows = [
    row({ name: "stripe-test", env: ["STRIPE_SECRET_KEY"] }),
    row({ name: "mine", workspace: "user:u" }),
    row({ name: "github-bot", status: "requested", sites: ["github.com"] }),
  ];
  const base = { query: "", scope: "all" as const, team: "team:t", personal: "user:u" };
  test("requests first, then by name", () => {
    expect(filterSecrets(rows, base).map((r) => r.name)).toEqual(["github-bot", "mine", "stripe-test"]);
  });
  test("scope and query", () => {
    expect(filterSecrets(rows, { ...base, scope: "personal" }).map((r) => r.name)).toEqual(["mine"]);
    expect(filterSecrets(rows, { ...base, scope: "team" }).map((r) => r.name)).toEqual(["github-bot", "stripe-test"]);
    expect(filterSecrets(rows, { ...base, query: "stripe_secret" }).map((r) => r.name)).toEqual(["stripe-test"]);
    expect(filterSecrets(rows, { ...base, query: "github.com" }).map((r) => r.name)).toEqual(["github-bot"]);
  });
});

describe("payloadOf", () => {
  const d = { value: " sk ", username: "bot", password: "pw", totp_seed: "", content: "A=1\n", filename: "" };
  test("each kind takes its own fields", () => {
    expect(payloadOf("key", d)).toEqual({ value: " sk " });
    expect(payloadOf("login", d)).toEqual({ username: "bot", password: "pw" });
    expect(payloadOf("file", { ...d, filename: ".env" })).toEqual({ content: "A=1\n", filename: ".env" });
    expect(payloadOf("signin", d)).toBeNull();
  });
});

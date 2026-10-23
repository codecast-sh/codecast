import { describe, expect, test } from "bun:test";
import type { SecretMeta } from "@codecast/shared/contracts/secrets";
import { findSecrets } from "@codecast/shared/contracts/secretShapes";
import { classifyPaste, fillRequest, filterSecrets, formatIn, isStub, loginEnv, nameIssue, parseEnvText, readEnvText, payloadOf, saveRemaining, secretHealth, withPendingSwap, siteName, slugify, suggestName, whereUsed, withVaultReferences } from "./vaultModel";

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

describe("readEnvText", () => {
  test("names every line it leaves out, with its line number", () => {
    const text = ["# a comment", "ZZ_ENV_ONE=aaa111", 'export ZZ_ENV_TWO="bbb 222"', "ZZ_ENV_THREE=", "bad line here", "", "a.b=x", "ZZ_ENV_ONE=again"].join("\n");
    expect(readEnvText(text)).toEqual({
      entries: [
        { key: "ZZ_ENV_ONE", value: "again" },
        { key: "ZZ_ENV_TWO", value: "bbb 222" },
      ],
      skipped: [
        { line: 2, key: "ZZ_ENV_ONE", why: "Set again on line 8" },
        { line: 4, key: "ZZ_ENV_THREE", why: "Empty value" },
        { line: 5, why: "Not KEY=value" },
        { line: 7, key: "a.b", why: "Not an env var name" },
      ],
    });
  });

  test("blank lines and comments are not skipped lines", () => {
    expect(readEnvText("\n# x\n  \nA=1\r\n").skipped).toEqual([]);
  });
});

describe("loginEnv", () => {
  test("one var is the password; both are username then password", () => {
    expect(loginEnv("", "", "X_PASSWORD")).toEqual([]);
    expect(loginEnv("", "GH_PASS", "X_PASSWORD")).toEqual(["GH_PASS"]);
    expect(loginEnv(" GH_USER ", "GH_PASS", "X_PASSWORD")).toEqual(["GH_USER", "GH_PASS"]);
    expect(loginEnv("GH_USER", "", "X_PASSWORD")).toEqual(["GH_USER", "X_PASSWORD"]);
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

  test("suggestName names a pasted key by its shape when nothing else names it", () => {
    const key = `sk_test_${"a1B2c3D4e5".repeat(3)}`;
    expect(suggestName({ kind: "key", value: ` ${key} ` })).toBe("stripe-test");
    expect(suggestName({ kind: "key", env: "PAYMENTS_KEY", value: key })).toBe("payments-key");
    expect(suggestName({ kind: "key", value: `token ${key}` })).toBe("");
    expect(suggestName({ kind: "key", value: "plain-opaque-value" })).toBe("");
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
  test("needs attention keeps requests and secrets whose health needs a look", () => {
    const now = 10 * DAY;
    const mixed = [...rows, row({ name: "used", use_count: 3, last_used_at: now - DAY })];
    expect(filterSecrets(mixed, { ...base, attention: true, now }).map((r) => r.name)).toEqual(["github-bot", "mine", "stripe-test"]);
  });
});

const DAY = 86_400_000;

describe("secretHealth", () => {
  const now = 200 * DAY;
  const row = (over: Partial<SecretMeta>): SecretMeta =>
    ({ _id: "s", short_id: "sec-1", name: "s", kind: "key", status: "ready", workspace: "team:t", created_by: "u", created_at: now - 10 * DAY, updated_at: 0, use_count: 4, last_used_at: now - DAY, ...over }) as SecretMeta;
  test("a secret read recently is fine", () => {
    expect(secretHealth(row({}), now)).toBeNull();
  });
  test("never used counts only after its first day", () => {
    expect(secretHealth(row({ use_count: 0, last_used_at: undefined }), now)).toBe("unused");
    expect(secretHealth(row({ use_count: 0, last_used_at: undefined, created_at: now - 3_600_000 }), now)).toBeNull();
  });
  test("stale after 90 days without a read", () => {
    expect(secretHealth(row({ last_used_at: now - 91 * DAY }), now)).toBe("stale");
    expect(secretHealth(row({ last_used_at: now - 89 * DAY }), now)).toBeNull();
  });
  test("a sign-in expiring within 3 days, or expired, comes before use", () => {
    const signin = { kind: "signin" as const, use_count: 0, last_used_at: undefined };
    expect(secretHealth(row({ ...signin, signin_expires_at: now + 2 * DAY }), now)).toBe("expiring");
    expect(secretHealth(row({ ...signin, signin_expires_at: now - 1 }), now)).toBe("expired");
    expect(secretHealth(row({ ...signin, signin_expires_at: now + 4 * DAY }), now)).toBe("unused");
  });
  test("a request has no health", () => {
    expect(secretHealth(row({ status: "requested", use_count: 0 }), now)).toBeNull();
  });
});

describe("formatIn", () => {
  test("minutes, hours, days ahead", () => {
    expect(formatIn(5 * 60_000, 0)).toBe("in 5m");
    expect(formatIn(3 * 3_600_000 + 1, 0)).toBe("in 3h");
    expect(formatIn(6.5 * DAY, 0)).toBe("in 6d");
    expect(formatIn(0, 1)).toBe("in 1m");
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

describe("withVaultReferences", () => {
  const key = `sk_test_${"a1B2c3D4e5".repeat(3)}`;

  test("the sent message carries the reference, never the value", () => {
    const text = `Charge with ${key} please`;
    const out = withVaultReferences(text, findSecrets(text), ["stripe-test"]);
    expect(out).toBe("Charge with [vault secret stripe-test: `cast vault run stripe-test -- <command>` sets STRIPE_SECRET_KEY] please");
    expect(out).not.toContain(key);
  });

  test("an assignment keeps its variable, and a renamed secret is referenced by its new name", () => {
    const text = `PAYMENTS_TOKEN=${key}`;
    expect(withVaultReferences(text, findSecrets(text), ["payments"])).toBe("PAYMENTS_TOKEN=[vault secret payments: `cast vault run payments -- <command>` sets PAYMENTS_TOKEN]");
  });
});

describe("whereUsed", () => {
  const row = (over: Partial<SecretMeta>): SecretMeta =>
    ({ _id: "s1", short_id: "sec-1", name: "stripe", kind: "key", workspace: "user:u1", status: "ready", created_at: 0, updated_at: 0, ...over }) as SecretMeta;

  test("a sign-in shows its sites", () => {
    expect(whereUsed(row({ kind: "signin", sites: ["github.com"] }))).toEqual({ sites: true, named: ["github.com"], implied: [] });
  });

  test("named env vars show as named, and a secret naming none shows the defaults it still injects", () => {
    expect(whereUsed(row({ env: ["STRIPE_KEY"] }))).toEqual({ sites: false, named: ["STRIPE_KEY"], implied: [] });
    expect(whereUsed(row({ kind: "login", name: "db" }))).toEqual({ sites: false, named: [], implied: ["DB_USERNAME", "DB_PASSWORD"] });
  });

  test("a secret with sites and no env var shows its sites", () => {
    expect(whereUsed(row({ sites: ["api.stripe.com"] })).named).toEqual(["api.stripe.com"]);
  });
});

test("isStub: a row is a stub until the server gives it a short id", () => {
  expect(isStub({ short_id: "" })).toBe(true);
  expect(isStub({ short_id: "sec-1" })).toBe(false);
});

describe("saveRemaining", () => {
  test("a retry after a refusal creates only what is not saved yet", async () => {
    const created: string[] = [];
    let refuse = "b";
    const create = async (x: string) => (x === refuse ? "taken" : (created.push(x), null));
    const first = await saveRemaining(["a", "b", "c"], new Set(), create);
    expect(first).toEqual({ saved: new Set([0]), failed: { index: 1, error: "taken" } });
    refuse = "";
    const second = await saveRemaining(["a", "b", "c"], first.saved, create);
    expect(second).toEqual({ saved: new Set([0, 1, 2]) });
    expect(created).toEqual(["a", "b", "c"]);
  });
});

describe("withPendingSwap", () => {
  const pending = { kind: "rotated", at: 300 };
  test("shows a rotate pressed here until its event arrives", () => {
    const events = [{ kind: "read", at: 250 }, { kind: "rotated", at: 100 }];
    expect(withPendingSwap(events, { rotated_at: 300 }, pending)).toEqual([pending, ...events]);
    expect(withPendingSwap([{ kind: "rotated", at: 300 }, ...events], { rotated_at: 300 }, pending)).toHaveLength(3);
    expect(withPendingSwap(events, { rotated_at: undefined }, pending)).toBe(events);
    expect(withPendingSwap([{ kind: "restored", at: 400 }], { rotated_at: 300 }, pending)).toHaveLength(1);
  });
});

describe("fillRequest", () => {
  const row = { _id: "s1", name: "STRIPE_KEY", kind: "key", status: "requested", updated_at: 1 } as SecretMeta;
  const payload = { kind: "key", value: "sk_test_x" } as const;

  test("the row reads ready before fulfill answers, and the value goes only to fulfill", async () => {
    const staged: SecretMeta[] = [];
    let answer!: (v: unknown) => void;
    const pending = fillRequest(row, payload, {
      stage: (r) => staged.push(r),
      fulfill: (args) => {
        expect(args).toEqual({ ref: "s1", payload });
        return new Promise((resolve) => (answer = resolve));
      },
    });
    expect(staged.map((r) => r.status)).toEqual(["ready"]);
    expect(JSON.stringify(staged)).not.toContain("sk_test_x");
    answer({ delivered: true });
    expect(await pending).toEqual({ delivered: true });
    expect(staged).toHaveLength(1);
  });

  test("a refusal puts the row back as it was", async () => {
    const staged: SecretMeta[] = [];
    const res = await fillRequest(row, payload, { stage: (r) => staged.push(r), fulfill: async () => ({ error: "no access" }) });
    expect(res).toEqual({ error: "no access" });
    expect(staged.map((r) => r.status)).toEqual(["ready", "requested"]);
    expect(staged[1]).toBe(row);
  });

  test("a thrown action is a refusal too", async () => {
    const staged: SecretMeta[] = [];
    const res = await fillRequest(row, payload, { stage: (r) => staged.push(r), fulfill: async () => { throw new Error("offline"); } });
    expect(res).toEqual({ error: "offline" });
    expect(staged.at(-1)).toBe(row);
  });
});

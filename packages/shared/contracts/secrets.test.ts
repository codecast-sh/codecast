import { describe, expect, test } from "bun:test";
import {
  siteProblem,
  base32Decode,
  base32Encode,
  ambiguousSecretName,
  envFor,
  envNameProblem,
  envValues,
  dotenvVars,
  fingerprint,
  parseDotenv,
  signinName,
  siteName,
  pickSecretByName,
  secretEnvProblem,
  secretHealth,
  compareSecrets,
  isExpiring,
  DAY_MS,
  parseOtpauth,
  redactionValuesOf,
  secretNameProblem,
  signinExpiresAt,
  totp,
  totpParams,
  validatePayload,
} from "./secrets";

const ascii = (s: string) => new TextEncoder().encode(s);

// RFC 6238 Appendix B: the key is the ASCII string repeated to the hash's length.
const SEEDS = {
  "SHA-1": base32Encode(ascii("12345678901234567890")),
  "SHA-256": base32Encode(ascii("12345678901234567890123456789012")),
  "SHA-512": base32Encode(ascii("1234567890123456789012345678901234567890123456789012345678901234")),
};
const VECTORS: [number, string, string, string][] = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

describe("totp", () => {
  test("RFC 6238 test vectors, all three hashes, 8 digits", async () => {
    for (const [t, sha1, sha256, sha512] of VECTORS) {
      for (const [alg, want] of [["SHA1", sha1], ["SHA256", sha256], ["SHA512", sha512]] as const) {
        const seed = SEEDS[alg === "SHA1" ? "SHA-1" : alg === "SHA256" ? "SHA-256" : "SHA-512"];
        const uri = `otpauth://totp/x?secret=${seed}&digits=8&algorithm=${alg}`;
        expect((await totp(uri, t * 1000)).code).toBe(want);
      }
    }
  });

  test("a bare base32 seed is SHA-1, 6 digits, 30 s", async () => {
    const r = await totp(SEEDS["SHA-1"].toLowerCase().replace(/(.{4})/g, "$1 "), 59_000);
    expect(r).toEqual({ code: "287082", remaining: 1, period: 30 });
  });

  test("an unreadable seed throws a sentence that says what to do", async () => {
    await expect(totp("not!base32")).rejects.toThrow(/setup key/);
  });
});

describe("base32 and otpauth", () => {
  test("decode is case-insensitive, ignores padding and spaces, refuses other characters", () => {
    expect(new TextDecoder().decode(base32Decode("mzxw6ytb oi======")!)).toBe("foobar");
    expect(base32Decode("MZXW1")).toBeNull();
  });

  test("parses issuer, account and parameters", () => {
    expect(parseOtpauth("otpauth://totp/Stripe:ana%40acme.dev?secret=JBSWY3DPEHPK3PXP&issuer=Stripe&period=60&digits=8")).toEqual({
      secret: "JBSWY3DPEHPK3PXP",
      digits: 8,
      period: 60,
      algorithm: "SHA-1",
      issuer: "Stripe",
      account: "ana@acme.dev",
    });
    // A malformed escape in the label keeps the label as typed rather than throwing.
    expect(parseOtpauth("otpauth://totp/a%?secret=GEZDGNBVGY3TQOJQ")).toMatchObject({ secret: "GEZDGNBVGY3TQOJQ", account: "a%" });
    expect(validatePayload("login", { username: "ana", password: "pw12345678", totp_seed: "otpauth://totp/a%?secret=GEZDGNBVGY3TQOJQ" })).not.toHaveProperty("error");
    expect(parseOtpauth("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP")).toBeNull();
    expect(parseOtpauth("otpauth://totp/x?secret=")).toBeNull();
    expect(parseOtpauth("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5")).toBeNull();
    expect(totpParams("JBSW Y3DP EHPK 3PXP")?.secret).toBe("JBSWY3DPEHPK3PXP");
  });
});

describe("validation", () => {
  test("names are lowercase slugs of 1 to 63", () => {
    expect(secretNameProblem("stripe-test")).toBeNull();
    expect(secretNameProblem("a")).toBeNull();
    expect(secretNameProblem("Stripe")).toMatch(/lowercase/);
    expect(secretNameProblem("-x")).not.toBeNull();
    expect(secretNameProblem("x".repeat(64))).not.toBeNull();
  });

  test("a name shaped like a short id or a Convex id is refused, since lookups would read it as an id", () => {
    expect(secretNameProblem("sec-5")).toMatch(/reads as a secret's id/);
    expect(secretNameProblem("a".repeat(32))).toMatch(/reads as a secret's id/);
    expect(secretNameProblem("sec-5-live")).toBeNull();
    expect(secretNameProblem("a".repeat(31))).toBeNull();
  });

  test("env vars that make a shell or an interpreter load code are refused, any case", () => {
    for (const name of ["PATH", "BASH_ENV", "ENV", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "PYTHONPATH", "PYTHONSTARTUP", "PERL5OPT", "RUBYOPT", "SHELL", "IFS", "PROMPT_COMMAND", "GIT_SSH_COMMAND", "GIT_CONFIG_GLOBAL", "npm_config_script_shell", "path"]) {
      expect(envNameProblem(name)).toMatch(/what code to load/);
    }
    for (const name of ["STRIPE_SECRET_KEY", "GITHUB_TOKEN", "GIT_TOKEN", "DATABASE_URL", "PGPASSWORD", "OPENAI_API_KEY", "CARGO_REGISTRY_TOKEN", "NPM_TOKEN", "DOCKER_PASSWORD", "AWS_SECRET_ACCESS_KEY"]) expect(envNameProblem(name)).toBeNull();
    // A key's var derived from its name counts too, and a stored one refuses to inject.
    expect(secretEnvProblem({ name: "path", kind: "key" })).toMatch(/PATH/);
    expect(secretEnvProblem({ name: "path", kind: "login" })).toBeNull();
    expect(secretEnvProblem({ name: "team-file", kind: "file", env: ["BASH_ENV"] })).toMatch(/BASH_ENV/);
    expect(() => envValues({ name: "team-file", kind: "file", env: ["BASH_ENV"] }, { content: "x" }, "/tmp/p")).toThrow(/BASH_ENV/);
  });

  test("env vars that redirect what a tool trusts, routes through or runs are refused too", () => {
    const names = [
      "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "HTTPS_PROXY", "http_proxy", "ALL_PROXY", "NO_PROXY",
      "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "SSH_AUTH_SOCK", "KUBECONFIG", "AWS_CONFIG_FILE", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_S3",
      "PIP_INDEX_URL", "UV_INDEX_URL", "GOPROXY", "GOFLAGS", "RUSTC_WRAPPER", "CARGO_HOME", "CARGO_BUILD_RUSTFLAGS", "CC", "MAKEFLAGS", "TMPDIR",
      "GIT_SSL_CAINFO", "NODE_TLS_REJECT_UNAUTHORIZED",
      "MAVEN_OPTS", "GRADLE_OPTS", "JAVA_OPTS", "SBT_OPTS", "BUN_OPTIONS", "JAVA_TOOL_OPTIONS", "SHELLOPTS", "XDG_DATA_DIRS", "XDG_CONFIG_HOME",
      "TERMINFO_DIRS", "JAVA_HOME", "GRADLE_USER_HOME", "GNUPGHOME", "MAKEFILES", "CPATH", "CMAKE_PREFIX_PATH", "RESOLV_HOST_CONF",
    ];
    for (const name of names) expect([name, envNameProblem(name)]).toEqual([name, expect.stringMatching(/what to trust/)]);
  });

  test("a name in several workspaces resolves only when the preferred workspace or the status settles it", () => {
    const rows = [
      { name: "foo", workspace: "user:u1", status: "ready" as const, short_id: "sec-1" },
      { name: "foo", workspace: "team:t1", status: "requested" as const, short_id: "sec-2" },
      { name: "bar", workspace: "team:t1", status: "ready" as const, short_id: "sec-3" },
    ];
    expect(pickSecretByName(rows, "bar")).toBe(rows[2]);
    expect(pickSecretByName(rows, "nope")).toBeNull();
    expect(pickSecretByName(rows, "foo")).toEqual({ ambiguous: [rows[0], rows[1]] });
    expect(pickSecretByName(rows, "foo", { prefer: "team:t1" })).toBe(rows[1]);
    expect(pickSecretByName(rows, "foo", { prefer: "team:other" })).toEqual({ ambiguous: [rows[0], rows[1]] });
    expect(pickSecretByName(rows, "foo", { status: "requested" })).toBe(rows[1]);
    expect(ambiguousSecretName("foo", [rows[0], rows[1]])).toBe("foo is in 2 workspaces (sec-1 personal, sec-2 team): name the one you mean by its short id, like sec-1");
    // A [vault] line or vault:// reference cannot take a short id, so it is never offered there.
    expect(ambiguousSecretName("foo", [rows[0], rows[1]], { byNameOnly: true })).toBe("foo is in 2 workspaces (sec-1 personal, sec-2 team): rename one of them (cast vault ls shows both), since this names a secret only by name");
  });

  test("each kind normalizes or refuses with a sentence that never quotes the value", () => {
    expect(validatePayload("key", { value: "  sk_test_abc \n" })).toEqual({ payload: { value: "sk_test_abc" } });
    expect(validatePayload("key", { value: " " })).toMatchObject({ error: expect.stringMatching(/needs a value/) });
    expect(validatePayload("login", { username: "ana", totp_seed: "jbsw y3dp ehpk 3pxp" })).toEqual({ payload: { username: "ana", totp_seed: "JBSWY3DPEHPK3PXP" } });
    const bad = validatePayload("login", { password: "hunter2-secret", totp_seed: "!!" });
    expect(bad).toMatchObject({ error: expect.stringMatching(/setup key/) });
    expect(JSON.stringify(bad)).not.toContain("hunter2");
    expect(validatePayload("login", {})).toMatchObject({ error: expect.any(String) });
    expect(validatePayload("file", { content: "A=1\n", filename: ".env" })).toEqual({ payload: { content: "A=1\n", filename: ".env" } });
    const cookie = { name: "s", value: "v", domain: ".x.com", path: "/", secure: true, httpOnly: true, expires: 2_000_000_000 };
    expect(validatePayload("signin", { cookies: [cookie], captured_from: "chrome" })).toEqual({ payload: { cookies: [cookie], captured_from: "chrome" } });
    expect(validatePayload("signin", { cookies: [{ ...cookie, secure: "yes" }], captured_from: "chrome" })).toMatchObject({ error: expect.stringMatching(/cookie 1/) });
    expect(validatePayload("signin", { cookies: [cookie], captured_from: "safari" })).toMatchObject({ error: expect.any(String) });
    expect(validatePayload("nope" as any, {})).toMatchObject({ error: expect.stringMatching(/key, login/) });
  });

  test("fingerprint shows the ends of a long key and nothing of a short one", () => {
    expect(fingerprint("sk_test_51Habcdefghijklmnop1234")).toBe("sk_t…1234");
    expect(fingerprint("short-key")).toBeUndefined();
  });
});

describe("env and redaction", () => {
  test("a key fills its names or one from the secret's name", () => {
    expect(envFor({ name: "stripe-test", kind: "key" })).toEqual([{ var: "STRIPE_TEST", field: "value" }]);
    expect(envValues({ name: "stripe-test", kind: "key", env: ["STRIPE_SECRET_KEY", "STRIPE_KEY"] }, { value: "sk" })).toEqual({ STRIPE_SECRET_KEY: "sk", STRIPE_KEY: "sk" });
  });

  test("a login fills username and password; one given name is the password", () => {
    const login = { username: "admin", password: "pw" };
    expect(envValues({ name: "staging-db", kind: "login" }, login)).toEqual({ STAGING_DB_USERNAME: "admin", STAGING_DB_PASSWORD: "pw" });
    expect(envValues({ name: "staging-db", kind: "login", env: ["PGPASSWORD"] }, login)).toEqual({ PGPASSWORD: "pw" });
    expect(envValues({ name: "staging-db", kind: "login", env: ["PGUSER", "PGPASSWORD"] }, login)).toEqual({ PGUSER: "admin", PGPASSWORD: "pw" });
  });

  test("a file fills a path var; a sign-in nothing", () => {
    expect(envValues({ name: "gcp-sa", kind: "file" }, { content: "{}" }, "/tmp/x.json")).toEqual({ GCP_SA_FILE: "/tmp/x.json" });
    expect(envFor({ name: "vercel", kind: "signin" })).toEqual([]);
  });

  test("redaction takes secrets, not usernames, and skips a file too long to match", () => {
    const link = "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP";
    expect(redactionValuesOf("login", { username: "ana", password: "pw-123456", totp_seed: link })).toEqual(["pw-123456", "JBSWY3DPEHPK3PXP", link]);
    expect(redactionValuesOf("file", { content: "x".repeat(9000) })).toEqual([]);
  });

  test("a sign-in redacts its session cookies, never consent or preference words", () => {
    const cookie = (name: string, value: string, httpOnly = false) => ({ name, value, domain: ".acme.dev", path: "/", secure: true, httpOnly });
    const cookies = [
      cookie("sid", "s3ss10n-token-abcdef", true),
      cookie("csrf", "a1b2c3d4", true),
      cookie("consent", "granted"),
      cookie("theme", "dark_mode"),
      cookie("lang", "accepteddesktopview"),
      cookie("xsrf", "Zk3_9aQ-pL0r8sTuV2"),
    ];
    expect(redactionValuesOf("signin", { cookies } as any)).toEqual(["s3ss10n-token-abcdef", "a1b2c3d4", "Zk3_9aQ-pL0r8sTuV2"]);
  });

  test("a sign-in redacts the tokens its localStorage holds, bare and inside JSON", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop";
    const session = JSON.stringify({ user: { id: 7, access_token: "at_9f8e7d6c5b4a3210", name: "Ana" }, expires: 1729700000 });
    const local_storage = {
      "https://x.com": { token: jwt, session, theme: "dark", route: "https://x.com/dashboard/settings", flag: "enabledfeaturesforall", big: "y".repeat(9000) },
    };
    const got = redactionValuesOf("signin", { cookies: [], captured_from: "chrome", local_storage });
    expect(got).toEqual([jwt, session, "at_9f8e7d6c5b4a3210"]);
  });

  test("a file is redacted in the pieces a command prints: dotenv values, JSON strings, one-token lines", () => {
    const env = "# staging\nexport API_KEY=abc123def456\nDB_PASSWORD=\"hunter2-staging\"\nDEBUG=true\nURL=https://api.example.com/v1\n";
    expect(redactionValuesOf("file", { content: env })).toEqual([env.trim(), "abc123def456", "hunter2-staging"]);
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nVJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDu\n-----END PRIVATE KEY-----\n";
    const sa = JSON.stringify({ type: "service_account", private_key_id: "0123456789abcdef0123", private_key: pem, token_uri: "https://oauth2.googleapis.com/token" }, null, 2);
    const got = redactionValuesOf("file", { content: sa });
    expect(got).toContain("0123456789abcdef0123");
    expect(got).toContain(pem.trim());
    expect(got).toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7");
    expect(got).toContain("VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDu");
    // Armour, urls and the JSON's own short words name no secret.
    expect(got.some((v) => v === "-----BEGIN PRIVATE KEY-----" || v.startsWith("https://") || v === "service_account")).toBe(false);
  });
});

describe("sites and sign-in cookies", () => {
  test("a public suffix or a single label is refused as a site", () => {
    for (const s of ["com", "co.uk", ".com", "localhost"]) expect(siteProblem(s)).toMatch(/every site under it/);
    for (const s of ["github.com", "bbc.co.uk", "dashboard.stripe.com", "127.0.0.1"]) expect(siteProblem(s)).toBeNull();
  });

  test("a stored sign-in cookie keeps only a cookie's own fields", () => {
    const checked = validatePayload("signin", {
      cookies: [{ name: "a", value: "b", domain: ".x.com", path: "/", secure: true, httpOnly: true, url: "https://evil.test", partitionKey: "p" }],
      captured_from: "chrome",
    });
    expect("payload" in checked && checked.payload.cookies[0]).toEqual({ name: "a", value: "b", domain: ".x.com", path: "/", secure: true, httpOnly: true });
  });

  test("a sign-in expires with its first session cookie, never with a long-lived tracker", () => {
    const c = (name: string, expires: number | undefined, httpOnly: boolean) => ({ name, value: "v", domain: ".x.com", path: "/", secure: true, httpOnly, ...(expires ? { expires } : {}) });
    const day = 86_400;
    const now = 1_800_000_000;
    // A one-day auth cookie beside a two-year _ga and a week-long preference: the auth cookie dates it.
    expect(signinExpiresAt({ cookies: [c("_ga", now + 730 * day, false), c("sid", now + day, true), c("csrf", now + 7 * day, true)], captured_from: "chrome" })).toBe((now + day) * 1000);
    // No httpOnly cookies: trackers are left out, the rest's earliest wins.
    expect(signinExpiresAt({ cookies: [c("_ga", now + 730 * day, false), c("token", now + 2 * day, false)], captured_from: "chrome" })).toBe((now + 2 * day) * 1000);
    // The session lives in a session cookie: no known expiry, whatever the trackers say.
    expect(signinExpiresAt({ cookies: [c("_ga", now + 730 * day, false), c("sid", undefined, true)], captured_from: "chrome" })).toBeUndefined();
  });
});

describe(".env files", () => {
  // One table for every reader: the Vault's import, `run --env-file` and the daemon's redaction.
  const LINES: [string, [string, string] | null][] = [
    ["KEY=plain", ["KEY", "plain"]],
    ["export KEY=plain", ["KEY", "plain"]],
    ["  KEY = spaced  ", ["KEY", "spaced"]],
    ["KEY=abc # a comment", ["KEY", "abc"]],
    ["KEY=abc#not-a-comment", ["KEY", "abc#not-a-comment"]],
    ['KEY="two\\nlines"', ["KEY", "two\nlines"]],
    ['KEY="say \\"hi\\" \\\\ \\t"', ["KEY", 'say "hi" \\ \t']],
    ['KEY="keeps # inside" # comment', ["KEY", "keeps # inside"]],
    ['KEY="\\x unknown"', ["KEY", "\\x unknown"]],
    ["KEY='keep $raw \\n'", ["KEY", "keep $raw \\n"]],
    ["KEY=`back \\n tick`", ["KEY", "back \\n tick"]],
    ['KEY="never closed', ["KEY", '"never closed']],
    ["KEY=", ["KEY", ""]],
    ["a.b-c=dotted", ["a.b-c", "dotted"]],
    ["# KEY=commented", null],
    ["1BAD=x", null],
    ["not an assignment", null],
  ];
  test.each(LINES)("%s", (line, want) => {
    expect(parseDotenv(line)).toEqual(want ? [want] : []);
  });

  test("dotenvVars keeps env var names only, the last line winning", () => {
    expect([...dotenvVars("A=1\na.b=2\nB=x\nA=3")]).toEqual([["A", "3"], ["B", "x"]]);
  });
});

describe("naming a site", () => {
  test.each([
    ["github.com", "github", "github-signin"],
    ["https://dashboard.stripe.com/x?y", "stripe", "stripe-signin"],
    ["www.vercel.com", "vercel", "vercel-signin"],
    ["bbc.co.uk", "bbc", "bbc-signin"],
    ["news.example.co.uk", "example", "example-signin"],
    ["localhost", "localhost", "localhost-signin"],
    ["---", "", "site-signin"],
    ["", "", ""],
  ])("%s", (site, name, signin) => {
    expect(siteName(site)).toBe(name);
    expect(signinName(site)).toBe(signin);
  });

  test("a long site name still fits a secret name with its suffix", () => {
    const n = signinName(`${"a".repeat(80)}.com`);
    expect(n.length).toBeLessThanOrEqual(63);
    expect(secretNameProblem(n)).toBeNull();
    expect(n.endsWith("-signin")).toBe(true);
  });
});

describe("secretHealth", () => {
  const DAY = 86_400_000;
  const now = 200 * DAY;
  const row = (over: Record<string, unknown>) =>
    ({ kind: "key", status: "ready", created_at: now - 10 * DAY, use_count: 0, ...over }) as Parameters<typeof secretHealth>[0];

  test("never used counts from when the value arrived, so a request filled late is not flagged at once", () => {
    expect(secretHealth(row({ value_updated_at: now - 3_600_000 }), now)).toBeNull();
    expect(secretHealth(row({ value_updated_at: now - 2 * DAY }), now)).toBe("unused");
  });

  test("a sign-in is never stale: a browser still signed in uses it without a read", () => {
    expect(secretHealth(row({ use_count: 3, last_used_at: now - 120 * DAY }), now)).toBe("stale");
    expect(secretHealth(row({ kind: "signin", use_count: 3, last_used_at: now - 120 * DAY }), now)).toBeNull();
  });
});

describe("isExpiring", () => {
  test("ahead of now and inside the expiring window, the same line secretHealth draws", () => {
    const now = 1_000 * DAY_MS;
    expect(isExpiring(now + 2 * DAY_MS, now)).toBe(true);
    expect(isExpiring(now + 4 * DAY_MS, now)).toBe(false);
    expect(isExpiring(now - 1, now)).toBe(false);
  });
});

describe("compareSecrets", () => {
  test("open requests first, then by name", () => {
    const rows = [
      { status: "ready", name: "b" },
      { status: "requested", name: "z" },
      { status: "ready", name: "a" },
      { status: "requested", name: "c" },
    ] as const;
    expect([...rows].sort(compareSecrets).map((r) => r.name)).toEqual(["c", "z", "a", "b"]);
  });
});
